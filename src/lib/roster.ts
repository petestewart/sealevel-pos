import { mindbody } from "./mindbody";

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
  paid: boolean;
  checkedIn: boolean;
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
  const body = await mindbody(
    `/class/classes?StartDateTime=${encodeURIComponent(start.toISOString())}` +
      `&EndDateTime=${encodeURIComponent(end.toISOString())}`,
  );
  return (body?.Classes ?? []).map(
    (c: any): ClassSummary => ({
      classId: c.Id,
      name: c.ClassDescription?.Name ?? "Class",
      teacher: c.Staff?.Name ?? "",
      startsAt: c.StartDateTime,
      capacity: c.MaxCapacity ?? null,
      booked: c.TotalBooked ?? null,
    }),
  );
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

export async function rosterFor(classId: number): Promise<RosterEntry[]> {
  const body = await mindbody(`/class/classvisits?ClassId=${classId}`);
  const visits = body?.Class?.Visits ?? body?.Visits ?? [];
  return visits.map(
    (v: any): RosterEntry => ({
      clientId: String(v.ClientId ?? v.Client?.Id ?? ""),
      name: personName(v) ?? "",
      visitId: typeof v.Id === "number" ? v.Id : null,
      pricingOption: v.ServiceName ?? null,
      /**
       * Mindbody does not expose a single "is this paid" flag on a visit.
       * A visit booked against a pricing option is paid; one with no
       * service attached is the unpaid reservation case, which is exactly
       * the amber row in the design doc.
       */
      paid: Boolean(v.ServiceName),
      checkedIn: Boolean(v.SignedIn),
    }),
  );
}

/**
 * Names for a specific set of client ids, in one call. Mindbody accepts a
 * repeated clientIds parameter, which keeps this to a single round trip
 * regardless of class size.
 */
async function namesForIds(ids: string[]): Promise<Map<string, string>> {
  const query = ids
    .map((id) => `clientIds=${encodeURIComponent(id)}`)
    .join("&");
  const out = new Map<string, string>();
  try {
    const body = await mindbody(`/client/clients?${query}&limit=200`);
    for (const c of body?.Clients ?? []) {
      const name = `${c.FirstName ?? ""} ${c.LastName ?? ""}`.trim();
      if (c.Id !== undefined && name) out.set(String(c.Id), name);
    }
  } catch {
    /* A roster with ids but no names still beats no roster at all. */
  }
  return out;
}

export async function classRoster(classId: number): Promise<ClassRoster> {
  const [classes, rawEntries] = await Promise.all([
    classesAroundNow(),
    rosterFor(classId),
  ]);

  /**
   * Fill any name the visit payload did not carry, with ONE batched
   * lookup of just the ids on this roster.
   *
   * The obvious move is to read them out of the search index, but that
   * index is built by paging the whole client list, and making a roster
   * wait on it turns a sub-second screen into a multi-second one. A
   * roster is at most a few dozen people, so ask for exactly those.
   */
  const missing = [
    ...new Set(rawEntries.filter((e) => !e.name && e.clientId).map((e) => e.clientId)),
  ];
  const names = missing.length > 0 ? await namesForIds(missing) : new Map();
  const entries = rawEntries.map((entry) =>
    entry.name
      ? entry
      : { ...entry, name: names.get(entry.clientId) ?? "(unknown client)" },
  );
  const summary = classes.find((c) => c.classId === classId);
  return {
    classId,
    name: summary?.name ?? "Class",
    teacher: summary?.teacher ?? "",
    startsAt: summary?.startsAt ?? "",
    capacity: summary?.capacity ?? null,
    booked: summary?.booked ?? null,
    entries,
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
  const res = await mindbody("/class/addclienttoclass", {
    method: "POST",
    body,
    clientId: opts.clientId,
  });
  if (res?.DryRun) return { visitId: null, suppressed: "dry-run" };
  if (res?.WriteSuppressed) return { visitId: null, suppressed: "write-guard" };
  const id = res?.Visit?.Id;
  return { visitId: typeof id === "number" ? id : null, suppressed: null };
}

/**
 * The waiting list for one class, in queue order.
 *
 * `GET /class/waitlistentries` filtered by class id. The entries carry a
 * `Client` reference that live data may populate thinly (the design doc's
 * stub warning), so any missing name is filled from the same batched
 * client lookup the roster uses.
 */
export interface WaitlistRow {
  entryId: number;
  clientId: string;
  name: string;
  requestedAt: string | null;
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
      }),
    );
  const missing = [
    ...new Set(rows.filter((r) => !r.name && r.clientId).map((r) => r.clientId)),
  ];
  const names = missing.length > 0 ? await namesForIds(missing) : new Map();
  const named = rows.map((r) =>
    r.name ? r : { ...r, name: names.get(r.clientId) ?? "(unknown client)" },
  );
  /** Queue order: first asked, first offered the spot. */
  return named.sort((a, b) =>
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
export async function setSignedIn(
  visitId: number,
  signedIn: boolean,
  /**
   * Who the visit belongs to, for the POS_WRITE_CLIENT_IDS guard only.
   * The Mindbody payload does not name a client, so without this the
   * guard would suppress every check-in whenever it is armed.
   */
  clientId?: string,
): Promise<void> {
  await mindbody("/client/updateclientvisit", {
    method: "POST",
    body: { VisitId: visitId, SignedIn: signedIn },
    clientId,
  });
}
