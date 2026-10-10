// src/lib/intelligence/momentum.ts
// Momentum ("who is on top?") and rhythm ("control or chaos?"), both computed from events only.
//
// Threat is a simple attacking score per event: shots count most (scaled by xG), then dangerous
// passes into the final third, dribbles won high up, and the ball won back in the opponent's half.
// Momentum is each team's share of the threat over a sliding window of minutes.

import type { MatchEvent } from "../datasource/types";
import { formatClock } from "./clock";
import type { MatchContext } from "./context";

export function threatOf(e: MatchEvent): number {
  switch (e.type) {
    case "shot":
      return 0.3 + 3 * (e.xg ?? 0);
    case "pass":
      return e.outcome === "success" && (e.endX ?? 0) >= 70 ? 0.12 : 0;
    case "duel":
      return e.outcome === "success" && e.x >= 60 ? 0.15 : 0;
    case "possession_change":
      return e.x >= 60 ? 0.2 : 0;
    default:
      return 0;
  }
}

export interface ThreatBins {
  home: number[];        // attacking threat per play-minute
  away: number[];
  clocks: string[];      // label of the last event in each minute
  events: MatchEvent[][];
}

export function threatBins(ctx: MatchContext): ThreatBins {
  const home: number[] = [];
  const away: number[] = [];
  const clocks: string[] = [];
  const events: MatchEvent[][] = [];
  for (const e of ctx.events) {
    const bin = Math.floor(ctx.clock.playSec(e) / 60);
    while (home.length <= bin) {
      home.push(0);
      away.push(0);
      clocks.push("");
      events.push([]);
    }
    events[bin].push(e);
    clocks[bin] = formatClock(e);
    const t = threatOf(e);
    if (t > 0) {
      if (e.teamId === ctx.match.homeTeamId) home[bin] += t;
      else away[bin] += t;
    }
  }
  // a minute with no events (e.g. a long goal celebration) keeps the previous minute's clock label
  for (let i = 1; i < clocks.length; i++) if (!clocks[i]) clocks[i] = clocks[i - 1];
  return { home, away, clocks, events };
}

export const sum = (arr: number[], from: number, to: number): number => {
  let s = 0;
  for (let i = Math.max(0, from); i <= to && i < arr.length; i++) s += arr[i];
  return s;
};

export interface MomentumPoint {
  bin: number;      // play-minute
  clock: string;
  home: number;     // threat inside the window
  away: number;
  share: number;    // home's share of threat, 0-1 (0.5 = even)
  index: number;    // -1 (away on top) to +1 (home on top)
}

export const MOMENTUM_WINDOW = 6;

export function momentumSeries(ctx: MatchContext, window = MOMENTUM_WINDOW): MomentumPoint[] {
  const bins = threatBins(ctx);
  return bins.home.map((_, i) => {
    const h = sum(bins.home, i - window + 1, i);
    const a = sum(bins.away, i - window + 1, i);
    const share = h + a > 0 ? h / (h + a) : 0.5;
    return { bin: i, clock: bins.clocks[i], home: h, away: a, share, index: share * 2 - 1 };
  });
}

// ---- Rhythm: control versus chaos ------------------------------------------------------------

export type RhythmLabel = "controlled" | "balanced" | "chaotic";

export interface RhythmPoint {
  bin: number;
  clock: string;
  turnoversPerMin: number;   // how often the ball changes hands
  label: RhythmLabel;
}

// Thresholds were calibrated on 300 simulated matches (roughly the bottom and top thirds).
export const RHYTHM_CONTROLLED_BELOW = 1.8;
export const RHYTHM_CHAOTIC_ABOVE = 2.4;

export function rhythmLabel(turnoversPerMin: number): RhythmLabel {
  if (turnoversPerMin < RHYTHM_CONTROLLED_BELOW) return "controlled";
  if (turnoversPerMin > RHYTHM_CHAOTIC_ABOVE) return "chaotic";
  return "balanced";
}

export function rhythmSeries(ctx: MatchContext, window = 5): RhythmPoint[] {
  const bins = threatBins(ctx);
  const perBin = bins.events.map((es) => es.filter((e) => e.type === "possession_change").length);
  return perBin.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const tpm = sum(perBin, from, i) / (i - from + 1);
    return { bin: i, clock: bins.clocks[i], turnoversPerMin: Math.round(tpm * 100) / 100, label: rhythmLabel(tpm) };
  });
}
