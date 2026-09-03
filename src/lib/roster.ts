import { mindbody, type Actor } from "./mindbody";

/**
 * Classes and their rosters, shaped for one screen.
 *
 * The speed argument from the design doc lives here: at 6:29pm we already
 * know who is about to walk in, so the roster for the classes around now is
 * fetched once and held, and tapping a name hits memory rather than the API.
 */

export interface RosterEntry {
  clientId: string;
  name: string;
  /** Mindbody's visit id, needed to mark the arrival. */
  visitId: number | null;
  /** What they booked against: a pass, a membership, unpaid. */
  pricingOption: string | null;
  /**
   * The pass paying for this visit, parsed from `Visit.Service` on the
   * `/class/classvisits` response (a ClientService per the vendored spec,
   * docs/mindbody-openapi/class.yml). Zero extra calls: the visit payload
   * already embeds the whole object. All null when the visit carries no
   * service, i.e. the unpaid case.
   */
  passRemaining: number | null;
  /** Sessions the pass held when purchased. Mindbody fakes "unlimited" with
   *  absurd counts (99999, 1000); the UI treats Count >= 100 as unlimited
   *  and shows no number. */
  passCount: number | null;
  /** ISO date-time the pass expires, if it does. */
  passExpires: string | null;
  /** The purchase-instance id of the pass (`Service.Id`), which is what
   *  `POST /client/updateclientvisit` takes as ClientServiceId to change
   *  how the visit is paid. */
  clientServiceId: number | null;
  /** The pricing option's own id (`Service.ProductId`, class.yml:3705),
   *  matching CatalogItem.productId from /sale/services. What T26's
   *  renewal prompt uses to default to the same pack again. */
  passProductId: number | null;
  /**
   * `AccountBalance` from the batched client lookup. null when the lookup
   * failed (fail open, like waiverSigned); 0 renders as nothing.
   */
  balance: number | null;
  /** Whether the client has a membership (`MembershipIcon` nonzero on the
   *  client record). null when the lookup failed. */
  member: boolean | null;
  paid: boolean;
  checkedIn: boolean;
  /**
   * Liability waiver state, from `Liability.IsReleased` on the client
   * record (the visit payload does not carry it). `true` means released,
   * `false` means Mindbody says there is no released waiver and check-in
   * must not happen on reflex, `null` means the lookup failed and the row
   * FAILS OPEN: the design doc's concern is reflex check-ins, not outages,
   * and blocking every row because one batched read timed out would stop
   * the counter.
   */
  waiverSigned: boolean | null;
  redAlert: string | null;
  /** `YellowAlert` free text from the client record, the softer sibling of
   *  `RedAlert` (both are top-level Client fields per
   *  docs/mindbody-openapi/client.yml). Information, not a gate; null when
   *  none or when the lookup failed (fail open, like its siblings). */
  yellowAlert: string | null;
  /** Staff notes from the client record (`Notes`, a top-level Client field
   *  per docs/mindbody-openapi/client.yml, and staff-facing by its own
   *  description). null when none or when the lookup failed. */
  notes: string | null;
  /** Mindbody's numeric UniqueId, which the staff web app's client URLs
   *  use (the API's ClientId is the editable custom id and 404s there).
   *  null when neither the visit nor the client lookup carried it. */
  mindbodyId: number | null;
}

export interface ClassSummary {
  classId: number;
  name: string;
  teacher: string;
  startsAt: string;
  capacity: number | null;
  booked: number | null;
}

export interface ClassRoster extends ClassSummary {
  entries: RosterEntry[];
  /**
   * Set when the batched client lookup failed, in which case every entry's
   * `waiverSigned` is null (fail open). The UI surfaces this quietly.
   */
  waiverError: string | null;
}

/**
 * Classes within a window around now. Two hours back covers a class already
 * running (people arrive late); four hours forward covers the next couple of
 * slots without pulling the whole day.
 */
