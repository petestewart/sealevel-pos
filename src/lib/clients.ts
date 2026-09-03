import { mindbody, type Actor } from "./mindbody";

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
  /** T49: the signed-in teacher to save as, when there is one. */
  actor?: Actor | null,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const res = await mindbody("/client/updateclient", {
    method: "POST",
    body: {
      Client: { Id: clientId, [field]: value },
      CrossRegionalUpdate: false,
    },
    clientId,
    ...(actor ? { actor } : {}),
  });
  if (res?.DryRun) return { suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { suppressed: "write-guard" };
  return { suppressed: null };
}

/**
 * T53: the email opt-in, written from the counter (Pete: "a teacher can
 * ask them if they want to opt in to emails and receive an email
 * receipt"). The three EMAIL consent flags are the only ones Mindbody
 * lets an API caller set: `SendAccountEmails`, `SendPromotionalEmails`
 * and `SendScheduleEmails` are "editable" on ClientWithSuspensionInfo
 * (client.yml:5286-5306), while the three text flags say "cannot be
 * updated by developers. If included in a request, it is ignored", so
 * they are not in this type and can never be sent.
 *
 * Same surgical envelope as updateClientField: the id, ONLY the flags
 * the caller decided, `CrossRegionalUpdate: false`, nothing else, since
 * updateclient overwrites whatever it is given. An empty `flags` is
 * refused here rather than sent as a no-op write.
 */
export interface ConsentFlags {
  SendAccountEmails?: boolean;
  SendPromotionalEmails?: boolean;
  SendScheduleEmails?: boolean;
}

export const CONSENT_EMAIL_FLAGS = [
  "SendAccountEmails",
  "SendPromotionalEmails",
  "SendScheduleEmails",
] as const;

