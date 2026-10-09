// src/lib/db/retry.ts
// Retries a Supabase call when the NETWORK drops (e.g. "TypeError: fetch failed").
// Real database errors (bad data, missing table, wrong key) are NOT retried: they fail immediately with the real message.

export function isNetworkError(message: string): boolean {
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket|network|timed? ?out|\b(502|503|504)\b/i.test(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T extends { error: { message: string } | null }>(
  label: string,
  fn: () => PromiseLike<T>,
  opts: { tries?: number; delayMs?: number; quiet?: boolean } = {},
): Promise<T> {
  const tries = opts.tries ?? 8;
  const delayMs = opts.delayMs ?? 1000;

  for (let attempt = 1; ; attempt++) {
    let message: string;
    try {
      const res = await fn();
      if (!res.error) return res;
      message = res.error.message;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    if (!isNetworkError(message)) throw new Error(`${label} failed: ${message}`);
    if (attempt >= tries) throw new Error(`${label} failed after ${tries} tries (network): ${message}`);
    if (!opts.quiet) console.log(`  network hiccup on ${label}, retry ${attempt}/${tries - 1}...`);
    await sleep(Math.min(delayMs * attempt, 8000));
  }
}