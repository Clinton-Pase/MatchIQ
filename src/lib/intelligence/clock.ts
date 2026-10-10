// src/lib/intelligence/clock.ts
// The match clock has two quirks: both halves have stoppage time, and the second half's minutes
// restart at 45. This file turns that into one continuous "play clock" and readable labels.

import type { MatchEvent } from "../datasource/types";

type Timed = Pick<MatchEvent, "period" | "minute" | "second">;

/** Seconds into the current half (the second half starts again at 0). */
export function halfSeconds(e: Timed): number {
  return e.period === 1 ? e.minute * 60 + e.second : (e.minute - 45) * 60 + e.second;
}

export interface PlayClock {
  firstHalfSeconds: number;      // how long the first half ran, stoppage included
  playSec(e: Timed): number;     // continuous seconds since kick-off (no gap at half-time)
}

export function buildClock(events: readonly MatchEvent[]): PlayClock {
  let p1 = 0;
  for (const e of events) if (e.period === 1) p1 = Math.max(p1, halfSeconds(e));
  return { firstHalfSeconds: p1, playSec: (e) => (e.period === 1 ? halfSeconds(e) : p1 + halfSeconds(e)) };
}

/** "37'", "45+2'", "90+4'" */
export function formatClock(e: Timed): string {
  if (e.period === 1 && e.minute >= 45) return `45+${e.minute - 44}'`;
  if (e.period === 2 && e.minute >= 90) return `90+${e.minute - 89}'`;
  return `${e.minute}'`;
}
