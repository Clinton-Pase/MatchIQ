// src/lib/ai/orchestrator.ts
// The conductor. One run goes through the five stages of the product:
//   ingest      (code)   stats + key moments from the events, candidates chosen for this viewer
//   interpret   (Analyst) which moments tell the story
//   explain     (Narrator + Verifier) neutral, fact-checked report; fixed up to N times, else plain data text
//   personalize (Personalizer + Verifier) voice, language, favorite club; if it fails, the neutral report is used
//   render      (code)   the overlay JSON
// All agents share one RunState (calls, tokens, trace). Handoffs are plain typed objects.
// Invariant: nothing unverified reaches the output, and the report is ALWAYS produced, even with no model at all.

import type { MatchContext } from "../intelligence/context";
import { detectMoments, type KeyMoment } from "../intelligence/moments";
import { computeStats } from "../intelligence/stats";
import {
  BudgetError, runAnalyst, runNarrator, runPersonalizer, type AgentEnv, type MatchBrief,
} from "./agents";
import { modelConfigFromEnv, type LLMClient, type ModelConfig } from "./llm";
import { MANDATORY_TYPES, reportSize, selectCandidates } from "./select";
import {
  LANGUAGES, OVERLAY_SCHEMA, type AnalystOutput, type NarratedItem, type NarratorOutput, type OverlayItem, type OverlayJson,
  type ReportSettings, type RunState,
} from "./types";
import { describeViolations, failingMomentIds, numbersIn, verifyNarration, type Violation } from "./verifier";

export interface ReportOptions {
  settings: ReportSettings;
  maxMoments?: number;       // how many moments the report covers (goals and red cards are always included)
  maxRepairs?: number;       // times the Narrator is asked to fix rejected items
  maxCalls?: number;         // hard cap on model calls per report (cost control)
  models?: ModelConfig;
  moments?: KeyMoment[];     // pass pre-computed moments to skip detection
}

export interface ReportResult {
  overlay: OverlayJson;
  state: RunState;
}

const newState = (): RunState => ({ stages: {}, trace: [], calls: 0, inputTokens: 0, outputTokens: 0, notes: [] });

const NEUTRAL = (s: ReportSettings) => s.persona === "analyst" && s.language === "en";

const squash = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** The Verifier cannot read languages, but it can tell when text was simply handed back unchanged. */
export function untranslated(out: NarratorOutput, source: NarratorOutput, language: ReportSettings["language"]): string[] {
  if (language === "en") return [];
  const name = LANGUAGES[language];
  const problems: string[] = [];
  const same = (a: string, b: string) => a.trim() !== "" && squash(a) === squash(b);
  if (same(out.headline, source.headline)) problems.push(`output → headline was left in English; write it in ${name}`);
  if (same(out.summary, source.summary)) problems.push(`output → summary was left in English; write it in ${name}`);
  const base = new Map(source.items.map((i) => [i.momentId, i]));
  for (const it of out.items) {
    const b = base.get(it.momentId);
    if (!b) continue;
    if (same(it.measured, b.measured)) problems.push(`moment ${it.momentId} → measured was left in English; write it in ${name}`);
    if (same(it.interpretation, b.interpretation)) problems.push(`moment ${it.momentId} → interpretation was left in English; write it in ${name}`);
  }
  return problems;
}

/** The text used when the AI text for a moment is rejected: the detector's own sentence. Always verified, by construction. */
function fallbackItem(m: KeyMoment): NarratedItem {
  return { momentId: m.id, measured: m.reason, interpretation: "", lowerThird: m.headline };
}

