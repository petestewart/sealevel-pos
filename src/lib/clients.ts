import { mindbody } from "./mindbody";

/**
 * In-memory client index for type-ahead search.
 *
 * Searching Mindbody per keystroke would be one metered API call per letter
 * and ~500ms of latency each (measured: /client/clients round-trips in
 * 400-900ms). The whole client list is a few thousand rows, so it is pulled
 * once at first use and searched locally, which is the difference between
 * finding a walk-in instantly and watching a spinner with a line waiting.
 *
 * No database on purpose. A cold start costs one full pull; if that ever
 * becomes annoying, a Redis or volume-backed snapshot is a detail, not an
 * architecture change.
 */

export interface IndexedClient {
  id: string;
  name: string;
  email: string | null;
  /** Lowercased name + email, for matching. */
  haystack: string;
}

const REFRESH_MS = 6 * 60 * 60 * 1000;
const PAGE_LIMIT = 200;

let index: IndexedClient[] = [];
let loadedAt = 0;
let inFlight: Promise<void> | null = null;

async function pull(): Promise<void> {
  const collected: IndexedClient[] = [];
  let offset = 0;
  for (;;) {
    const body = await mindbody(
      `/client/clients?limit=${PAGE_LIMIT}&offset=${offset}`,
    );
    const rows: any[] = body?.Clients ?? [];
    for (const row of rows) {
      const id = row?.Id;
      if (id === null || id === undefined) continue;
      const name = `${row.FirstName ?? ""} ${row.LastName ?? ""}`.trim();
      const email = row.Email ?? null;
      collected.push({
        id: String(id),
        name: name || "(unnamed)",
        email,
        haystack: `${name} ${email ?? ""}`.toLowerCase(),
      });
    }
    const total = body?.PaginationResponse?.TotalResults;
    offset += rows.length;
    if (rows.length === 0 || (typeof total === "number" && offset >= total)) {
      break;
    }
  }
  index = collected;
  loadedAt = Date.now();
}

export async function ensureIndex(): Promise<void> {
  if (index.length > 0 && Date.now() - loadedAt < REFRESH_MS) return;
  /** One pull at a time: a cold start with several tabs open should not
   *  fan out into several full client sweeps. */
  inFlight ??= pull().finally(() => {
    inFlight = null;
  });
  await inFlight;
}

export interface SearchResult extends IndexedClient {
  score: number;
}

/**
 * Prefix matches rank above substring matches, because at a counter people
 * type the beginning of a name. Everything else is alphabetical so the list
 * does not reshuffle as the teacher types.
 */
export function search(query: string, limit = 12): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: SearchResult[] = [];
  for (const client of index) {
    const at = client.haystack.indexOf(q);
    if (at < 0) continue;
    const startsWord = at === 0 || client.haystack[at - 1] === " ";
    out.push({ ...client, score: startsWord ? 0 : 1 });
    if (out.length > 400) break;
  }
  return out
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Display name for a client id, or null when the index has no such row. */
export function nameFor(clientId: string): string | null {
  return index.find((c) => c.id === clientId)?.name ?? null;
}

export function indexSize(): number {
  return index.length;
}
