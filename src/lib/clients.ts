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

/**
 * Save a client's staff notes: `POST /client/updateclient` (spec:
 * docs/mindbody-openapi/client.yml, `UpdateClientRequest`).
 *
 * The envelope is `{Client: {...}}` with flags alongside, and two of the
 * spec's facts shape this payload:
 *
 * - The payload is SURGICAL, deliberately: per the schema, "any specified
 *   values are updated", so every field present on the nested Client is a
 *   field this call may overwrite. This is the app's first client-record
 *   write, and it sends the client's `Id` (the lookup key) and `Notes` and
 *   NOTHING else -- never `Liability` (the one-line waiver write the design
 *   doc forbids), never names, never contact fields.
 * - `CrossRegionalUpdate` is documented as DEFAULTING TO TRUE, which would
 *   propagate the edit to every site in the region where the client has a
 *   profile. Sent as `false` explicitly: a counter note belongs to this
 *   studio.
 *
 * `Test`, `NewId` and `LeadChannelId` are omitted as unneeded. The
 * clientId rides mindbody()'s options for the POS_WRITE_CLIENT_IDS guard
 * (the body nests it under Client, where the guard's body sniffing does
 * not look); under dry run or the guard the caller is told which fired.
 */
export async function updateClientNotes(
  clientId: string,
  notes: string,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const res = await mindbody("/client/updateclient", {
    method: "POST",
    body: {
      Client: { Id: clientId, Notes: notes },
      CrossRegionalUpdate: false,
    },
    clientId,
  });
  if (res?.DryRun) return { suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { suppressed: "write-guard" };
  return { suppressed: null };
}

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
