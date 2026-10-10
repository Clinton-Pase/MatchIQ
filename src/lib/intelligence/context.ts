// src/lib/intelligence/context.ts
// Everything the intelligence code needs to know about one match, in one object.
// Passing upToSeq gives the match "as it stood" at that moment, with no knowledge of what happens next.
// That is what makes live replay honest: nothing is ever explained using the future.

import type { FatigueSource } from "../datasource/fatigue";
import type { Id, LineupEntry, Match, MatchDataSource, MatchEvent, Player, Team } from "../datasource/types";
import type { FatigueSample } from "../simulator/match";
import { buildClock, type PlayClock } from "./clock";

export interface MatchContext {
  match: Match;
  teams: Map<Id, Team>;
  players: Map<Id, Player>;
  lineup: LineupEntry[];
  events: MatchEvent[];        // sorted by seq
  fatigue: FatigueSample[];    // only readings taken before the last included event
  clock: PlayClock;
  complete: boolean;           // true once the full-time whistle is in the events
}

export interface ContextInput {
  match: Match;
  teams: Team[];
  players: Player[];
  lineup: LineupEntry[];
  events: MatchEvent[];
  fatigue: FatigueSample[];
}

export function buildContext(input: ContextInput, upToSeq?: number): MatchContext {
  const events = input.events
    .filter((e) => upToSeq === undefined || e.seq <= upToSeq)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const clock = buildClock(events);
  const last = events[events.length - 1];
  const nowSec = last ? clock.playSec(last) : 0;
  return {
    match: input.match,
    teams: new Map(input.teams.map((t) => [t.id, t])),
    players: new Map(input.players.map((p) => [p.id, p])),
    lineup: input.lineup,
    events,
    fatigue: input.fatigue.filter((f) => upToSeq === undefined || f.minute * 60 <= nowSec),
    clock,
    complete: events.some((e) => e.type === "full_time"),
  };
}

export async function loadMatchContext(
  ds: MatchDataSource & FatigueSource,
  matchId: Id,
  upToSeq?: number,
): Promise<MatchContext | null> {
  const match = await ds.getMatch(matchId);
  if (!match) return null;
  const [teams, players, lineup, events, fatigue] = await Promise.all([
    ds.getTeams(),
    ds.getPlayers(),
    ds.getLineup(matchId),
    ds.getEvents(matchId, upToSeq === undefined ? undefined : { toSeq: upToSeq }),
    ds.getFatigue(matchId),
  ]);
  return buildContext({ match, teams, players, lineup, events, fatigue }, upToSeq);
}
