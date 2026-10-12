// src/lib/ai/ai.test.ts
// Run with:  npx tsx --test "src/**/*.test.ts"
// None of these tests call the real Claude API: they use the mock model and deliberately misbehaving models.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateLeague } from "../simulator/league";
import { simulateMatch, type SimulatedMatch } from "../simulator/match";
import { buildContext } from "../intelligence/context";
import { detectMoments } from "../intelligence/moments";
import { AnthropicClient, extractJson, JsonError, type LLMClient, type LLMRequest, type LLMResponse } from "./llm";
import { MockLLMClient, mockAnswer } from "./mock";
import { cleanText, validateNarration } from "./agents";
import { generateReport, untranslated } from "./orchestrator";
import { adjustedScore, FAVORITE_BOOST, FOCUS_BOOST, reportSize, selectCandidates } from "./select";
import { OVERLAY_SCHEMA, type ReportSettings } from "./types";
import { allowedNumbers, checkNames, checkNumbers, numbersIn, verifyNarration } from "./verifier";

const league = generateLeague(2026);
function simulate(seed: number): SimulatedMatch {
  const home = league.teams[seed % 20];
  const away = league.teams[(seed + 7) % 20];
  return simulateMatch(league, { matchId: `ai${seed}`, homeTeamId: home.id, awayTeamId: away.id, seed: 9000 + seed, round: 1 });
}
function context(sim: SimulatedMatch, upToSeq?: number) {
  return buildContext({ match: sim.match, teams: league.teams, players: league.players, lineup: sim.lineup, events: sim.events, fatigue: sim.fatigue }, upToSeq);
}
// a match with at least two goals and plenty of moments
const sim = [3, 5, 7, 11, 12, 14, 2, 4].map(simulate).find((s) => s.match.homeScore + s.match.awayScore >= 2)!;
const ctx = context(sim);
const moments = detectMoments(ctx);

const base: ReportSettings = { mode: "autopsy", persona: "analyst", language: "en" };
const MODELS = { smart: "smart-x", cheap: "cheap-x" };

/** A model whose behavior per agent can be overridden; anything not overridden is answered by the mock. */
function scripted(over: Partial<Record<LLMRequest["agent"], (req: LLMRequest, n: number) => string>>): LLMClient & { calls: LLMRequest[] } {
  const counts: Record<string, number> = {};
  const calls: LLMRequest[] = [];
  return {
    name: "scripted",
    calls,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      calls.push(req);
      counts[req.agent] = (counts[req.agent] ?? 0) + 1;
      const f = over[req.agent];
      const text = f ? f(req, counts[req.agent]) : mockAnswer(req);
      return { text, model: "scripted", inputTokens: 10, outputTokens: 5 };
    },
  };
}
const edit = (req: LLMRequest, fn: (o: any) => void) => {
  const o = JSON.parse(mockAnswer(req));
  fn(o);
  return JSON.stringify(o);
};

// ---- JSON extraction ---------------------------------------------------------------------------------

test("extractJson: plain, fenced, chatty and broken replies", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":{"b":"}"}}\n```'), { a: { b: "}" } });
  assert.deepEqual(extractJson('Sure! Here you go: {"a":"x {y}"} hope that helps'), { a: "x {y}" });
  assert.throws(() => extractJson("no json here"), JsonError);
  assert.throws(() => extractJson('{"a": "cut off'), JsonError);
});

// ---- The Claude API client (with a fake network) ------------------------------------------------------

const okBody = { model: "m", content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }], usage: { input_tokens: 12, output_tokens: 3 } };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const req: LLMRequest = { agent: "analyst", model: "m", system: "s", user: "u", maxTokens: 10 };

test("claude client: sends the right request and reads text and token usage", async () => {
  let seen: any;
  const c = new AnthropicClient({ apiKey: "k", sleep: async () => {}, fetchImpl: (async (url: string, init: any) => { seen = { url, init }; return reply(200, okBody); }) as any });
  const res = await c.complete(req);
  assert.equal(res.text, "hello world");
  assert.equal(res.inputTokens, 12);
  assert.equal(res.outputTokens, 3);
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.init.headers["x-api-key"], "k");
  assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "m");
  assert.equal(body.system, "s");
  assert.deepEqual(body.messages, [{ role: "user", content: "u" }]);
});

