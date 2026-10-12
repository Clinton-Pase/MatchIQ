// src/lib/ai/service.ts
// The one function the website calls to get a report. It decides:
//   - is the request valid, and is the match known?
//   - is there already a stored report? (then no model is called at all)
//   - is an identical request already being worked on? (then wait for it instead of starting another)
//   - did the models fail a moment ago? (then do not hammer them again straight away)
// Only complete, verified, non-degraded reports are stored.

import type { FatigueSource } from "../datasource/fatigue";
import type { MatchDataSource } from "../datasource/types";
import { loadMatchContext } from "../intelligence/context";
import { modelConfigFromEnv, type LLMClient, type ModelConfig } from "./llm";
import { generateReport } from "./orchestrator";
import { bucketSeq, reportKey, type ReportStore } from "./report-cache";
import { LANGUAGES, PERSONAS, type OverlayJson, type ReportMode, type ReportSettings } from "./types";

export class RequestError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

export interface ReportRequest {
  matchId: string;
  settings: ReportSettings;
  upToSeq?: number;          // live mode: the match as it stood after this event
}

export interface ReportResponse {
  overlay: OverlayJson;
  cached: boolean;
}

export interface ServiceOptions {
  models?: ModelConfig;
  liveBucket?: number;         // live reports are cut every N events (default 150)
  failureCooldownMs?: number;  // after a degraded report, serve it from memory this long (default 60s)
  maxCalls?: number;           // model calls allowed for one report (default 10)
  now?: () => number;
  log?: (msg: string) => void;
}

const MODES: ReportMode[] = ["live", "halftime", "autopsy"];

export class ReportService {
  private inflight = new Map<string, Promise<ReportResponse | null>>();
  private recentFailures = new Map<string, { until: number; overlay: OverlayJson }>();
  private readonly models: ModelConfig;
  private readonly liveBucket: number;
  private readonly cooldown: number;
  private readonly now: () => number;

  constructor(
    private readonly ds: MatchDataSource & FatigueSource,
    private readonly store: ReportStore,
    private readonly llm: LLMClient,
    private readonly options: ServiceOptions = {},
  ) {
    this.models = options.models ?? modelConfigFromEnv();
    this.liveBucket = options.liveBucket ?? 150;
    this.cooldown = options.failureCooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Checks the request and returns the cut-off point that will really be used (undefined = whole match). */
  async plan(req: ReportRequest): Promise<{ upToSeq: number | undefined; key: string }> {
    const s = req.settings;
    if (!MODES.includes(s.mode)) throw new RequestError(`mode must be one of: ${MODES.join(", ")}`);
    if (!PERSONAS.includes(s.persona)) throw new RequestError(`persona must be one of: ${PERSONAS.join(", ")}`);
    if (!(s.language in LANGUAGES)) throw new RequestError(`language must be one of: ${Object.keys(LANGUAGES).join(", ")}`);
    if (!/^[\w-]+$/.test(req.matchId)) throw new RequestError("invalid match id");

    const match = await this.ds.getMatch(req.matchId);
    if (!match) throw new RequestError("match not found", 404);

    let upToSeq: number | undefined;
    if (s.mode === "live") {
      if (!Number.isFinite(req.upToSeq) || (req.upToSeq as number) < 1) throw new RequestError("live mode needs upToSeq (a positive event number)");
      upToSeq = bucketSeq(req.upToSeq as number, this.liveBucket);
    } else if (s.mode === "halftime") {
      const events = await this.ds.getEvents(req.matchId);
      const ht = events.find((e) => e.type === "half_time");
      if (!ht) throw new RequestError("this match has no half-time yet");
      upToSeq = ht.seq;
    } else if (match.status !== "finished") {
      throw new RequestError("the match autopsy is only available once the match is finished");
    }
    return { upToSeq, key: reportKey(req.matchId, s, upToSeq, `${this.llm.name}:${this.models.smart}`) };
  }

  async get(req: ReportRequest): Promise<ReportResponse> {
    const { upToSeq, key } = await this.plan(req);

    const stored = await this.store.get(key);
    if (stored) return { overlay: stored, cached: true };

    const failure = this.recentFailures.get(key);
    if (failure && failure.until > this.now()) return { overlay: failure.overlay, cached: false };

    let job = this.inflight.get(key);
    if (!job) {
      job = this.build(req, upToSeq, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    const out = await job;
    if (!out) throw new RequestError("match not found", 404);
    return out;
  }

  private async build(req: ReportRequest, upToSeq: number | undefined, key: string): Promise<ReportResponse | null> {
    const ctx = await loadMatchContext(this.ds, req.matchId, upToSeq);
    if (!ctx) return null;
    const { overlay } = await generateReport(ctx, this.llm, { settings: req.settings, models: this.models, maxCalls: this.options.maxCalls });
    if (overlay.meta.degraded) {
      this.recentFailures.set(key, { until: this.now() + this.cooldown, overlay });
      this.options.log?.(`report ${key} degraded: ${overlay.meta.notes.join(" | ")}`);
    } else {
      this.recentFailures.delete(key);
      await this.store.put(key, overlay);
    }
    return { overlay, cached: false };
  }
}
