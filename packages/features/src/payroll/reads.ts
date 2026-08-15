import {
  pageSelect,
  PAYROLL_ANCHOR,
  periodContaining,
  type PayPeriod,
  type PayRate,
  type QuotaClass,
} from "@ai-manager/core";

import type { PeriodClass, TeacherPeriodInput } from "./compute.js";

/**
 * payroll.prepare's reads through the analytics seam (plan §2.5: the MCP
 * tools are the only data path; no second D1 client). Every query filters
 * cancelled classes (policy §5) and orders deterministically with
 * class_instance_id as the tie-break so pageSelect's OFFSET paging can
 * never repeat or skip a row.
 */

async function runSelect(
  select: string,
  pageSelectImpl: typeof pageSelect = pageSelect,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for await (const page of pageSelectImpl(select)) {
    rows.push(...page);
  }
  return rows;
}

/**
 * Freshness gate (policy §6 step 4): the run must be able to SEE the
 * period it is invoicing. A stale mirror is indistinguishable from a
 * light teaching day, so every check errs toward blocking:
 *
 * 1. the maximum class date must reach the period end, and
 * 2. the period's final Sunday must have classes present (the studio
 *    runs four to five every Sunday), and
 * 3. ATTENDED VISITS must exist for the final Sunday's classes.
 *
 * Check 3 is the one that proves what payroll actually needs. The sync
 * pulls a forward window, so class_instances carries FUTURE-DATED
 * schedule rows: a class scheduled for tonight is already a row before
 * anyone has taught it, which made checks 1 and 2 pass on booking-shaped
 * morning data (the 2:30am nightly) while afternoon cancellations were
 * still is_canceled=0 and sub swaps invisible. Attended visits rows for
 * the period-end Sunday exist only once a sync whose window covers the
 * Sunday classes has landed, i.e. after the classes: the on-demand
 * payday dispatch, or a manual one. Zero attended Sunday visits means
 * Sunday evening data has not landed, and the run blocks rather than
 * invoicing from stale data. A genuinely closed Sunday also blocks, and
 * a human clears it, per the existing design.
 */
export async function checkFreshness(
  period: PayPeriod,
  /** Injectable analytics seam for the offline smoke; production callers
   * pass nothing and get the real pageSelect. */
  pageSelectImpl: typeof pageSelect = pageSelect,
): Promise<{
  fresh: boolean;
  maxClassDate: string | null;
  finalSundayClasses: number;
  /** SUM(visits.attended) over the final Sunday's non-cancelled classes:
   * the attendance-shaped evidence that the post-classes sync landed. */
  finalSundayAttended: number;
}> {
  // A bare aggregate returns exactly one row; the ORDER BY only satisfies
  // pageSelect's determinism contract.
  const rows = await runSelect(
    `SELECT MAX(ci.date) AS max_date,
            SUM(CASE WHEN ci.date = '${period.end}' THEN 1 ELSE 0 END) AS sunday_classes,
            (SELECT COALESCE(SUM(v.attended), 0)
               FROM visits v
               JOIN class_instances sci
                 ON sci.class_instance_id = v.class_instance_id
              WHERE sci.date = '${period.end}'
                AND COALESCE(sci.is_canceled, 0) = 0) AS sunday_attended
     FROM class_instances ci
     WHERE COALESCE(ci.is_canceled, 0) = 0
     ORDER BY max_date`,
    pageSelectImpl,
  );
  const row = rows[0] ?? {};
  const maxClassDate =
    typeof row["max_date"] === "string" ? row["max_date"] : null;
  const finalSundayClasses = Number(row["sunday_classes"] ?? 0);
  const finalSundayAttended = Number(row["sunday_attended"] ?? 0);
  return {
    fresh:
      maxClassDate !== null &&
      maxClassDate >= period.end &&
      finalSundayClasses > 0 &&
      finalSundayAttended > 0,
    maxClassDate,
    finalSundayClasses,
    finalSundayAttended,
  };
}

/** One raw period class row as the query returns it (exported for the
 * grouping smoke, which must exercise the exact production path). */
export interface PeriodClassRow {
  mb_staff_id: unknown;
  name: unknown;
  role: unknown;
  date: unknown;
  time_norm: unknown;
  class_type: unknown;
  attendees: unknown;
}

/**
 * Group raw period rows into one TeacherPeriodInput per PERSON (SEA-110
 * fix 1a). The identity key is mb_staff_id ALONE: two upstream teachers
 * rows can share a staff id (a rename, or an auto-onboard duplicate;
 * upstream cannot enforce uniqueness on the column), and keying on the
 * name as well would split one person's classes across two invoices, of
 * which only one survives filing. The display name is chosen
 * deterministically as the one on the teacher's most recent class (rows
 * arrive date-ordered per staff id, so last write wins); upstream has no
 * timestamps and teacher_id is rebuilt nightly, so recency of actual
 * teaching is the only stable rule available.
 *
 * NULL staff ids deliberately stay split PER NAME: several unidentified
 * teachers must not collapse into one blocker row, and each must reach
 * the policy §7 blocker path under their own name.
 */