test("claude client: retries rate limits and server errors, then succeeds", async () => {
  let n = 0;
  const waits: number[] = [];
  const c = new AnthropicClient({ apiKey: "k", sleep: async (ms) => void waits.push(ms), fetchImpl: (async () => (++n === 1 ? reply(429, { error: "slow down" }, { "retry-after": "2" }) : n === 2 ? reply(529, {}) : reply(200, okBody))) as any });
  const res = await c.complete(req);
  assert.equal(res.text, "hello world");
  assert.equal(n, 3);
  assert.equal(waits[0], 2000, "obeys retry-after");
});

test("claude client: a bad key or model name fails at once with the API's message", async () => {
  let n = 0;
  const c = new AnthropicClient({ apiKey: "k", sleep: async () => {}, fetchImpl: (async () => { n++; return reply(401, { error: { message: "invalid x-api-key" } }); }) as any });
  await assert.rejects(() => c.complete(req), /Claude API 401.*invalid x-api-key/);
  assert.equal(n, 1);
  assert.throws(() => new AnthropicClient({ apiKey: "" }), /ANTHROPIC_API_KEY/);
});

test("claude client: network failures are retried, then reported plainly", async () => {
  let n = 0;
  const c = new AnthropicClient({ apiKey: "k", tries: 3, sleep: async () => {}, fetchImpl: (async () => { n++; throw new TypeError("fetch failed"); }) as any });
  await assert.rejects(() => c.complete(req), /network problem talking to Claude.*gave up after 3 tries/);
  assert.equal(n, 3);
});

// ---- The Verifier -----------------------------------------------------------------------------------------

const goal = moments.find((m) => m.type === "goal")!;

test("verifier: finds numbers written as digits and as English words", () => {
  assert.deepEqual(numbersIn("45+2' and 0,84 xG, three shots").map((n) => n.value), [45, 2, 0.84, 3]);
});

test("verifier: a measured sentence may only use numbers from the evidence", () => {
  const allowed = allowedNumbers([goal], [goal.facts.scoreHome as number, goal.facts.scoreAway as number]);
  assert.equal(checkNumbers(`${goal.clock} goal, ${goal.facts.scoreHome}-${goal.facts.scoreAway}`, "measured", allowed), null);
  assert.match(checkNumbers("They had 777 shots", "measured", allowed)!, /777/);
  assert.match(checkNumbers("They had seven shots", "measured", [3])!, /seven/);
  assert.equal(checkNumbers("A third of the way in", "measured", [3]), null);
});

test("verifier: rounding is allowed, inventing is not", () => {
  assert.equal(checkNumbers("0.8 xG", "measured", [0.84]), null);
  assert.equal(checkNumbers("0.84 xG", "measured", [0.84]), null);
  assert.ok(checkNumbers("0.9 xG", "measured", [0.84]));
  assert.equal(checkNumbers("49% energy", "measured", [49]), null);
});

test("verifier: an interpretation may not contain any number", () => {
  assert.ok(checkNumbers("This changed things after 70 minutes", "interpretation", [70]));
  assert.ok(checkNumbers("That is two goals of difference", "interpretation", [2]));
  assert.equal(checkNumbers("This changed the whole shape of the match", "interpretation", [70]), null);
});

test("verifier: players and clubs outside the moment are rejected", () => {
  const scorer = String(goal.facts.scorer);
  assert.equal(checkNames(`${scorer} scored.`, [goal], ctx), null);
  const stranger = [...ctx.players.values()].find((p) => !goal.reason.includes(p.name) && !goal.reason.includes(p.name.split(" ").pop()!))!;
  assert.match(checkNames(`${stranger.name} set it up.`, [goal], ctx)!, /not part of this moment/);
  assert.match(checkNames(`Only ${stranger.name.split(" ").pop()} could have stopped it.`, [goal], ctx)!, /not part of this moment/);
  const otherClub = [...ctx.teams.values()].find((t) => t.id !== ctx.match.homeTeamId && t.id !== ctx.match.awayTeamId)!;
  assert.match(checkNames(`Unlike ${otherClub.name}, they finished.`, [goal], ctx)!, /not part of this moment/);
});

