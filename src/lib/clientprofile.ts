import { fetchPasses, type PassInfo } from "./clientcontext";
import { mindbody } from "./mindbody";
import { studioWall } from "./roster";

/**
 * T41: the client profile behind the Buy header's profile icon (Pete:
 * "a modal with the same basic info as the mindbody client-info page").
 * His client-info page shows phone, email, a visit count with the join
 * date, the client id, the waiver with its date, the last visit (class,
 * date, time), membership status, and each pass with sessions remaining
 * and expiry. This assembles exactly that from three reads, in parallel,
 * each optional: a sub-read that fails leaves its fields null and names
 * the failure in `errors`, so a slow /client/clientvisits never blanks
 * the phone number.
 *
 * Reads only, every one through mindbody() so the dev drawer records it.
 * Nothing here is cached: the modal opens on a tap and the data behind
 * it (a waiver signed a minute ago, a pass just sold) must be current.
 *
 * Spec notes (docs/mindbody-openapi/client.yml):
 *
 * - `/client/clients` (1323): `clientIds=` repeated-param spelling, the
 *   one the roster's batched lookup verified live. The Client model
 *   (5070) carries Email, MobilePhone/HomePhone/WorkPhone, CreationDate,
 *   FirstClassDate, Id, UniqueId, Liability {IsReleased, AgreementDate},
 *   MembershipIcon, Status, RedAlert, YellowAlert, Notes.
 * - `/client/clientvisits` (1803): `request.startDate` defaults to the
 *   END date and `request.endDate` to today, so the bare call returns one
 *   day. Both are sent as studio wall-clock strings (roster.ts
 *   `studioWall`): Mindbody reads a datetime's digits as site-local and
 *   ignores the offset (T40). The response wraps `Visits` with a
 *   `PaginationResponse` whose `TotalResults` (6734) is the count even
 *   when the page is capped.
 * - Passes reuse clientcontext's `fetchPasses`, spill guard included.
 */

export interface ProfileVisit {
  /** Site-local start, as Mindbody sent it ("2026-09-02T09:00:00"). */
  at: string;
  /** The class name (`/client/clientvisits` fills `Name` with it). */
  name: string | null;
  signedIn: boolean;
}

export interface ClientConsent {
  accountEmails: boolean;
  scheduleEmails: boolean;
  promotionalEmails: boolean;
  accountTexts: boolean;
  scheduleTexts: boolean;
  promotionalTexts: boolean;
}

