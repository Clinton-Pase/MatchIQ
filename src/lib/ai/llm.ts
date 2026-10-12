// src/lib/ai/llm.ts
// The one doorway to a language model. Everything else in the app talks to the LLMClient interface,
// so the model (or the provider) can change without touching an agent.
// Server-side only: the API key must never reach the browser.

import type { AgentName } from "./types";

export interface LLMRequest {
  agent: AgentName;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMClient {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export interface ModelConfig {
  smart: string;   // agents that reason and write (Analyst, Narrator, Ask)
  cheap: string;   // cheap, fast jobs (Personalizer / translation)
}

export function modelConfigFromEnv(env: Record<string, string | undefined> = process.env): ModelConfig {
  // Defaults are Claude model names. With another provider, set MATCHIQ_MODEL_SMART / MATCHIQ_MODEL_CHEAP
  // to that provider's model names (the same name may be used for both).
  return {
    smart: env.MATCHIQ_MODEL_SMART || "claude-sonnet-5-5",
    cheap: env.MATCHIQ_MODEL_CHEAP || env.MATCHIQ_MODEL_SMART || "claude-haiku-5-5",
  };
}

// ---- Pulling JSON out of a model reply ------------------------------------------------------------------

export class JsonError extends Error {}

/** Models sometimes wrap JSON in ```json fences or add a sentence before it. Take the first complete object. */
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  if (start === -1) throw new JsonError("no JSON object found in the reply");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch (err) {
        throw new JsonError(`the JSON is malformed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  throw new JsonError("the JSON object was cut off (never closed)");
}

// ---- The Claude API client ----------------------------------------------------------------------------------

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  tries?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;     // injected in tests
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class AnthropicClient implements LLMClient {
  readonly name = "anthropic";
  private o: Required<Omit<AnthropicOptions, "apiKey">> & { apiKey: string };

  constructor(options: AnthropicOptions) {
    if (!options.apiKey) throw new Error("ANTHROPIC_API_KEY is missing. Add it to .env.local (never commit that file).");
    this.o = {
      baseUrl: "https://api.anthropic.com",
      timeoutMs: 60_000,
      tries: 4,
      baseDelayMs: 1000,
      fetchImpl: (...a: Parameters<typeof fetch>) => fetch(...a),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      ...options,
    };
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): AnthropicClient {
    return new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY ?? "" });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    let lastErr = "unknown error";
    for (let attempt = 1; attempt <= this.o.tries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
      let retryAfterMs = 0;
      try {
        const res = await this.o.fetchImpl(`${this.o.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.o.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          const body = (await res.json()) as {
            model?: string;
            content?: { type: string; text?: string }[];
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
          return { text, model: body.model ?? req.model, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
        }
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        lastErr = `Claude API ${res.status}: ${detail}`;
        if (!RETRY_STATUS.has(res.status)) throw new Error(lastErr);   // a real error (bad key, bad model name): do not retry
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 20_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("Claude API ") && !RETRY_STATUS.has(Number(msg.split(" ")[2]?.replace(":", "")))) throw err;
        lastErr = msg.startsWith("Claude API ") ? msg : `network problem talking to Claude: ${msg}`;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.o.tries) await this.o.sleep(retryAfterMs || this.o.baseDelayMs * 2 ** (attempt - 1));
    }
    throw new Error(`${lastErr} (gave up after ${this.o.tries} tries)`);
  }
}