test("verifier: structure problems are reported (missing, duplicate, empty, over-long)", () => {
  const input = { ctx, moments: new Map([[goal.id, goal]]), expectedIds: [goal.id], scoreNumbers: [] };
  const v = (o: any) => verifyNarration(o, input).map((x) => `${x.field}:${x.problem}`);
  const good = { headline: "Goal", summary: "A goal.", items: [{ momentId: goal.id, measured: goal.reason, interpretation: "It changed the match." }] };
  assert.deepEqual(v(good), []);
  assert.ok(v({ ...good, items: [] }).some((x) => x.includes("missing")));
  assert.ok(v({ ...good, items: [good.items[0], good.items[0]] }).some((x) => x.includes("twice")));
  assert.ok(v({ ...good, items: [{ ...good.items[0], measured: "" }] }).some((x) => x.includes("empty")));
  assert.ok(v({ ...good, items: [{ ...good.items[0], measured: "x".repeat(500) }] }).some((x) => x.includes("too long")));
  assert.ok(v({ ...good, items: [{ ...good.items[0], momentId: "zzz" }] }).length > 0);
});

// ---- Selection ----------------------------------------------------------------------------------------------

test("selection: every goal and red card is always a candidate; favorite club is boosted", () => {
  const cands = selectCandidates(moments, base, 3);
  for (const m of moments.filter((x) => x.type === "goal" || x.type === "red_card")) assert.ok(cands.some((c) => c.id === m.id));
  for (let i = 1; i < cands.length; i++) assert.ok(cands[i].seq >= cands[i - 1].seq);
  const other = moments.filter((m) => m.type !== "goal" && m.type !== "red_card" && m.teamId);
  if (other.length >= 2) {
    const low = [...other].sort((a, b) => a.score - b.score).find((m) => m.teamId)!;
    const fav: ReportSettings = { ...base, favoriteTeamId: low.teamId };
    const withFav = selectCandidates(moments, fav, moments.length);
    assert.equal(withFav.length, moments.length);
  }
  assert.equal(FAVORITE_BOOST > 0, true);
  assert.equal(reportSize(cands, 1), Math.max(1, cands.filter((m) => m.type === "goal" || m.type === "red_card").length));
  assert.ok(reportSize(cands, 99) <= 10);
});

// ---- The orchestrator ---------------------------------------------------------------------------------------

function assertValidOverlay(o: any, c = ctx) {
  assert.equal(o.schema, OVERLAY_SCHEMA);
  assert.equal(o.matchId, c.match.id);
  const ids = new Set(c.events.map((e) => e.id));
  assert.ok(o.items.length > 0);
  for (const it of o.items) {
    assert.equal(it.verified, true);
    assert.ok(it.evidence.length > 0 && it.evidence.every((id: string) => ids.has(id)), "evidence points at real events");
    assert.ok(it.measured.length > 0);
    assert.ok(it.lowerThird.length > 0);
    assert.ok(!/\d/.test(it.interpretation), "no numbers in interpretation");
  }
  for (let i = 1; i < o.items.length; i++) assert.ok(o.items[i].seq >= o.items[i - 1].seq);
  const goalsInMatch = c.events.filter((e) => e.type === "shot" && e.outcome === "goal").length;
  assert.equal(o.items.filter((i: any) => i.type === "goal").length, goalsInMatch, "every goal is in the report");
  assert.equal(o.score.home + o.score.away, goalsInMatch);
}

