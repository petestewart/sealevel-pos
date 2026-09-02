import { mindbody, target } from "./mindbody";

/**
 * Teachers, for the counter's "who is here" prompt (T44). Read from
 * `GET /staff/staff` (docs/mindbody-openapi/staff.yml), which returns the
 * phone fields only with a staff token whose group may view staff; the
 * API account needs that permission, unverified live as of the ticket.
 *
 * A teacher identifies with the last four digits of a phone on file
 * (mobile first, then home, then work; digits only, everything else
 * stripped). Those four digits are the whole secret, so this module is
 * the only place they exist server-side and nothing here returns a phone
 * number: `pinDigits` is the four digits, compared in auth code and
 * never sent to a browser.
 *
 * Cached ten minutes per target, in memory only (the T29 charter: a
 * staff row is Mindbody's, and a table of it would be a copy). A failed
 * read serves the stale cache when there is one, so a Mindbody blip
 * during a shift change does not lock the counter; with no cache at all
 * the error propagates and the login route answers 502.
 */

export interface Teacher {
  id: number;
  /** "First Last", falling back to DisplayName, then "Staff <id>". */
  name: string;
  /** The last four digits of the first phone on file, or null when no
   *  phone has four digits. */
  pinDigits: string | null;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_LIMIT = 100;
/** More pages than any studio has staff; a guard against a pagination
 *  answer that never shrinks. */
const MAX_PAGES = 10;

let cache: { key: string; at: number; teachers: Teacher[] } | null = null;

function digitsOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

/** The last four digits of the first usable phone, else null. */
function lastFour(row: Record<string, unknown>): string | null {
  for (const field of ["MobilePhone", "HomePhone", "WorkPhone"]) {
    const digits = digitsOf(row[field]);
    if (digits.length >= 4) return digits.slice(-4);
  }
  return null;
}

function nameOf(row: Record<string, unknown>): string {
  const first = typeof row["FirstName"] === "string" ? row["FirstName"].trim() : "";
  const last = typeof row["LastName"] === "string" ? row["LastName"].trim() : "";
  const full = `${first} ${last}`.trim();
  if (full) return full;
  const display =
    typeof row["DisplayName"] === "string" ? row["DisplayName"].trim() : "";
  return display || `Staff ${String(row["Id"])}`;
}

/** Whether a staff row is a teacher the counter should offer. The
 *  ClassInstructor filter goes out with the request; this is the same
 *  rule applied to what came back, in case the filter is ignored (the
 *  spec documents it, nobody has watched it work). `Active` is not in
 *  the spec's Staff model but appears in its examples, so only an
 *  explicit false excludes. */
function isTeacher(row: Record<string, unknown>): boolean {
  if (row["ClassTeacher"] === false) return false;
  if (row["Active"] === false) return false;
  return typeof row["Id"] === "number";
}

async function fetchTeachers(): Promise<Teacher[]> {
  const out: Teacher[] = [];
  const seen = new Set<number>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await mindbody(
      `/staff/staff?Filters=ClassInstructor&Limit=${PAGE_LIMIT}` +
        `&Offset=${page * PAGE_LIMIT}`,
    );
    const rows: unknown[] = Array.isArray(body?.StaffMembers)
      ? body.StaffMembers
      : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      if (!isTeacher(row)) continue;
      const id = row["Id"] as number;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: nameOf(row), pinDigits: lastFour(row) });
    }
    const total = Number(body?.PaginationResponse?.TotalResults ?? NaN);
    if (rows.length < PAGE_LIMIT) break;
    if (Number.isFinite(total) && (page + 1) * PAGE_LIMIT >= total) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** The teachers, cached. Throws only when there is nothing cached to
 *  serve instead. */
export async function listTeachers(): Promise<Teacher[]> {
  const key = target();
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.teachers;
  }
  try {
    const teachers = await fetchTeachers();
    cache = { key, at: Date.now(), teachers };
    return teachers;
  } catch (err) {
    if (cache && cache.key === key) {
      console.warn(
        `[staff] read failed (${err instanceof Error ? err.message : String(err)}); serving the cached list`,
      );
      return cache.teachers;
    }
    throw err;
  }
}
