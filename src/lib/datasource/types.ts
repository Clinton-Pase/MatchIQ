// src/lib/datasource/types.ts
// The shared vocabulary for the whole app. Every other module imports from here.

export type Id = string;

// Pitch coordinates run 0-100 on both axes.
// x: 0 = own goal line, 100 = opponent goal line (the team is always attacking left to right).
// y: 0 = left touchline, 100 = right touchline.

export type EventType =
  | "kickoff"
  | "pass"
  | "shot"
  | "tackle"
  | "interception"
  | "duel"
  | "pressure"
  | "possession_change"
  | "foul"
  | "card"
  | "substitution"
  | "half_time"
  | "full_time";

export type EventOutcome =
  | "success"
  | "fail"
  | "goal"
  | "saved"
  | "blocked"
  | "off_target"
  | "post";

export interface MatchEvent {
  id: Id;
  matchId: Id;
  seq: number;            // strict order within the match, starting at 1
  period: 1 | 2;
  minute: number;         // 0-45+ and 45-90+
  second: number;         // 0-59
  type: EventType;
  teamId: Id;             // team performing the action
  playerId?: Id;          // main player involved
  otherPlayerId?: Id;     // pass receiver, player tackled, player coming on
  x: number;
  y: number;
  endX?: number;          // pass end point
  endY?: number;
  outcome?: EventOutcome;
  xg?: number;            // shots only, 0-1
  passDistance?: number;  // metres
  passDifficulty?: number; // 0-1, higher is harder
  speedKmh?: number;      // ball speed for passes and shots
  cardColor?: "yellow" | "red";
  pressureIntensity?: number; // 0-1 for pressure events
}

export interface Team {
  id: Id;
  name: string;           // fictional club
  shortName: string;      // 3 letters
  colorPrimary: string;
  colorSecondary: string;
  style: "high_press" | "possession" | "counter" | "direct";
}

export type Position = "GK" | "DF" | "MF" | "FW";

export interface Player {
  id: Id;
  teamId: Id;
  name: string;           // fictional player
  shirtNumber: number;
  position: Position;
  stamina: number;        // 0-1, drives fatigue in the simulator
  quality: number;        // 0-1, drives pass and shot success
}

export interface Match {
  id: Id;
  season: string;         // e.g. "2026/27"
  round: number;
  homeTeamId: Id;
  awayTeamId: Id;
  kickoffAt: string;      // ISO date
  venue: string;
  status: "scheduled" | "live" | "finished";
  homeScore: number;
  awayScore: number;
  seed?: number;          // simulator seed, so a match can be regenerated exactly
}

export interface LineupEntry {
  matchId: Id;
  playerId: Id;
  teamId: Id;
  role: "starter" | "bench" | "unused";
}

// Anything that can supply match data implements this one interface.
// Today: the synthetic simulator. Later: a licensed real-world API adapter.
export interface MatchDataSource {
  listMatches(filter?: { teamId?: Id; status?: Match["status"] }): Promise<Match[]>;
  getMatch(matchId: Id): Promise<Match | null>;
  getTeams(): Promise<Team[]>;
  getPlayers(teamId?: Id): Promise<Player[]>;
  getLineup(matchId: Id): Promise<LineupEntry[]>;
  getEvents(matchId: Id, range?: { fromSeq?: number; toSeq?: number }): Promise<MatchEvent[]>;
  streamEvents(matchId: Id, opts?: { speed?: number }): AsyncIterable<MatchEvent>;
}