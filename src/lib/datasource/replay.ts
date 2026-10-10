// src/lib/datasource/replay.ts
// Plays a finished list of events back as if the match were happening now.
// speed 1 = real time, 60 = one match minute per real second, 0 (or Infinity) = no waiting at all.

import type { MatchEvent } from "./types";

export interface ReplayOptions {
  speed?: number;
  maxGapMs?: number;                    // never wait longer than this between two events (default 4000)
  signal?: AbortSignal;                 // abort to stop the replay (e.g. when the user leaves the page)
  sleep?: (ms: number) => Promise<void>; // injectable so tests don't really wait
}

/** Seconds into the current half (the second half starts again at 0). */
const halfSeconds = (e: MatchEvent) => (e.period === 1 ? e.minute * 60 + e.second : (e.minute - 45) * 60 + e.second);

export function replayDelayMs(prev: MatchEvent, next: MatchEvent, speed: number, maxGapMs = 4000): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  if (prev.period !== next.period) return 0; // half-time: don't make anyone wait
  const gapSeconds = halfSeconds(next) - halfSeconds(prev);
  if (gapSeconds <= 0) return 0;
  return Math.min(maxGapMs, (gapSeconds * 1000) / speed);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function* replayEvents(events: readonly MatchEvent[], opts: ReplayOptions = {}): AsyncGenerator<MatchEvent> {
  const speed = opts.speed ?? 1;
  const sleep = opts.sleep ?? realSleep;
  let prev: MatchEvent | null = null;
  for (const e of events) {
    if (opts.signal?.aborted) return;
    if (prev) {
      const wait = replayDelayMs(prev, e, speed, opts.maxGapMs);
      if (wait > 0) await sleep(wait);
      if (opts.signal?.aborted) return;
    }
    yield e;
    prev = e;
  }
}
