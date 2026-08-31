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
 * The three free-text client fields this app may edit, and the ONLY three:
 * the whitelist is enforced server-side (in /api/client-field and by this
 * module's types), never trusted from a browser. All three are plain
 * strings on the Client record per docs/mindbody-openapi/client.yml --
 * `Notes`, `RedAlert` (~line 6339) and `YellowAlert` (~line 6343) sit on
 * `ClientWithSuspensionInfo`, which is exactly the schema
 * `UpdateClientRequest.Client` references (~line 7076), so all three are
 * writable through the same envelope.
 */
export const EDITABLE_CLIENT_FIELDS = [
  "Notes",
  "RedAlert",
  "YellowAlert",
] as const;

export type EditableClientField = (typeof EDITABLE_CLIENT_FIELDS)[number];

/**
 * Save ONE free-text field on a client record: `POST /client/updateclient`
 * (spec: docs/mindbody-openapi/client.yml, `UpdateClientRequest`).
 *
 * The envelope is `{Client: {...}}` with flags alongside, and two of the
 * spec's facts shape this payload:
 *
 * - The payload is SURGICAL, deliberately: per the schema, "any specified
 *   values are updated", so every field present on the nested Client is a
 *   field this call may overwrite. It sends the client's `Id` (the lookup
 *   key) and the ONE whitelisted field and NOTHING else -- one field per
 *   save, never `Liability` (the one-line waiver write the design doc
 *   restricts to recordLiabilityRelease below), never names, never
 *   contact fields.
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
export async function updateClientField(
  clientId: string,
  field: EditableClientField,
  value: string,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const res = await mindbody("/client/updateclient", {
    method: "POST",
    body: {
      Client: { Id: clientId, [field]: value },
      CrossRegionalUpdate: false,
    },
    clientId,
  });
  if (res?.DryRun) return { suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { suppressed: "write-guard" };
  return { suppressed: null };
}

/** The notes save, as the one-field write above. Kept named because the
 *  waiver receipt append (/api/waiver-agree) is a NOTES write by design
 *  and should read as one at its call site. */
export async function updateClientNotes(
  clientId: string,
  notes: string,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  return updateClientField(clientId, "Notes", notes);
}

/**
 * Record a liability release: `POST /client/updateclient` with
 * `LiabilityRelease: true` (T18, Pete's recorded reversal of the T6 "no
 * tap path marks a waiver signed" rule -- Mindbody's own POS shows the
 * waiver text with a staff-tappable Resolve, and this matches it).
 *
 * Spec-verified in docs/mindbody-openapi/client.yml: `UpdateClientRequest`
 * holds `{Client, Test, CrossRegionalUpdate, NewId, LeadChannelId}`, and
 * `LiabilityRelease` is a boolean ON THE NESTED CLIENT
 * (`ClientWithSuspensionInfo.LiabilityRelease`), not top-level on the
 * request. Per its schema description, passing `true` sets
 * `Liability.IsReleased`, stamps `AgreementDate` in the business's time
 * zone, and records `ReleasedBy` as the calling staff member. The
 * `Liability` sub-object itself is never sent: the flag is the documented
 * write path and anything more would overwrite fields Mindbody owns.
 *
 * Same surgical discipline as updateClientNotes above, for the same
 * reason: updateclient overwrites whatever the payload carries, so this
 * sends the id, the flag, `CrossRegionalUpdate: false`, and nothing else
 * -- never Notes (the receipt append is a separate call through
 * updateClientNotes). The clientId rides mindbody()'s options for the
 * POS_WRITE_CLIENT_IDS guard; suppression is reported, never dressed as
 * success. The CALLER must only invoke this after the real waiver text
 * was shown and read to the end -- that gate lives in the dialog, and
 * this function is deliberately not reachable from anywhere else.
 */
export async function recordLiabilityRelease(
  clientId: string,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const res = await mindbody("/client/updateclient", {
    method: "POST",
    body: {
      Client: { Id: clientId, LiabilityRelease: true },
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
  /**
   * Context carried FREE from the search: `searchText` returns full Client
   * records, so the same fields the roster's batched lookup extracts ride
   * along at zero extra calls. Parsed identically to `briefsForIds` in
   * src/lib/roster.ts so a walk-in row and a roster row cannot disagree
   * about the same person.
   */
  /** `Liability.IsReleased`; false means no released waiver on file. */
  waiverSigned: boolean;
  /** `RedAlert` free text; null when none. Information behind the row's
   *  info icon since T20, not a gate. */
  redAlert: string | null;
  /** `YellowAlert` free text; null when none. Same standing as redAlert. */
  yellowAlert: string | null;
  /** `AccountBalance`; null when Mindbody omitted it. */
  balance: number | null;
  /** `MembershipIcon` nonzero. */
  member: boolean;
  /** Staff `Notes`; null when none. */
  notes: string | null;
  /** Mindbody's numeric `UniqueId`, for staff web app links. */
  mindbodyId: number | null;
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
  /* Pete's fifth live test: a search once rendered EVERY row as
   * "(unnamed)" and recovered on the next search, with no way to see what
   * came back. The rows are counted here so a repeat leaves a trace in
   * the server log even after the dev drawer's buffer has rolled. */
  let nameless = 0;
  for (const row of body?.Clients ?? []) {
    if (row?.Id === null || row?.Id === undefined) continue;
    const name = `${row.FirstName ?? ""} ${row.LastName ?? ""}`.trim();
    if (!name) nameless += 1;
    results.push({
      id: String(row.Id),
      /* An email beats "(unnamed)": a nameless row is still a person the
       * teacher may need to pick. */
      name: name || (typeof row.Email === "string" ? row.Email : "") ||
        "(unnamed)",
      email: row.Email ?? null,
      waiverSigned: Boolean(row?.Liability?.IsReleased),
      redAlert:
        typeof row?.RedAlert === "string" && row.RedAlert.trim()
          ? row.RedAlert.trim()
          : null,
      yellowAlert:
        typeof row?.YellowAlert === "string" && row.YellowAlert.trim()
          ? row.YellowAlert.trim()
          : null,
      balance:
        typeof row?.AccountBalance === "number" &&
        Number.isFinite(row.AccountBalance)
          ? row.AccountBalance
          : null,
      member:
        typeof row?.MembershipIcon === "number" && row.MembershipIcon !== 0,
      notes:
        typeof row?.Notes === "string" && row.Notes.trim()
          ? row.Notes.trim()
          : null,
      mindbodyId: typeof row?.UniqueId === "number" ? row.UniqueId : null,
    });
  }
  if (results.length > 0 && nameless === results.length) {
    /* Keys only, never values: this line goes to a server log. If it ever
     * appears, the shape Mindbody returned is the question, and the dev
     * drawer holds the same call's raw body. */
    const first = (body?.Clients ?? [])[0];
    console.warn(
      `[search] every one of ${results.length} results came back without a ` +
        `name for query length ${q.length}; row keys: ` +
        `${first ? Object.keys(first).join(",") : "none"}`,
    );
  }
  return { results };
}