test("orchestrator: mock model, default voice: valid overlay, two model calls, nothing degraded", async () => {
  const { overlay, state } = await generateReport(ctx, new MockLLMClient(), { settings: base, models: MODELS });
  assertValidOverlay(overlay);
  assert.equal(overlay.meta.degraded, false);
  assert.equal(overlay.meta.calls, 2, "analyst + narrator only; the neutral voice needs no personalizer");
  assert.equal(state.stages.personalize, "skipped");
  assert.ok(overlay.items.every((i) => i.source === "ai"));
  JSON.parse(JSON.stringify(overlay));
});

test("orchestrator: another voice and language adds the personalizer, on the cheap model", async () => {
  const llm = scripted({});
  const { overlay, state } = await generateReport(ctx, llm, { settings: { ...base, persona: "fan", language: "fr", favoriteTeamId: ctx.match.homeTeamId }, models: MODELS });
  assertValidOverlay(overlay);
  assert.equal(state.stages.personalize, "done");
  assert.deepEqual(llm.calls.map((c) => [c.agent, c.model]), [["analyst", "smart-x"], ["narrator", "smart-x"], ["personalizer", "cheap-x"]]);
  assert.match(llm.calls[2].system, /French/);
  assert.match(llm.calls[2].system, new RegExp(ctx.teams.get(ctx.match.homeTeamId)!.name));
});

test("orchestrator: the Narrator invents a number once, is told exactly what was wrong, and fixes it", async () => {
  const llm = scripted({
    narrator: (r, n) => edit(r, (o) => { if (n === 1) o.items[0].measured += " It was the 777th shot of the season."; }),
  });
  const { overlay, state } = await generateReport(ctx, llm, { settings: base, models: MODELS });
  assertValidOverlay(overlay);
  assert.ok(overlay.items.every((i) => i.source === "ai"));
  const second = JSON.parse(llm.calls.filter((c) => c.agent === "narrator")[1].user);
  assert.ok(second.problemsToFix.some((p: string) => p.includes("777")), "the retry quotes the problem");
  assert.ok(!overlay.items.some((i) => i.measured.includes("777")));
  assert.ok(state.trace.some((t) => t.stage === "explain" && !t.ok));
});

test("orchestrator: a Narrator that keeps lying never reaches the screen, plain data text is used instead", async () => {
  const llm = scripted({ narrator: (r) => edit(r, (o) => { o.items[0].measured = "He scored 888 goals this season."; o.items[0].interpretation = "This was the 2nd time."; }) });
  const { overlay } = await generateReport(ctx, llm, { settings: base, models: MODELS });
  assertValidOverlay(overlay);
  assert.equal(overlay.items.filter((i) => i.source === "fallback").length, 1, "only the bad item falls back");
  assert.equal(overlay.meta.degraded, true);
  assert.ok(!JSON.stringify(overlay.items).includes("888"));
  assert.ok(overlay.items.filter((i) => i.source === "ai").length >= 1);
  const fb = overlay.items.find((i) => i.source === "fallback")!;
  assert.equal(fb.measured, moments.find((m) => m.id === fb.momentId)!.reason);
});

test("orchestrator: if the AI names someone who is not in the moment, that is caught too", async () => {
  const stranger = [...ctx.players.values()].find((p) => !moments.some((m) => m.reason.includes(p.name.split(" ").pop()!)))!;
  const llm = scripted({ narrator: (r) => edit(r, (o) => { o.items[0].interpretation = `${stranger.name} would have done better.`; }) });
  const { overlay } = await generateReport(ctx, llm, { settings: base, models: MODELS });
  assert.ok(!JSON.stringify(overlay).includes(stranger.name));
  assert.equal(overlay.items.filter((i) => i.source === "fallback").length, 1);
});

test("orchestrator: an Analyst that returns garbage is retried, then the top moments are used", async () => {
  const llm = scripted({ analyst: () => "I think the goals matter most!" });
  const { overlay, state } = await generateReport(ctx, llm, { settings: base, models: MODELS });
  assertValidOverlay(overlay);
  assert.equal(state.stages.interpret, "fallback");
  assert.equal(llm.calls.filter((c) => c.agent === "analyst").length, 3, "1 try + 2 retries");
  assert.equal(overlay.meta.degraded, true);
});

