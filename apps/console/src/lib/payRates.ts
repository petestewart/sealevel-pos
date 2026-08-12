import "./env";
import {
  analyticsBlackout,
  analyticsConfigured,
  pageSelect,
  listPayRates,
  listUnpaidQuotas,
  PAYROLL_ANCHOR,
  periodContaining,
  ratesInEffectOn,
  replayQuota,
  studioToday,
  type PayRate,
  type QuotaClass,
  type UnpaidQuota,
} from "@ai-manager/core";

/**
 * Data assembly for the Teacher pay rates settings page (SEA-106).
 *
 * The teacher list comes from the analytics mirror through the analytics
 * seam (the MCP server's read-only analytics identity): teachers are
 * never created in ai-manager, so the page lists the identities that
 * actually taught recently and attaches rate state to each. When
 * analytics is unconfigured or inside the nightly-rebuild blackout, the
 * page degrades to the rate rows alone with an honest note — rates stay
 * editable, only the "who taught recently" list is unavailable.
 *
 * NOTE (posture change, SEA-106): SEALEVEL_MCP_ANALYTICS_TOKEN was
 * documented worker-only when its only consumer was campaign jobs. This
 * page reads through the same seam from the console server, so the
 * console now holds the read-only analytics credential too — see
 * docs/infrastructure.md. The write-capable credentials (Gmail, KB
 * writer, QBO) remain worker-only; nothing here changes that split.
 */

/** One teacher known to have taught in the last 90 days. */
export interface RecentTeacher {
  /** NULL for export-era identities the sync could not resolve. */
  mbStaffId: number | null;
  name: string;
  role: string;
  classes90d: number;
  lastTaught: string;
}

/** Rate state attached to one listed teacher (the three row states). */
export type TeacherRateRow =
  | { state: "unpayable"; teacher: RecentTeacher }
  | { state: "no_rate"; teacher: RecentTeacher }
  | { state: "rated"; teacher: RecentTeacher; rate: PayRate };

/** A quota arrangement with its derived balance, for the payback section. */
export interface QuotaView {
  quota: UnpaidQuota;
  teacherName: string;
  /** Derived remaining balance in cents, or null when it could not be
   * computed (analytics down, or no rate history covering the window). */
  remainingCents: number | null;
  paidOffOn: string | null;
  /** Why the balance is missing, when it is. */
  note?: string;
}

export interface PayRatesPageData {
  /** Recent-teacher rows, or null when analytics could not be read. */
  rows: TeacherRateRow[] | null;
  /** Why rows is null (rendered as the degraded-mode note). */
  analyticsNote: string | null;
  /** Every stored rate, newest window first per teacher (history view). */
  history: PayRate[];
  quotas: QuotaView[];
}

/**
 * Collect a full SELECT result through core's pageSelect, which owns the
 * 200-row run_sql cap: it appends LIMIT/OFFSET per page and keeps going
 * until a short page. Hand-reading run_sql here would silently truncate
 * at 200 rows — for the quota replay that means crediting only part of a
 * teacher's class history and reporting a remaining balance that is too
 * high, with nothing in the UI marking the number as partial.
 */
async function runSelect(
  select: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for await (const page of pageSelect(select)) {
    rows.push(...page);
  }
  return rows;
}

/**
 * The upstream mb_staff_id as a number, or null only when it is truly
 * absent. Coerced, not typeof-checked: null is not a neutral default here
 * — it renders the row as "unpayable, fix upstream" and removes the Set
 * rate button — so a serialization change upstream (the mirror emitting
 * the column as a string) must not flip every teacher into that state.
 */
function staffIdOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function daysAgo(days: number): string {
  const ms = Date.parse(`${studioToday()}T00:00:00Z`) - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Teachers who taught a non-cancelled class in the last 90 days. Bounded
 * strictly BELOW studio-today on both reads in this file: the mirror
 * carries rows for today's and forward-scheduled classes whose data is
 * bookings, not attendance (policy §5 — only classes that have already
 * happened count), so an unbounded read would list a teacher as having
 * "taught" a class they only have on the schedule.
 */
async function recentTeachers(): Promise<RecentTeacher[]> {
  const cutoff = daysAgo(90);
  const today = studioToday();
  // Teacher volume sits far below one 200-row page, but the read still
  // goes through pageSelect so a surprise can never silently truncate.
  const rows = await runSelect(
    `SELECT t.mb_staff_id AS mb_staff_id, t.canonical_name AS name,
            t.role AS role, COUNT(*) AS classes, MAX(ci.date) AS last_taught
     FROM class_instances ci
     JOIN teachers t ON t.teacher_id = ci.teacher_id
     WHERE ci.date >= '${cutoff}' AND ci.date < '${today}'
       AND COALESCE(ci.is_canceled, 0) = 0
     GROUP BY t.teacher_id, t.mb_staff_id, t.canonical_name, t.role
     ORDER BY t.canonical_name`,
  );
  return rows.map((r) => ({
    mbStaffId: staffIdOf(r["mb_staff_id"]),
    name: String(r["name"] ?? "(unnamed)"),
    role: String(r["role"] ?? "staff"),
    classes90d: Number(r["classes"] ?? 0),
    lastTaught: String(r["last_taught"] ?? ""),
  }));
}

/**
 * The rate that applied to a class taught on `date` (policy §9: the rate
 * in effect on the class's period start; for pre-anchor classes, on the
 * class date itself). Null when no stored window covers it.
 */
function rateForClassDate(history: PayRate[], mbStaffId: number, date: string): number | null {
  const lookup = date >= PAYROLL_ANCHOR ? periodContaining(date).start : date;
  const row = history.find(
    (r) =>
      r.mb_staff_id === mbStaffId &&
      r.effective_from <= lookup &&
      (r.effective_to === null || r.effective_to >= lookup),
  );
  return row ? row.rate_cents : null;
}

/** Derive one arrangement's remaining balance by replaying its classes. */
async function quotaView(
  quota: UnpaidQuota,
  history: PayRate[],
  teacherName: string,
  analyticsUp: boolean,
): Promise<QuotaView> {
  const base: QuotaView = {
    quota,
    teacherName,
    remainingCents: null,
    paidOffOn: null,
  };
  if (!analyticsUp) {
    return { ...base, note: "Balance unavailable while analytics is unreachable." };
  }
  try {
    // Strictly before studio-today: today's and future-dated rows are
    // bookings, not attendance (policy §5), and crediting them would work
    // the balance off early — a class tonight must not count at noon.
    // class_instance_id makes the page ordering strictly unique, so a
    // multi-page read can never repeat or skip a row at a page boundary
    // when two classes share (date, time_norm).
    const rows = await runSelect(
      `SELECT ci.date AS date FROM class_instances ci
       JOIN teachers t ON t.teacher_id = ci.teacher_id
       WHERE t.mb_staff_id = ${quota.mb_staff_id}
         AND ci.date >= '${quota.effective_from}'
         AND ci.date < '${studioToday()}'
         AND COALESCE(ci.is_canceled, 0) = 0
       ORDER BY ci.date, ci.time_norm, ci.class_instance_id`,
    );
    const classes: QuotaClass[] = [];
    for (const r of rows) {
      const date = String(r["date"] ?? "");
      const rateCents = rateForClassDate(history, quota.mb_staff_id, date);
      if (rateCents === null) {
        return {
          ...base,
          note: `No rate covers ${date}, so the balance cannot be derived. Extend the rate history back to the arrangement start.`,
        };
      }
      classes.push({ date, rateCents });
    }
    const replay = replayQuota(
      {
        freeClassesPerMonth: quota.free_classes_per_month,
        obligationCents: quota.obligation_cents,
        effectiveFrom: quota.effective_from,
        effectiveTo: quota.effective_to,
      },
      classes,
    );
    return {
      ...base,
      remainingCents: replay.remainingCents,
      paidOffOn: replay.paidOffOn,
    };
  } catch (err) {
    console.warn(
      `[pay-rates] quota balance for staff ${quota.mb_staff_id} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { ...base, note: "Balance unavailable (analytics read failed)." };
  }
}

/** Assemble everything the pay-rates page renders. */
export async function payRatesPageData(): Promise<PayRatesPageData> {
  const today = studioToday();
  const [history, current, quotas] = await Promise.all([
    listPayRates(),
    ratesInEffectOn(today),
    listUnpaidQuotas(),
  ]);

  let rows: TeacherRateRow[] | null = null;
  let analyticsNote: string | null = null;
  let analyticsUp = false;
  if (!analyticsConfigured()) {
    analyticsNote =
      "Analytics is not configured on the console, so the recent-teacher list is unavailable. Stored rates are shown below.";
  } else if (analyticsBlackout()) {
    analyticsNote =
      "The analytics mirror is rebuilding (nightly sync window). The recent-teacher list will be back after 6:00 AM Pacific.";
  } else {
    try {
      const teachers = await recentTeachers();
      analyticsUp = true;
      rows = teachers.map((teacher): TeacherRateRow => {
        if (teacher.mbStaffId === null) return { state: "unpayable", teacher };
        const rate = current.get(teacher.mbStaffId);
        return rate
          ? { state: "rated", teacher, rate }
          : { state: "no_rate", teacher };
      });
    } catch (err) {
      analyticsNote = "The analytics read failed, so the recent-teacher list is unavailable. Stored rates are shown below.";
      console.warn(
        `[pay-rates] recent-teacher read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const nameOf = (mbStaffId: number): string =>
    rows?.find(
      (r) => r.teacher.mbStaffId === mbStaffId,
    )?.teacher.name ??
    history.find((r) => r.mb_staff_id === mbStaffId)?.teacher_display_name ??
    `staff ${mbStaffId}`;

  const quotaViews = await Promise.all(
    quotas.map((q) => quotaView(q, history, nameOf(q.mb_staff_id), analyticsUp)),
  );

  return { rows, analyticsNote, history, quotas: quotaViews };
}
