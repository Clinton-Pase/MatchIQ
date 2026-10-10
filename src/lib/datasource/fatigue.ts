// src/lib/datasource/fatigue.ts
// Fatigue readings are not part of the core MatchDataSource interface (real-world feeds rarely have them),
// so sources that DO have them also implement this small extra interface.

import type { Id } from "./types";
import type { FatigueSample } from "../simulator/match";

export type { FatigueSample };

export interface FatigueSource {
  getFatigue(matchId: Id): Promise<FatigueSample[]>;
}
