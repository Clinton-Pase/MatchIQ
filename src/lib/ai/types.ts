// src/lib/ai/types.ts
// The shared vocabulary of the AI layer: what the viewer can choose, what the agents pass to each other,
// and the overlay JSON that the app (and any broadcast graphics tool) reads.

import type { Id } from "../datasource/types";
import type { FactValue, MomentType } from "../intelligence/moments";

export type Persona = "fan" | "analyst" | "coach" | "beginner";
export const PERSONAS: Persona[] = ["fan", "analyst", "coach", "beginner"];

export type Language = "en" | "pcm" | "fr" | "es" | "pt" | "yo" | "sw";
export const LANGUAGES: Record<Language, string> = {
  en: "English",
  pcm: "Nigerian Pidgin",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  yo: "Yoruba",
  sw: "Swahili",
};

export type ReportMode = "live" | "halftime" | "autopsy";

export type AgentName = "analyst" | "narrator" | "personalizer" | "ask";

export interface ReportSettings {
  mode: ReportMode;
  persona: Persona;
  language: Language;
  favoriteTeamId?: Id;
  focusPlayerId?: Id;
}

// ---- What the agents hand to each other -----------------------------------------------------------

export type PickRole = "opening" | "turning_point" | "decider" | "cost" | "warning" | "highlight";

export interface AnalystPick {
  momentId: string;
  role: PickRole;
  angle: string;          // one line telling the Narrator what this moment is really about
}
export interface AnalystOutput {
  storyline: string;      // one sentence: the story of the match so far
  picks: AnalystPick[];
}

export interface NarratedItem {
  momentId: string;
  measured: string;       // only things the data shows; every number must come from the moment's facts
  interpretation: string; // what it might mean; no numbers allowed
  lowerThird?: string;    // short on-screen caption (the Personalizer fills it in the viewer's language)
}
export interface NarratorOutput {
  headline: string;
  summary: string;
  items: NarratedItem[];
}

// ---- The overlay JSON (the product's output contract) --------------------------------------------------

export const OVERLAY_SCHEMA = "matchiq.overlay/1";

export interface OverlayItem {
  id: string;
  momentId: string;
  type: MomentType;
  role: PickRole;
  clock: string;
  seq: number;
  teamId?: Id;
  playerId?: Id;
  lowerThird: string;                 // short caption for on-screen graphics
  measured: string;                   // "Measured": facts from the data
  interpretation: string;             // "AI interpretation": may be empty
  evidence: Id[];                     // event ids behind the claim (click-to-evidence)
  facts: Record<string, FactValue>;   // the numbers behind the claim
  verified: true;                     // an item only ships if it passed the Verifier
  source: "ai" | "fallback";          // fallback = the Verifier rejected the AI text, plain data text used
}

export interface OverlayJson {
  schema: typeof OVERLAY_SCHEMA;
  matchId: Id;
  mode: ReportMode;
  clock: string;
  score: { home: number; away: number; homeTeam: string; awayTeam: string };
  complete: boolean;
  settings: ReportSettings;
  headline: string;
  summary: string;
  storyline: string;
  items: OverlayItem[];
  meta: {
    llm: string;
    degraded: boolean;                // true if any stage fell back
    calls: number;
    inputTokens: number;
    outputTokens: number;
    notes: string[];
  };
}

// ---- The run record shared by every agent ----------------------------------------------------------------

export type StageName = "ingest" | "interpret" | "explain" | "personalize" | "render";

export interface TraceEntry {
  stage: StageName;
  agent?: AgentName;
  attempt: number;
  ok: boolean;
  ms: number;
  note: string;
}

export interface RunState {
  stages: Partial<Record<StageName, "done" | "fallback" | "skipped">>;
  trace: TraceEntry[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  notes: string[];
}
