// src/lib/datasource/datasource.test.ts
// Run with:  npx tsx --test "src/**/*.test.ts"
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAllPages } from "../db/paginate";
import { generateLeague } from "../simulator/league";
import { simulateMatch } from "../simulator/match";
import { MemoryDataSource } from "./memory";
import { replayDelayMs, replayEvents } from "./replay";
import type { MatchEvent } from "./types";

const league = generateLeague(2026);
const sim1 = simulateMatch(league, { matchId: "a1", homeTeamId: "t01", awayTeamId: "t02", seed: 1, round: 1 });
const sim2 = simulateMatch(league, { matchId: "a2", homeTeamId: "t03", awayTeamId: "t01", seed: 2, round: 2 });
const ds = new MemoryDataSource(league, [sim2, sim1]);

const ev = (period: 1 | 2, minute: number, second: number, seq: number): MatchEvent =>
  ({ id: `e${seq}`, matchId: "m", seq, period, minute, second, type: "pass", teamId: "t01", x: 50, y: 50 });

test("replay: delay follows the match clock and the speed", () => {
  assert.equal(replayDelayMs(ev(1, 10, 0, 1), ev(1, 10, 10, 2), 1), 4000, "capped at 4s");
  assert.equal(replayDelayMs(ev(1, 10, 0, 1), ev(1, 10, 3, 2), 1), 3000);
  assert.equal(replayDelayMs(ev(1, 10, 0, 1), ev(1, 10, 3, 2), 10), 300);
  assert.equal(replayDelayMs(ev(1, 10, 0, 1), ev(1, 10, 3, 2), 0), 0, "speed 0 means instant");
  assert.equal(replayDelayMs(ev(1, 10, 0, 1), ev(1, 10, 3, 2), Infinity), 0);
  assert.equal(replayDelayMs(ev(1, 47, 0, 1), ev(2, 45, 0, 2), 1), 0, "no waiting at half-time");
  assert.equal(replayDelayMs(ev(2, 50, 0, 1), ev(2, 50, 0, 2), 1), 0);
});

test("replay: yields every event in order and waits the right total time", async () => {
  const waits: number[] = [];
  const out: number[] = [];
  for await (const e of replayEvents(sim1.events.slice(0, 200), { speed: 30, sleep: async (ms) => void waits.push(ms) })) out.push(e.seq);
  assert.deepEqual(out, sim1.events.slice(0, 200).map((e) => e.seq));
  assert.ok(waits.length > 0 && waits.every((w) => w > 0 && w <= 4000));
});

test("replay: aborting stops the stream", async () => {
  const controller = new AbortController();
  let n = 0;
  for await (const _ of replayEvents(sim1.events, { speed: 0, signal: controller.signal })) {
    n++;
    if (n === 10) controller.abort();
  }
  assert.equal(n, 10);
});

test("memory source: lists, filters and ranges", async () => {
  assert.equal((await ds.listMatches()).length, 2);
  assert.deepEqual((await ds.listMatches({ teamId: "t01" })).map((m) => m.id), ["a1", "a2"]);
  assert.equal((await ds.listMatches({ teamId: "t02" })).length, 1);
  assert.equal(await ds.getMatch("nope"), null);
  assert.equal((await ds.getTeams()).length, 20);
  assert.equal((await ds.getPlayers("t01")).length, 23);
  assert.equal((await ds.getLineup("a1")).filter((l) => l.role === "starter").length, 22);
  const part = await ds.getEvents("a1", { fromSeq: 10, toSeq: 19 });
  assert.deepEqual(part.map((e) => e.seq), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal((await ds.getEvents("a1")).length, sim1.events.length);
});

test("memory source: streamEvents replays the whole match", async () => {
  let n = 0;
  for await (const _ of ds.streamEvents("a1", { speed: 0 })) n++;
  assert.equal(n, sim1.events.length);
});

test("pagination: reads every page, including exact multiples of the page size", async () => {
  for (const total of [0, 1, 999, 1000, 1001, 2500, 3000]) {
    const rows = Array.from({ length: total }, (_, i) => i);
    let calls = 0;
    const got = await fetchAllPages<number>(async (from, to) => {
      calls++;
      return { data: rows.slice(from, to + 1), error: null };
    }, 1000);
    assert.equal(got.length, total, `total ${total}`);
    assert.deepEqual(got, rows);
    assert.equal(calls, Math.floor(total / 1000) + 1);
  }
});

test("pagination: a real database error is thrown with its message, not retried", async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchAllPages<number>(async () => { calls++; return { data: null, error: { message: "permission denied for table events" } }; }),
    /permission denied for table events/,
  );
  assert.equal(calls, 1);
});
