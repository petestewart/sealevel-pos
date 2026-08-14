/**
 * Mindbody Public API v6 client for campaigns.sync_contacts (SEA-81).
 *
 * Just enough of the API for the contact sync: issue a staff user token
 * (optional) and page GET /client/clients. Everything model-shaped here
 * was verified against a mirror of Mindbody's official v6 swagger; the
 * one thing the spec cannot prove is what a LIVE response for THIS studio
 * contains, so the sync fails loudly (never guesses) when the consent
 * field is missing -- see extractClientRecord -- and `npm run
 * mindbody:verify` exists for Pete to eyeball a real payload before
 * trusting the mapping.
 *
 * THE CONSENT FIELD (the legal question SEA-81 flags): the v6 Client
 * model carries six notification booleans -- SendAccountEmails,
 * SendPromotionalEmails, SendScheduleEmails, and their *Texts twins.
 * Promotional email opt-in is `SendPromotionalEmails` ("When true,
 * indicates that the client has opted to receive promotional
 * notifications by email"). Account/schedule emails are transactional,
 * NOT marketing consent, and must never be read as it. All six are kept
 * verbatim in contacts.mb_opt_in_raw as evidence, alongside Id/UniqueId.
 *
 * IDs: `Id` (string) is the business-facing client id -- the same id
 * space the analytics mirror's client_source_ids covers (legacy short
 * numerics, "N"-prefixed imports, and current "100000xxx"-style values),
 * so it is what contacts.mb_client_id stores and what reconciliation
 * matches on. `UniqueId` (int) is Mindbody's immutable system id; it is
 * retained in mb_opt_in_raw so a future Id rewrite by the business stays
 * recoverable, but it has no analytics-side counterpart to join to.
 *
 * Auth: Api-Key + SiteId headers on every call. A staff user token
 * (POST /usertoken/issue) is attached when MINDBODY_STAFF_USERNAME /
 * MINDBODY_STAFF_PASSWORD are set -- the swagger marks it optional for
 * GET /client/clients, but permission level affects how much comes back,
 * so configure staff credentials for production sync.
 */

/** The one field that means promotional-email consent. */
export const MINDBODY_OPT_IN_FIELD = "SendPromotionalEmails";

/** Consent-adjacent fields snapshotted verbatim into mb_opt_in_raw. */
export const MINDBODY_CONSENT_FIELDS = [
  "SendAccountEmails",
  "SendPromotionalEmails",
  "SendScheduleEmails",
  "SendAccountTexts",
  "SendPromotionalTexts",
  "SendScheduleTexts",
] as const;

/** Default page size: the documented default is 100; 200 is the commonly
 * cited maximum. PageSize in the response is what actually counts. */
export const MINDBODY_PAGE_LIMIT = 200;

export interface MindbodyEnv {
  apiKey: string;
  siteId: string;
  username?: string;
  password?: string;
  baseUrl: string;
}

/** Whether the Mindbody API is configured (the sync's on/off switch). */
export function mindbodyConfigured(): boolean {
  return Boolean(
    process.env["MINDBODY_API_KEY"] && process.env["MINDBODY_SITE_ID"],
  );
}

function mindbodyEnv(): MindbodyEnv {
  const apiKey = process.env["MINDBODY_API_KEY"] ?? "";
  const siteId = process.env["MINDBODY_SITE_ID"] ?? "";
  if (!apiKey || !siteId) {
    throw new Error(
      "Mindbody API is not configured (MINDBODY_API_KEY / MINDBODY_SITE_ID)",
    );
  }
  return {
    apiKey,
    siteId,
    username: process.env["MINDBODY_STAFF_USERNAME"] || undefined,
    password: process.env["MINDBODY_STAFF_PASSWORD"] || undefined,
    baseUrl:
      process.env["MINDBODY_API_BASE_URL"] ||
      "https://api.mindbodyonline.com/public/v6",
  };
}