export async function classesAroundNow(
  now = new Date(),
  hoursBack = 2,
  hoursForward = 4,
): Promise<ClassSummary[]> {
  const start = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
  const end = new Date(now.getTime() + hoursForward * 60 * 60 * 1000);
  return classesBetween(start, end);
}

/** One `/class/classes` window, mapped. Shared by the around-now window
 *  and the whole-day one; always exactly one metered call. */
async function classesBetween(
  start: Date,
  end: Date,
): Promise<ClassSummary[]> {
  /* The bounds go out as NAIVE studio wall-clock strings, never as
   * `toISOString()` (T40). Mindbody reads the digits of a datetime as the
   * site's local time and ignores any offset or Z, the same convention
   * its responses use (see parseRosterAnchor). Sent as UTC, the window
   * was seven hours ahead in PDT: at 3:34am Seattle the request read
   * 08:34Z to 14:34Z, and Mindbody answered with the 9:00 and 9:30
   * classes. */
  const body = await mindbody(
    `/class/classes?StartDateTime=${encodeURIComponent(studioWall(start))}` +
      `&EndDateTime=${encodeURIComponent(studioWall(end))}`,
  );
  return (body?.Classes ?? [])
    .filter((c: any) => c.IsCanceled !== true)
    .map(
      (c: any): ClassSummary => ({
        classId: c.Id,
        name: c.ClassDescription?.Name ?? "Class",
        teacher: staffName(c.Staff),
        startsAt: c.StartDateTime,
        capacity: c.MaxCapacity ?? null,
        booked: c.TotalBooked ?? null,
      }),
    )
    /* Mindbody returns the window in no useful order (Pete's live list
     * read 12:00, 7:00pm, 8:00am, 5:00pm). The naive local strings sort
     * lexically as time. */
    .sort((a: ClassSummary, b: ClassSummary) =>
      a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0,
    );
}

/**
 * A cancelled class is filtered out above (T40): Mindbody keeps it in
 * `/class/classes` with `IsCanceled: true`, staff "TBA ." and zero booked,
 * and its `/class/classvisits` answers with staff "Class Cancelled" (id
 * -1). The studio's schedule carries cancelled placeholder slots (a
 * whole morning of them on 2026-09-02), and listing those as classes a
 * teacher could check people into is wrong twice over. When every class
 * in the window is cancelled the screen shows its "No classes" line.
 */

/** The teacher as a person's name. Mindbody's `Staff.Name` is first and
 *  last joined, and the studio's placeholder teacher is first name "TBA"
 *  with last name ".", which rendered as "TBA ." on every class. Parts
 *  with no letter or digit in them are dropped. */
function staffName(staff: any): string {
  const raw =
    typeof staff?.Name === "string" && staff.Name.trim()
      ? staff.Name
      : `${staff?.FirstName ?? ""} ${staff?.LastName ?? ""}`;
  return String(raw)
    .split(/\s+/)
    .filter((part) => /[\p{L}\p{N}]/u.test(part))
    .join(" ");
}

/** `at` as the studio's wall clock, `YYYY-MM-DDTHH:mm:ss` with no offset:
 *  the shape Mindbody reads correctly (see classesBetween). */
