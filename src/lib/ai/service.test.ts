// src/lib/ai/service.test.ts
// Run with:  npx tsx --test "src/**/*.test.ts"
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryDataSource } from "../datasource/memory";
import { generateLeague } from "../simulator/league";
import { simulateMatch } from "../simulator/match";
import { BudgetedLLM, BudgetExhaustedError, CallBudget, RateLimiter } from "./budget";
import type { LLMClient, LLMRequest, LLMResponse } from "./llm";
import { MockLLMClient } from "./mock";
import { bucketSeq, MemoryReportStore, reportKey } from "./report-cache";
import { ReportService, RequestError } from "./service";
import type { ReportSettings } from "./types";

const league = generateLeague(2026);
const sim = simulateMatch(league, { matchId: "svc1", homeTeamId: "t01", awayTeamId: "t02", seed: 77, round: 1 });
const liveSim = simulateMatch(league, { matchId: "svc2", homeTeamId: "t03", awayTeamId: "t04", seed: 78, round: 11 });
liveSim.match.status = "scheduled";
const ds = new MemoryDataSource(league, [sim, liveSim]);
const MODELS = { smart: "s", cheap: "c" };
const base: ReportSettings = { mode: "autopsy", persona: "analyst", language: "en" };

function counting(inner: LLMClient = new MockLLMClient()): LLMClient & { n: number } {
  const c = { name: inner.name, n: 0, async complete(r: LLMRequest): Promise<LLMResponse> { c.n++; return inner.complete(r); } };
  return c;
}
const down: LLMClient = { name: "down", complete: async () => { throw new Error("network problem talking to x: fetch failed"); } };
const svc = (llm: LLMClient, store = new MemoryReportStore(), o = {}) => ({ store, service: new ReportService(ds, store, llm, { models: MODELS, ...o }) });

test("cache: the second identical request is served from the store with no model call", async () => {
  const llm = counting();
  const { service, store } = svc(llm);
  const a = await service.get({ matchId: "svc1", settings: base });
  const callsAfterFirst = llm.n;
  assert.ok(callsAfterFirst >= 2);
  assert.equal(a.cached, false);
  const b = await service.get({ matchId: "svc1", settings: base });
  assert.equal(b.cached, true);
  assert.equal(llm.n, callsAfterFirst);
  assert.deepEqual(b.overlay, a.overlay);
  assert.equal(store.map.size, 1);
});

test("cache: different viewers get different reports, and a different model never reuses another model's report", async () => {
  const { service, store } = svc(counting());
  await service.get({ matchId: "svc1", settings: base });
  await service.get({ matchId: "svc1", settings: { ...base, persona: "fan", language: "fr" } });
  await service.get({ matchId: "svc1", settings: { ...base, favoriteTeamId: "t01" } });
  assert.equal(store.map.size, 3);
  const other = new ReportService(ds, store, new MockLLMClient(), { models: { smart: "other", cheap: "c" } });
  const r = await other.get({ matchId: "svc1", settings: base });
  assert.equal(r.cached, false, "a different model name is a different key");
  assert.equal(store.map.size, 4);
});

test("in-flight: ten identical requests at once cost one report", async () => {
  const llm = counting();
  const { service } = svc(llm);
  const results = await Promise.all(Array.from({ length: 10 }, () => service.get({ matchId: "svc1", settings: base })));
  assert.equal(new Set(results.map((r) => JSON.stringify(r.overlay))).size, 1);
  const single = counting();
  await svc(single).service.get({ matchId: "svc1", settings: base });
  assert.equal(llm.n, single.n);
});

test("failures: a degraded report is not stored, and the models are not hammered during the cooldown", async () => {
  let now = 1_000_000;
  const llm = counting(down);
  const { service, store } = svc(llm, new MemoryReportStore(), { now: () => now, failureCooldownMs: 60_000 });
  const a = await service.get({ matchId: "svc1", settings: base });
  assert.equal(a.overlay.meta.degraded, true);
  assert.equal(store.map.size, 0, "a fallback report must not be remembered as the real thing");
  const calls = llm.n;
  await service.get({ matchId: "svc1", settings: base });
  assert.equal(llm.n, calls, "inside the cooldown no new calls are made");
  now += 61_000;
  await service.get({ matchId: "svc1", settings: base });
  assert.ok(llm.n > calls, "after the cooldown it tries again");
});

