import { ensureIndex, nameFor } from "./clients";
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

export async function classRoster(classId: number): Promise<ClassRoster> {
  const [classes, rawEntries] = await Promise.all([
    classesAroundNow(),
    rosterFor(classId),
  ]);

  /**
   * Fill any name the visit payload did not carry from the client index.
   * The index is already loaded for search, so this costs a map lookup,
   * and it means a roster is never at the mercy of which name fields
   * Mindbody decides to include on a visit.
   */
  await ensureIndex();
  const entries = rawEntries.map((entry) =>
    entry.name
      ? entry
      : { ...entry, name: nameFor(entry.clientId) ?? "(unknown client)" },
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