export function studioWall(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${get("year")}-${two(get("month"))}-${two(get("day"))}` +
    /* hour12: false can render midnight as "24" in some ICU versions. */
    `T${two(get("hour") % 24)}:${two(get("minute"))}:${two(get("second"))}`
  );
}

/**
 * The studio's timezone. A constant in the same spirit as LocationId 1:
 * there is one physical studio and it is in Seattle, so "the day" for
 * schedule purposes is this timezone's day, not the server's (a container
 * commonly runs on UTC, where a 6:20am class belongs to the previous
 * UTC day's evening).
 */
const STUDIO_TZ = "America/Los_Angeles";

/** Milliseconds the studio's wall clock is offset from UTC at `at`
 *  (PDT: -25200000). Derived from Intl, the only timezone database a
 *  container is guaranteed to carry; second precision, which is why the
 *  anchor's own milliseconds are dropped before comparing. */
function studioOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    /* hour12: false can render midnight as "24" in some ICU versions. */
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return wallAsUtc - (at.getTime() - (at.getTime() % 1000));
}

/**
 * Parse a day-window anchor. Mindbody's datetimes (`startsAt` included)
 * are NAIVE studio-local strings -- no offset, no Z -- and the one wrong
 * reading is the default one: `new Date("...T06:20:00")` on a UTC
 * container calls that 6:20am UTC, which is the previous studio EVENING,
 * so the day dropdown anchored on a morning class fetched yesterday. A
 * naive anchor is therefore read as STUDIO_TZ wall clock; one carrying
 * an explicit offset or Z is an unambiguous instant and parses directly.
 * Returns null when unparseable (the route falls back to now).
 */
export function parseRosterAnchor(raw: string): Date | null {
  if (/(z|[+-]\d\d:?\d\d)$/i.test(raw)) {
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const wall = Date.parse(`${raw}Z`);
  if (!Number.isFinite(wall)) return null;
  /* The wall time read as if UTC, minus the studio offset at roughly
   * that instant, is the real instant; one refinement pass covers the
   * hour around a DST edge. */
  const guess = wall - studioOffsetMs(new Date(wall));
  return new Date(wall - studioOffsetMs(new Date(guess)));
}

/**
 * Every class on the STUDIO-LOCAL day containing `anchor` (T27 round
 * three: the attach quick-pick's class dropdown needs the whole teaching
 * day, which the -2/+4h around-now window deliberately does not cover).
 * One metered call, same as the around-now window; the caller is
 * expected to cache per day.
 *
 * The bounds: take the anchor's wall-clock time in the studio's
 * timezone and subtract it, landing on studio midnight, then add 24
 * hours. On a DST-change day that midnight can be off by an hour at the
 * edges, which for a 6am-9pm schedule cannot drop a class.
 */
export async function classesForDay(anchor: Date): Promise<ClassSummary[]> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(anchor);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  /* hour12: false can render midnight as "24" in some ICU versions. */
  const msIntoDay =
    (((get("hour") % 24) * 60 + get("minute")) * 60 + get("second")) * 1000;
  const start = new Date(anchor.getTime() - msIntoDay);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return classesBetween(start, end);
}

/**
 * Live `/class/classvisits` puts the CLASS name in the visit's `Name`
 * field, not the client's, so reading it showed every roster row as
 * "bikram yoga". Only trust fields that unambiguously name a person, and
 * return null otherwise: `classRoster` fills the gaps from the client
 * index by id, which is authoritative and already in memory.
 */
function personName(v: any): string | null {
  const first = v.Client?.FirstName ?? v.FirstName ?? "";
  const last = v.Client?.LastName ?? v.LastName ?? "";
  const joined = `${first} ${last}`.trim();
  return joined || null;
}

/** A pricing option whose session count means nothing: ClassPass (and
 *  any other partner pass) is booked against a placeholder Mindbody never
 *  decrements. Matched on the name, which is the only handle the visit
 *  payload gives. Shared by the roster and the pass sweep. */
export function sessionless(name: unknown): boolean {
  return typeof name === "string" && /class\s*pass/i.test(name);
}

export async function rosterFor(classId: number): Promise<RosterEntry[]> {
  const body = await mindbody(`/class/classvisits?ClassId=${classId}`);
  const visits = body?.Class?.Visits ?? body?.Visits ?? [];
  return visits.map((v: any): RosterEntry => {
    /* The visit embeds the full pass (`Service`, a ClientService). Its
     * Name is the same pricing option ServiceName carries, but the object
     * also has Remaining/Count/ExpirationDate/Id, which is everything the
     * row shows without a single extra call. */
    const service = v.Service ?? null;
    const num = (x: unknown): number | null =>
      typeof x === "number" && Number.isFinite(x) ? x : null;
    return {
      clientId: String(v.ClientId ?? v.Client?.Id ?? ""),
      name: personName(v) ?? "",
      visitId: typeof v.Id === "number" ? v.Id : null,
      pricingOption: service?.Name ?? v.ServiceName ?? null,
      /* A ClassPass booking rides a placeholder pricing option that
       * Mindbody never decrements, so its Remaining is always 0 and read
       * as "0 remaining" it looks like a spent pass (Pete, live pass
       * 2026-09-02). No session count is shown for it; the expiry stays. */
      passRemaining: sessionless(service?.Name) ? null : num(service?.Remaining),
      passCount: sessionless(service?.Name) ? null : num(service?.Count),
      passExpires:
        typeof service?.ExpirationDate === "string" && service.ExpirationDate
          ? service.ExpirationDate
          : null,
      clientServiceId: num(service?.Id),
      passProductId: num(service?.ProductId),
      /** Filled by classRoster's batched client lookup. */
      balance: null,
      member: null,
      /**
       * Mindbody does not expose a single "is this paid" flag on a visit.
       * A visit booked against a pricing option is paid; one with no
       * service attached is the unpaid reservation case, which is exactly
       * the amber row in the design doc.
       */
      paid: Boolean(service?.Name ?? v.ServiceName),
      checkedIn: Boolean(v.SignedIn),
      /** Filled by classRoster's batched client lookup; a bare visit list
       *  knows nothing about waivers. */
      waiverSigned: null,
      redAlert: null,
      yellowAlert: null,
      notes: null,
      mindbodyId:
        typeof v.ClientUniqueId === "number" ? v.ClientUniqueId : null,
    };
  });
}

/**
 * The slice of the client record a roster row needs: the name, and the
 * waiver state (`Liability.IsReleased` per the vendored spec,
 * docs/mindbody-openapi/client.yml). One `GET /client/clients?clientIds=`
 * round trip for the whole set -- Mindbody accepts a repeated clientIds
 * parameter -- so this stays one batched call per roster load, never one
 * per client.
 *
 * Ids are chunked defensively: the old name-only lookup sent every id in a
 * single query string, which was fine for the handful of nameless visits it
 * served but a full hot-room roster is 40+ ids and query strings have
 * practical length limits. A chunk of 40 keeps the URL under ~1KB; a normal
 * class fits in one chunk, so the "one call" property holds where it
 * matters.
 */
interface ClientBrief {
  /** RedAlert free text from the client record; null when none. */
  redAlert: string | null;
  /** YellowAlert free text from the client record; null when none. */
  yellowAlert: string | null;
  /** Staff notes (`Notes`) from the client record; null when none. */
  notes: string | null;
  uniqueId: number | null;
  name: string;
  waiverSigned: boolean;
  /** `AccountBalance`, a top-level Client field; null when Mindbody
   *  omitted it. */
  balance: number | null;
  /** `MembershipIcon` nonzero means the client holds a membership; 0 or
   *  absent means none. This is Mindbody's OWN flag, from the studio's
   *  Membership setup, and it can rest on an autopay contract or on a
   *  pricing option within its dates with no sessions left (T56, Pete's
   *  Devin: one Drop In at 0 remaining, still an M). The M chip's modal
   *  reads /api/membership to show what it rests on. */
  member: boolean;
}

/**
 * Mindbody's hard limit, learned live: 21 ids in one request returned
 * HTTP 400 "ClientIds should not be more than 20." and the whole roster
 * fell back to "(unknown client)" with no waiver data. The old value of
 * 40 was a URL-length guess that testing with small rosters never hit.
 * Do not raise this.
 */
const CLIENT_LOOKUP_CHUNK = 20;

async function briefsForIds(ids: string[]): Promise<Map<string, ClientBrief>> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CLIENT_LOOKUP_CHUNK) {
    chunks.push(ids.slice(i, i + CLIENT_LOOKUP_CHUNK));
  }
  const bodies = await Promise.all(
    chunks.map((chunk) => {
      const query = chunk
        .map((id) => `clientIds=${encodeURIComponent(id)}`)
        .join("&");
      return mindbody(`/client/clients?${query}&limit=200`);
    }),
  );
  const out = new Map<string, ClientBrief>();
  for (const body of bodies) {
    for (const c of body?.Clients ?? []) {
      if (c?.Id === undefined || c?.Id === null) continue;
      out.set(String(c.Id), {
        name: `${c.FirstName ?? ""} ${c.LastName ?? ""}`.trim(),
        /** Absent Liability or IsReleased means no released waiver. */
        waiverSigned: Boolean(c?.Liability?.IsReleased),
        redAlert:
          typeof c?.RedAlert === "string" && c.RedAlert.trim()
            ? c.RedAlert.trim()
            : null,
        yellowAlert:
          typeof c?.YellowAlert === "string" && c.YellowAlert.trim()
            ? c.YellowAlert.trim()
            : null,
        notes:
          typeof c?.Notes === "string" && c.Notes.trim()
            ? c.Notes.trim()
            : null,
        uniqueId: typeof c?.UniqueId === "number" ? c.UniqueId : null,
        balance:
          typeof c?.AccountBalance === "number" &&
          Number.isFinite(c.AccountBalance)
            ? c.AccountBalance
            : null,
        member:
          typeof c?.MembershipIcon === "number" && c.MembershipIcon !== 0,
      });
    }
  }
  return out;
}

/**
 * `summary: false` skips the around-now `/class/classes` lookup that
 * fills name, teacher, startsAt, capacity and booked (they come back as
 * their defaults). T46: a class on another day is never in that window,
 * so for it the call was a metered miss on every roster load; the page
 * holds that day's list already and merges the roster's counts only
 * when present.
 */
export async function classRoster(
  classId: number,
  opts: { summary?: boolean } = {},
): Promise<ClassRoster> {
  const [classes, rawEntries] = await Promise.all([
    opts.summary === false ? Promise.resolve([]) : classesAroundNow(),
    rosterFor(classId),
  ]);

  /**
   * ONE batched client lookup for ALL ids on this roster. It used to run
   * only for nameless visits and keep only names; the waiver state widened
   * it to every row, because a blocked state that only appears after a row
   * is opened is not a blocked state, it is a surprise. Still one round
   * trip per roster load (chunked past 40 ids), still just the ids on this
   * roster -- never the whole client list, which was deleted deliberately.
   *
   * A failed lookup fails OPEN: names fall back, waiverSigned stays null on
   * every row, and waiverError says so, quietly. Blocking the whole roster
   * on a lookup outage would stop the counter, and the design doc's worry
   * is reflex check-ins, not outages.
   */
  const ids = [
    ...new Set(rawEntries.map((e) => e.clientId).filter((id) => id)),
  ];
  let briefs = new Map<string, ClientBrief>();
  let waiverError: string | null = null;
  if (ids.length > 0) {
    try {
      briefs = await briefsForIds(ids);
    } catch (err) {
      waiverError = err instanceof Error ? err.message : String(err);
    }
  }
  const entries = rawEntries.map((entry): RosterEntry => {
    const brief = briefs.get(entry.clientId);
    return {
      ...entry,
      name: entry.name || brief?.name || "(unknown client)",
      /** A client the successful lookup did not return stays null: unknown
       *  is not "unsigned", and null fails open. */
      waiverSigned: brief ? brief.waiverSigned : null,
      /* The red alert rides the same batch, so the blocking gate works on
       * a reflex tap, not only after a row has been opened. Null when the
       * lookup failed or the client has none. */
      redAlert: brief?.redAlert ?? null,
      /* The yellow alert rides the same batch as the red one; both are
       * information behind the row's info icon, not gates (T20). */
      yellowAlert: brief?.yellowAlert ?? null,
      /* Notes ride the same batch: the row's info icon brightens only when
       * there is text behind it. Null when the lookup failed. */
      notes: brief?.notes ?? null,
      /* Balance and membership ride the same batch. Null when the lookup
       * failed or missed this client: unknown renders as nothing, which is
       * the same fail-open posture as waiverSigned. */
      balance: brief ? brief.balance : null,
      member: brief ? brief.member : null,
      mindbodyId: entry.mindbodyId ?? brief?.uniqueId ?? null,
    };
  });
  const summary = classes.find((c) => c.classId === classId);
  return {
    classId,
    name: summary?.name ?? "Class",
    teacher: summary?.teacher ?? "",
    startsAt: summary?.startsAt ?? "",
    capacity: summary?.capacity ?? null,
    booked: summary?.booked ?? null,
    entries,
    waiverError,
  };
}

/**
 * Book a client into a class, onto its waiting list, or off the waiting
 * list into the class. All three are the same endpoint:
 * `POST /class/addclienttoclass` (spec: docs/mindbody-openapi/class.yml,
 * `AddClientToClassRequest`).
 *
 * - Plain booking sends `{ClientId, ClassId}`. `RequirePayment` is omitted
 *   deliberately: per the spec, omitted means an active pricing option is
 *   NOT required, which is exactly the money-free half of walk-in booking.
 *   Phase 2 sells the pass; Phase 1 gets the person a visit to sign in.
 * - `ClientServiceId` names the pricing option on the client's account
 *   that pays for the booking, when the caller chose one explicitly (the
 *   search modal's pass picker, T17). The spec carries it on
 *   `AddClientToClassRequest` directly, so the choice rides the ONE
 *   booking call instead of a book-then-updateclientvisit follow-up.
 *   Omitted when no choice was made, leaving the payload exactly as
 *   before: Mindbody picks the applicable pass, as it always did.
 * - `Waitlist: true` adds them to the waiting list instead, for a class
 *   at capacity. The caller decides; Mindbody will refuse a plain booking
 *   on a full class rather than queueing it silently.
 * - `WaitlistEntryId` promotes: it names the waiting list entry the client
 *   is being moved out of, which is the documented way to move someone off
 *   a waiting list rather than double-booking them.
 * - `SendEmail: false` explicitly: a counter tap with the person standing
 *   there should not fire a booking-confirmation email at them.
 *
 * The response is `{Visit}` (an `AddClientToClassVisit`), whose `Id` is the
 * visit id check-in needs. Under dry run or the write guard the call never
 * goes out and there is no visit; the caller gets told which guard fired so
 * the UI can say so instead of showing a booking that did not happen.
 */
export interface BookingResult {
  visitId: number | null;
  suppressed: "dry-run" | "write-guard" | null;
}

export async function bookClientIntoClass(opts: {
  clientId: string;
  classId: number;
  waitlist?: boolean;
  waitlistEntryId?: number;
  /** Purchase-instance id of the pass that pays, when explicitly chosen.
   *  Omitted otherwise, and the payload is unchanged from before. */
  clientServiceId?: number;
  /** T49: the signed-in teacher to book as, when there is one. */
  actor?: Actor | null;
}): Promise<BookingResult> {
  const body: Record<string, unknown> = {
    ClientId: opts.clientId,
    ClassId: opts.classId,
    SendEmail: false,
  };
  if (opts.waitlist) body["Waitlist"] = true;
  if (opts.waitlistEntryId !== undefined) {
    body["WaitlistEntryId"] = opts.waitlistEntryId;
  }
  if (opts.clientServiceId !== undefined) {
    body["ClientServiceId"] = opts.clientServiceId;
  }
  const res = await mindbody("/class/addclienttoclass", {
    method: "POST",
    body,
    clientId: opts.clientId,
    ...(opts.actor ? { actor: opts.actor } : {}),
  });
  if (res?.DryRun) return { visitId: null, suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { visitId: null, suppressed: "write-guard" };
  const id = res?.Visit?.Id;
  return { visitId: typeof id === "number" ? id : null, suppressed: null };
}

/**
 * Cancel a booking outright: `POST /class/removeclientfromclass` (spec:
 * docs/mindbody-openapi/class.yml, `RemoveClientFromClassRequest`).
 *
 * The schema takes `ClassId` (int) plus ONE of `ClientId` (string RSSID) or
 * `UniqueClientId`; this app holds the RSSID everywhere, so it sends
 * `ClientId`. `SendEmail: false` explicitly, same reasoning as booking: a
 * counter tap with the person standing there should not fire a cancellation
 * email at them. `LateCancel` is omitted: the spec defaults it to false
 * (early cancel), and whether the studio's late-cancel policy should bite
 * is a business decision this screen must not quietly make. `VisitId` and
 * `Test` are omitted as unneeded.
 *
 * This ClientId also drives the POS_WRITE_CLIENT_IDS guard (the payload
 * names the client, and mindbody() reads it from the body). Under dry run
 * or the write guard the call never goes out; the caller is told which
 * guard fired so the UI says so instead of showing a removal that did not
 * happen.
 */
export async function removeClientFromClass(
  clientId: string,
  classId: number,
  /** T49: the signed-in teacher to cancel as, when there is one. */
  actor?: Actor | null,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const res = await mindbody("/class/removeclientfromclass", {
    method: "POST",
    body: { ClientId: clientId, ClassId: classId, SendEmail: false },
    clientId,
    ...(actor ? { actor } : {}),
  });
  if (res?.DryRun) return { suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { suppressed: "write-guard" };
  return { suppressed: null };
}

/**
 * The waiting list for one class, in queue order.
 *
 * `GET /class/waitlistentries` filtered by class id. The entries carry a
 * `Client` reference that live data may populate thinly (the design doc's
 * stub warning), so every row is enriched from the same batched client
 * lookup the roster uses -- ONE briefsForIds call for the whole list
 * (T20), which now serves both the missing names AND the waiver state:
 * a no-waiver student who waitlisted online must not be promotable with
 * no dialog, and an after-start promotion can come back already signed
 * in, so the promote tap is the last reliable stop (the T19 mechanism,
 * found by its review).
 */
export interface WaitlistRow {
  entryId: number;
  clientId: string;
  name: string;
  requestedAt: string | null;
  /**
   * `Liability.IsReleased` from the batched client lookup. Same contract
   * as the roster's: `false` means the promote tap must stop at the
   * waiver dialog, `null` means the lookup failed and the row FAILS
   * OPEN -- unknown must not block a promotion, the risk being managed
   * is reflex promotions of known-unsigned students, not outages.
   */
  waiverSigned: boolean | null;
  /** Staff notes, riding the same lookup: the waiver dialog's receipt
   *  append needs the current notes to append to. Null when none or
   *  when the lookup failed. */
  notes: string | null;
}

export async function waitlistFor(classId: number): Promise<WaitlistRow[]> {
  const body = await mindbody(
    `/class/waitlistentries?ClassIds=${classId}&HidePastEntries=true&limit=100`,
  );
  const rows: WaitlistRow[] = (body?.WaitlistEntries ?? [])
    .filter((e: any) => typeof e?.Id === "number")
    .map(
      (e: any): WaitlistRow => ({
        entryId: e.Id,
        clientId:
          e.Client?.Id !== undefined && e.Client?.Id !== null
            ? String(e.Client.Id)
            : "",
        name: `${e.Client?.FirstName ?? ""} ${e.Client?.LastName ?? ""}`.trim(),
        requestedAt: e.RequestDateTime ?? null,
        /* Filled from the batched lookup below; a bare waitlist entry
         * knows nothing about waivers. */
        waiverSigned: null,
        notes: null,
      }),
    );
  /* ONE batched lookup for every id on the list (it used to run only for
   * nameless rows, and kept only names). A failed lookup fails OPEN:
   * names fall back, waiverSigned stays null on every row, and the list
   * still renders -- same posture as the roster's. */
  const ids = [...new Set(rows.map((r) => r.clientId).filter((id) => id))];
  let briefs = new Map<string, ClientBrief>();
  if (ids.length > 0) {
    try {
      briefs = await briefsForIds(ids);
    } catch {
      /* fall through with the un-enriched rows */
    }
  }
  const enriched = rows.map((r): WaitlistRow => {
    const brief = briefs.get(r.clientId);
    return {
      ...r,
      name: r.name || brief?.name || "(unknown client)",
      /* A client the successful lookup did not return stays null:
       * unknown is not "unsigned", and null fails open. */
      waiverSigned: brief ? brief.waiverSigned : null,
      notes: brief?.notes ?? null,
    };
  });
  /** Queue order: first asked, first offered the spot. */
  return enriched.sort((a, b) =>
    (a.requestedAt ?? "").localeCompare(b.requestedAt ?? ""),
  );
}

/**
 * Sign a visit in or out.
 *
 * This is `POST /client/updateclientvisit` with `{VisitId, SignedIn}`, and
 * getting here took vendoring the OpenAPI spec (docs/mindbody-openapi).
 * Two things were wrong before that:
 *
 * 1. The endpoint was `/class/addarrival`. There is no such path. Arrival
 *    lives at `/client/addarrival`, under the Client tag rather than Class.
 * 2. Arrival is the wrong operation anyway. It logs "this client turned up
 *    at the studio" and carries no ClassId at all. Signing someone into a
 *    specific class is a property of their VISIT, which is what this sets.
 *
 * And unlike arrival, it reverses: `SignedIn: false` undoes a check-in, so
 * a mistake is recoverable rather than permanent.
 */
/**
 * Change which pass pays for a visit: Mindbody's "Change how the client is
 * paying", and the same `POST /client/updateclientvisit` endpoint check-in
 * uses. The payload is `{VisitId, ClientServiceId}` and nothing else --
 * deliberately no `SignedIn`, because sending a field the operation does
 * not need would also set it, and changing payment must not sign anyone
 * in or out as a side effect.
 *
 * Under dry run or the write guard the call never goes out; the caller is
 * told which guard fired so the UI can say so instead of showing a swap
 * that did not happen (same contract as bookClientIntoClass).
 */
export async function setVisitService(
  visitId: number,
  clientServiceId: number,
  /** Who the visit belongs to, for POS_WRITE_CLIENT_IDS only; never
   *  merged into the payload. */
  clientId?: string,
  /** T49: the signed-in teacher to make the change as, when there is one. */
  actor?: Actor | null,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const res = await mindbody("/client/updateclientvisit", {
    method: "POST",
    body: { VisitId: visitId, ClientServiceId: clientServiceId },
    clientId,
    ...(actor ? { actor } : {}),
  });
  if (res?.DryRun) return { suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { suppressed: "write-guard" };
  return { suppressed: null };
}

export async function setSignedIn(
  visitId: number,
  signedIn: boolean,
  /**
   * Who the visit belongs to, for the POS_WRITE_CLIENT_IDS guard only.
   * The Mindbody payload does not name a client, so without this the
   * guard would suppress every check-in whenever it is armed.
   */
  clientId?: string,
  /** T49: the signed-in teacher to sign the client in as, when there is
   *  one, so Mindbody's sign-in record names them. */
  actor?: Actor | null,
): Promise<{ suppressed: "dry-run" | "write-guard" | null }> {
  const res = await mindbody<{ DryRun?: boolean; WriteSuppressed?: boolean }>(
    "/client/updateclientvisit",
    {
      method: "POST",
      body: { VisitId: visitId, SignedIn: signedIn },
      clientId,
      ...(actor ? { actor } : {}),
    },
  );
  if (res?.DryRun) return { suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { suppressed: "write-guard" };
  return { suppressed: null };
}
