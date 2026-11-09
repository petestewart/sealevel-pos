/**
 * Whether the class on screen is a student's FIRST class with the studio
 * (Pete: "when a class is going to be a student's first class with us a
 * star is shown on their row in the same area where \"M\" (for member)
 * is"), and since T217 only the first one on their first day (Pete, after
 * booking himself into five classes and seeing five stars: "it should only
 * have the star if it's their first class on their first day").
 *
 * Two facts decide it, both gathered by the roster on the server:
 *
 * - `date`, the client record's `FirstClassDate` (client.yml, the Client
 *   schema: "The date of the clients first booked class at the
 *   business"), from the batched `/client/clients` lookup the roster
 *   already makes. A date on an EARLIER day than this class rules the
 *   star out with no further call: they have had a first day already.
 * - `earlier`, whether the client has any booking that starts before this
 *   class: on an earlier day, or earlier the same day. The roster asks
 *   `/client/clientvisits` for it, and only for rows the date did not
 *   already rule out (`needsVisitCheck`). This is what T216 lacked: a
 *   bare date, or no date at all, cannot tell a student's 9am from their
 *   5pm, so every booking on the first day drew a star.
 *
 * The star shows only when `earlier` is `false`: Mindbody knows of no
 * class before this one. `earlier: null` (not asked, the read failed, or
 * the roster was over its per-load budget) draws nothing, and so does a
 * `fact` of null (the client lookup did not answer). A missing star on a
 * new student is the error direction chosen over a star on a regular.
 *
 * Every datetime here is a NAIVE studio wall-clock string, which is what
 * makes the comparisons plain string comparisons.
 */
export interface FirstClassFact {
  /** `FirstClassDate` as Mindbody sent it, or null when the record
   *  carries none. */
  date: string | null;
  /** Whether a booking starts before this class: true, false, or null
   *  when nobody asked or the answer did not come. */
  earlier: boolean | null;
}

const DAY = /^\d{4}-\d\d-\d\d/;

/** False when `FirstClassDate` already puts the first class on an earlier
 *  day than this one, so no visit read is needed; true otherwise. */
export function needsVisitCheck(
  date: string | null,
  classStartsAt: string | null | undefined,
): boolean {
  if (!classStartsAt || !DAY.test(classStartsAt)) return false;
  if (date === null || !DAY.test(date)) return true;
  return date.slice(0, 10) >= classStartsAt.slice(0, 10);
}

export function isFirstClass(
  fact: FirstClassFact | null | undefined,
  classStartsAt: string | null | undefined,
): boolean {
  if (!fact) return false;
  if (!needsVisitCheck(fact.date, classStartsAt)) return false;
  return fact.earlier === false;
}