export function groupPeriodRows(
  rows: PeriodClassRow[],
): TeacherPeriodInput[] {
  const byTeacher = new Map<string, TeacherPeriodInput>();
  const latestDates = new Map<string, string>();
  for (const row of rows) {
    const name = String(row.name ?? "(unnamed)");
    const staffRaw = row.mb_staff_id;
    const parsed =
      staffRaw === null || staffRaw === undefined || staffRaw === ""
        ? null
        : Number(staffRaw);
    const mbStaffId =
      parsed !== null && Number.isInteger(parsed) && parsed > 0
        ? parsed
        : null;
    const key = mbStaffId !== null ? `id:${mbStaffId}` : `null:${name}`;
    let teacher = byTeacher.get(key);
    if (!teacher) {
      teacher = {
        mbStaffId,
        name,
        role: String(row.role ?? "staff"),
        classes: [],
      };
      byTeacher.set(key, teacher);
      latestDates.set(key, "");
    }
    const cls: PeriodClass = {
      date: String(row.date ?? ""),
      timeNorm: String(row.time_norm ?? ""),
      classType: String(row.class_type ?? ""),
      attendeeCount:
        typeof row.attendees === "number" ? row.attendees : null,
    };
    teacher.classes.push(cls);
    // Most-recent-class name wins, independent of row order.
    if (cls.date >= (latestDates.get(key) ?? "")) {
      latestDates.set(key, cls.date);
      teacher.name = name;
    }
  }
  return [...byTeacher.values()];
}

/** Every non-cancelled class in the period, grouped per teacher. */
export async function readPeriodTeachers(
  period: PayPeriod,
): Promise<TeacherPeriodInput[]> {
  const rows = await runSelect(
    `SELECT t.mb_staff_id AS mb_staff_id, t.canonical_name AS name,
            t.role AS role, ci.date AS date, ci.time_norm AS time_norm,
            ct.canonical_type AS class_type, ci.attendee_count AS attendees
     FROM class_instances ci
     JOIN teachers t ON t.teacher_id = ci.teacher_id
     JOIN class_types ct ON ct.class_type_id = ci.class_type_id
     WHERE ci.date >= '${period.start}' AND ci.date <= '${period.end}'
       AND COALESCE(ci.is_canceled, 0) = 0
     ORDER BY t.canonical_name, ci.date, ci.time_norm, ci.class_instance_id`,
  );
  return groupPeriodRows(rows as unknown as PeriodClassRow[]);
}

/**
 * The rate applicable to a class taught on `date` (policy §9: the rate in
 * effect on the class's period start; pre-anchor classes use the class
 * date itself). Null when no stored window covers it.
 */
export function rateForClassDate(
  history: PayRate[],
  mbStaffId: number,
  date: string,
): number | null {
  const lookup = date >= PAYROLL_ANCHOR ? periodContaining(date).start : date;
  const row = history.find(
    (r) =>
      r.mb_staff_id === mbStaffId &&
      r.effective_from <= lookup &&
      (r.effective_to === null || r.effective_to >= lookup),
  );
  return row ? row.rate_cents : null;
}

/**
 * A quota teacher's full replay history: every taught class from the
 * arrangement start THROUGH the period end (inclusive; by run time the
 * period's Sunday classes are taught and synced, policy §6), each
 * carrying its applicable rate. Throws when a class predates every rate
 * window: a balance derived from a guessed rate is a money bug.
 */
export async function readQuotaHistory(input: {
  mbStaffId: number;
  effectiveFrom: string;
  periodEnd: string;
  rateHistory: PayRate[];
}): Promise<QuotaClass[]> {
  const rows = await runSelect(
    `SELECT ci.date AS date FROM class_instances ci
     JOIN teachers t ON t.teacher_id = ci.teacher_id
     WHERE t.mb_staff_id = ${input.mbStaffId}
       AND ci.date >= '${input.effectiveFrom}'
       AND ci.date <= '${input.periodEnd}'
       AND COALESCE(ci.is_canceled, 0) = 0
     ORDER BY ci.date, ci.time_norm, ci.class_instance_id`,
  );
  return rows.map((row) => {
    const date = String(row["date"] ?? "");
    const rateCents = rateForClassDate(input.rateHistory, input.mbStaffId, date);
    if (rateCents === null) {
      throw new Error(
        `payroll: no rate covers ${date} for staff ${input.mbStaffId}; extend the rate history to the arrangement start`,
      );
    }
    return { date, rateCents };
  });
}
