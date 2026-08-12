/**
 * Training-payback quota replay (SEA-108, docs/payroll-policy.md §13).
 *
 * Some teachers owe the studio unpaid classes per month against a training
 * balance. This module decides, for every class a teacher taught since the
 * arrangement began, whether that class was free (credited against the
 * balance) or paid, by REPLAYING the whole history from effective_from.
 * Nothing is stored or decremented: a derived balance means a re-synced or
 * back-dated class changes nothing about what an already-approved invoice
 * meant, and re-running an old period reproduces exactly the numbers that
 * were approved at the time.
 *
 * The rules, each traceable to policy §13:
 * - Quota consumption is accounted per CALENDAR MONTH, never per pay
 *   period (periods straddle month boundaries).
 * - The free classes are the first N chronologically within the month, so
 *   a class's paid-or-free status never depends on when payroll ran.
 * - No rollover: unused free classes vanish with the month.
 * - Cancelled classes are invisible here (callers pass only taught,
 *   non-cancelled classes; they are unpaid anyway per policy §5).
 * - Dollar-denominated: each free class credits the amount it would
 *   otherwise have paid (the teacher's rate in effect for that class), so
 *   the class count moves with rate changes while the dollar balance
 *   stays the agreement actually struck.
 * - A class is free only while BOTH hold: fewer than N free classes taken
 *   that month AND remaining obligation > 0. The second condition keeps
 *   the tail correct (two credits left + quota of three = two free).
 * - Partial tail: if less than one class's rate remains, the class works
 *   off the remainder and the teacher is paid the difference.
 */

/** One taught, non-cancelled class entering the replay. */
export interface QuotaClass {
  /** Class date, YYYY-MM-DD (studio-local calendar date). */
  date: string;
  /** The teacher's per-class rate in cents in effect for this class. */
  rateCents: number;
}

/** The arrangement being replayed (a teacher_unpaid_quotas row). */
export interface QuotaArrangement {
  freeClassesPerMonth: number;
  obligationCents: number;
  /** YYYY-MM-DD. Classes before this date must not be passed in. */
  effectiveFrom: string;
  /** Optional agreed end date, inclusive. */
  effectiveTo?: string | null;
}

/** One class's replay outcome. */
export interface QuotaClassOutcome extends QuotaClass {
  /** Cents credited against the obligation (0 for a fully paid class). */
  creditedCents: number;
  /** Cents the teacher is paid for this class. */
  paidCents: number;
  /** Whether the class drew against the month's free-class quota. */
  free: boolean;
}

export interface QuotaReplayResult {
  classes: QuotaClassOutcome[];
  /** Obligation remaining after the replay. 0 = arrangement complete. */
  remainingCents: number;
  /** The date of the class that worked the balance off, once complete. */
  paidOffOn: string | null;
}

/**
 * Replay `classes` (every taught, non-cancelled class since
 * effectiveFrom, in any order; sorted internally) against the
 * arrangement. Chronological order within a date uses input order, which
 * callers should make deterministic (e.g. by class start time) so two
 * same-day classes replay identically on every run.
 */
export function replayQuota(
  arrangement: QuotaArrangement,
  classes: QuotaClass[],
): QuotaReplayResult {
  const { freeClassesPerMonth, obligationCents, effectiveFrom, effectiveTo } =
    arrangement;
  for (const cls of classes) {
    if (cls.date < effectiveFrom) {
      throw new Error(
        `quota replay: class on ${cls.date} predates effective_from ${effectiveFrom}; pre-arrangement classes must not enter the replay`,
      );
    }
  }
  // Stable sort by date preserves caller-provided intra-day order.
  const ordered = [...classes].sort((a, b) => a.date.localeCompare(b.date));

  let remaining = obligationCents;
  let paidOffOn: string | null = null;
  let month = "";
  let freeThisMonth = 0;
  const outcomes: QuotaClassOutcome[] = [];

  for (const cls of ordered) {
    const clsMonth = cls.date.slice(0, 7);
    if (clsMonth !== month) {
      month = clsMonth;
      freeThisMonth = 0; // no rollover: each month starts fresh
    }
    const inWindow = effectiveTo == null || cls.date <= effectiveTo;
    const eligible =
      inWindow && freeThisMonth < freeClassesPerMonth && remaining > 0;
    if (!eligible) {
      outcomes.push({
        ...cls,
        creditedCents: 0,
        paidCents: cls.rateCents,
        free: false,
      });
      continue;
    }
    const credited = Math.min(cls.rateCents, remaining);
    remaining -= credited;
    freeThisMonth += 1;
    if (remaining === 0 && paidOffOn === null) paidOffOn = cls.date;
    outcomes.push({
      ...cls,
      creditedCents: credited,
      // Partial tail (policy §13): the class works off what remains and
      // the teacher is paid the rest of their rate for it.
      paidCents: cls.rateCents - credited,
      free: true,
    });
  }

  return { classes: outcomes, remainingCents: remaining, paidOffOn };
}
