// src/lib/db/db.test.ts
// Run with:  npx tsx --test "src/**/*.test.ts"
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateLeague } from "../simulator/league";
import { simulateMatch } from "../simulator/match";
import * as m from "./mappers";
import { isNetworkError, withRetry } from "./retry";

const net = { error: { message: "TypeError: fetch failed" } };
const good = { error: null, data: [1] };

test("retry: recovers after dropped connections", async () => {
  let n = 0;
  const res = await withRetry("t", async () => (++n <= 3 ? net : good), { delayMs: 0, quiet: true });
  assert.equal(res.error, null);
  assert.equal(n, 4);
});

test("retry: recovers when fetch throws instead of returning an error", async () => {
  let n = 0;
  const res = await withRetry("t", async () => { if (++n <= 2) throw new TypeError("fetch failed"); return good; }, { delayMs: 0, quiet: true });
  assert.equal(res.error, null);
  assert.equal(n, 3);
});

test("retry: real database errors are not retried and keep their message", async () => {
  let n = 0;
  await assert.rejects(
    () => withRetry("save", async () => { n++; return { error: { message: 'duplicate key value violates unique constraint "x"' } }; }, { delayMs: 0, quiet: true }),
    /save failed: duplicate key/,
  );
  assert.equal(n, 1);
});

test("retry: gives up after the limit", async () => {
  let n = 0;
  await assert.rejects(() => withRetry("t", async () => { n++; return net; }, { tries: 4, delayMs: 0, quiet: true }), /after 4 tries/);
  assert.equal(n, 4);
});

test("retry: tells network errors from database errors", () => {
  for (const msg of ["TypeError: fetch failed", "read ECONNRESET", "connect ETIMEDOUT", "getaddrinfo ENOTFOUND x", "UND_ERR_CONNECT_TIMEOUT"]) assert.ok(isNetworkError(msg), msg);
  for (const msg of ["duplicate key value", "Could not find the table", "Invalid API key", "violates foreign key"]) assert.ok(!isNetworkError(msg), msg);
});

test("mappers: everything survives a trip through database rows unchanged", () => {
  const league = generateLeague(2026);
  const sim = simulateMatch(league, { matchId: "rt", homeTeamId: "t03", awayTeamId: "t09", seed: 99, round: 5 });
  const json = (v: unknown) => JSON.parse(JSON.stringify(v));
  const sorted = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));
  for (const t of league.teams) assert.equal(sorted(m.rowToTeam(m.teamToRow(t))), sorted(t));
  for (const p of league.players) assert.equal(sorted(m.rowToPlayer(m.playerToRow(p))), sorted(p));
  assert.equal(sorted(m.rowToMatch(m.matchToRow(sim.match))), sorted(sim.match));
  for (const l of sim.lineup) assert.equal(sorted(m.rowToLineup(m.lineupToRow(l))), sorted(l));
  for (const f of sim.fatigue) assert.equal(sorted(m.rowToFatigue(m.fatigueToRow(f))), sorted(f));
  for (const e of sim.events) assert.equal(sorted(json(m.rowToEvent(m.eventToRow(e)))), sorted(json(e)));
});

test("mappers: every event row has the same columns (needed for bulk inserts)", () => {
  const league = generateLeague(2026);
  const sim = simulateMatch(league, { matchId: "rt", homeTeamId: "t03", awayTeamId: "t09", seed: 99, round: 5 });
  const shapes = new Set(sim.events.map((e) => Object.keys(m.eventToRow(e)).sort().join(",")));
  assert.equal(shapes.size, 1);
  assert.ok(sim.events.every((e) => Object.values(m.eventToRow(e)).every((v) => v !== undefined)));
});