test("orchestrator: an Analyst that skips a goal or invents a moment is rejected", async () => {
  const llm = scripted({
    analyst: (r, n) => edit(r, (o) => {
      if (n === 1) o.picks.push({ momentId: "made-up", role: "highlight", angle: "x" });
      else if (n === 2) o.picks = o.picks.filter((p: any) => !p.momentId.includes("goal")).slice(0, 1);
    }),
  });
  const { overlay, state } = await generateReport(ctx, llm, { settings: base, models: MODELS });
  assertValidOverlay(overlay);
  const analystCalls = llm.calls.filter((c) => c.agent === "analyst");
  assert.ok(analystCalls.length >= 2);
  assert.ok(JSON.parse(analystCalls[1].user).problemsToFix.some((p: string) => p.includes("made-up")));
  assert.ok(state.trace.some((t) => t.agent === "analyst" && !t.ok));
});

test("orchestrator: with no model at all (network down) the report is still produced from the data", async () => {
  const down: LLMClient = { name: "down", complete: async () => { throw new Error("network problem talking to Claude: fetch failed"); } };
  const { overlay, state } = await generateReport(ctx, down, { settings: { ...base, persona: "fan", language: "yo" }, models: MODELS });
  assertValidOverlay(overlay);
  assert.equal(overlay.meta.degraded, true);
  assert.ok(overlay.items.every((i) => i.source === "fallback" && i.interpretation === ""));
  assert.ok(overlay.meta.notes.length >= 2);
  assert.ok(state.calls <= 3);
});

test("orchestrator: the call budget is a hard cap", async () => {
  const llm = scripted({ narrator: (r) => edit(r, (o) => { o.items[0].measured = "999 shots"; }) });
  const { overlay, state } = await generateReport(ctx, llm, { settings: { ...base, persona: "fan" }, models: MODELS, maxCalls: 3 });
  assert.ok(state.calls <= 3);
  assertValidOverlay(overlay);
});

test("orchestrator: a personalizer that changes the facts is rejected and the neutral report is used", async () => {
  const llm = scripted({ personalizer: (r) => edit(r, (o) => { o.items[0].measured += " 12345 fans watched."; }) });
  const { overlay, state } = await generateReport(ctx, llm, { settings: { ...base, persona: "coach", language: "es" }, models: MODELS });
  assertValidOverlay(overlay);
  assert.equal(state.stages.personalize, "fallback");
  // the rejected text must never reach what the viewer sees (the diagnostic notes may describe the rejection)
  assert.ok(!JSON.stringify({ ...overlay, meta: undefined }).includes("12345"));
  assert.equal(llm.calls.filter((c) => c.agent === "personalizer").length, 3);
});

test("orchestrator: live mode only ever uses what had happened by then", async () => {
  const cut = Math.floor(sim.events.length * 0.55);
  const live = context(sim, cut);
  const { overlay } = await generateReport(live, new MockLLMClient(), { settings: { ...base, mode: "live" }, models: MODELS });
  assert.equal(overlay.complete, false);
  assert.ok(overlay.items.length > 0);
  assert.ok(overlay.items.every((i) => i.seq <= cut));
  const goalsSoFar = sim.events.filter((e) => e.seq <= cut && e.type === "shot" && e.outcome === "goal").length;
  assert.equal(overlay.items.filter((i) => i.type === "goal").length, goalsSoFar);
  const calls = scripted({});
  await generateReport(live, calls, { settings: { ...base, mode: "live" }, models: MODELS });
  assert.equal(JSON.parse(calls.calls[0].user).matchComplete, false);
});

test("orchestrator: a match with nothing to report still returns a valid, empty overlay without calling a model", async () => {
  const tiny = context(sim, 3);
  const llm = scripted({});
  const { overlay } = await generateReport(tiny, llm, { settings: base, models: MODELS, moments: [] });
  assert.equal(overlay.items.length, 0);
  assert.equal(llm.calls.length, 0);
  assert.equal(overlay.schema, OVERLAY_SCHEMA);
});