/** One Mindbody client, reduced to what the sync stores. */
export interface MindbodyClientRecord {
  /** Client.Id -- the business-facing id, matches analytics source_ids. */
  mbClientId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Derived from MINDBODY_OPT_IN_FIELD, strictly boolean. */
  subscribed: boolean;
  /** The raw value behind `subscribed`, for consent-event detail lines. */
  optInValue: unknown;
  optInFieldName: string;
  /** The six consent booleans + Id/UniqueId, verbatim (evidence blob). */
  optInRaw: Record<string, unknown>;
}

interface PaginationResponse {
  RequestedLimit?: number;
  RequestedOffset?: number;
  PageSize?: number;
  TotalResults?: number;
}

async function readJson(
  res: Response,
  what: string,
): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Mindbody ${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Mindbody ${what} returned non-JSON: ${text.slice(0, 200)}`,
    );
  }
}

/** Issue a staff user token. Returns null when staff creds are not set. */
export async function issueStaffToken(
  env: MindbodyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!env.username || !env.password) return null;
  const res = await fetchImpl(`${env.baseUrl}/usertoken/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Api-Key": env.apiKey,
      SiteId: env.siteId,
    },
    body: JSON.stringify({ Username: env.username, Password: env.password }),
  });
  const body = await readJson(res, "usertoken/issue");
  const token = body["AccessToken"];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Mindbody usertoken/issue returned no AccessToken");
  }
  return token;
}

/**
 * Reduce one raw Client object to a MindbodyClientRecord, or null when the
 * record carries no usable Id (live sites hold ancient rows with a null
 * Id; they cannot become contacts -- contacts key on mb_client_id -- so
 * they can never be emailed, and the caller skips-and-counts them).
 *
 * The live API returns Id as a string on some sites and a number on
 * others; both are accepted, numbers coerced to their decimal string.
 *
 * Fails LOUDLY when the opt-in field is absent or non-boolean: consent is
 * a legal question, and a surprise field shape must stop the sync (a fix
 * here), not silently default anyone to subscribed or unsubscribed.
 */
export function extractClientRecord(
  raw: Record<string, unknown>,
): MindbodyClientRecord | null {
  const rawId = raw["Id"];
  const id =
    typeof rawId === "string" && rawId.length > 0
      ? rawId
      : typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : null;
  if (id === null) return null;
  const optInValue = raw[MINDBODY_OPT_IN_FIELD];
  if (typeof optInValue !== "boolean") {
    const present = Object.keys(raw)
      .filter((k) => k.startsWith("Send"))
      .join(", ");
    throw new Error(
      `Mindbody client ${id} has no boolean ${MINDBODY_OPT_IN_FIELD} ` +
        `(got ${JSON.stringify(optInValue)}). Send* fields present: ` +
        `[${present}]. Consent cannot be guessed -- verify the live field ` +
        `shape (npm run mindbody:verify) and fix the mapping here.`,
    );
  }
  const optInRaw: Record<string, unknown> = { Id: id };
  if (raw["UniqueId"] !== undefined) optInRaw["UniqueId"] = raw["UniqueId"];
  for (const field of MINDBODY_CONSENT_FIELDS) {
    if (raw[field] !== undefined) optInRaw[field] = raw[field];
  }
  const email = raw["Email"];
  const firstName = raw["FirstName"];
  const lastName = raw["LastName"];
  return {
    mbClientId: id,
    email: typeof email === "string" && email.trim() !== "" ? email : null,
    firstName: typeof firstName === "string" ? firstName : null,
    lastName: typeof lastName === "string" ? lastName : null,
    subscribed: optInValue,
    optInValue,
    optInFieldName: MINDBODY_OPT_IN_FIELD,
    optInRaw,
  };
}