test("modes: autopsy only for finished matches, halftime stops at the break, live needs a cut-off", async () => {
  const { service } = svc(new MockLLMClient());
  await assert.rejects(() => service.get({ matchId: "svc2", settings: base }), (e: unknown) => e instanceof RequestError && /finished/.test(e.message));
  const ht = await service.get({ matchId: "svc1", settings: { ...base, mode: "halftime" } });
  const htSeq = sim.events.find((e) => e.type === "half_time")!.seq;
  assert.equal(ht.overlay.complete, false);
  assert.ok(ht.overlay.items.every((i) => i.seq <= htSeq));
  await assert.rejects(() => service.get({ matchId: "svc1", settings: { ...base, mode: "live" } }), /upToSeq/);
  const live = await service.get({ matchId: "svc2", settings: { ...base, mode: "live" }, upToSeq: 700 });
  assert.ok(live.overlay.items.every((i) => i.seq <= 600), "the cut is bucketed down, never up");
  assert.equal(live.overlay.complete, false);
});

test("live buckets: nearby cut-offs share one report", async () => {
  const llm = counting();
  const { service, store } = svc(llm);
  await service.get({ matchId: "svc2", settings: { ...base, mode: "live" }, upToSeq: 610 });
  const calls = llm.n;
  const again = await service.get({ matchId: "svc2", settings: { ...base, mode: "live" }, upToSeq: 740 });
  assert.equal(again.cached, true);
  assert.equal(llm.n, calls);
  assert.equal(store.map.size, 1);
  assert.equal(bucketSeq(5, 150), 150);
  assert.equal(bucketSeq(449, 150), 300);
  assert.equal(bucketSeq(450, 150), 450);
  assert.equal(bucketSeq(7.9, 1), 7);
});

test("validation: bad input is refused with a clear message and never reaches the models", async () => {
  const llm = counting();
  const { service } = svc(llm);
  const bad: [any, RegExp][] = [
    [{ matchId: "svc1", settings: { ...base, persona: "robot" } }, /persona/],
    [{ matchId: "svc1", settings: { ...base, language: "xx" } }, /language/],
    [{ matchId: "svc1", settings: { ...base, mode: "everything" } }, /mode/],
    [{ matchId: "../etc", settings: base }, /invalid match id/],
    [{ matchId: "nope", settings: base }, /not found/],
  ];
  for (const [req, re] of bad) await assert.rejects(() => service.get(req), re);
  assert.equal(llm.n, 0);
  await assert.rejects(() => service.get({ matchId: "nope", settings: base }), (e: unknown) => e instanceof RequestError && e.status === 404);
});

test("keys: every setting that changes the report changes the key", () => {
  const k = (s: Partial<ReportSettings>, seq?: number) => reportKey("m", { ...base, ...s }, seq, "x");
  const keys = [k({}), k({ persona: "fan" }), k({ language: "fr" }), k({ favoriteTeamId: "t1" }), k({ focusPlayerId: "p1" }), k({ mode: "live" }, 150), k({ mode: "live" }, 300), reportKey("m", base, undefined, "y")];
  assert.equal(new Set(keys).size, keys.length);
});

test("budget: a hard daily cap on model calls, reset each day, and reports still come out from the data", async () => {
  let now = Date.parse("2026-10-12T10:00:00Z");
  const budget = new CallBudget(3, () => now);
  const llm = new BudgetedLLM(counting(), budget);
  const r = { agent: "analyst", model: "m", system: "", user: "{}", maxTokens: 1 } as LLMRequest;
  for (let i = 0; i < 3; i++) await llm.complete({ ...r, agent: "ask" }).catch(() => {});
  assert.equal(budget.remaining, 0);
  await assert.rejects(() => llm.complete(r), BudgetExhaustedError);
  now = Date.parse("2026-10-13T00:00:01Z");
  assert.equal(budget.remaining, 3);

  const capped = new BudgetedLLM(new MockLLMClient(), new CallBudget(1));
  const { service } = svc(capped);
  const out = await service.get({ matchId: "svc1", settings: base });
  assert.equal(out.overlay.meta.degraded, true);
  assert.ok(out.overlay.items.length > 0 && out.overlay.items.every((i) => i.verified));
});

test("rate limiter: a visitor gets N requests per window, others are unaffected", () => {
  let now = 0;
  const rl = new RateLimiter(3, 1000, () => now);
  assert.deepEqual([1, 2, 3, 4].map(() => rl.allow("a")), [true, true, true, false]);
  assert.equal(rl.allow("b"), true);
  now = 1001;
  assert.equal(rl.allow("a"), true);
});
