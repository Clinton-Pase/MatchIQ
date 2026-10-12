// scripts/check-cache.ts
// Proves the report cache works against your real Supabase: the first request builds a report with the model and
// stores it, the second comes straight from the database with no model call.
// Needs the 0002_reports.sql migration to have been run, and SUPABASE_SERVICE_ROLE_KEY in .env.local.
//   npx tsx scripts/check-cache.ts
import { config } from "dotenv";
config({ path: ".env.local" });

import { getAnonClient, getServiceClient } from "../src/lib/db/client";
import { SupabaseDataSource } from "../src/lib/datasource/supabase";
import { BudgetedLLM, CallBudget } from "../src/lib/ai/budget";
import { chooseProvider, createLLM } from "../src/lib/ai/factory";
import { SupabaseReportStore } from "../src/lib/ai/report-cache";
import { ReportService } from "../src/lib/ai/service";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

async function main() {
  const service = getServiceClient();
  const ds = new SupabaseDataSource(getAnonClient());
  const budget = new CallBudget(Number(process.env.MATCHIQ_DAILY_CALL_CAP || 300));
  const llm = new BudgetedLLM(createLLM(), budget);
  const errors: string[] = [];
  const store = new SupabaseReportStore(service, (m) => errors.push(m));
  const svc = new ReportService(ds, store, llm, { log: (m) => console.log("  log:", m) });

  console.log(`Model: ${llm.name} (${chooseProvider()}), daily call budget left: ${budget.remaining}\n`);
  const match = (await ds.listMatches({ status: "finished" }))[1];   // a different match from check-ai, so the cache starts empty for it
  const req = { matchId: match.id, settings: { mode: "autopsy" as const, persona: "analyst" as const, language: "en" as const } };

  const t1 = Date.now();
  const first = await svc.get(req);
  const ms1 = Date.now() - t1;
  console.log(`First request:  ${(ms1 / 1000).toFixed(1)}s, cached=${first.cached}, degraded=${first.overlay.meta.degraded}, model calls=${first.overlay.meta.calls}`);

  const svc2 = new ReportService(ds, store, llm);   // a fresh service: nothing in its memory, only the database remembers
  const t2 = Date.now();
  const second = await svc2.get(req);
  const ms2 = Date.now() - t2;
  console.log(`Second request: ${(ms2 / 1000).toFixed(1)}s, cached=${second.cached}\n`);

  check("cache table is reachable (no read/write errors)", errors.length === 0, errors[0] ?? "");
  if (first.overlay.meta.degraded) {
    console.log("NOTE: the first report was degraded (model unavailable), so by design it was NOT stored.");
    check("degraded report was not stored", !second.cached);
  } else {
    check("second request came from the database", second.cached);
    check("it is the same report", JSON.stringify(second.overlay) === JSON.stringify(first.overlay));
    check("and it was much faster", ms2 < Math.max(3000, ms1 / 3), `${ms2}ms vs ${ms1}ms`);
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures) process.exit(1);
}
main().catch((e) => { console.error("\nCheck failed:", e instanceof Error ? e.message : e); process.exit(1); });
