// src/lib/datasource/supabase.ts
// Reads match data from Supabase. This is the "real" MatchDataSource the app uses.
// A licensed live-data API could be added later as another class implementing the same interface.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "../db/paginate";
import {
  rowToEvent, rowToFatigue, rowToLineup, rowToMatch, rowToPlayer, rowToTeam,
  type EventRow, type FatigueRow, type LineupRow, type MatchRow, type PlayerRow, type TeamRow,
} from "../db/mappers";
import { withRetry } from "../db/retry";
import type { FatigueSample } from "../simulator/match";
import type { FatigueSource } from "./fatigue";
import { replayEvents, type ReplayOptions } from "./replay";
import type { Id, LineupEntry, Match, MatchDataSource, MatchEvent, Player, Team } from "./types";

const SAFE_ID = /^[\w-]+$/;
function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid id: ${id}`);
  return id;
}

export class SupabaseDataSource implements MatchDataSource, FatigueSource {
  constructor(private readonly db: SupabaseClient) {}

  async listMatches(filter: { teamId?: Id; status?: Match["status"] } = {}): Promise<Match[]> {
    const rows = await fetchAllPages<MatchRow>((from, to) => {
      let q = this.db.from("matches").select("*");
      if (filter.teamId) {
        const id = safeId(filter.teamId);
        q = q.or(`home_team_id.eq.${id},away_team_id.eq.${id}`);
      }
      if (filter.status) q = q.eq("status", filter.status);
      return q.order("round").order("id").range(from, to);
    }, 1000, "list matches");
    return rows.map(rowToMatch);
  }

  async getMatch(matchId: Id): Promise<Match | null> {
    const res = await withRetry<{ data: MatchRow | null; error: { message: string } | null }>("get match", () =>
      this.db.from("matches").select("*").eq("id", matchId).maybeSingle(),
    );
    return res.data ? rowToMatch(res.data) : null;
  }

  async getTeams(): Promise<Team[]> {
    const rows = await fetchAllPages<TeamRow>((from, to) => this.db.from("teams").select("*").order("id").range(from, to), 1000, "get teams");
    return rows.map(rowToTeam);
  }

  async getPlayers(teamId?: Id): Promise<Player[]> {
    const rows = await fetchAllPages<PlayerRow>((from, to) => {
      let q = this.db.from("players").select("*");
      if (teamId) q = q.eq("team_id", teamId);
      return q.order("id").range(from, to);
    }, 1000, "get players");
    return rows.map(rowToPlayer);
  }

  async getLineup(matchId: Id): Promise<LineupEntry[]> {
    const rows = await fetchAllPages<LineupRow>(
      (from, to) => this.db.from("lineups").select("*").eq("match_id", matchId).order("player_id").range(from, to),
      1000,
      "get lineup",
    );
    return rows.map(rowToLineup);
  }

  async getEvents(matchId: Id, range: { fromSeq?: number; toSeq?: number } = {}): Promise<MatchEvent[]> {
    const rows = await fetchAllPages<EventRow>((from, to) => {
      let q = this.db.from("events").select("*").eq("match_id", matchId);
      if (range.fromSeq !== undefined) q = q.gte("seq", range.fromSeq);
      if (range.toSeq !== undefined) q = q.lte("seq", range.toSeq);
      return q.order("seq").range(from, to);
    }, 1000, "get events");
    return rows.map(rowToEvent);
  }

  async getFatigue(matchId: Id): Promise<FatigueSample[]> {
    const rows = await fetchAllPages<FatigueRow>(
      (from, to) => this.db.from("fatigue_samples").select("*").eq("match_id", matchId).order("minute").order("player_id").range(from, to),
      1000,
      "get fatigue",
    );
    return rows.map(rowToFatigue);
  }

  async *streamEvents(matchId: Id, opts: ReplayOptions = {}): AsyncGenerator<MatchEvent> {
    yield* replayEvents(await this.getEvents(matchId), opts);
  }
}
