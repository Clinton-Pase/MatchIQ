// src/lib/ai/report-cache.ts
// Remembers finished reports. A report only depends on the match, the cut-off point, the viewer's settings and
// the model, so the same request always gets the same answer without calling the model again.

import type { SupabaseClient } from "@supabase/supabase-js";
import { withRetry } from "../db/retry";
import type { Id } from "../datasource/types";
import type { OverlayJson, ReportSettings } from "./types";

/** Live reports are cut every `bucket` events, so a viewer scrubbing through a match does not create thousands of reports. */
export function bucketSeq(seq: number, bucket: number): number {
  if (bucket <= 1) return Math.max(1, Math.floor(seq));
  return Math.max(bucket, Math.floor(seq / bucket) * bucket);
}

export function reportKey(matchId: Id, settings: ReportSettings, upToSeq: number | undefined, modelTag: string): string {
  return [
    matchId, settings.mode, settings.persona, settings.language,
    settings.favoriteTeamId ?? "-", settings.focusPlayerId ?? "-",
    upToSeq === undefined ? "full" : `seq${upToSeq}`, modelTag,
  ].join("|");
}

export interface ReportStore {
  get(key: string): Promise<OverlayJson | null>;
  put(key: string, overlay: OverlayJson): Promise<void>;
}

export class MemoryReportStore implements ReportStore {
  readonly map = new Map<string, OverlayJson>();
  async get(key: string) { return this.map.get(key) ?? null; }
  async put(key: string, overlay: OverlayJson) { this.map.set(key, overlay); }
}

/** Server only: reads and writes with the service key. A cache failure must never break a request, so errors are swallowed. */
export class SupabaseReportStore implements ReportStore {
  constructor(private readonly db: SupabaseClient, private readonly onError: (msg: string) => void = () => {}) {}

  async get(key: string): Promise<OverlayJson | null> {
    try {
      const res = await withRetry<{ data: { overlay: OverlayJson } | null; error: { message: string } | null }>(
        "get report", () => this.db.from("reports").select("overlay").eq("key", key).maybeSingle(), { tries: 3, quiet: true },
      );
      return res.data?.overlay ?? null;
    } catch (err) {
      this.onError(`report cache read failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async put(key: string, overlay: OverlayJson): Promise<void> {
    try {
      await withRetry<{ error: { message: string } | null }>(
        "save report",
        () => this.db.from("reports").upsert({ key, match_id: overlay.matchId, mode: overlay.mode, llm: overlay.meta.llm, overlay }),
        { tries: 3, quiet: true },
      );
    } catch (err) {
      this.onError(`report cache write failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