export async function generateReport(ctx: MatchContext, llm: LLMClient, options: ReportOptions): Promise<ReportResult> {
  const state = newState();
  const t = (stage: Parameters<typeof state.trace.push>[0]["stage"], note: string, ok = true, ms = 0) =>
    state.trace.push({ stage, attempt: 1, ok, ms, note });
  const settings = options.settings;
  const models = options.models ?? modelConfigFromEnv();
  const env: AgentEnv = { llm, state, maxCalls: options.maxCalls ?? 10 };
  const maxRepairs = options.maxRepairs ?? 2;

  // ---- ingest -------------------------------------------------------------------------------------------
  const stats = computeStats(ctx);
  const home = ctx.teams.get(ctx.match.homeTeamId)?.name ?? "Home";
  const away = ctx.teams.get(ctx.match.awayTeamId)?.name ?? "Away";
  const brief: MatchBrief = { home, away, score: `${stats.score.home}-${stats.score.away}`, clock: stats.clock, matchComplete: ctx.complete };
  // The score and the current clock are measured from the events, so a sentence may always use them.
  const scoreNumbers = [stats.score.home, stats.score.away, ...numbersIn(stats.clock).map((n) => n.value)];
  const all = options.moments ?? detectMoments(ctx);
  const candidates = selectCandidates(all, settings, 12);
  const byId = new Map(candidates.map((m) => [m.id, m]));
  const mandatory = new Set(candidates.filter((m) => MANDATORY_TYPES.has(m.type)).map((m) => m.id));
  const size = reportSize(candidates, options.maxMoments ?? 5);
  state.stages.ingest = "done";
  t("ingest", `${all.length} moments detected, ${candidates.length} candidates, report size ${size}`);

  // ---- interpret ----------------------------------------------------------------------------------------
  let analysis: AnalystOutput;
  if (candidates.length === 0) {
    analysis = { storyline: "Not much has happened yet.", picks: [] };
    state.stages.interpret = "skipped";
  } else {
    try {
      analysis = await runAnalyst(env, models.smart, brief, candidates, mandatory, size);
      state.stages.interpret = "done";
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      state.notes.push(`Analyst unavailable (${why}); the highest-scoring moments were used.`);
      state.stages.interpret = "fallback";
      const top = [...candidates].sort((a, b) => (mandatory.has(b.id) ? 1000 : b.score) - (mandatory.has(a.id) ? 1000 : a.score)).slice(0, size);
      analysis = {
        storyline: "",
        picks: top.sort((a, b) => a.seq - b.seq).map((m) => ({ momentId: m.id, role: "highlight" as const, angle: m.headline })),
      };
    }
  }
  const picked = analysis.picks.map((p) => byId.get(p.momentId)!).filter(Boolean);
  const pickedMap = new Map(picked.map((m) => [m.id, m]));
  const expectedIds = analysis.picks.map((p) => p.momentId);
  const verifyInput = { ctx, moments: pickedMap, expectedIds, scoreNumbers };

  // ---- explain: write, verify, repair ----------------------------------------------------------------------
  let narration: NarratorOutput;
  const sourceOf = new Map<string, "ai" | "fallback">();
  if (picked.length === 0) {
    narration = { headline: `${home} v ${away}`, summary: `${home} ${brief.score} ${away} at ${brief.clock}.`, items: [] };
    state.stages.explain = "skipped";
  } else {
    const accepted = new Map<string, NarratedItem>();
    let draft: NarratorOutput | null = null;
    let problems: string[] = [];
    let violations: Violation[] = [];
    let aiAvailable = true;
    for (let round = 0; round <= maxRepairs && aiAvailable; round++) {
      try {
        draft = await runNarrator(env, models.smart, brief, analysis, pickedMap, problems);
      } catch (err) {
        aiAvailable = false;
        state.notes.push(`Narrator unavailable (${err instanceof Error ? err.message : err}); plain data text used.`);
        break;
      }
      violations = verifyNarration(draft, verifyInput);
      const bad = failingMomentIds(violations);
      for (const item of draft.items) if (!bad.has(item.momentId) && pickedMap.has(item.momentId)) accepted.set(item.momentId, item);
      t("explain", `round ${round + 1}: ${accepted.size}/${expectedIds.length} items verified, ${violations.length} violation(s)`, violations.length === 0);
      if (violations.length === 0) break;
      problems = describeViolations(violations);
      // Ask only about what failed: the items that passed are kept as they are.
      if (round === maxRepairs) break;
    }
    const finalViolationsAreHeader = violations.some((v) => !v.momentId);
    for (const id of expectedIds) {
      const m = pickedMap.get(id)!;
      if (accepted.has(id)) sourceOf.set(id, "ai");
      else { accepted.set(id, fallbackItem(m)); sourceOf.set(id, "fallback"); }
    }
    const aiCount = [...sourceOf.values()].filter((s) => s === "ai").length;
    const headerOk = draft !== null && !finalViolationsAreHeader && violations.length === 0;
    narration = {
      headline: headerOk ? draft!.headline : picked[0].headline,
      summary: headerOk ? draft!.summary : `${home} ${brief.score} ${away} at ${brief.clock}.`,
      items: expectedIds.map((id) => accepted.get(id)!),
    };
    if (aiCount < expectedIds.length) state.notes.push(`${expectedIds.length - aiCount} of ${expectedIds.length} moments used plain data text because the AI text did not pass the Verifier.`);
    state.stages.explain = aiCount === expectedIds.length ? "done" : "fallback";
  }

  // ---- personalize ---------------------------------------------------------------------------------------------
  let finalText = narration;
  if (picked.length === 0 || NEUTRAL(settings)) {
    state.stages.personalize = "skipped";
  } else {
    const favoriteTeamName = settings.favoriteTeamId ? ctx.teams.get(settings.favoriteTeamId)?.name : undefined;
    try {
      finalText = await runPersonalizer(
        env, models.cheap, { persona: settings.persona, language: settings.language, favoriteTeamName }, brief, narration,
        (out) => [
          ...describeViolations(verifyNarration(out, { ...verifyInput, requireLowerThird: true })),
          ...untranslated(out, narration, settings.language),
        ],
      );
      state.stages.personalize = "done";
    } catch (err) {
      state.notes.push(`Personalizer unavailable (${err instanceof Error ? err.message : err}); the neutral English report was used.`);
      state.stages.personalize = "fallback";
      if (err instanceof BudgetError) t("personalize", "call budget reached", false);
    }
  }

  // ---- render ----------------------------------------------------------------------------------------------------
  const roleOf = new Map(analysis.picks.map((p) => [p.momentId, p.role]));
  const items: OverlayItem[] = finalText.items.map((it) => {
    const m = pickedMap.get(it.momentId)!;
    return {
      id: `${ctx.match.id}:${m.id}`,
      momentId: m.id,
      type: m.type,
      role: roleOf.get(m.id) ?? "highlight",
      clock: m.clock,
      seq: m.seq,
      teamId: m.teamId,
      playerId: m.playerId,
      lowerThird: it.lowerThird?.trim() || m.headline,
      measured: it.measured,
      interpretation: it.interpretation,
      evidence: m.evidence,
      facts: m.facts,
      verified: true as const,
      source: sourceOf.get(m.id) ?? "fallback",
    };
  }).sort((a, b) => a.seq - b.seq);
  state.stages.render = "done";

  const degraded = Object.values(state.stages).some((s) => s === "fallback");
  const overlay: OverlayJson = {
    schema: OVERLAY_SCHEMA,
    matchId: ctx.match.id,
    mode: settings.mode,
    clock: stats.clock,
    score: { home: stats.score.home, away: stats.score.away, homeTeam: home, awayTeam: away },
    complete: ctx.complete,
    settings,
    headline: finalText.headline,
    summary: finalText.summary,
    storyline: analysis.storyline,
    items,
    meta: { llm: llm.name, degraded, calls: state.calls, inputTokens: state.inputTokens, outputTokens: state.outputTokens, notes: state.notes },
  };
  return { overlay, state };
}
