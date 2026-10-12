// src/lib/ai/verifier.ts
// The Verifier agent. Pure code, no AI, so it cannot be talked into anything.
// The rule of the whole product: the AI may explain, but it may never invent a fact.
//   - Every number in a "measured" sentence must be one of the numbers in the evidence (the moment's facts).
//   - An "interpretation" may not contain numbers at all (numbers belong to measurements).
//   - A sentence may only name players and clubs that appear in the moment it is about, or the two clubs playing.
// An item that breaks a rule never reaches the screen: the Narrator is asked to fix it, and if it still fails
// the plain data text is used instead.

import type { MatchContext } from "../intelligence/context";
import type { KeyMoment } from "../intelligence/moments";
import type { NarratedItem, NarratorOutput } from "./types";

export type Field = "measured" | "interpretation" | "lowerThird" | "headline" | "summary";

export interface Violation {
  momentId?: string;      // undefined = about the headline or summary
  field: Field;
  problem: string;
}

const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const WORD_RE = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join("|")})\\b`, "gi");
const NUM_RE = /\d+(?:[.,]\d+)?/g;

const decimals = (s: string) => (s.includes(".") ? s.split(".")[1].length : 0);
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Every number found in a piece of text, as written (digits) or spelled out in English (two..ninety). */
export function numbersIn(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const raw = m[0].replace(",", ".");
    out.push({ raw, value: Number(raw) });
  }
  for (const m of text.matchAll(WORD_RE)) out.push({ raw: m[0], value: WORD_NUMBERS[m[1].toLowerCase()] });
  return out;
}

/**
 * The numbers a sentence about these moments is allowed to use:
 * the moment's facts, its clock, and every number in the detector's own sentence (headline and reason).
 * That sentence is written by code from the events, so its numbers (e.g. "35% chance" from 0.35 xG, or the
 * start and end of a spell) are computed evidence, not AI output. Anything else is rejected.
 */
export function allowedNumbers(moments: KeyMoment[], extra: number[] = []): number[] {
  const set = new Set<number>(extra);
  for (const m of moments) {
    set.add(m.minute);
    for (const n of numbersIn(m.clock)) set.add(n.value);
    for (const n of numbersIn(`${m.headline} ${m.reason}`)) set.add(n.value);
    for (const v of Object.values(m.facts)) {
      if (typeof v === "number") set.add(v);
      else if (typeof v === "string") for (const n of numbersIn(v)) set.add(n.value);
    }
  }
  return [...set];
}

function numberAllowed(raw: string, value: number, allowed: number[]): boolean {
  const d = decimals(raw);
  return allowed.some((a) => a === value || round(a, d) === value);
}

/** Checks numbers only. Returns a problem description or null. */
export function checkNumbers(text: string, kind: "measured" | "interpretation", allowed: number[]): string | null {
  const nums = numbersIn(text);
  if (kind === "interpretation") {
    return nums.length ? `contains the number "${nums[0].raw}"; an interpretation must not contain numbers` : null;
  }
  const bad = nums.find((n) => !numberAllowed(n.raw, n.value, allowed));
  return bad ? `uses the number "${bad.raw}", which is not in the evidence` : null;
}

// ---- Names ----------------------------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text: string, word: string) => new RegExp(`(^|[^\\p{L}])${escapeRe(word)}($|[^\\p{L}])`, "u").test(text);

/** Text that is allowed to name people: the moment's own sentences and facts, plus the two club names. */
function namePool(moments: KeyMoment[], ctx: MatchContext): string {
  const parts: string[] = [];
  for (const t of [ctx.match.homeTeamId, ctx.match.awayTeamId]) parts.push(ctx.teams.get(t)?.name ?? "");
  for (const m of moments) {
    parts.push(m.headline, m.reason);
    for (const v of Object.values(m.facts)) if (typeof v === "string") parts.push(v);
    if (m.playerId) parts.push(ctx.players.get(m.playerId)?.name ?? "");
    if (m.teamId) parts.push(ctx.teams.get(m.teamId)?.name ?? "");
  }
  return parts.join(" \n ");
}

export function checkNames(text: string, moments: KeyMoment[], ctx: MatchContext): string | null {
  const pool = namePool(moments, ctx);
  for (const p of ctx.players.values()) {
    const parts = p.name.split(/\s+/);
    const surname = parts[parts.length - 1];
    if (hasWord(text, p.name) && !hasWord(pool, p.name)) return `names "${p.name}", who is not part of this moment`;
    if (surname.length >= 4 && hasWord(text, surname) && !hasWord(pool, surname)) return `names "${surname}", who is not part of this moment`;
  }
  for (const t of ctx.teams.values()) {
    if (hasWord(text, t.name) && !hasWord(pool, t.name)) return `names "${t.name}", who is not part of this moment`;
  }
  return null;
}

// ---- Putting it together ----------------------------------------------------------------------------

export interface VerifyInput {
  ctx: MatchContext;
  moments: Map<string, KeyMoment>;     // the moments the narration is allowed to use
  expectedIds: string[];               // the moments it must cover, once each
  scoreNumbers: number[];              // the current score is always allowed
  requireLowerThird?: boolean;
}

const LIMITS = { measured: 420, interpretation: 320, lowerThird: 90, headline: 120, summary: 360 };

function checkItemText(
  field: "measured" | "interpretation" | "lowerThird",
  text: string | undefined,
  moments: KeyMoment[],
  allowed: number[],
  ctx: MatchContext,
  momentId: string,
  out: Violation[],
  required = true,
) {
  if (text === undefined || text.trim() === "") {
    if (field === "measured" || (field === "lowerThird" && required)) out.push({ momentId, field, problem: "is empty" });
    return;
  }
  if (text.length > LIMITS[field]) out.push({ momentId, field, problem: `is too long (${text.length} characters, limit ${LIMITS[field]})` });
  const numProblem = checkNumbers(text, field === "interpretation" ? "interpretation" : "measured", allowed);
  if (numProblem) out.push({ momentId, field, problem: numProblem });
  const nameProblem = checkNames(text, moments, ctx);
  if (nameProblem) out.push({ momentId, field, problem: nameProblem });
}

export function verifyNarration(out: NarratorOutput, v: VerifyInput): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const item of out.items) {
    if (seen.has(item.momentId)) violations.push({ momentId: item.momentId, field: "measured", problem: "appears twice" });
    seen.add(item.momentId);
  }
  for (const id of v.expectedIds) if (!seen.has(id)) violations.push({ momentId: id, field: "measured", problem: "is missing from the output" });
  for (const id of seen) if (!v.expectedIds.includes(id)) violations.push({ momentId: id, field: "measured", problem: "is not one of the requested moments" });

  const all = v.expectedIds.map((id) => v.moments.get(id)).filter((m): m is KeyMoment => !!m);
  for (const item of out.items) {
    const m = v.moments.get(item.momentId);
    if (!m || !v.expectedIds.includes(item.momentId)) continue;
    const allowed = allowedNumbers([m], v.scoreNumbers);
    checkItemText("measured", item.measured, [m], allowed, v.ctx, item.momentId, violations);
    checkItemText("interpretation", item.interpretation, [m], allowed, v.ctx, item.momentId, violations, false);
    checkItemText("lowerThird", item.lowerThird, [m], allowed, v.ctx, item.momentId, violations, !!v.requireLowerThird);
  }

  const allAllowed = allowedNumbers(all, v.scoreNumbers);
  for (const [field, text] of [["headline", out.headline], ["summary", out.summary]] as const) {
    if (!text || !text.trim()) { violations.push({ field, problem: "is empty" }); continue; }
    if (text.length > LIMITS[field]) violations.push({ field, problem: `is too long (${text.length} characters, limit ${LIMITS[field]})` });
    const np = checkNumbers(text, "measured", allAllowed);
    if (np) violations.push({ field, problem: np });
    const nm = checkNames(text, all, v.ctx);
    if (nm) violations.push({ field, problem: nm });
  }
  return violations;
}

export const failingMomentIds = (vs: Violation[]): Set<string> =>
  new Set(vs.filter((x) => x.momentId).map((x) => x.momentId as string));

export const describeViolations = (vs: Violation[]): string[] =>
  vs.map((x) => `${x.momentId ? `moment ${x.momentId}` : "output"} → ${x.field} ${x.problem}`);

export type { NarratedItem };
