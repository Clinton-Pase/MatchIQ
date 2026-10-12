// src/lib/ai/openai-compat.test.ts
// Run with:  npx tsx --test "src/**/*.test.ts"
// No real API is called: the network is replaced by a fake.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseProvider, createLLM } from "./factory";
import { modelConfigFromEnv, type LLMRequest } from "./llm";
import { OpenAICompatClient } from "./openai-compat";

const req: LLMRequest = { agent: "narrator", model: "some-model", system: "s", user: "u", maxTokens: 50 };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const ok = { model: "some-model-001", choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 7, completion_tokens: 2 } };

test("openai-compatible client: sends the standard request and reads text and token usage", async () => {
  let seen: any;
  const c = new OpenAICompatClient({ apiKey: "k", baseUrl: "https://example.test/v1/", label: "demo", sleep: async () => {}, fetchImpl: (async (url: string, init: any) => { seen = { url, init }; return reply(200, ok); }) as any });
  const res = await c.complete(req);
  assert.equal(c.name, "demo");
  assert.equal(res.text, "hello");
  assert.equal(res.inputTokens, 7);
  assert.equal(res.outputTokens, 2);
  assert.equal(seen.url, "https://example.test/v1/chat/completions");
  assert.equal(seen.init.headers.authorization, "Bearer k");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "some-model");
  assert.deepEqual(body.messages, [{ role: "system", content: "s" }, { role: "user", content: "u" }]);
});

test("openai-compatible client: free tiers rate-limit, so 429 is retried and retry-after is honoured", async () => {
  let n = 0;
  const waits: number[] = [];
  const c = new OpenAICompatClient({ apiKey: "k", baseUrl: "https://x.test", sleep: async (ms) => void waits.push(ms), fetchImpl: (async () => (++n === 1 ? reply(429, { error: "slow" }, { "retry-after": "3" }) : reply(200, ok))) as any });
  assert.equal((await c.complete(req)).text, "hello");
  assert.equal(n, 2);
  assert.deepEqual(waits, [3000]);
});

test("openai-compatible client: a bad key or model name fails at once with the API's message", async () => {
  let n = 0;
  const c = new OpenAICompatClient({ apiKey: "k", baseUrl: "https://x.test", label: "demo", sleep: async () => {}, fetchImpl: (async () => { n++; return reply(401, "bad token"); }) as any });
  await assert.rejects(() => c.complete(req), /demo API 401.*bad token/);
  assert.equal(n, 1);
});

test("openai-compatible client: network failures are retried then reported plainly", async () => {
  let n = 0;
  const c = new OpenAICompatClient({ apiKey: "k", baseUrl: "https://x.test", label: "demo", tries: 3, sleep: async () => {}, fetchImpl: (async () => { n++; throw new TypeError("fetch failed"); }) as any });
  await assert.rejects(() => c.complete(req), /network problem talking to demo.*gave up after 3 tries/);
  assert.equal(n, 3);
});

test("openai-compatible client: an empty reply is returned as empty text (the agent will ask again)", async () => {
  const c = new OpenAICompatClient({ apiKey: "k", baseUrl: "https://x.test", sleep: async () => {}, fetchImpl: (async () => reply(200, { choices: [{ message: { content: null } }] })) as any });
  assert.equal((await c.complete(req)).text, "");
});

test("openai-compatible client: refuses to start without a key or address", () => {
  assert.throws(() => new OpenAICompatClient({ apiKey: "", baseUrl: "https://x.test" }), /LLM_API_KEY/);
  assert.throws(() => new OpenAICompatClient({ apiKey: "k", baseUrl: "" }), /LLM_BASE_URL/);
});

test("factory: the provider is chosen from the keys that are present", () => {
  assert.equal(chooseProvider({}), "mock");
  assert.equal(chooseProvider({ ANTHROPIC_API_KEY: "a" }), "anthropic");
  assert.equal(chooseProvider({ LLM_API_KEY: "k", LLM_BASE_URL: "https://x.test" }), "openai");
  assert.equal(chooseProvider({ LLM_API_KEY: "k" }), "mock", "a key without an address is not enough");
  assert.equal(chooseProvider({ ANTHROPIC_API_KEY: "a", LLM_API_KEY: "k", LLM_BASE_URL: "u", LLM_PROVIDER: "openai" }), "openai", "LLM_PROVIDER wins");
  assert.equal(chooseProvider({ ANTHROPIC_API_KEY: "a", LLM_PROVIDER: "mock" }), "mock");
  assert.throws(() => chooseProvider({ LLM_PROVIDER: "gpt" }), /LLM_PROVIDER must be/);
  assert.equal(createLLM({}).name, "mock");
  assert.equal(createLLM({ LLM_API_KEY: "k", LLM_BASE_URL: "https://x.test", LLM_LABEL: "github" }).name, "github");
});

test("model names: one name can serve both jobs when the provider has one free model", () => {
  assert.deepEqual(modelConfigFromEnv({ MATCHIQ_MODEL_SMART: "m1" }), { smart: "m1", cheap: "m1" });
  assert.deepEqual(modelConfigFromEnv({ MATCHIQ_MODEL_SMART: "m1", MATCHIQ_MODEL_CHEAP: "m2" }), { smart: "m1", cheap: "m2" });
  assert.deepEqual(modelConfigFromEnv({}), { smart: "claude-sonnet-5-5", cheap: "claude-haiku-5-5" });
});

test("openai-compatible client: thinking models get extra token room, and reasoning effort is sent only when set", async () => {
  const bodies: any[] = [];
  const f = (async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return reply(200, ok); }) as any;
  await new OpenAICompatClient({ apiKey: "k", baseUrl: "https://x.test", fetchImpl: f }).complete(req);
  assert.equal(bodies[0].max_tokens, 50 + 2500);
  assert.equal("reasoning_effort" in bodies[0], false);
  await new OpenAICompatClient({ apiKey: "k", baseUrl: "https://x.test", fetchImpl: f, tokenHeadroom: 100, reasoningEffort: "low" }).complete(req);
  assert.equal(bodies[1].max_tokens, 150);
  assert.equal(bodies[1].reasoning_effort, "low");
});
