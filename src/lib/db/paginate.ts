// src/lib/db/paginate.ts
// Supabase returns at most 1,000 rows per request, and one match has ~1,700 events.
// This reads every page (and retries dropped connections) so callers get the full list.

import { withRetry } from "./retry";

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 1000,
  label = "query",
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const res = await withRetry(label, () => fetchPage(from, from + pageSize - 1));
    const page = res.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