export interface FetchClientsOptions {
  /** ISO timestamp for request.lastModifiedDate (incremental sync).
   * Omit for a full pull. */
  modifiedSince?: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Page GET /client/clients, yielding extracted records per page. Paging
 * trusts the response's PaginationResponse (PageSize / TotalResults)
 * rather than assuming the requested limit was honored.
 */
export async function* fetchAllClients(
  options: FetchClientsOptions = {},
): AsyncGenerator<MindbodyClientRecord[]> {
  const env = mindbodyEnv();
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.pageSize ?? MINDBODY_PAGE_LIMIT;
  const token = await issueStaffToken(env, fetchImpl);

  const headers: Record<string, string> = {
    "Api-Key": env.apiKey,
    SiteId: env.siteId,
  };
  if (token) headers["Authorization"] = token;

  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      "request.limit": String(limit),
      "request.offset": String(offset),
    });
    if (options.modifiedSince) {
      params.set("request.lastModifiedDate", options.modifiedSince);
    }
    const res = await fetchImpl(
      `${env.baseUrl}/client/clients?${params.toString()}`,
      { headers },
    );
    const body = await readJson(res, "client/clients");
    const clients = body["Clients"];
    if (!Array.isArray(clients)) {
      throw new Error(
        `Mindbody client/clients returned no Clients array: ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    const extracted = (clients as Array<Record<string, unknown>>).map(
      (c) => [c, extractClientRecord(c)] as const,
    );
    const records = extracted
      .map(([, r]) => r)
      .filter((r): r is MindbodyClientRecord => r !== null);
    const skipped = extracted.filter(([, r]) => r === null);
    if (skipped.length > 0) {
      // Not a silent drop: idless rows can never be contacts (nothing to
      // key on), but the operator should see how many exist and roughly
      // how old they are.
      const sample = skipped[0]![0];
      console.warn(
        `[sync_contacts] skipped ${skipped.length} client record(s) with no usable Id on this page ` +
          `(sample CreationDate: ${JSON.stringify(sample["CreationDate"] ?? null)})`,
      );
    }
    if (records.length > 0) yield records;

    const pagination = (body["PaginationResponse"] ?? {}) as PaginationResponse;
    const pageSize = pagination.PageSize ?? clients.length;
    const total = pagination.TotalResults;
    offset += pageSize;
    if (pageSize === 0) return;
    if (typeof total === "number" && offset >= total) return;
    // No TotalResults? A short page has to mean the end.
    if (typeof total !== "number" && pageSize < limit) return;
  }
}

/**
 * Field verification for Pete (the ticket's "confirm the exact
 * promotional-email opt-in field name against a live v6 client response"):
 * fetch ONE client and return every field name plus the consent-related
 * values, so the mapping above can be eyeballed against reality before
 * the first real sync is trusted.
 */
export async function verifyClientFields(
  fetchImpl: typeof fetch = fetch,
): Promise<{
  fieldNames: string[];
  consentFields: Record<string, unknown>;
  optInFieldPresent: boolean;
  totalResults: number | null;
}> {
  const env = mindbodyEnv();
  const token = await issueStaffToken(env, fetchImpl);
  const headers: Record<string, string> = {
    "Api-Key": env.apiKey,
    SiteId: env.siteId,
  };
  if (token) headers["Authorization"] = token;
  const res = await fetchImpl(
    `${env.baseUrl}/client/clients?request.limit=1&request.offset=0`,
    { headers },
  );
  const body = await readJson(res, "client/clients");
  const clients = body["Clients"];
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error("Mindbody returned no clients to verify against");
  }
  const client = clients[0] as Record<string, unknown>;
  const consentFields: Record<string, unknown> = {};
  for (const field of MINDBODY_CONSENT_FIELDS) {
    consentFields[field] = client[field];
  }
  const pagination = (body["PaginationResponse"] ?? {}) as PaginationResponse;
  return {
    fieldNames: Object.keys(client).sort(),
    consentFields,
    optInFieldPresent: typeof client[MINDBODY_OPT_IN_FIELD] === "boolean",
    totalResults:
      typeof pagination.TotalResults === "number"
        ? pagination.TotalResults
        : null,
  };
}
