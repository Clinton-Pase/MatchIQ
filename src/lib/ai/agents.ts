// src/lib/ai/agents.ts
// The three language agents: Analyst (what matters), Narrator (what happened and why), Personalizer (for whom).
// Each one: builds a JSON payload from the shared state, calls the model, validates the reply's shape,
// and retries with the exact problem when the reply is not usable.
// The fourth agent, the Verifier, is plain code in verifier.ts.

import { extractJson, JsonError, type LLMClient, type LLMRequest } from "./llm";
import { ANALYST_SYSTEM, NARRATOR_SYSTEM, personalizerSystem } from "./prompts";
import type {
  AgentName, AnalystOutput, AnalystPick, Language, NarratedItem, NarratorOutput, PickRole, Persona, RunState, StageName,
} from "./types";
import type { KeyMoment } from "../intelligence/moments";

export class ValidationError extends Error {}
export class BudgetError extends Error {}

const ROLES: PickRole[] = ["opening", "turning_point", "decider", "cost", "warning", "highlight"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Models occasionally emit zero-width or control characters; they can glue words together on screen. */
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]+/g, " ").replace(/ {2,}/g, " ").trim();
}
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new ValidationError(`${what} must be a string`);
  return cleanText(v);
};

// ---- Shape validators ----------------------------------------------------------------------------------

export function validateAnalyst(raw: unknown, candidateIds: Set<string>, mandatoryIds: Set<string>, maxPicks: number): AnalystOutput {
  if (!isObj(raw)) throw new ValidationError("the reply must be a JSON object");
  const storyline = str(raw.storyline, "storyline");
  if (!Array.isArray(raw.picks) || raw.picks.length === 0) throw new ValidationError("picks must be a non-empty array");
  const picks: AnalystPick[] = [];
  const seen = new Set<string>();
  for (const p of raw.picks) {
    if (!isObj(p)) throw new ValidationError("each pick must be an object");
    const momentId = str(p.momentId, "momentId");
    if (!candidateIds.has(momentId)) throw new ValidationError(`momentId "${momentId}" is not one of the candidates`);
    if (seen.has(momentId)) throw new ValidationError(`momentId "${momentId}" was picked twice`);
    seen.add(momentId);
    const role = str(p.role, "role") as PickRole;
    if (!ROLES.includes(role)) throw new ValidationError(`role "${role}" is not one of ${ROLES.join(", ")}`);
    picks.push({ momentId, role, angle: str(p.angle ?? "", "angle") });
  }
  if (picks.length > maxPicks) throw new ValidationError(`too many picks (${picks.length}); the limit is ${maxPicks}`);
  for (const id of mandatoryIds) if (!seen.has(id)) throw new ValidationError(`mandatory moment "${id}" was not picked`);
  return { storyline, picks };
}

export function validateNarration(raw: unknown, withLowerThird: boolean): NarratorOutput {
  if (!isObj(raw)) throw new ValidationError("the reply must be a JSON object");
  const headline = str(raw.headline, "headline");
  const summary = str(raw.summary, "summary");
  if (!Array.isArray(raw.items)) throw new ValidationError("items must be an array");
  const items: NarratedItem[] = raw.items.map((it) => {
    if (!isObj(it)) throw new ValidationError("each item must be an object");
    const item: NarratedItem = {
      momentId: str(it.momentId, "momentId"),
      measured: str(it.measured, "measured"),
      interpretation: str(it.interpretation ?? "", "interpretation"),
    };
    if (withLowerThird) item.lowerThird = str(it.lowerThird, "lowerThird");
    return item;
  });
  return { headline, summary, items };
}

// ---- The call wrapper: budget, tokens, trace, retry on bad replies -----------------------------------------

export interface AgentEnv {
  llm: LLMClient;
  state: RunState;
  maxCalls: number;
  now?: () => number;
}

