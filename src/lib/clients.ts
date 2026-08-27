import { mindbody } from "./mindbody";

/**
 * Client search, straight through to Mindbody's own `searchText`.
 *
 * There was an in-memory index here: every client paged into memory at
 * server start, searched locally, instant and free per query. It was
 * deleted, and the reasoning is worth keeping so it does not get rebuilt
 * by reflex.
 *
 * - The warm-up cost ~30 metered API calls on every server start and every
 *   six hours after, to save calls on maybe a hundred searches a day. It
 *   plausibly cost more calls than it saved.
 * - A six-hour-old index cannot contain a client created ten minutes ago,
 *   and a brand-new client is exactly who a teacher searches for at the
 *   counter. The index was stalest about the case it most needed to serve.
 * - `searchText` answers in 400-900ms, which measured fast enough in the
 *   hand. The latency win was real but not worth the other two.
 *
 * If search ever needs to be instant, the answer is probably a warm cache
 * of RECENT clients rather than all of them.
 */

export interface SearchResult {
  id: string;
  name: string;
  email: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
}

export async function search(
  query: string,
  limit = 12,
): Promise<SearchResponse> {
  const q = query.trim();
  if (q.length < 2) return { results: [] };

  const body = await mindbody(
    `/client/clients?searchText=${encodeURIComponent(q)}&limit=${limit}`,
  );
  const results: SearchResult[] = [];
  for (const row of body?.Clients ?? []) {
    if (row?.Id === null || row?.Id === undefined) continue;
    const name = `${row.FirstName ?? ""} ${row.LastName ?? ""}`.trim();
    results.push({
      id: String(row.Id),
      name: name || "(unnamed)",
      email: row.Email ?? null,
    });
  }
  return { results };
}
