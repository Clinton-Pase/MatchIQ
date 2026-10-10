// scripts/check-intelligence.ts
// Runs the stats and key-moment detector over simulated matches (no database needed).
//   npx tsx scripts/check-intelligence.ts            summary over 300 matches + one demo match
//   npx tsx scripts/check-intelligence.ts --seed=7   show the full breakdown for one seed
import { generateLeague } from "../src/lib/simulator/league";
import { simulateMatch } from "../src/lib/simulator/match";
import { buildContext } from "../src/lib/intelligence/context";
import { computeStats } from "../src/lib/intelligence/stats";
import { detectMoments, topMoments, type MomentType } from "../src/lib/intelligence/moments";
import { momentumSeries, rhythmSeries } from "../src/lib/intelligence/momentum";

const league = generateLeague(2026);
const N = 300;
const seedArg = process.argv.find((a) => a.startsWith("--seed="));

function build(seed: number) {
  const home = league.teams[seed % 20];
  const away = league.teams[(seed * 7 + 3) % 20 === seed % 20 ? (seed + 1) % 20 : (seed * 7 + 3) % 20];
  const sim = simulateMatch(league, { matchId: `s${seed}`, homeTeamId: home.id, awayTeamId: away.id, seed: 5000 + seed, round: 1 + (seed % 38) });
  const ctx = buildContext({ match: sim.match, teams: league.teams, players: league.players, lineup: sim.lineup, events: sim.events, fatigue: sim.fatigue });
  return { sim, ctx };
}

function show(seed: number) {
  const { sim, ctx } = build(seed);
  const stats = computeStats(ctx);
  const tn = (id: string) => league.teams.find((t) => t.id === id)!.name;
  console.log(`\n=== seed ${seed}: ${tn(sim.match.homeTeamId)} ${stats.score.home}-${stats.score.away} ${tn(sim.match.awayTeamId)} ===`);
  const row = (label: string, a: number | string, b: number | string) => console.log(`  ${label.padEnd(22)}${String(a).padStart(8)}${String(b).padStart(8)}`);
  row("", "home", "away");
  for (const k of ["possession", "shots", "shotsOnTarget", "xg", "passAccuracy", "hardPassesCompleted", "tackles", "interceptions", "pressures", "fouls"] as const) row(k, stats.home[k], stats.away[k]);
  const moments = detectMoments(ctx);
  console.log(`\n  ${moments.length} moments, top 8 by importance:`);
  for (const m of topMoments(moments, 8)) console.log(`   [${String(m.score).padStart(3)}] ${m.clock.padEnd(6)} ${m.type.padEnd(14)} ${m.reason}`);
  const mom = momentumSeries(ctx);
  const rh = rhythmSeries(ctx);
  console.log(`\n  momentum (home share by minute, every 10): ${mom.filter((_, i) => i % 10 === 9).map((p) => `${p.clock}:${Math.round(p.share * 100)}%`).join("  ")}`);
  console.log(`  rhythm (every 10): ${rh.filter((_, i) => i % 10 === 9).map((p) => `${p.clock}:${p.label}`).join("  ")}`);
}

if (seedArg) { show(Number(seedArg.split("=")[1])); process.exit(0); }

const counts: Record<string, number> = {};
const matchesWith: Record<string, number> = {};
let evidenceBad = 0, anchorBad = 0, totalMoments = 0, scoreBad = 0;
let goalsEvents = 0, goalMoments = 0, redEvents = 0, redMoments = 0;
const tpm: number[] = [];
const best: { seed: number; value: number; types: string }[] = [];
const runLens: number[] = [];

for (let s = 0; s < N; s++) {
  const { ctx } = build(s);
  const ids = new Set(ctx.events.map((e) => e.id));
  const moments = detectMoments(ctx);
  totalMoments += moments.length;
  const seen = new Set<string>();
  for (const m of moments) {
    counts[m.type] = (counts[m.type] ?? 0) + 1;
    seen.add(m.type);
    if (m.evidence.some((id) => !ids.has(id)) || m.evidence.length === 0) evidenceBad++;
    if (m.seqFrom > m.seq || m.seq > m.seqTo) anchorBad++;
    if (m.score < 0 || m.score > 100) scoreBad++;
  }
  seen.forEach((t) => (matchesWith[t] = (matchesWith[t] ?? 0) + 1));
  goalsEvents += ctx.events.filter((e) => e.type === "shot" && e.outcome === "goal").length;
  goalMoments += moments.filter((m) => m.type === "goal").length;
  redEvents += ctx.events.filter((e) => e.type === "card" && e.cardColor === "red").length;
  redMoments += moments.filter((m) => m.type === "red_card").length;
  rhythmSeries(ctx).forEach((p) => tpm.push(p.turnoversPerMin));
  const top = topMoments(moments, 5);
  best.push({ seed: s, value: top.reduce((a, m) => a + m.score, 0) + (seen.has("manager_call") ? 40 : 0) + goalsEvents * 0, types: [...seen].join(",") });
}

console.log(`\n=== ${N} matches ===`);
console.log(`moments per match: ${(totalMoments / N).toFixed(1)}`);
console.log("type".padEnd(16) + "total".padStart(7) + "per match".padStart(11) + "% of matches".padStart(14));
for (const t of Object.keys(counts).sort()) console.log(t.padEnd(16) + String(counts[t]).padStart(7) + (counts[t] / N).toFixed(2).padStart(11) + (((matchesWith[t] ?? 0) / N) * 100).toFixed(0).padStart(13) + "%");
console.log(`\nevery goal has a moment: ${goalsEvents === goalMoments} (${goalMoments}/${goalsEvents})   every red has a moment: ${redEvents === redMoments} (${redMoments}/${redEvents})`);
console.log(`bad evidence ids: ${evidenceBad}   bad anchors: ${anchorBad}   scores out of range: ${scoreBad}`);
tpm.sort((a, b) => a - b);
const q = (p: number) => tpm[Math.floor(p * (tpm.length - 1))];
console.log(`rhythm turnovers/min  p33=${q(0.33)}  p50=${q(0.5)}  p67=${q(0.67)}  p90=${q(0.9)}`);
best.sort((a, b) => b.value - a.value);
console.log("\nbest demo candidates (seed: moment types):");
best.slice(0, 5).forEach((b) => console.log(`  seed ${b.seed}  [${b.value.toFixed(0)}]  ${b.types}`));
show(best[0].seed);
