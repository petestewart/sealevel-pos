import { mindbody, target } from "./mindbody";

/**
 * Teachers: the active class instructors, for the comp dialog's "for"
 * list (T45) and for checking that a Mindbody login enrolling a PIN
 * (T48) belongs to one. Read from `GET /staff/staff`
 * (docs/mindbody-openapi/staff.yml). Names and ids only: T44 read phone
 * numbers here for a last-four PIN and T48 removed that (Pete: "we dont
 * have phone #s for everyone"), so nothing in this module touches a
 * phone field and no answer built from it can carry one.
 *
 * Cached ten minutes per target, in memory only (the T29 charter: a
 * staff row is Mindbody's, and a table of it would be a copy). A failed
 * read serves the stale cache when there is one, so a Mindbody blip does
 * not take the comp dialog down; with no cache at all the error
 * propagates and the caller answers 502.
 */

export interface Teacher {
  id: number;
  /** "First Last", falling back to DisplayName, then "Staff <id>". */
  name: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_LIMIT = 100;
/** More pages than any studio has staff; a guard against a pagination
 *  answer that never shrinks. */
const MAX_PAGES = 10;

let cache: { key: string; at: number; teachers: Teacher[] } | null = null;

/** T48: the studio's staff list carries placeholder rows that are not
 *  people ("TBA .", "TBA TBA", "TBA Teacher", "No Class No Class", "No
 *  Class Today", "FrontDesk Account" on the live list), and a comp "for"
 *  one of them names nobody. A row is a placeholder when its id is not
 *  positive or its name carries one of these words. */
const PLACEHOLDER_NAME = /\b(tba|no class|front ?desk|account|teacher|staff)\b/i;

export function isPlaceholderTeacher(id: number, name: string): boolean {
  return id <= 0 || PLACEHOLDER_NAME.test(name);
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
  if (typeof row["Id"] !== "number") return false;
  return !isPlaceholderTeacher(row["Id"], nameOf(row));
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
      out.push({ id, name: nameOf(row) });
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
