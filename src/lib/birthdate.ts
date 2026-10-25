/**
 * A birth date, the one field the sign-up forms ask for ONLY when the
 * site demands it (T206).
 *
 * Pete's first drive of the self-serve sign-up, 2026-09-20: the student
 * filled the customer screen in and the teacher's New Client modal
 * ended in "The following are required: Birthday". Site -99 lists
 * `BirthDate` in `/client/requiredclientfields`, and the four-field form
 * (D4: "first name, last name, email, phone. Nothing else") had no way
 * to give Mindbody a fifth it insists on. So both forms grow one field,
 * and ONLY when the site's own required list names it: on a site that
 * does not, the field is absent and the `addclient` body is byte for
 * byte what it was.
 *
 * Nothing here calls Mindbody and nothing imports a server module: it is
 * used by the display's sign-up scene, by the teacher's modal, by
 * /api/display/complete and by /api/client-create, so one rule covers
 * what the student types, what the teacher corrects and what is stored.
 *
 * The shape is `YYYY-MM-DD`, which is what `<input type="date">` gives
 * and what the create turns into Mindbody's own
 * `YYYY-MM-DDT00:00:00` (datetimes are site-local and naive, so no
 * offset and no `toISOString()`; see CLAUDE.md).
 */

/** Nobody at a yoga counter was born before this. A typo of "1025" is
 *  refused rather than sent. */
export const MAX_AGE_YEARS = 120;

/** The names Mindbody's required-field list uses for it. The spec's own
 *  field is `BirthDate`; the refusal a live site words is "Birthday". */
export function isBirthDateField(field: string): boolean {
  return /^birth\s*(date|day)$/i.test(field.trim());
}

/** Whether the site's required list asks for one. */
export function birthDateRequired(fields: readonly string[]): boolean {
  return fields.some((f) => typeof f === "string" && isBirthDateField(f));
}

/**
 * `YYYY-MM-DD`, a real day, not in the future and not more than 120
 * years back. Empty (or absent) is `null`, which is "not given": whether
 * that is allowed is the caller's question, since it depends on the
 * site's list.
 */
export function readBirthDate(
  value: unknown,
  now = Date.now(),
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "birthDate must be a string" };
  }
  const raw = value.trim();
  if (raw === "") return { ok: true, value: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m === null) {
    return { ok: false, error: "that birth date does not look right" };
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const at = Date.UTC(year, month - 1, day);
  const d = new Date(at);
  /* The round trip is what refuses 2026-02-30 and 2026-13-01, which the
   * pattern alone lets through. */
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return { ok: false, error: "that birth date does not look right" };
  }
  if (at > now) {
    return { ok: false, error: "that birth date is in the future" };
  }
  const floor = new Date(now);
  floor.setUTCFullYear(floor.getUTCFullYear() - MAX_AGE_YEARS);
  if (at < floor.getTime()) {
    return { ok: false, error: "that birth date is too long ago" };
  }
  return { ok: true, value: raw };
}

/** Mindbody's own shape for the day: naive, site-local, midnight. */
export function birthDateForMindbody(day: string): string {
  return `${day}T00:00:00`;
}
