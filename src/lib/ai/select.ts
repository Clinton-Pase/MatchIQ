// src/lib/ai/select.ts
// Deterministic selection: which moments are even put in front of the Analyst.
// Personalization (favorite club, player focus) is applied here as a score boost, in plain code,
// so it is predictable and testable rather than left to the model.

import type { KeyMoment } from "../intelligence/moments";
import type { ReportSettings } from "./types";

export const FAVORITE_BOOST = 12;
export const FOCUS_BOOST = 30;
export const MANDATORY_TYPES = new Set(["goal", "red_card"]);

export function adjustedScore(m: KeyMoment, s: ReportSettings): number {
  let v = m.score;
  if (s.favoriteTeamId && m.teamId === s.favoriteTeamId) v += FAVORITE_BOOST;
  if (s.focusPlayerId && m.playerId === s.focusPlayerId) v += FOCUS_BOOST;
  return v;
}

/** The best `limit` moments for this viewer, always including every goal and red card, in match order. */
export function selectCandidates(moments: KeyMoment[], s: ReportSettings, limit = 12): KeyMoment[] {
  const mandatory = moments.filter((m) => MANDATORY_TYPES.has(m.type));
  const rest = moments
    .filter((m) => !MANDATORY_TYPES.has(m.type))
    .sort((a, b) => adjustedScore(b, s) - adjustedScore(a, s) || a.seq - b.seq);
  const room = Math.max(0, limit - mandatory.length);
  return [...mandatory, ...rest.slice(0, room)].sort((a, b) => a.seq - b.seq);
}

/** How many moments the report shows: at least every goal and red card, never more than `hardCap`. */
export function reportSize(candidates: KeyMoment[], wanted: number, hardCap = 10): number {
  const mandatory = candidates.filter((m) => MANDATORY_TYPES.has(m.type)).length;
  return Math.min(hardCap, Math.max(wanted, mandatory));
}
