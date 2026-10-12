// src/lib/ai/budget.ts
// Cost and abuse protection. The app must stay free to test, so:
//   CallBudget / BudgetedLLM  a hard daily cap on model calls (after it, reports are built from the data alone)
//   RateLimiter               a per-visitor limit on how often reports can be requested
// Both live in server memory. On a serverless host each instance has its own counters, so they are a safety net,
// not an exact meter; the report cache is what really keeps the number of model calls low.

import type { LLMClient, LLMRequest, LLMResponse } from "./llm";

export class BudgetExhaustedError extends Error {}

export class CallBudget {
  private day = "";
  private used = 0;
  constructor(private readonly dailyCap: number, private readonly now: () => number = Date.now) {}

  private roll() {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.used = 0; }
  }
  /** Takes one call from today's budget, or throws when it is spent. */
  take(): void {
    this.roll();
    if (this.used >= this.dailyCap) throw new BudgetExhaustedError(`daily limit of ${this.dailyCap} model calls reached`);
    this.used++;
  }
  get remaining(): number { this.roll(); return Math.max(0, this.dailyCap - this.used); }
}

export class BudgetedLLM implements LLMClient {
  constructor(private readonly inner: LLMClient, private readonly budget: CallBudget) {}
  get name() { return this.inner.name; }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.budget.take();
    return this.inner.complete(req);
  }
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** true if this visitor may go ahead (and counts the request), false if they must wait. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return true;
  }
}
