// src/lib/ai/openai-compat.ts
// A second doorway to a language model: any service that speaks the "OpenAI chat completions" format.
// That covers most free tiers (GitHub Models, Google Gemini's compatibility endpoint, Groq, OpenRouter, Mistral...).
// The agents, the Verifier and the orchestrator do not change: only the LLMClient behind them.
// Server-side only: the key must never reach the browser.

import type { LLMClient, LLMRequest, LLMResponse } from "./llm";

export interface OpenAICompatOptions {
  apiKey: string;
  baseUrl: string;               // e.g. https://models.github.ai/inference  (the client adds /chat/completions)
  label?: string;                // shown in reports: "github", "gemini"...
  tokenHeadroom?: number;        // extra tokens added to every max_tokens: "thinking" models spend them on reasoning first
  reasoningEffort?: string;      // optional: "low" / "medium" / "high" / "minimal" / "none" (sent only if set)
  timeoutMs?: number;
  tries?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class OpenAICompatClient implements LLMClient {
  readonly name: string;
  private o: Required<Omit<OpenAICompatOptions, "label" | "reasoningEffort">> & Pick<OpenAICompatOptions, "reasoningEffort">;

  constructor(options: OpenAICompatOptions) {
    if (!options.apiKey) throw new Error("LLM_API_KEY is missing. Add it to .env.local (never commit that file).");
    if (!options.baseUrl) throw new Error("LLM_BASE_URL is missing. Add it to .env.local (see .env.example).");
    this.name = options.label ?? "openai-compatible";
    this.o = {
      tokenHeadroom: 2500,
      timeoutMs: 90_000,
      tries: 4,
      baseDelayMs: 1500,
      fetchImpl: (...a: Parameters<typeof fetch>) => fetch(...a),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
    };
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): OpenAICompatClient {
    return new OpenAICompatClient({
      apiKey: env.LLM_API_KEY ?? "",
      baseUrl: env.LLM_BASE_URL ?? "",
      label: env.LLM_LABEL || "openai-compatible",
      reasoningEffort: env.LLM_REASONING_EFFORT || undefined,
      ...(env.LLM_TOKEN_HEADROOM && Number.isFinite(Number(env.LLM_TOKEN_HEADROOM)) ? { tokenHeadroom: Number(env.LLM_TOKEN_HEADROOM) } : {}),
    });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = req.model;
    let lastErr = "unknown error";
    for (let attempt = 1; attempt <= this.o.tries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
      let retryAfterMs = 0;
      try {
        const res = await this.o.fetchImpl(`${this.o.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
          body: JSON.stringify({
            model,
            max_tokens: req.maxTokens + this.o.tokenHeadroom,
            temperature: 0.3,
            ...(this.o.reasoningEffort ? { reasoning_effort: this.o.reasoningEffort } : {}),
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          const body = (await res.json()) as {
            model?: string;
            choices?: { message?: { content?: string | null } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const text = body.choices?.[0]?.message?.content ?? "";
          return { text, model: body.model ?? model, inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
        }
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        lastErr = `${this.name} API ${res.status}: ${detail}`;
        if (!RETRY_STATUS.has(res.status)) throw new FatalApiError(lastErr);   // bad key, bad model name: do not retry
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 20_000);
      } catch (err) {
        if (err instanceof FatalApiError) throw new Error(err.message);
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes(" API ")) lastErr = `network problem talking to ${this.name}: ${msg}`;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.o.tries) await this.o.sleep(retryAfterMs || this.o.baseDelayMs * 2 ** (attempt - 1));
    }
    throw new Error(`${lastErr} (gave up after ${this.o.tries} tries)`);
  }
}

class FatalApiError extends Error {}
