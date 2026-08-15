import {
  replayQuota,
  type PayPeriod,
  type PayRate,
  type QuotaClass,
  type UnpaidQuota,
} from "@ai-manager/core";

/**
 * The payroll arithmetic (SEA-104), pure and deterministic: every number
 * on an invoice comes out of this module, and every rule traces to
 * docs/payroll-policy.md. No model touches money; payroll.prepare's
 * preflight feeds this with rows read through the analytics seam and
 * files the result verbatim.
 *
 * Policy mapping:
 * - §1 pay = rate_cents * classes taught (per teacher, one rate).
 * - §2 role is informational; owners are computed like everyone else.
 * - §3 class_instances.teacher_id is who actually taught; subs need
 *   nothing special here.
 * - §4 attendance is context, never an input (this module never sees it).
 * - §5 cancelled classes are filtered by the CALLER's query
 *   (COALESCE(is_canceled,0)=0, dates bounded to the closed period).
 * - §7 blockers: NULL mb_staff_id, missing rate row, or the TBA
 *   placeholder fail the WHOLE run; nothing is filed.
 * - §9 the rate applied is the one in effect on the period START.
 * - §12 a computed total of zero files no item (but is reported).
 * - §13 training payback: replay the arrangement's full class history
 *   through the period end; the period's classes' free/paid status falls
 *   out of the replay, so it never depends on when payroll ran.
 */

/** One taught class inside the period, as read through the seam. */
export interface PeriodClass {
  date: string;
  timeNorm: string;
  classType: string;
  /** Context for the approver (policy §4): shown, never computed on. */
  attendeeCount: number | null;
}

/** One teacher's period input. */
export interface TeacherPeriodInput {
  /** Null when the upstream identity is unresolved — a run blocker. */
  mbStaffId: number | null;
  name: string;
  role: string;
  classes: PeriodClass[];
}

/** A quota arrangement plus the replay's full input history (classes
 * since effective_from THROUGH the period end, every one carrying the
 * rate applicable to its own period per policy §9/§13). */
export interface QuotaInput {
  quota: Pick<
    UnpaidQuota,
    "free_classes_per_month" | "obligation_cents" | "effective_from" | "effective_to"
  >;
  historyClasses: QuotaClass[];
}

/** One class line on an invoice, with its replay outcome when a quota
 * arrangement applies. */
export interface InvoiceClassLine extends PeriodClass {
  rateCents: number;
  /** Cents actually payable for this class. */
  paidCents: number;
  /** True when the class drew against a training-payback quota. */
  free: boolean;
  /** Cents credited against the training balance (0 without a quota). */
  creditedCents: number;
}

/** One teacher's computed invoice for the period. */
export interface TeacherInvoice {
  mbStaffId: number;
  name: string;
  role: string;
  rateCents: number;
  classCount: number;
  freeCount: number;
  paidCount: number;
  totalCents: number;
  lines: InvoiceClassLine[];
  /** Present when a training-payback arrangement applied this period. */
  quota?: {
    creditedCents: number;
    remainingCentsAfter: number;
    paidOffOn: string | null;
  };
  /** Human-readable arithmetic (policy §13: an invoice shows its work),
   * e.g. "6 classes taught, 3 unpaid (training payback), 3 paid at $75,
   * total $225". No em dashes (house rule). */
  summary: string;
}

/** Why the whole run must block (policy §7). quota_history_mismatch and
 * quota_rate_gap (SEA-111 fix 2d) are quota DATA gaps: the replay
 * history disagrees with the period read, or a rate window fails to
 * cover a class in the replay. Both used to surface as raw exceptions
 * with no alert; as blockers they fail the run loudly and consistently
 * like every other blocking condition, filing nothing. */
export interface RunBlocker {
  teacherName: string;
  reason:
    | "null_mb_staff_id"
    | "no_rate"
    | "tba_identity"
    | "quota_history_mismatch"
    | "quota_rate_gap";
}

export interface PayrollComputation {
  period: PayPeriod;
  invoices: TeacherInvoice[];
  /** Teachers whose computed total was zero: reported, never invoiced. */
  zeroTotals: Array<{ mbStaffId: number; name: string; reason: string }>;
  blockers: RunBlocker[];
}

function dollars(cents: number): string {
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;
}

function invoiceSummary(inv: Omit<TeacherInvoice, "summary">): string {
  const classes = `${inv.classCount} class${inv.classCount === 1 ? "" : "es"} taught`;
  if (inv.freeCount === 0) {
    return `${classes}, paid at ${dollars(inv.rateCents)}, total ${dollars(inv.totalCents)}`;
  }
  // Partial tail (policy §13): a free class can still carry pay when it
  // works off less than a full rate; the line items show the split.
  return `${classes}, ${inv.freeCount} unpaid (training payback), ${inv.paidCount} paid at ${dollars(inv.rateCents)}, total ${dollars(inv.totalCents)}`;
}

