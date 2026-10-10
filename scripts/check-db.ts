// scripts/check-db.ts
// Checks that the app can read everything it needs from Supabase, using the PUBLIC (anon) key,
// exactly as the website will. Safe to run any time: it only reads.
//   npx tsx scripts/check-db.ts

import { config } from "dotenv";
config({ path: ".env.local" });

import { getAnonClient } from "../src/lib/db/client";
import { withRetry } from "../src/lib/db/retry";
import { SupabaseDataSource } from "../src/lib/datasource/supabase";
import { loadMatchContext } from "../src/lib/intelligence/context";
import { detectMoments, topMoments } from "../src/lib/intelligence/moments";
import { computeStats } from "../src/lib/intelligence/stats";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

async function main() {
  const db = getAnonClient();
  const ds = new SupabaseDataSource(db);

  console.log("1. Table sizes (read with the public key)");
  const expected: Record<string, number> = { teams: 20, players: 460, matches: 110, events: 179498, fatigue_samples: 51258 };
  for (const [table, want] of Object.entries(expected)) {
    const res = await withRetry<{ count: number | null; error: { message: string } | null }>(`count ${table}`, () =>
      db.from(table).select("*", { count: "exact", head: true }),
    );
    check(`${table}: ${res.count}`, res.count === want, res.count === want ? "" : `expected ${want}`);
  }

  console.log("\n2. Matches");
  const finished = await ds.listMatches({ status: "finished" });
  const scheduled = await ds.listMatches({ status: "scheduled" });
  check("100 finished matches (rounds 1-10)", finished.length === 100, String(finished.length));
  check("10 scheduled matches (the live round)", scheduled.length === 10, String(scheduled.length));
  check("live-round scores are hidden (0-0)", scheduled.every((m) => m.homeScore === 0 && m.awayScore === 0));

  console.log("\n3. Full-match checks on three finished matches");
  const sample = [finished[0], finished[Math.floor(finished.length / 2)], finished[finished.length - 1]];
  for (const m of sample) {
    const t0 = Date.now();
    const ctx = await loadMatchContext(ds, m.id);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!ctx) { check(`load ${m.id}`, false); continue; }
    const stats = computeStats(ctx);
    const seqOk = ctx.events.every((e, i) => e.seq === i + 1);
    const ids = new Set(ctx.events.map((e) => e.id));
    const moments = detectMoments(ctx);
    console.log(`  ${m.id}  round ${m.round}  ${ctx.events.length} events, ${ctx.fatigue.length} fatigue readings, loaded in ${secs}s`);
    check("  events complete and in order (paging works)", seqOk && ctx.events.length > 1000);
    check("  match is complete (full-time whistle present)", ctx.complete);
    check("  goals counted from events equal the stored score", stats.score.home === m.homeScore && stats.score.away === m.awayScore, `${stats.score.home}-${stats.score.away} vs ${m.homeScore}-${m.awayScore}`);
    check("  every moment's evidence exists", moments.every((x) => x.evidence.length > 0 && x.evidence.every((id) => ids.has(id))), `${moments.length} moments`);
    for (const t of topMoments(moments, 3)) console.log(`     [${t.score}] ${t.clock} ${t.type}: ${t.reason}`);
  }

  console.log("\n4. The live round: result hidden in the table, present in the events");
  const live = scheduled[0];
  const liveCtx = await loadMatchContext(ds, live.id);
  if (liveCtx) {
    const s = computeStats(liveCtx);
    check(`${live.id} has a full set of events`, liveCtx.events.length > 1000 && liveCtx.complete);
    console.log(`     (replay will reveal ${s.score.home}-${s.score.away} as it plays)`);
  } else check("live match loads", false);

  console.log("\n5. Time travel: the same match as it stood at event 600");
  const early = await loadMatchContext(ds, finished[0].id, 600);
  if (early) {
    const s = computeStats(early);
    check("only events up to the cut are included", early.events.length === 600 && !early.complete, `${early.events.length} events, clock ${s.clock}`);
  }

  console.log("\n6. Streaming: first 40 events replayed at 600x");
  let n = 0;
  const t0 = Date.now();
  for await (const _ of ds.streamEvents(finished[0].id, { speed: 600 })) {
    if (++n >= 40) break;
  }
  check("stream delivers events", n === 40, `${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nCheck failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
