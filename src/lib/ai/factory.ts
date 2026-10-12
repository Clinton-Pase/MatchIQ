// src/lib/ai/factory.ts
// Chooses the language model from environment variables, so switching provider never touches code.
//   LLM_PROVIDER=anthropic | openai | mock      (optional; if missing it is guessed from the keys present)
//   anthropic: ANTHROPIC_API_KEY
//   openai:    LLM_API_KEY + LLM_BASE_URL   (+ LLM_LABEL), for GitHub Models, Gemini, Groq, OpenRouter...
//   models:    MATCHIQ_MODEL_SMART / MATCHIQ_MODEL_CHEAP   (names are provider-specific)

import { AnthropicClient, type LLMClient } from "./llm";
import { MockLLMClient } from "./mock";
import { OpenAICompatClient } from "./openai-compat";

export type ProviderChoice = "anthropic" | "openai" | "mock";

export function chooseProvider(env: Record<string, string | undefined> = process.env): ProviderChoice {
  const forced = env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "anthropic" || forced === "openai" || forced === "mock") return forced;
  if (forced) throw new Error(`LLM_PROVIDER must be anthropic, openai or mock (got "${forced}")`);
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.LLM_API_KEY && env.LLM_BASE_URL) return "openai";
  return "mock";
}

export function createLLM(env: Record<string, string | undefined> = process.env): LLMClient {
  const choice = chooseProvider(env);
  if (choice === "anthropic") return AnthropicClient.fromEnv(env);
  if (choice === "openai") return OpenAICompatClient.fromEnv(env);
  return new MockLLMClient();
}
