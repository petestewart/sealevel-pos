/**
 * Whether the class on screen is a student's FIRST class with the studio
 * (Pete: "when a class is going to be a student's first class with us a
 * star is shown on their row in the same area where \"M\" (for member)
 * is").
 *
 * The evidence is the client record's `FirstClassDate` (client.yml, the
 * Client schema: "The date of the clients first booked class at the
 * business"), which rides the batched `/client/clients` lookup the roster
 * already makes, so the star costs no Mindbody call. Like every other
 * Mindbody datetime it is a NAIVE studio wall-clock string, and so is the
 * class's `startsAt`, which is what makes the comparison below a plain
 * string comparison.
 *
 * The rule, read as "Mindbody knows of no class for this person before
 * this one":
 *
 * - The record says nothing (`date: null`): a first class. The student
 *   is on this roster, so this class is one, and Mindbody knows no
 *   earlier one. This is the brand-new walk-in, the person the star is
 *   most for.
 * - The date is on a LATER day than this class: a first class, for the
 *   same reason.
 * - The date is on an EARLIER day: not.
 * - The same day: when the date carries a time, it must not be earlier
 *   than this class's start (a 6:20am first class makes the 4:30pm one
 *   their second); a bare date (midnight) cannot tell two classes on one
 *   day apart, so it counts.
 *
 * Unverified live: whether Mindbody sets the field at BOOKING or at the
 * first sign-in, and whether it carries a time. The rule above gives the
 * right star under either reading for a student whose first class is
 * this one. If it is set at booking, a student who booked an earlier
 * class and missed it shows no star; that is the error direction chosen,
 * a missing star rather than a false one on a regular.
 *
 * `fact` null means the client lookup did not answer for this row (it
 * failed, or missed the client): unknown, and unknown draws nothing,
 * the same fail-open posture as the M.
 */
export interface FirstClassFact {
  /** `FirstClassDate` as Mindbody sent it, or null when the record
   *  carries none. */
  date: string | null;
}

export function isFirstClass(
  fact: FirstClassFact | null | undefined,
  classStartsAt: string | null | undefined,
): boolean {
  if (!fact) return false;
  if (!classStartsAt || !/^\d{4}-\d\d-\d\d/.test(classStartsAt)) return false;
  const first = fact.date;
  if (first === null) return true;
  if (!/^\d{4}-\d\d-\d\d/.test(first)) return false;
  const firstDay = first.slice(0, 10);
  const classDay = classStartsAt.slice(0, 10);
  if (firstDay !== classDay) return firstDay > classDay;
  const firstTime = first.slice(11, 16);
  /* A bare date, or midnight: no time to tell two classes apart by. */
  if (!/^\d\d:\d\d$/.test(firstTime) || firstTime === "00:00") return true;
  const classTime = classStartsAt.slice(11, 16);
  if (!/^\d\d:\d\d$/.test(classTime)) return true;
  return firstTime >= classTime;
}
