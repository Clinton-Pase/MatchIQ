import { generateLeague } from "../src/lib/simulator/league";
import { simulateMatch } from "../src/lib/simulator/match";
import type { MatchEvent } from "../src/lib/datasource/types";

const league = generateLeague();
const N = 200;
const ids = league.teams.map((t) => t.id);

interface Row { passes: number; ok: number; shots: number; sot: number; goals: number; xg: number; fouls: number; yellow: number; red: number; tackles: number; press: number; inter: number; pens: number }
const blank = (): Row => ({ passes: 0, ok: 0, shots: 0, sot: 0, goals: 0, xg: 0, fouls: 0, yellow: 0, red: 0, tackles: 0, press: 0, inter: 0, pens: 0 });
const total = blank();
const byStyle: Record<string, Row & { n: number }> = {};
let evCount = 0, subs = 0, subMinSum = 0, late = 0, goalsAll = 0, tiredAt75 = 0, matchesWithTired = 0, draws = 0, homeWins = 0, seqBad = 0;
let possShareHome = 0;

for (let i = 0; i < N; i++) {
  const h = ids[i % 20];
  const a = ids[(i * 7 + 3) % 20 === i % 20 ? (i + 1) % 20 : (i * 7 + 3) % 20];
  const sim = simulateMatch(league, { matchId: `m${i}`, homeTeamId: h, awayTeamId: a, seed: 1000 + i, round: 1 + (i % 38) });
  evCount += sim.events.length;
  sim.events.forEach((e, k) => { if (e.seq !== k + 1) seqBad++; });
  const side = (teamId: string) => {
    const row = blank();
    for (const e of sim.events as MatchEvent[]) {
      if (e.teamId !== teamId) continue;
      if (e.type === "pass") { row.passes++; if (e.outcome === "success") row.ok++; }
      if (e.type === "shot") { row.shots++; row.xg += e.xg ?? 0; if (e.outcome === "goal" || e.outcome === "saved") row.sot++; if (e.outcome === "goal") row.goals++; if (e.xg === 0.76) row.pens++; }
      if (e.type === "foul") row.fouls++;
      if (e.type === "card") e.cardColor === "red" ? row.red++ : row.yellow++;
      if (e.type === "tackle") row.tackles++;
      if (e.type === "pressure") row.press++;
      if (e.type === "interception") row.inter++;
    }
    return row;
  };
  const rh = side(h), ra = side(a);
  possShareHome += rh.passes / (rh.passes + ra.passes);
  for (const [row, tid] of [[rh, h], [ra, a]] as const) {
    (Object.keys(row) as (keyof Row)[]).forEach((k) => (total[k] += row[k]));
    const st = league.teams.find((t) => t.id === tid)!.style;
    byStyle[st] ??= { ...blank(), n: 0 };
    (Object.keys(row) as (keyof Row)[]).forEach((k) => (byStyle[st][k] += row[k]));
    byStyle[st].n++;
  }
  goalsAll += rh.goals + ra.goals;
  if (sim.match.homeScore === sim.match.awayScore) draws++;
  if (sim.match.homeScore > sim.match.awayScore) homeWins++;
  for (const e of sim.events) {
    if (e.type === "substitution") { subs++; subMinSum += e.minute; }
    if (e.type === "shot" && e.outcome === "goal" && e.minute >= 75) late++;
  }
  const tired = sim.fatigue.filter((f) => f.minute === 75 && f.energy < 0.45).length;
  tiredAt75 += tired;
  if (tired > 0) matchesWithTired++;
}

const tm = N * 2;
const f = (v: number, d = 2) => (v / tm).toFixed(d);
console.log(`\n=== ${N} matches, ${tm} team-performances ===`);
console.log(`events per match      ${(evCount / N).toFixed(0)}   (seq errors: ${seqBad})`);
console.log(`passes per team       ${f(total.passes, 0)}   accuracy ${((total.ok / total.passes) * 100).toFixed(1)}%`);
console.log(`shots per team        ${f(total.shots, 1)}   on target ${f(total.sot, 1)}   (${((total.sot / total.shots) * 100).toFixed(0)}% of shots)`);
console.log(`goals per team        ${f(total.goals)}   xG per team ${f(total.xg)}   xG per shot ${(total.xg / total.shots).toFixed(3)}`);
console.log(`goals per match       ${(goalsAll / N).toFixed(2)}   draws ${((draws / N) * 100).toFixed(0)}%   home wins ${((homeWins / N) * 100).toFixed(0)}%`);
console.log(`fouls / team          ${f(total.fouls, 1)}   yellows ${f(total.yellow)}   reds ${f(total.red, 3)}   penalties ${f(total.pens, 3)}`);
console.log(`tackles / team        ${f(total.tackles, 1)}   interceptions ${f(total.inter, 1)}   pressure events ${f(total.press, 1)}`);
console.log(`goals after 75'       ${((late / goalsAll) * 100).toFixed(0)}% of all goals`);
console.log(`subs per match        ${(subs / N).toFixed(1)}   avg minute ${(subMinSum / subs).toFixed(0)}`);
console.log(`tired players (<0.45) still on pitch at 75': ${(tiredAt75 / N).toFixed(2)} per match, in ${((matchesWithTired / N) * 100).toFixed(0)}% of matches`);
console.log(`home possession share (pass share) ${((possShareHome / N) * 100).toFixed(1)}%`);

console.log("\nBy style (per team-match):");
for (const [s, row] of Object.entries(byStyle)) {
  console.log(
    `  ${s.padEnd(11)} passes ${(row.passes / row.n).toFixed(0).padStart(4)}  acc ${((row.ok / row.passes) * 100).toFixed(1)}%  shots ${(row.shots / row.n).toFixed(1).padStart(5)}  xG/shot ${(row.xg / row.shots).toFixed(3)}  goals ${(row.goals / row.n).toFixed(2)}  pressure ${(row.press / row.n).toFixed(0).padStart(3)}  (n=${row.n})`,
  );
}

const a = JSON.stringify(simulateMatch(league, { matchId: "d1", homeTeamId: "t01", awayTeamId: "t02", seed: 42 }));
const b = JSON.stringify(simulateMatch(league, { matchId: "d1", homeTeamId: "t01", awayTeamId: "t02", seed: 42 }));
const c = JSON.stringify(simulateMatch(league, { matchId: "d1", homeTeamId: "t01", awayTeamId: "t02", seed: 43 }));
console.log(`\nSame seed gives identical match: ${a === b}`);
console.log(`Different seed gives different match: ${a !== c}`);

const sample = simulateMatch(league, { matchId: "demo", homeTeamId: "t01", awayTeamId: "t02", seed: 7 });
const nameOf = (id?: string) => league.players.find((p) => p.id === id)?.name ?? "-";
const tn = (id: string) => league.teams.find((t) => t.id === id)!.name;
console.log(`\nDemo: ${tn("t01")} ${sample.match.homeScore} - ${sample.match.awayScore} ${tn("t02")}`);
sample.events
  .filter((e) => e.type === "shot" && e.outcome === "goal" || e.type === "card" || e.type === "substitution")
  .forEach((e) => console.log(`  ${String(e.minute).padStart(2)}'  ${e.type.padEnd(12)} ${nameOf(e.playerId)}${e.otherPlayerId ? " -> " + nameOf(e.otherPlayerId) : ""} ${e.cardColor ?? ""}${e.xg ? " xG " + e.xg : ""}`));
console.log("\nFirst 6 events:");
sample.events.slice(0, 6).forEach((e) => console.log(" ", JSON.stringify(e)));