// scripts/check-ai.ts
// Runs the whole AI pipeline on one match and prints the result.
//   npx tsx scripts/check-ai.ts                      uses the model set in .env.local (Claude, or a free OpenAI-compatible one), else the offline mock
//   npx tsx scripts/check-ai.ts --mock               force the offline mock (free, no key needed)
//   npx tsx scripts/check-ai.ts --cut=900            live mode: the match as it stood after event 900
//   npx tsx scripts/check-ai.ts --persona=fan --lang=fr --fav=home
//   npx tsx scripts/check-ai.ts --match=<id>         a specific match (default: the first finished one)
//   npx tsx scripts/check-ai.ts --json               print the overlay JSON only

import { config } from "dotenv";
config({ path: ".env.local" });

import { getAnonClient } from "../src/lib/db/client";
import { SupabaseDataSource } from "../src/lib/datasource/supabase";
import { loadMatchContext } from "../src/lib/intelligence/context";
import { modelConfigFromEnv, type LLMClient } from "../src/lib/ai/llm";
import { chooseProvider, createLLM } from "../src/lib/ai/factory";
import { MockLLMClient } from "../src/lib/ai/mock";
import { generateReport } from "../src/lib/ai/orchestrator";
import { LANGUAGES, PERSONAS, type Language, type Persona } from "../src/lib/ai/types";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const persona = (arg("persona") ?? "analyst") as Persona;
  const language = (arg("lang") ?? "en") as Language;
  if (!PERSONAS.includes(persona)) throw new Error(`--persona must be one of: ${PERSONAS.join(", ")}`);
  if (!(language in LANGUAGES)) throw new Error(`--lang must be one of: ${Object.keys(LANGUAGES).join(", ")}`);

  const ds = new SupabaseDataSource(getAnonClient());
  const matchId = arg("match") ?? (await ds.listMatches({ status: "finished" }))[0].id;
  const cut = arg("cut") ? Number(arg("cut")) : undefined;
  const ctx = await loadMatchContext(ds, matchId, cut);
  if (!ctx) throw new Error(`match ${matchId} not found`);

  const useMock = flag("mock") || chooseProvider() === "mock";
  const llm: LLMClient = useMock ? new MockLLMClient() : createLLM();
  const fav = arg("fav") === "home" ? ctx.match.homeTeamId : arg("fav") === "away" ? ctx.match.awayTeamId : undefined;
  if (!flag("json")) {
    console.log(`Match ${matchId}${cut ? ` after event ${cut} (live)` : ""} | model: ${llm.name}${useMock && !flag("mock") ? "  (no model key found in .env.local, using the offline mock)" : ""}`);
    if (!useMock) console.log(`Models: ${JSON.stringify(modelConfigFromEnv())}`);
  }

  const t0 = Date.now();
  const { overlay, state } = await generateReport(ctx, llm, {
    settings: { mode: cut ? "live" : "autopsy", persona, language, favoriteTeamId: fav },
  });
  if (flag("json")) { console.log(JSON.stringify(overlay, null, 2)); return; }

  console.log(`\n${overlay.score.homeTeam} ${overlay.score.home}-${overlay.score.away} ${overlay.score.awayTeam}  at ${overlay.clock}${overlay.complete ? " (full time)" : ""}`);
  console.log(`\n${overlay.headline}\n${overlay.summary}\nStory: ${overlay.storyline || "(none)"}\n`);
  for (const it of overlay.items) {
    console.log(`${it.clock.padEnd(7)} [${it.role}] ${it.type}  (${it.source}, ${it.evidence.length} evidence events)`);
    console.log(`        ${it.lowerThird}`);
    console.log(`        MEASURED:       ${it.measured}`);
    if (it.interpretation) console.log(`        INTERPRETATION: ${it.interpretation}`);
  }
  console.log(`\nStages: ${JSON.stringify(state.stages)}`);
  console.log(`Model calls: ${state.calls}, tokens in/out: ${state.inputTokens}/${state.outputTokens}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const n of overlay.meta.notes) console.log(`NOTE: ${n}`);
  console.log(overlay.meta.degraded ? "\nDegraded: some text fell back to plain data." : "\nAll text passed the Verifier.");
}

main().catch((e) => { console.error("\nCheck failed:", e instanceof Error ? e.message : e); process.exit(1); });