export async function updateClientConsent(
  clientId: string,
  flags: ConsentFlags,
  actor?: Actor | null,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const sent: Record<string, boolean> = {};
  for (const key of CONSENT_EMAIL_FLAGS) {
    if (typeof flags[key] === "boolean") sent[key] = flags[key];
  }
  if (Object.keys(sent).length === 0) {
    throw new Error("updateClientConsent needs at least one email flag.");
  }
  const res = await mindbody("/client/updateclient", {
    method: "POST",
    body: {
      Client: { Id: clientId, ...sent },
      CrossRegionalUpdate: false,
    },
    clientId,
    ...(actor ? { actor } : {}),
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
  actor?: Actor | null,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  return updateClientField(clientId, "Notes", notes, actor);
}

/**
 * T62: the client's current `Notes`, for a server-side append. The
 * waiver receipt takes the row's notes from the browser; the record that
 * falls back from a Formula Note (src/lib/formulanote.ts) has no row in
 * hand and reads them itself, one `/client/clients?clientIds=` call,
 * because `updateclient` writes the field whole and an append must start
 * from what is there. Empty string when the client has none; throws when
 * the read fails or the client is not found, so the caller never writes
 * over notes it did not see.
 */
export async function readClientNotes(clientId: string): Promise<string> {
  const body = await mindbody(
    `/client/clients?clientIds=${encodeURIComponent(clientId)}&limit=1`,
  );
  const row = (body?.Clients ?? []).find(
    (c: { Id?: unknown }) => String(c?.Id ?? "") === clientId,
  );
  if (!row) throw new Error(`client ${clientId} not found`);
  return typeof row.Notes === "string" ? row.Notes : "";
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
  /** T49: the signed-in teacher to release as, when there is one; the
   *  schema says `ReleasedBy` records the calling staff member, which
   *  is exactly what a teacher's token changes. */
  actor?: Actor | null,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const res = await mindbody("/client/updateclient", {
    method: "POST",
    body: {
      Client: { Id: clientId, LiabilityRelease: true },
      CrossRegionalUpdate: false,
    },
    clientId,
    ...(actor ? { actor } : {}),
  });
  if (res?.DryRun) return { suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { suppressed: "write-guard" };
  return { suppressed: null };
}

export interface SearchResult {
  id: string;
  name: string;
  email: string | null;
  /** MobilePhone, else HomePhone, else WorkPhone; null when none. With
   *  the email it is the small line under a search result's name (T42):
   *  the studio has duplicate names, and this is how Mindbody's own
   *  search tells them apart. */
  phone: string | null;
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
  /** `PaginationResponse.TotalResults` (client.yml:6753), the size of the
   *  whole match set, so a scrolling list knows when to stop asking.
   *  Null when Mindbody omitted it; the caller then stops on a short
   *  page. */
  total: number | null;
}

/**
 * One page of matches. `offset` is `/client/clients`' own page offset
 * (client.yml:1392, "Page offset, defaults to 0"): the attach modal and
 * the walk-in search load the next page as the list scrolls (T42), and
 * every page is one metered call, so nothing here prefetches.
 */
export async function search(
  query: string,
  limit = 12,
  offset = 0,
): Promise<SearchResponse> {
  const q = query.trim();
  if (q.length < 2) return { results: [], total: 0 };

  const body = await mindbody(
    `/client/clients?searchText=${encodeURIComponent(q)}&limit=${limit}` +
      (offset > 0 ? `&offset=${offset}` : ""),
  );
  const totalRaw = body?.PaginationResponse?.TotalResults;
  const total =
    typeof totalRaw === "number" && Number.isFinite(totalRaw) ? totalRaw : null;
  const results: SearchResult[] = [];
  /* Pete's fifth live test: a search once rendered EVERY row as
   * "(unnamed)" and recovered on the next search, with no way to see what
   * came back. The rows are counted here so a repeat leaves a trace in
   * the server log even after the dev drawer's buffer has rolled. */
  let nameless = 0;
  for (const row of body?.Clients ?? []) {
    const parsed = resultOf(row);
    if (parsed === null) continue;
    if (!`${row.FirstName ?? ""} ${row.LastName ?? ""}`.trim()) nameless += 1;
    results.push(parsed);
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
  return { results, total };
}

/** The first non-empty phone in the order Mindbody's own client page
 *  reads them, mirroring clientprofile.ts. */
function phoneOf(row: {
  MobilePhone?: unknown;
  HomePhone?: unknown;
  WorkPhone?: unknown;
}): string | null {
  for (const v of [row.MobilePhone, row.HomePhone, row.WorkPhone]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * One Client record as a search result. Shared by the search above and
 * by createClient below (T59b), so a person the counter just signed up
 * renders exactly as they will on their next search.
 */
function resultOf(row: any): SearchResult | null {
  if (row?.Id === null || row?.Id === undefined) return null;
  const name = `${row.FirstName ?? ""} ${row.LastName ?? ""}`.trim();
  return {
    id: String(row.Id),
    /* An email beats "(unnamed)": a nameless row is still a person the
     * teacher may need to pick. */
    name:
      name || (typeof row.Email === "string" ? row.Email : "") || "(unnamed)",
    email: row.Email ?? null,
    phone: phoneOf(row),
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
  };
}

/**
 * T59b: the fields the sign-up form has, in Mindbody's own names, so the
 * required-field read below can say which of the site's requirements the
 * form cannot meet. `Email` and `MobilePhone` are optional on the form
 * but present, so a site requiring them is satisfied when they are
 * filled; the route makes them mandatory when Mindbody lists them.
 */
export const SIGNUP_FORM_FIELDS = [
  "FirstName",
  "LastName",
  "Email",
  "MobilePhone",
] as const;

/**
 * `GET /client/requiredclientfields` (docs/mindbody-openapi/client.yml:2359):
 * "the list of fields that a new client has to fill out in business
 * mode", the exact list `AddClient` validates against under a staff
 * token. Read once at form open (T59b). The live answer for site 471 is
 * unknown; the call is in the dev drawer whenever the form opens. A read,
 * on the service account like every other read.
 *
 * Returns the raw list and the subset the form has no input for; the
 * form shows those as an amber line and lets the teacher continue,
 * since a refusal from Mindbody is the authoritative answer and comes
 * back in plain words.
 */
export async function requiredClientFields(): Promise<{
  required: string[];
  missing: string[];
}> {
  const body = await mindbody("/client/requiredclientfields");
  const raw: unknown[] = Array.isArray(body?.RequiredClientFields)
    ? body.RequiredClientFields
    : [];
  const required = raw
    .filter((f): f is string => typeof f === "string" && f.trim() !== "")
    .map((f) => f.trim());
  const have = new Set<string>(SIGNUP_FORM_FIELDS);
  /* Mindbody's list may say "Phone" or "MobilePhone" for the one phone
   * field the form has; either is met by it. Anything else the form
   * cannot answer. */
  const missing = required.filter(
    (f) => !have.has(f) && !/^(mobile)?phone$/i.test(f),
  );
  return { required, missing };
}

export interface NewClientInput {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  sendAccountEmails: boolean;
  sendPromotionalEmails: boolean;
}

/**
 * T59b: create a client at the counter. `POST /client/addclient`
 * (docs/mindbody-openapi/client.yml:2491, `AddClientRequest` ~4709).
 * Under the signed-in teacher's token it "respects Business Mode
 * required fields", which is why the form reads requiredClientFields
 * first; and since May 2020 Mindbody refuses a duplicate, defined as
 * the same first name, last name and email.
 *
 * The payload is exactly the four fields Pete named ("first name, last
 * name, email, phone. Nothing else") plus the two T53 consent flags the
 * form asks in the same breath; both flags are sent explicitly, ticked
 * or not, so an unticked box is a recorded no rather than Mindbody's
 * default. Nothing else: not Active, not LiabilityRelease (the waiver
 * dialog is the ONLY thing that sets that, T18), no address. Property
 * names are the schema's own: FirstName, LastName, Email, MobilePhone,
 * SendAccountEmails, SendPromotionalEmails.
 *
 * The write guard: there is no client id yet, and `mindbody()` finds
 * none in the body either (it reads ClientId/ClientIds/UniqueClientId,
 * and AddClientRequest has none), so under POS_WRITE_CLIENT_IDS the call
 * is suppressed as "(none named)". That is the right answer: a dummy
 * cannot be pre-listed for its own creation, so a guarded run can never
 * create a client. Suppression is reported, never dressed as success.
 */
export async function createClient(
  input: NewClientInput,
  actor?: Actor | null,
): Promise<{
  suppressed: "dry-run" | "write-guard" | null;
  /** The new client as a search result; null when suppressed. */
  client: SearchResult | null;
}> {
  const res = await mindbody("/client/addclient", {
    method: "POST",
    body: {
      FirstName: input.firstName,
      LastName: input.lastName,
      ...(input.email ? { Email: input.email } : {}),
      ...(input.phone ? { MobilePhone: input.phone } : {}),
      SendAccountEmails: input.sendAccountEmails,
      SendPromotionalEmails: input.sendPromotionalEmails,
    },
    /* Deliberately absent: a create has no client id to name. See above. */
    clientId: undefined,
    ...(actor ? { actor } : {}),
  });
  if (res?.DryRun) return { suppressed: "dry-run", client: null };
  if (res?.WriteSuppressed) return { suppressed: "write-guard", client: null };
  const client = resultOf(res?.Client);
  if (client === null) {
    throw new Error(
      "Mindbody answered the sign-up without a client id; search for " +
        "the name before trying again.",
    );
  }
  return { suppressed: null, client };
}

/**
 * Whether a refused addclient was Mindbody's duplicate rule. The spec
 * documents the rule but not the wording; the call log holds the exact
 * message the first time it happens live, and this widens if needed.
 */
export function isDuplicateClientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate|already exist|already has|already in use/i.test(message);
}