/**
 * Compute every teacher's invoice for one closed period. Throws nothing:
 * blockers are returned for the caller to act on (file nothing, notify),
 * because a partial computation must never leak into filing.
 */
export function computePayroll(input: {
  period: PayPeriod;
  teachers: TeacherPeriodInput[];
  /** Rate in effect on the period start, keyed by mb_staff_id (§9). */
  rates: Map<number, PayRate>;
  /** Active quota arrangements keyed by mb_staff_id (§13). */
  quotas: Map<number, QuotaInput>;
}): PayrollComputation {
  const { period, teachers, rates, quotas } = input;
  const blockers: RunBlocker[] = [];
  const invoices: TeacherInvoice[] = [];
  const zeroTotals: PayrollComputation["zeroTotals"] = [];

  for (const teacher of teachers) {
    if (teacher.classes.length === 0) continue;
    if (teacher.mbStaffId === null) {
      blockers.push({ teacherName: teacher.name, reason: "null_mb_staff_id" });
      continue;
    }
    if (teacher.name.trim().toUpperCase() === "TBA") {
      blockers.push({ teacherName: teacher.name, reason: "tba_identity" });
      continue;
    }
    const rate = rates.get(teacher.mbStaffId);
    if (!rate) {
      blockers.push({ teacherName: teacher.name, reason: "no_rate" });
      continue;
    }

    const ordered = [...teacher.classes].sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.timeNorm.localeCompare(b.timeNorm),
    );

    const quotaInput = quotas.get(teacher.mbStaffId);
    let lines: InvoiceClassLine[];
    let quotaSection: TeacherInvoice["quota"];
    if (quotaInput) {
      // Replay the arrangement's whole history (policy §13: derivation,
      // never a counter), then pick this period's classes out of it. The
      // replay input must extend through the period end and no further.
      const replay = replayQuota(
        {
          freeClassesPerMonth: quotaInput.quota.free_classes_per_month,
          obligationCents: quotaInput.quota.obligation_cents,
          effectiveFrom: quotaInput.quota.effective_from,
          effectiveTo: quotaInput.quota.effective_to,
        },
        quotaInput.historyClasses,
      );
      const inPeriod = replay.classes.filter(
        (c) => c.date >= period.start && c.date <= period.end,
      );
      if (inPeriod.length !== ordered.length) {
        // The replay history must contain exactly this period's classes;
        // a mismatch means the two reads disagree and no number derived
        // from either can be trusted. A BLOCKER, not a throw (SEA-111
        // fix 2d): the run fails loudly through the policy §7 path
        // (alert + nothing filed) instead of dying as a raw exception
        // that pages nobody.
        console.error(
          `[payroll] quota history for staff ${teacher.mbStaffId} has ${inPeriod.length} period classes, period read has ${ordered.length}; blocking the run`,
        );
        blockers.push({
          teacherName: teacher.name,
          reason: "quota_history_mismatch",
        });
        continue;
      }
      lines = ordered.map((cls, i) => {
        const outcome = inPeriod[i];
        if (!outcome) throw new Error("computePayroll: unreachable");
        return {
          ...cls,
          rateCents: outcome.rateCents,
          paidCents: outcome.paidCents,
          free: outcome.free,
          creditedCents: outcome.creditedCents,
        };
      });
      quotaSection = {
        creditedCents: inPeriod.reduce((s, c) => s + c.creditedCents, 0),
        remainingCentsAfter: replay.remainingCents,
        paidOffOn: replay.paidOffOn,
      };
    } else {
      lines = ordered.map((cls) => ({
        ...cls,
        rateCents: rate.rate_cents,
        paidCents: rate.rate_cents,
        free: false,
        creditedCents: 0,
      }));
    }

    const totalCents = lines.reduce((s, l) => s + l.paidCents, 0);
    const freeCount = lines.filter((l) => l.free).length;
    const base = {
      mbStaffId: teacher.mbStaffId,
      name: teacher.name,
      role: teacher.role,
      rateCents: rate.rate_cents,
      classCount: lines.length,
      freeCount,
      paidCount: lines.filter((l) => l.paidCents > 0).length,
      totalCents,
      lines,
      ...(quotaSection ? { quota: quotaSection } : {}),
    };

    if (totalCents === 0) {
      // Policy §12: no item and no Bill for a zero total (trade
      // arrangements, or a period fully consumed by the quota).
      zeroTotals.push({
        mbStaffId: teacher.mbStaffId,
        name: teacher.name,
        reason:
          rate.rate_cents === 0
            ? "zero rate (unpaid by agreement)"
            : "period fully covered by training payback",
      });
      continue;
    }
    invoices.push({ ...base, summary: invoiceSummary(base) });
  }

  invoices.sort((a, b) => a.name.localeCompare(b.name));
  return { period, invoices, zeroTotals, blockers };
}