export interface ClientProfile {
  clientId: string;
  name: string | null;
  email: string | null;
  /** MobilePhone, else HomePhone, else WorkPhone. */
  phone: string | null;
  /** `UniqueId`, the number Mindbody's own screens show as the client id. */
  mindbodyId: number | null;
  /** `CreationDate`, site-local. The "member since" of the info page. */
  joined: string | null;
  /** `FirstClassDate`, site-local, when Mindbody has one. */
  firstClass: string | null;
  /** `Status`: Declined, Non-Member, Active, Expired, Suspended,
   *  Terminated (client.yml:5279). */
  status: string | null;
  /** True when a membership icon rides the name (client.yml:5152). */
  member: boolean;
  waiver: { released: boolean; agreedAt: string | null } | null;
  redAlert: string | null;
  yellowAlert: string | null;
  notes: string | null;
  /** T53: the six consent flags (client.yml:5286-5306), read from the
   *  same /client/clients row as everything above. A flag Mindbody
   *  omits reads as false, its documented default. Null when the client
   *  read failed. */
  consent: ClientConsent | null;
  /** Visits in the window: the count Mindbody reports, and the latest
   *  attended one. Null when the read failed. */
  visits: { count: number; last: ProfileVisit | null } | null;
  /** Current passes, newest purchase first as Mindbody lists them. Null
   *  when the read failed. */
  passes: PassInfo[] | null;
  /** Which sub-reads failed, by name, with Mindbody's reason. */
  errors: { client?: string; visits?: string; passes?: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the visit window reaches. Ten years covers the studio's
 *  whole API-era history; the count comes from TotalResults, so the page
 *  cap below does not truncate it. */
const VISIT_WINDOW_DAYS = 10 * 365;

/** Visits fetched per page. Only the LATEST is rendered, and the count
 *  rides TotalResults, so the page is a search window for "most recent
 *  attended", not the history. `Order=desc` is requested (client.yml:1879)
 *  and the page is sorted again here; if it arrives oldest-first and
 *  truncated, the tail page is read too (see fetchVisitSummary). */
const VISIT_PAGE = 200;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ClientFields = Pick<
  ClientProfile,
  | "name"
  | "email"
  | "phone"
  | "mindbodyId"
  | "joined"
  | "firstClass"
  | "status"
  | "member"
  | "waiver"
  | "redAlert"
  | "yellowAlert"
  | "notes"
  | "consent"
>;

async function fetchClientFields(clientId: string): Promise<ClientFields> {
  const body = await mindbody(
    `/client/clients?clientIds=${encodeURIComponent(clientId)}&limit=1`,
  );
  const c = (body?.Clients ?? []).find(
    (row: any) => String(row?.Id ?? "") === clientId,
  );
  if (!c) throw new Error("Mindbody returned no client record for this id.");
  const first = str(c?.FirstName);
  const last = str(c?.LastName);
  const liability = c?.Liability;
  return {
    name: [first, last].filter(Boolean).join(" ") || null,
    email: str(c?.Email),
    phone: str(c?.MobilePhone) ?? str(c?.HomePhone) ?? str(c?.WorkPhone),
    mindbodyId: num(c?.UniqueId),
    joined: str(c?.CreationDate),
    firstClass: str(c?.FirstClassDate),
    status: str(c?.Status),
    member: num(c?.MembershipIcon) !== null,
    waiver:
      liability && typeof liability === "object"
        ? {
            released: liability.IsReleased === true,
            agreedAt: str(liability.AgreementDate),
          }
        : null,
    redAlert: str(c?.RedAlert),
    yellowAlert: str(c?.YellowAlert),
    notes: str(c?.Notes),
    consent: {
      accountEmails: c?.SendAccountEmails === true,
      scheduleEmails: c?.SendScheduleEmails === true,
      promotionalEmails: c?.SendPromotionalEmails === true,
      accountTexts: c?.SendAccountTexts === true,
      scheduleTexts: c?.SendScheduleTexts === true,
      promotionalTexts: c?.SendPromotionalTexts === true,
    },
  };
}

async function fetchVisitSummary(
  clientId: string,
  now: Date,
): Promise<{ count: number; last: ProfileVisit | null }> {
  const start = new Date(now.getTime() - VISIT_WINDOW_DAYS * DAY_MS);
  const body = await mindbody(
    `/client/clientvisits?ClientId=${encodeURIComponent(clientId)}` +
      `&StartDate=${encodeURIComponent(studioWall(start))}` +
      `&EndDate=${encodeURIComponent(studioWall(now))}` +
      `&Order=desc&limit=${VISIT_PAGE}`,
  );
  const rows: any[] = body?.Visits ?? [];
  const total = num(body?.PaginationResponse?.TotalResults);
  /* Review: sorting the page only finds the latest visit if the page
     HOLDS it. `Order` is unverified live, and a regular has more than
     one page of visits in ten years; if Mindbody ignored the parameter
     and sent the oldest page, the newest row here would be years old.
     Detected off the page itself (its first row older than its last
     means ascending), and only then, when the window is also truncated,
     the tail page is read too; a page already newest-first costs
     nothing extra. */
  const first = str(rows[0]?.StartDateTime);
  const lastRow = str(rows[rows.length - 1]?.StartDateTime);
  const ascending = first !== null && lastRow !== null && first < lastRow;
  if (ascending && total !== null && total > rows.length) {
    const tail = await mindbody(
      `/client/clientvisits?ClientId=${encodeURIComponent(clientId)}` +
        `&StartDate=${encodeURIComponent(studioWall(start))}` +
        `&EndDate=${encodeURIComponent(studioWall(now))}` +
        `&Order=desc&limit=${VISIT_PAGE}` +
        `&offset=${Math.max(0, total - VISIT_PAGE)}`,
    );
    rows.push(...((tail?.Visits ?? []) as any[]));
  }
  /* Attended or booked and not skipped: a no-show is not a last visit. */
  const attended = rows
    .filter((v) => !v?.Missed && !v?.LateCancelled && str(v?.StartDateTime))
    .map(
      (v): ProfileVisit => ({
        at: v.StartDateTime as string,
        name: str(v?.Name),
        signedIn: Boolean(v?.SignedIn),
      }),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
  return {
    count: total ?? rows.length,
    last: attended[0] ?? null,
  };
}

/**
 * The profile, from three parallel reads. `Promise.allSettled` so that
 * one refusal (an inactive id makes clientservices spill site-wide and
 * fetchPasses throws on purpose) costs only its own section.
 */
export async function clientProfile(
  clientId: string,
  now = new Date(),
): Promise<ClientProfile> {
  if (!clientId) throw new Error("clientProfile needs a client id.");
  const [client, visits, passes] = await Promise.allSettled([
    fetchClientFields(clientId),
    fetchVisitSummary(clientId, now),
    fetchPasses(clientId, now),
  ]);
  /* Review: the route promises a 502 when the whole read fails, and
     allSettled alone could never deliver one; three refusals (a dead
     token, a wrong site) came back as a 200 profile of nulls, which the
     card would render as a client with nothing on file. All three down
     is a failed read, not a partial one. */
  if (
    client.status === "rejected" &&
    visits.status === "rejected" &&
    passes.status === "rejected"
  ) {
    throw new Error(`Could not read the client: ${reason(client.reason)}`);
  }
  const errors: ClientProfile["errors"] = {};
  const fields: ClientFields =
    client.status === "fulfilled"
      ? client.value
      : ((errors.client = reason(client.reason)),
        {
          name: null,
          email: null,
          phone: null,
          mindbodyId: null,
          joined: null,
          firstClass: null,
          status: null,
          member: false,
          waiver: null,
          redAlert: null,
          yellowAlert: null,
          notes: null,
          consent: null,
        });
  if (visits.status === "rejected") errors.visits = reason(visits.reason);
  if (passes.status === "rejected") errors.passes = reason(passes.reason);
  return {
    clientId,
    ...fields,
    visits: visits.status === "fulfilled" ? visits.value : null,
    passes: passes.status === "fulfilled" ? passes.value : null,
    errors,
  };
}
