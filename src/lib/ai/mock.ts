// src/lib/ai/mock.ts
// A stand-in language model that needs no API key and no network. It writes the report straight from the
// detected facts. Used for: tests, offline development, and as the safety net if the real API is ever
// unavailable or over budget (the app then still works, in plain English, with the same verified facts).

import type { LLMClient, LLMRequest, LLMResponse } from "./llm";

const INTERPRETATION: Record<string, string> = {
  goal: "A goal like this changes what both sides need to do for the rest of the match.",
  penalty_miss: "Missing from the spot can swing belief and pressure in a way the scoreboard does not show.",
  big_chance: "Chances this good usually come from a defence that was stretched or caught out of shape.",
  red_card: "Playing a man down forces a team to defend deeper and gives up the initiative.",
  manager_call: "This looks like a moment where a fresh pair of legs could have helped the team.",
  momentum_shift: "The balance of the match appears to have tipped, which often follows a change in shape or energy.",
  press_spell: "Sustained pressing like this is hard to keep up and can tire a team out.",
  control_spell: "Long calm spells of possession can be a way of slowing the match down on purpose.",
  key_pass: "A pass this demanding suggests the player saw something the defence did not.",
};

const ROLE_BY_TYPE: Record<string, string> = {
  goal: "turning_point", penalty_miss: "turning_point", big_chance: "highlight", red_card: "turning_point",
  manager_call: "warning", momentum_shift: "turning_point", press_spell: "highlight", control_spell: "highlight", key_pass: "highlight",
};

type Json = Record<string, any>;

/** First sentence, cut at a word boundary so a number is never sliced in half. */
function caption(text: string, max = 80): string {
  const first = text.split(/(?<=[.!?])\s/)[0];
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[,;:\s]+$/, "");
}

export function mockAnswer(req: LLMRequest): string {
  const p = JSON.parse(req.user) as Json;
  if (req.agent === "analyst") {
    const cands = (p.candidates as Json[]).slice();
    const mandatory = cands.filter((c) => c.mandatory);
    const others = cands.filter((c) => !c.mandatory).sort((a, b) => b.importance - a.importance);
    const chosen = [...mandatory, ...others].slice(0, p.maxPicks).sort((a, b) => cands.indexOf(a) - cands.indexOf(b));
    return JSON.stringify({
      storyline: p.matchComplete ? "A match shaped by a handful of decisive moments." : "A match that is still taking shape.",
      picks: chosen.map((c) => ({ momentId: c.momentId, role: ROLE_BY_TYPE[c.type] ?? "highlight", angle: c.headline })),
    });
  }
  if (req.agent === "narrator") {
    const moments = p.moments as Json[];
    return JSON.stringify({
      headline: moments[0]?.headline ?? "Match report",
      summary: `${p.match.home} ${p.match.score} ${p.match.away} at ${p.match.clock}.`,
      items: moments.map((m) => ({ momentId: m.momentId, measured: m.reason, interpretation: INTERPRETATION[m.type] ?? "" })),
    });
  }
  if (req.agent === "personalizer") {
    const r = p.report as Json;
    // A pretend translation: tag the text with the language code (it contains no digits, so no number changes).
    const tag = (t: string) => (p.targetLanguage && p.targetLanguage !== "en" ? `[${p.targetLanguage}] ${t}` : t);
    return JSON.stringify({
      headline: tag(r.headline),
      summary: tag(r.summary),
      items: (r.items as Json[]).map((i) => ({
        ...i,
        measured: tag(i.measured),
        interpretation: i.interpretation ? tag(i.interpretation) : i.interpretation,
        lowerThird: i.lowerThird ?? tag(caption(String(i.measured))),
      })),
    });
  }
  throw new Error(`mock has no answer for agent "${req.agent}"`);
}

export class MockLLMClient implements LLMClient {
  readonly name = "mock";
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const text = mockAnswer(req);
    return { text, model: "mock", inputTokens: Math.ceil(req.user.length / 4), outputTokens: Math.ceil(text.length / 4) };
  }
}
