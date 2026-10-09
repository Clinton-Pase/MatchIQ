// src/lib/db/mappers.ts
// Converts between our camelCase TypeScript types and the snake_case database rows.

import type {
  EventOutcome, EventType, LineupEntry, Match, MatchEvent, Player, Position, Team,
} from "../datasource/types";
import type { FatigueSample } from "../simulator/match";

export interface TeamRow {
  id: string; name: string; short_name: string;
  color_primary: string; color_secondary: string; style: Team["style"];
}
export const teamToRow = (t: Team): TeamRow => ({
  id: t.id, name: t.name, short_name: t.shortName,
  color_primary: t.colorPrimary, color_secondary: t.colorSecondary, style: t.style,
});
export const rowToTeam = (r: TeamRow): Team => ({
  id: r.id, name: r.name, shortName: r.short_name,
  colorPrimary: r.color_primary, colorSecondary: r.color_secondary, style: r.style,
});

export interface PlayerRow {
  id: string; team_id: string; name: string; shirt_number: number;
  position: Position; stamina: number; quality: number;
}
export const playerToRow = (p: Player): PlayerRow => ({
  id: p.id, team_id: p.teamId, name: p.name, shirt_number: p.shirtNumber,
  position: p.position, stamina: p.stamina, quality: p.quality,
});
export const rowToPlayer = (r: PlayerRow): Player => ({
  id: r.id, teamId: r.team_id, name: r.name, shirtNumber: r.shirt_number,
  position: r.position, stamina: r.stamina, quality: r.quality,
});

export interface MatchRow {
  id: string; season: string; round: number; home_team_id: string; away_team_id: string;
  kickoff_at: string; venue: string; status: Match["status"];
  home_score: number; away_score: number; seed: number | null;
}
export const matchToRow = (m: Match): MatchRow => ({
  id: m.id, season: m.season, round: m.round, home_team_id: m.homeTeamId, away_team_id: m.awayTeamId,
  kickoff_at: m.kickoffAt, venue: m.venue, status: m.status,
  home_score: m.homeScore, away_score: m.awayScore, seed: m.seed ?? null,
});
export const rowToMatch = (r: MatchRow): Match => ({
  id: r.id, season: r.season, round: r.round, homeTeamId: r.home_team_id, awayTeamId: r.away_team_id,
  kickoffAt: r.kickoff_at, venue: r.venue, status: r.status,
  homeScore: r.home_score, awayScore: r.away_score, seed: r.seed ?? undefined,
});

export interface LineupRow { match_id: string; player_id: string; team_id: string; role: LineupEntry["role"] }
export const lineupToRow = (l: LineupEntry): LineupRow => ({
  match_id: l.matchId, player_id: l.playerId, team_id: l.teamId, role: l.role,
});
export const rowToLineup = (r: LineupRow): LineupEntry => ({
  matchId: r.match_id, playerId: r.player_id, teamId: r.team_id, role: r.role,
});

export interface EventRow {
  id: string; match_id: string; seq: number; period: 1 | 2; minute: number; second: number;
  type: EventType; team_id: string; player_id: string | null; other_player_id: string | null;
  x: number; y: number; end_x: number | null; end_y: number | null;
  outcome: EventOutcome | null; xg: number | null; pass_distance: number | null;
  pass_difficulty: number | null; speed_kmh: number | null;
  card_color: "yellow" | "red" | null; pressure_intensity: number | null;
}
// Every optional field is written explicitly (as null) so bulk inserts always have the same columns.
export const eventToRow = (e: MatchEvent): EventRow => ({
  id: e.id, match_id: e.matchId, seq: e.seq, period: e.period, minute: e.minute, second: e.second,
  type: e.type, team_id: e.teamId, player_id: e.playerId ?? null, other_player_id: e.otherPlayerId ?? null,
  x: e.x, y: e.y, end_x: e.endX ?? null, end_y: e.endY ?? null,
  outcome: e.outcome ?? null, xg: e.xg ?? null, pass_distance: e.passDistance ?? null,
  pass_difficulty: e.passDifficulty ?? null, speed_kmh: e.speedKmh ?? null,
  card_color: e.cardColor ?? null, pressure_intensity: e.pressureIntensity ?? null,
});
export const rowToEvent = (r: EventRow): MatchEvent => ({
  id: r.id, matchId: r.match_id, seq: r.seq, period: r.period, minute: r.minute, second: r.second,
  type: r.type, teamId: r.team_id, playerId: r.player_id ?? undefined, otherPlayerId: r.other_player_id ?? undefined,
  x: r.x, y: r.y, endX: r.end_x ?? undefined, endY: r.end_y ?? undefined,
  outcome: r.outcome ?? undefined, xg: r.xg ?? undefined, passDistance: r.pass_distance ?? undefined,
  passDifficulty: r.pass_difficulty ?? undefined, speedKmh: r.speed_kmh ?? undefined,
  cardColor: r.card_color ?? undefined, pressureIntensity: r.pressure_intensity ?? undefined,
});

export interface FatigueRow { match_id: string; player_id: string; minute: number; energy: number }
export const fatigueToRow = (f: FatigueSample): FatigueRow => ({
  match_id: f.matchId, player_id: f.playerId, minute: f.minute, energy: f.energy,
});
export const rowToFatigue = (r: FatigueRow): FatigueSample => ({
  matchId: r.match_id, playerId: r.player_id, minute: r.minute, energy: r.energy,
});