export async function callAgent<T>(
  env: AgentEnv,
  meta: { stage: StageName; agent: AgentName; model: string; system: string; maxTokens: number },
  payload: Record<string, unknown>,
  validate: (raw: unknown) => T,
  extraChecks: (value: T) => string[] = () => [],
  maxRetries = 2,
): Promise<T> {
  const now = env.now ?? Date.now;
  let problems: string[] = [];
  let lastError = "no attempt made";
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (env.state.calls >= env.maxCalls) throw new BudgetError(`call budget of ${env.maxCalls} reached`);
    const req: LLMRequest = {
      agent: meta.agent, model: meta.model, system: meta.system, maxTokens: meta.maxTokens,
      user: JSON.stringify(problems.length ? { ...payload, problemsToFix: problems } : payload),
    };
    const t0 = now();
    env.state.calls++;
    try {
      const res = await env.llm.complete(req);
      env.state.inputTokens += res.inputTokens;
      env.state.outputTokens += res.outputTokens;
      const value = validate(extractJson(res.text));
      const found = extraChecks(value);
      if (found.length) {
        problems = found;
        lastError = found[0];
        env.state.trace.push({ stage: meta.stage, agent: meta.agent, attempt, ok: false, ms: now() - t0, note: `rejected: ${found.length} problem(s), first: ${found[0]}` });
        continue;
      }
      env.state.trace.push({ stage: meta.stage, agent: meta.agent, attempt, ok: true, ms: now() - t0, note: "ok" });
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fixable = err instanceof ValidationError || err instanceof JsonError;
      env.state.trace.push({ stage: meta.stage, agent: meta.agent, attempt, ok: false, ms: now() - t0, note: msg.slice(0, 200) });
      if (!fixable) throw err;                     // network / auth / model errors are not fixed by asking again
      problems = [msg];
      lastError = msg;
    }
  }
  throw new ValidationError(`${meta.agent} could not produce a usable reply: ${lastError}`);
}

// ---- The agents ------------------------------------------------------------------------------------------------

const factsView = (m: KeyMoment) => ({
  momentId: m.id, type: m.type, clock: m.clock, headline: m.headline, reason: m.reason, facts: m.facts,
});

export interface MatchBrief {
  home: string;
  away: string;
  score: string;           // "2-1"
  clock: string;
  matchComplete: boolean;
}

export async function runAnalyst(
  env: AgentEnv,
  model: string,
  brief: MatchBrief,
  candidates: KeyMoment[],
  mandatoryIds: Set<string>,
  maxPicks: number,
): Promise<AnalystOutput> {
  const ids = new Set(candidates.map((c) => c.id));
  return callAgent(
    env,
    { stage: "interpret", agent: "analyst", model, system: ANALYST_SYSTEM, maxTokens: 900 },
    {
      match: brief, matchComplete: brief.matchComplete, maxPicks,
      candidates: candidates.map((c) => ({ ...factsView(c), importance: c.score, mandatory: mandatoryIds.has(c.id) })),
    },
    (raw) => validateAnalyst(raw, ids, mandatoryIds, maxPicks),
  );
}

/** One Narrator draft. The orchestrator verifies it and, if needed, calls again with `priorProblems`. */
export async function runNarrator(
  env: AgentEnv,
  model: string,
  brief: MatchBrief,
  analysis: AnalystOutput,
  moments: Map<string, KeyMoment>,
  priorProblems: string[] = [],
): Promise<NarratorOutput> {
  const ordered = analysis.picks.map((p) => ({ ...factsView(moments.get(p.momentId)!), role: p.role, angle: p.angle }));
  return callAgent(
    env,
    { stage: "explain", agent: "narrator", model, system: NARRATOR_SYSTEM, maxTokens: 2000 },
    { match: brief, matchComplete: brief.matchComplete, storyline: analysis.storyline, moments: ordered, ...(priorProblems.length ? { problemsToFix: priorProblems } : {}) },
    (raw) => validateNarration(raw, false),
    () => [],
    1,
  );
}

export async function runPersonalizer(
  env: AgentEnv,
  model: string,
  settings: { persona: Persona; language: Language; favoriteTeamName?: string },
  brief: MatchBrief,
  report: NarratorOutput,
  check: (out: NarratorOutput) => string[],
): Promise<NarratorOutput> {
  return callAgent(
    env,
    { stage: "personalize", agent: "personalizer", model, system: personalizerSystem(settings.persona, settings.language, settings.favoriteTeamName), maxTokens: 2400 },
    { match: brief, targetLanguage: settings.language, persona: settings.persona, report },
    (raw) => validateNarration(raw, true),
    check,
    2,
  );
}