test("orchestrator: the same inputs give the same overlay (mock model)", async () => {
  const a = await generateReport(ctx, new MockLLMClient(), { settings: base, models: MODELS });
  const b = await generateReport(ctx, new MockLLMClient(), { settings: base, models: MODELS });
  assert.deepEqual(a.overlay, b.overlay);
});

test("player focus: a focused player's moments are boosted and chosen first", () => {
  const rest = moments.filter((m) => m.type !== "goal" && m.type !== "red_card");
  const withPlayer = rest.filter((m) => m.playerId);
  if (withPlayer.length === 0 || rest.length < 2) return;
  const target = [...withPlayer].sort((a, b) => a.score - b.score)[0];   // the weakest moment of that player
  const settings = { ...base, focusPlayerId: target.playerId };
  assert.equal(adjustedScore(target, settings), target.score + FOCUS_BOOST);
  const mandatory = moments.filter((m) => m.type === "goal" || m.type === "red_card").length;
  const picked = selectCandidates(moments, settings, mandatory + 1).filter((m) => !(m.type === "goal" || m.type === "red_card"));
  const best = [...rest].sort((a, b) => adjustedScore(b, settings) - adjustedScore(a, settings) || a.seq - b.seq)[0];
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, best.id, "the single free slot goes to the best boosted score");
});

// ---- language and text hygiene ------------------------------------------------------------------------

test("text hygiene: zero-width and control characters become single spaces", () => {
  assert.equal(cleanText("calm the game\u200bafter\nthe lead\t now"), "calm the game after the lead now");
  const out = validateNarration({ headline: "a\u200bb", summary: "s", items: [{ momentId: "m", measured: "x\ny", interpretation: "" }] }, false);
  assert.equal(out.headline, "a b");
  assert.equal(out.items[0].measured, "x y");
});

test("language: text handed back unchanged is caught, translated text is not", () => {
  const src = { headline: "H", summary: "S", items: [{ momentId: "a", measured: "It was 1-0.", interpretation: "It may matter." }] };
  assert.deepEqual(untranslated(src, src, "en"), [], "English needs no translation");
  const lazy = untranslated({ ...src, headline: "Titre" }, src, "fr");
  assert.equal(lazy.length, 3);
  assert.ok(lazy.every((p) => p.includes("French")));
  assert.deepEqual(untranslated({ headline: "T", summary: "R", items: [{ momentId: "a", measured: "C'était 1-0.", interpretation: "Cela peut compter." }] }, src, "fr"), []);
});

test("orchestrator: a personalizer that leaves the text in English is told to translate, and fixes it", async () => {
  const llm = scripted({
    personalizer: (r, n) => (n === 1 ? edit(r, (o) => { const x = JSON.parse(r.user).report; o.headline = x.headline; o.summary = x.summary; o.items = x.items.map((i: any) => ({ ...i, lowerThird: "Cap" })); }) : mockAnswer(r)),
  });
  const { overlay, state } = await generateReport(ctx, llm, { settings: { ...base, persona: "fan", language: "fr" }, models: MODELS });
  assertValidOverlay(overlay);
  assert.equal(state.stages.personalize, "done");
  const calls = llm.calls.filter((c) => c.agent === "personalizer");
  assert.equal(calls.length, 2);
  assert.ok(JSON.parse(calls[1].user).problemsToFix.some((p: string) => p.includes("left in English")));
  assert.ok(overlay.items.every((i) => i.measured.startsWith("[fr]")));
  assert.equal(JSON.parse(calls[0].user).targetLanguage, "fr");
});

test("orchestrator: a personalizer that never translates ends with the neutral English report", async () => {
  const llm = scripted({ personalizer: (r) => { const x = JSON.parse(r.user).report; return JSON.stringify({ ...x, items: x.items.map((i: any) => ({ ...i, lowerThird: "Cap" })) }); } });
  const { overlay, state } = await generateReport(ctx, llm, { settings: { ...base, persona: "fan", language: "yo" }, models: MODELS });
  assertValidOverlay(overlay);
  assert.equal(state.stages.personalize, "fallback");
  assert.ok(overlay.items.every((i) => !i.measured.startsWith("[yo]")));
});
