// src/lib/intelligence/intelligence.test.ts
// Run with:  npx tsx --test "src/**/*.test.ts"
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateLeague } from "../simulator/league";
import { simulateMatch, type SimulatedMatch } from "../simulator/match";
import { buildContext } from "./context";
import { buildClock, formatClock } from "./clock";
import { detectMoments, topMoments } from "./moments";
import { rhythmLabel } from "./momentum";
import { computeStats } from "./stats";

const league = generateLeague(2026);

function simulate(seed: number): SimulatedMatch {
  const home = league.teams[seed % 20];
  const away = league.teams[(seed + 7) % 20];
  return simulateMatch(league, { matchId: `t${seed}`, homeTeamId: home.id, awayTeamId: away.id, seed: 9000 + seed, round: 1 });
}

function context(sim: SimulatedMatch, upToSeq?: number) {
  return buildContext(
    { match: sim.match, teams: league.teams, players: league.players, lineup: sim.lineup, events: sim.events, fatigue: sim.fatigue },
    upToSeq,
  );
}

const SEEDS = Array.from({ length: 25 }, (_, i) => i);
const sims = SEEDS.map(simulate);

test("stats: goals counted from events equal the final score", () => {
  for (const sim of sims) {
    const stats = computeStats(context(sim));
    assert.equal(stats.score.home, sim.match.homeScore);
    assert.equal(stats.score.away, sim.match.awayScore);
  }
});

test("stats: possession adds to 100 and rates stay in range", () => {
  for (const sim of sims) {
    const s = computeStats(context(sim));
    assert.ok(Math.abs(s.home.possession + s.away.possession - 100) < 0.2);
    for (const t of [s.home, s.away]) {
      assert.ok(t.passAccuracy >= 0 && t.passAccuracy <= 100);
      assert.ok(t.shotsOnTarget <= t.shots);
      assert.ok(t.goals <= t.shotsOnTarget);
      assert.ok(t.avgPassDifficulty >= 0 && t.avgPassDifficulty <= 1);
    }
  }
});

test("stats: player goals add up to team goals", () => {
  for (const sim of sims) {
    const s = computeStats(context(sim));
    for (const t of [s.home, s.away]) {
      const fromPlayers = Object.values(s.players).filter((p) => p.teamId === t.teamId).reduce((a, p) => a + p.goals, 0);
      assert.equal(fromPlayers, t.goals);
    }
  }
});

test("live replay: stats at a point in time never include the future", () => {
  const sim = sims[3];
  let previousGoals = 0;
  for (const cut of [100, 400, 800, 1200, 1600, sim.events.length]) {
    const ctx = context(sim, cut);
    const stats = computeStats(ctx);
    const expected = sim.events.filter((e) => e.seq <= cut && e.type === "shot" && e.outcome === "goal").length;
    assert.equal(stats.score.home + stats.score.away, expected);
    assert.ok(expected >= previousGoals);
    previousGoals = expected;
  }
});

test("moments: every goal and every red card gets a moment", () => {
  for (const sim of sims) {
    const moments = detectMoments(context(sim));
    const goals = sim.events.filter((e) => e.type === "shot" && e.outcome === "goal").length;
    const reds = sim.events.filter((e) => e.type === "card" && e.cardColor === "red").length;
    assert.equal(moments.filter((m) => m.type === "goal").length, goals);
    assert.equal(moments.filter((m) => m.type === "red_card").length, reds);
  }
});

test("moments: evidence points at real events and anchors sit inside their range", () => {
  for (const sim of sims) {
    const ids = new Set(sim.events.map((e) => e.id));
    for (const m of detectMoments(context(sim))) {
      assert.ok(m.evidence.length > 0, `${m.type} has no evidence`);
      assert.ok(m.evidence.every((id) => ids.has(id)), `${m.type} cites an unknown event`);
      assert.ok(m.seqFrom <= m.seq && m.seq <= m.seqTo, `${m.type} anchor outside its range`);
      assert.ok(m.score >= 0 && m.score <= 100);
      assert.ok(m.reason.length > 20 && m.headline.length > 5);
    }
  }
});

test("moments: every moment id is unique within a match", () => {
  for (const sim of sims) {
    const ids = detectMoments(context(sim)).map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test("moments: results are in match order and identical on every run", () => {
  const ctx = context(sims[5]);
  const a = detectMoments(ctx);
  const b = detectMoments(ctx);
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].seq >= a[i - 1].seq);
});

test("moments: goal explanations name the scorer, the clock and the new score", () => {
  for (const sim of sims) {
    const ctx = context(sim);
    for (const m of detectMoments(ctx).filter((x) => x.type === "goal")) {
      assert.ok(m.reason.includes(String(m.facts.scorer)));
      assert.ok(m.reason.includes(m.clock));
      assert.ok(m.reason.includes(`${m.facts.scoreHome}-${m.facts.scoreAway}`));
    }
  }
});

test("live replay: no hindsight before full time (no 'winning goal', nothing beyond the cut)", () => {
  for (const sim of sims.slice(0, 12)) {
    const cut = Math.floor(sim.events.length * 0.8);
    const live = detectMoments(context(sim, cut));
    assert.ok(live.every((m) => m.seqTo <= cut), "a moment reaches past the cut");
    assert.ok(live.every((m) => m.facts.winningGoal !== true), "claimed a winning goal before the match ended");
  }
});

test("moments: at most one manager's call per team, and the facts agree with the story", () => {
  for (const sim of sims) {
    const ctx = context(sim);
    const calls = detectMoments(ctx).filter((m) => m.type === "manager_call");
    const perTeam = new Map<string, number>();
    for (const c of calls) {
      perTeam.set(c.teamId!, (perTeam.get(c.teamId!) ?? 0) + 1);
      assert.ok(Number(c.facts.energyPct) < 50);
      assert.ok(Number(c.facts.stayMinutes) >= 5);
      assert.ok(c.reason.includes(`${c.facts.energyPct}%`));
    }
    for (const n of perTeam.values()) assert.ok(n <= 1);
  }
});

test("moments: topMoments returns the best N in match order", () => {
  const all = detectMoments(context(sims[7]));
  const top = topMoments(all, 4);
  assert.ok(top.length <= 4);
  for (let i = 1; i < top.length; i++) assert.ok(top[i].seq >= top[i - 1].seq);
  const cutoff = [...all].sort((a, b) => b.score - a.score)[Math.min(3, all.length - 1)].score;
  assert.ok(top.every((m) => m.score >= cutoff));
});

test("clock: labels and continuous play time", () => {
  assert.equal(formatClock({ period: 1, minute: 37, second: 0 }), "37'");
  assert.equal(formatClock({ period: 1, minute: 45, second: 10 }), "45+1'");
  assert.equal(formatClock({ period: 1, minute: 47, second: 0 }), "45+3'");
  assert.equal(formatClock({ period: 2, minute: 60, second: 0 }), "60'");
  assert.equal(formatClock({ period: 2, minute: 90, second: 5 }), "90+1'");
  const clock = buildClock(sims[0].events);
  const times = sims[0].events.map((e) => clock.playSec(e));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], "play clock went backwards");
});

test("rhythm: labels follow the calibrated thresholds", () => {
  assert.equal(rhythmLabel(1.2), "controlled");
  assert.equal(rhythmLabel(2.1), "balanced");
  assert.equal(rhythmLabel(3.0), "chaotic");
});
