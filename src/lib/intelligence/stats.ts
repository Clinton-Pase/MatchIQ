// src/lib/intelligence/stats.ts
// Turns raw events into football statistics. Pure code, no AI: every number here can be recomputed from the events.

import type { Id, MatchEvent } from "../datasource/types";
import { formatClock } from "./clock";
import type { MatchContext } from "./context";

export interface TeamStats {
  teamId: Id;
  goals: number;
  shots: number;
  shotsOnTarget: number;
  xg: number;
  passes: number;
  passesCompleted: number;
  passAccuracy: number;        // %
  possession: number;          // % of all passes (a standard stand-in for possession)
  avgPassDifficulty: number;   // 0-1
  hardPassesCompleted: number; // completed passes with difficulty >= 0.6
  fouls: number;
  yellowCards: number;
  redCards: number;
  tackles: number;
  interceptions: number;
  pressures: number;
  turnoversWon: number;
  topShotSpeedKmh: number;
}

export interface PlayerStats {
  playerId: Id;
  teamId: Id;
  passes: number;
  passesCompleted: number;
  passAccuracy: number;        // %
  shots: number;
  shotsOnTarget: number;
  goals: number;
  xg: number;
  tackles: number;
  interceptions: number;
  duels: number;
  duelsWon: number;
  fouls: number;
  cards: number;
  topSpeedKmh: number;         // fastest pass or shot
}

export interface MatchStats {
  clock: string;               // label of the latest event, e.g. "67'"
  score: { home: number; away: number };
  home: TeamStats;
  away: TeamStats;
  byTeam: Record<Id, TeamStats>;
  players: Record<Id, PlayerStats>;
}

export const HARD_PASS = 0.6;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? r1((num / den) * 100) : 0);

const blankTeam = (teamId: Id): TeamStats => ({
  teamId, goals: 0, shots: 0, shotsOnTarget: 0, xg: 0, passes: 0, passesCompleted: 0, passAccuracy: 0,
  possession: 0, avgPassDifficulty: 0, hardPassesCompleted: 0, fouls: 0, yellowCards: 0, redCards: 0,
  tackles: 0, interceptions: 0, pressures: 0, turnoversWon: 0, topShotSpeedKmh: 0,
});

const blankPlayer = (playerId: Id, teamId: Id): PlayerStats => ({
  playerId, teamId, passes: 0, passesCompleted: 0, passAccuracy: 0, shots: 0, shotsOnTarget: 0, goals: 0, xg: 0,
  tackles: 0, interceptions: 0, duels: 0, duelsWon: 0, fouls: 0, cards: 0, topSpeedKmh: 0,
});

export function computeStats(ctx: MatchContext): MatchStats {
  const home = blankTeam(ctx.match.homeTeamId);
  const away = blankTeam(ctx.match.awayTeamId);
  const byTeam: Record<Id, TeamStats> = { [home.teamId]: home, [away.teamId]: away };
  const players: Record<Id, PlayerStats> = {};
  const difficultySum: Record<Id, number> = { [home.teamId]: 0, [away.teamId]: 0 };

  const player = (e: MatchEvent): PlayerStats | null => {
    if (!e.playerId) return null;
    return (players[e.playerId] ??= blankPlayer(e.playerId, e.teamId));
  };

  for (const e of ctx.events) {
    const t = byTeam[e.teamId];
    if (!t) continue;
    const p = player(e);
    switch (e.type) {
      case "pass": {
        const ok = e.outcome === "success";
        t.passes++;
        difficultySum[t.teamId] += e.passDifficulty ?? 0;
        if (ok) {
          t.passesCompleted++;
          if ((e.passDifficulty ?? 0) >= HARD_PASS) t.hardPassesCompleted++;
        }
        if (p) {
          p.passes++;
          if (ok) p.passesCompleted++;
          p.topSpeedKmh = Math.max(p.topSpeedKmh, e.speedKmh ?? 0);
        }
        break;
      }
      case "shot": {
        const onTarget = e.outcome === "goal" || e.outcome === "saved";
        t.shots++;
        t.xg += e.xg ?? 0;
        if (onTarget) t.shotsOnTarget++;
        if (e.outcome === "goal") t.goals++;
        t.topShotSpeedKmh = Math.max(t.topShotSpeedKmh, e.speedKmh ?? 0);
        if (p) {
          p.shots++;
          p.xg += e.xg ?? 0;
          if (onTarget) p.shotsOnTarget++;
          if (e.outcome === "goal") p.goals++;
          p.topSpeedKmh = Math.max(p.topSpeedKmh, e.speedKmh ?? 0);
        }
        break;
      }
      case "tackle":
        t.tackles++;
        if (p) p.tackles++;
        break;
      case "interception":
        t.interceptions++;
        if (p) p.interceptions++;
        break;
      case "duel":
        if (p) {
          p.duels++;
          if (e.outcome === "success") p.duelsWon++;
        }
        break;
      case "pressure":
        t.pressures++;
        break;
      case "foul":
        t.fouls++;
        if (p) p.fouls++;
        break;
      case "card":
        if (e.cardColor === "red") t.redCards++;
        else t.yellowCards++;
        if (p) p.cards++;
        break;
      case "possession_change":
        t.turnoversWon++;
        break;
      default:
        break;
    }
  }

  const totalPasses = home.passes + away.passes;
  for (const t of [home, away]) {
    t.passAccuracy = pct(t.passesCompleted, t.passes);
    t.possession = pct(t.passes, totalPasses);
    t.avgPassDifficulty = t.passes > 0 ? r2(difficultySum[t.teamId] / t.passes) : 0;
    t.xg = r2(t.xg);
  }
  for (const p of Object.values(players)) {
    p.passAccuracy = pct(p.passesCompleted, p.passes);
    p.xg = r2(p.xg);
  }

  const last = ctx.events[ctx.events.length - 1];
  return {
    clock: last ? formatClock(last) : "0'",
    score: { home: home.goals, away: away.goals },
    home,
    away,
    byTeam,
    players,
  };
}
