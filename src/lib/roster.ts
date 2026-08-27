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
): Promise<ClassSummary[]> {
  const start = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 4 * 60 * 60 * 1000);
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
 * Mark someone as arrived. Requires the staff account to hold
 * LaunchSignInScreen; without it Mindbody returns "Authorization Required"
 * and the check-in silently does nothing, so the caller must surface a
 * failure rather than assume success.
 *
 * UNRESOLVED, and worth settling before this is trusted at a counter: the
 * v6 AddArrival request carries ClientId, LocationId, ArrivalTypeId,
 * LeadChannelId and Test -- and NO ClassId. It logs "this client arrived at
 * the studio", which is not the same as "this client is signed into this
 * class", and the ClassId passed below is very likely ignored. If what we
 * want is the class roster's signed-in flag, this may be the wrong endpoint
 * entirely. Verify against a sandbox class before relying on it: check in a
 * sandbox client here, then look at whether the visit's SignedIn flag
 * actually flipped.
 *
 * There is also no counterpart to reverse an arrival anywhere in v6, which
 * is why undo in the UI holds the call briefly rather than sending and
 * retracting.
 */
export async function checkIn(
  clientId: string,
  classId: number,
): Promise<void> {
  await mindbody("/class/addarrival", {
    method: "POST",
    body: { ClientId: clientId, ClassId: classId },
  });
}
