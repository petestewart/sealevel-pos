import { mindbody } from "./mindbody";

/**
 * Client search.
 *
 * Two paths, because neither alone is good enough:
 *
 * - **Local index.** The whole client list held in memory and searched
 *   there, which makes a search instant and costs no metered API call. The
 *   right steady state at a counter.
 * - **Mindbody `searchText`.** One call, 400-900ms, no warm-up needed. The
 *   right answer before the index is ready.
 *
 * The first version had only the local index and paid for it: the first
 * search of a session blocked on paging the entire client list, dozens of
 * sequential round trips, while a teacher watched an empty box. Now the
 * index warms in the background from server start, and any search arriving
 * before it is ready goes straight to Mindbody. Nobody waits for the
 * warm-up, and once it lands, searches stop costing API calls.
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
/** Pages in flight at once: enough to make the warm-up quick, few enough
 *  to stay polite to a metered API. */
const PAGE_CONCURRENCY = 4;

let index: IndexedClient[] = [];
let loadedAt = 0;
let warming: Promise<void> | null = null;

function toIndexed(row: any): IndexedClient | null {
  const id = row?.Id;
  if (id === null || id === undefined) return null;
  const name = `${row.FirstName ?? ""} ${row.LastName ?? ""}`.trim();
  const email = row.Email ?? null;
  return {
    id: String(id),
    name: name || "(unnamed)",
    email,
    haystack: `${name} ${email ?? ""}`.toLowerCase(),
  };
}

async function fetchPage(offset: number): Promise<{ rows: any[]; total: number }> {
  const body = await mindbody(
    `/client/clients?limit=${PAGE_LIMIT}&offset=${offset}`,
  );
  return {
    rows: body?.Clients ?? [],
    total: body?.PaginationResponse?.TotalResults ?? 0,
  };
}

async function pull(): Promise<void> {
  /**
   * The first page reports the total, after which the rest go out in
   * parallel rather than one at a time. On a few thousand clients that is
   * the difference between a warm-up measured in minutes and one measured
   * in seconds.
   */
  const first = await fetchPage(0);
  const collected: IndexedClient[] = [];
  for (const row of first.rows) {
    const client = toIndexed(row);
    if (client) collected.push(client);
  }

  const offsets: number[] = [];
  for (let o = PAGE_LIMIT; o < first.total; o += PAGE_LIMIT) offsets.push(o);

  for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
    const batch = offsets.slice(i, i + PAGE_CONCURRENCY);
    const results = await Promise.all(batch.map((o) => fetchPage(o)));
    for (const result of results) {
      for (const row of result.rows) {
        const client = toIndexed(row);
        if (client) collected.push(client);
      }
    }
  }

  index = collected;
  loadedAt = Date.now();
  console.info(`[clients] index ready: ${index.length} clients`);
}

/** Whether the local index can answer searches right now. */
export function indexReady(): boolean {
  return index.length > 0 && Date.now() - loadedAt < REFRESH_MS;
}

/**
 * Start the warm-up if it is not already running or fresh. Deliberately
 * not awaited by callers: a search must never block on it.
 */
export function warmIndex(): void {
  if (indexReady() || warming) return;
  warming = pull()
    .catch((err) => {
      console.warn("[clients] index warm-up failed:", err);
    })
    .finally(() => {
      warming = null;
    });
}

export interface SearchResult {
  id: string;
  name: string;
  email: string | null;
}

/**
 * Prefix matches rank above substring matches, because at a counter people
 * type the beginning of a name. Everything else is alphabetical so the list
 * does not reshuffle as the teacher types.
 */
function searchIndex(query: string, limit: number): SearchResult[] {
  const q = query.toLowerCase();
  const scored: { client: IndexedClient; score: number }[] = [];
  for (const client of index) {
    const at = client.haystack.indexOf(q);
    if (at < 0) continue;
    const startsWord = at === 0 || client.haystack[at - 1] === " ";
    scored.push({ client, score: startsWord ? 0 : 1 });
    if (scored.length > 400) break;
  }
  return scored
    .sort(
      (a, b) => a.score - b.score || a.client.name.localeCompare(b.client.name),
    )
    .slice(0, limit)
    .map(({ client }) => ({
      id: client.id,
      name: client.name,
      email: client.email,
    }));
}

async function searchMindbody(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const body = await mindbody(
    `/client/clients?searchText=${encodeURIComponent(query)}&limit=${limit}`,
  );
  const out: SearchResult[] = [];
  for (const row of body?.Clients ?? []) {
    const client = toIndexed(row);
    if (client) {
      out.push({ id: client.id, name: client.name, email: client.email });
    }
  }
  return out;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Which path answered, so slow searches are explicable. */
  source: "index" | "mindbody";
  indexed: number;
}

export async function search(
  query: string,
  limit = 12,
): Promise<SearchResponse> {
  const q = query.trim();
  if (q.length < 2) {
    return { results: [], source: "index", indexed: index.length };
  }

  warmIndex();
  if (indexReady()) {
    return {
      results: searchIndex(q, limit),
      source: "index",
      indexed: index.length,
    };
  }
  return {
    results: await searchMindbody(q, limit),
    source: "mindbody",
    indexed: index.length,
  };
}

export function indexSize(): number {
  return index.length;
}
