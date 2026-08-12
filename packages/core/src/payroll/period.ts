/**
 * Pay-period math (docs/payroll-policy.md §6): fortnightly, Monday through
 * Sunday inclusive, by class date in studio time, anchored at 2026-08-03.
 * Every period is the 14 days beginning on the anchor plus a multiple of 14.
 *
 * Everything here works on plain YYYY-MM-DD date strings, deliberately:
 * class dates arrive from the analytics mirror as studio-local calendar
 * dates, and the period boundary is a calendar-date rule, so involving
 * timezones or Date-with-time here would only add ways to be wrong. Date
 * objects appear internally as UTC-midnight instants purely for day
 * arithmetic.
 */

/** The anchor Monday every period is a 14-day multiple from (policy §6). */
export const PAYROLL_ANCHOR = "2026-08-03";

/** Period length in days: fortnightly, Monday through Sunday inclusive. */
export const PERIOD_DAYS = 14;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toUtc(date: string): number {
  if (!DATE_RE.test(date)) {
    throw new Error(`payroll period: not a YYYY-MM-DD date: "${date}"`);
  }
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`payroll period: invalid date: "${date}"`);
  }
  return ms;
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One fortnightly pay period: inclusive start and end dates + label. */
export interface PayPeriod {
  /** First day, always a Monday (YYYY-MM-DD). */
  start: string;
  /** Last day, always a Sunday, inclusive (YYYY-MM-DD). */
  end: string;
  /** The payroll_invoices.period label form: "2026-08-03..2026-08-16". */
  label: string;
}

function periodStartingAt(startMs: number): PayPeriod {
  const start = fromUtc(startMs);
  const end = fromUtc(startMs + (PERIOD_DAYS - 1) * MS_PER_DAY);
  return { start, end, label: `${start}..${end}` };
}

/** The period containing `date`. Dates before the anchor are an error:
 * no period predates the first automated one. */
export function periodContaining(date: string): PayPeriod {
  const anchor = toUtc(PAYROLL_ANCHOR);
  const target = toUtc(date);
  if (target < anchor) {
    throw new Error(
      `payroll period: ${date} predates the anchor ${PAYROLL_ANCHOR}`,
    );
  }
  const days = Math.floor((target - anchor) / MS_PER_DAY);
  const index = Math.floor(days / PERIOD_DAYS);
  return periodStartingAt(anchor + index * PERIOD_DAYS * MS_PER_DAY);
}

/** Parse a "start..end" period label back into a PayPeriod, validating it
 * is a real anchor-aligned period (a malformed or misaligned label must
 * fail loudly, not silently define a new period). */
export function parsePeriodLabel(label: string): PayPeriod {
  const parts = label.split("..");
  if (parts.length !== 2 || parts[0] === undefined) {
    throw new Error(`payroll period: malformed label "${label}"`);
  }
  const period = periodContaining(parts[0]);
  if (period.label !== label) {
    throw new Error(
      `payroll period: "${label}" is not an anchor-aligned period (expected "${period.label}")`,
    );
  }
  return period;
}

/**
 * The start of the next period strictly after `date` (YYYY-MM-DD): the
 * default effective date for a rate change (policy §11), so an edit never
 * lands inside the period in progress. For a date before the anchor this
 * is the anchor itself.
 */
export function nextPeriodStart(date: string): string {
  if (toUtc(date) < toUtc(PAYROLL_ANCHOR)) return PAYROLL_ANCHOR;
  const current = periodContaining(date);
  return fromUtc(toUtc(current.start) + PERIOD_DAYS * MS_PER_DAY);
}

/**
 * Whether `date` falls inside the period that is still open (not yet
 * ended) as of `today`. The rates form refuses effective dates for which
 * this is true (policy §9 enforced structurally: a rate edited mid-period
 * must not retroactively alter the period in progress).
 */
export function isInOpenPeriod(date: string, today: string): boolean {
  if (toUtc(today) < toUtc(PAYROLL_ANCHOR)) return false;
  const open = periodContaining(today);
  return date >= open.start && date <= open.end;
}

/**
 * Whether a period has closed as of `today`: every day of it is in the
 * past. payroll.prepare refuses to run for a period that has not closed
 * (policy §5: future-dated class_instances rows exist, so a mid-flight
 * run would count bookings as attendance).
 */
export function isPeriodClosed(period: PayPeriod, today: string): boolean {
  return toUtc(today) > toUtc(period.end);
}

/**
 * Today's calendar date in studio time (America/Los_Angeles), YYYY-MM-DD.
 * Period boundaries are studio-local dates, so every "which period is
 * open" check must anchor on this, never on server-local or UTC "today"
 * (a 23:00 PT edit on Sunday is still inside the closing period even
 * though UTC has moved on).
 */
export function studioToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
