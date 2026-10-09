// scripts/seed.ts
// Plays the first N rounds of the fictional season and stores everything in Supabase.
// The round after that ("the live round") is stored too, but marked 'scheduled' with a 0-0 score,
// so the app can replay it as if it were happening live.
//
//   npx tsx scripts/seed.ts --dry            simulate only, no database (safe test)
//   npx tsx scripts/seed.ts                  seed 10 rounds + 1 live round
//   npx tsx scripts/seed.ts --rounds=6       seed 6 rounds + 1 live round
//
// WARNING: a real run first WIPES the MatchIQ tables (teams, players, matches, lineups, events, fatigue_samples).

import { config } from "dotenv";
config({ path: ".env.local" });

import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "../src/lib/db/client";
import {
  eventToRow, fatigueToRow, lineupToRow, matchToRow, playerToRow, teamToRow,
} from "../src/lib/db/mappers";
import { roundRobin } from "../src/lib/simulator/fixtures";
import { generateLeague } from "../src/lib/simulator/league";
import { simulateMatch } from "../src/lib/simulator/match";

const DRY = process.argv.includes("--dry");
const roundsArg = process.argv.find((a) => a.startsWith("--rounds="));
const ROUNDS = roundsArg ? Number(roundsArg.split("=")[1]) : 10;
const LEAGUE_SEED = 2026;

if (!Number.isInteger(ROUNDS) || ROUNDS < 1 || ROUNDS > 37) {
  console.error("--rounds must be a whole number from 1 to 37");
  process.exit(1);
}

let db: SupabaseClient | null = null;

async function insert(table: string, rows: object[], chunk = 1000) {
  if (!db) return;
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await db.from(table).insert(rows.slice(i, i + chunk));
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
}

async function wipe() {
  if (!db) return;
  // Deleting matches also removes their lineups, events and fatigue samples (cascade).
  for (const table of ["matches", "players", "teams"]) {
    const { error } = await db.from(table).delete().neq("id", "");
    if (error) throw new Error(`Wiping ${table} failed: ${error.message}`);
  }
}

async function main() {
  const started = Date.now();
  const league = generateLeague(LEAGUE_SEED);
  const fixtures = roundRobin(league.teams.map((t) => t.id))
    .filter((f) => f.round <= ROUNDS + 1)
    .sort((a, b) => a.round - b.round || a.index - b.index);

  console.log(`${DRY ? "DRY RUN: " : ""}${league.teams.length} teams, ${league.players.length} players, ${fixtures.length} matches (${ROUNDS} played rounds + 1 live round)`);

  if (!DRY) {
    db = getServiceClient();
    console.log("Wiping old data...");
    await wipe();
    await insert("teams", league.teams.map(teamToRow));
    await insert("players", league.players.map(playerToRow));
  }

  let nEvents = 0;
  let nFatigue = 0;
  let nGoals = 0;

  for (const f of fixtures) {
    const matchId = `m${String(f.round).padStart(2, "0")}-${String(f.index).padStart(2, "0")}`;
    const sim = simulateMatch(league, {
      matchId,
      homeTeamId: f.homeTeamId,
      awayTeamId: f.awayTeamId,
      round: f.round,
      seed: LEAGUE_SEED * 1_000_000 + f.round * 1000 + f.index,
    });

    const isLive = f.round === ROUNDS + 1;
    // The live round hides its result: the true score lives in the events and appears as the replay plays.
    const matchRow = isLive
      ? matchToRow({ ...sim.match, status: "scheduled", homeScore: 0, awayScore: 0 })
      : matchToRow(sim.match);

    await insert("matches", [matchRow]);
    await insert("lineups", sim.lineup.map(lineupToRow));
    await insert("events", sim.events.map(eventToRow));
    await insert("fatigue_samples", sim.fatigue.map(fatigueToRow));

    nEvents += sim.events.length;
    nFatigue += sim.fatigue.length;
    nGoals += sim.match.homeScore + sim.match.awayScore;
    if (f.index === 9) console.log(`  round ${f.round} done${isLive ? " (live round, stored as scheduled)" : ""}`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\nDone in ${secs}s. ${fixtures.length} matches, ${nEvents} events, ${nFatigue} fatigue samples, ${nGoals} goals.`);
  if (DRY) console.log("Dry run only: nothing was written to the database.");
}

main().catch((err) => {
  console.error("\nSeed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});