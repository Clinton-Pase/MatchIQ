// src/lib/datasource/memory.ts
// A MatchDataSource that lives entirely in memory, fed by the simulator.
// Used for tests, and as an offline "demo mode" that works even when the database is unreachable.

import type { League } from "../simulator/league";
import type { FatigueSample, SimulatedMatch } from "../simulator/match";
import type { FatigueSource } from "./fatigue";
import { replayEvents, type ReplayOptions } from "./replay";
import type { Id, LineupEntry, Match, MatchDataSource, MatchEvent, Player, Team } from "./types";

export class MemoryDataSource implements MatchDataSource, FatigueSource {
  private readonly byId = new Map<Id, SimulatedMatch>();

  constructor(private readonly league: League, sims: SimulatedMatch[]) {
    for (const s of sims) this.byId.set(s.match.id, s);
  }

  async listMatches(filter: { teamId?: Id; status?: Match["status"] } = {}): Promise<Match[]> {
    return [...this.byId.values()]
      .map((s) => s.match)
      .filter((m) => !filter.teamId || m.homeTeamId === filter.teamId || m.awayTeamId === filter.teamId)
      .filter((m) => !filter.status || m.status === filter.status)
      .sort((a, b) => a.round - b.round || a.id.localeCompare(b.id));
  }

  async getMatch(matchId: Id): Promise<Match | null> {
    return this.byId.get(matchId)?.match ?? null;
  }

  async getTeams(): Promise<Team[]> {
    return this.league.teams;
  }

  async getPlayers(teamId?: Id): Promise<Player[]> {
    return teamId ? this.league.players.filter((p) => p.teamId === teamId) : this.league.players;
  }

  async getLineup(matchId: Id): Promise<LineupEntry[]> {
    return this.byId.get(matchId)?.lineup ?? [];
  }

  async getEvents(matchId: Id, range: { fromSeq?: number; toSeq?: number } = {}): Promise<MatchEvent[]> {
    const events = this.byId.get(matchId)?.events ?? [];
    return events.filter((e) => (range.fromSeq === undefined || e.seq >= range.fromSeq) && (range.toSeq === undefined || e.seq <= range.toSeq));
  }

  async getFatigue(matchId: Id): Promise<FatigueSample[]> {
    return this.byId.get(matchId)?.fatigue ?? [];
  }

  async *streamEvents(matchId: Id, opts: ReplayOptions = {}): AsyncGenerator<MatchEvent> {
    yield* replayEvents(await this.getEvents(matchId), opts);
  }
}
