import type { Queryable } from "../db/campaignContacts.js";
import { getPool } from "../db/client.js";
import {
  emitPayrollAlert,
  type PayrollAlertPayload,
  type EmitResult,
} from "../notifications/emit.js";
import {
  PAYROLL_ANCHOR,
  periodContaining,
  studioToday,
  type PayPeriod,
} from "./period.js";

/**
 * payroll.monitor (SEA-111 fix 2b): the stuck-row sweeper. Pure code, no
 * brain; runs as a named worker processor on a 30-minute cadence
 * (queue/schedules.ts payrollMonitorSchedule), mirroring the campaign
 * monitor's shape (campaigns/monitor.ts stuck_sending): boot-registered
 * schedule, threshold from env with a safe default, injectable store for
 * the offline smoke, alerts through the existing Novu path
 * (notifications/emit.ts, event type payroll_alert).
 *
 * What it catches: any payroll_invoices row sitting 'queued' or
 * 'pushing' past the threshold. This is the safety net that does not
 * depend on any handler firing:
 *
 * - 'queued' forever = the push job was lost, dead-lettered, or gave up
 *   after exhausting its BullMQ retries (the retryable path reverts the
 *   claim pushing -> queued before each rethrow, so the terminal state
 *   of an exhausted retry loop is 'queued').
 * - 'pushing' forever = a worker crashed mid-push. That parking is
 *   DELIBERATE (claimPayrollPush: a Bill must never be written twice on
 *   the strength of a timeout), which means the row's only way forward
 *   is a human. This sweeper is the summons.
 * - A recently ended period with ZERO ledger rows = the payday run never
 *   filed anything for it (missed_run). prepare.ts has a tick-based
 *   check, but that check depends on an overdue Sunday job actually
 *   executing within its grace window; a worker outage longer than the
 *   grace, or a Redis wipe that re-registers the scheduler onto the NEXT
 *   Sunday, escapes it entirely. This sweeper runs every 30 minutes on
 *   its own schedule, so it survives both. Only the MOST recently ended
 *   period is checked, so the page naturally ages out when the next
 *   period ends (~14 days); until then an unfiled payday re-pages every
 *   sweep, which is the summons working as designed. A deliberately
 *   slipped period keeps paging for that window: acceptable, because a
 *   payday that filed nothing should never be quiet by default.
 *
 * Deliberately NO dedupe state (unlike the campaign monitor's
 * campaign_alert_state): a stuck money row re-pages on every sweep until
 * a human resolves it. Money correctness outranks alert comfort, the
 * condition is rare, and adding a dedupe table would be a migration this
 * fix does not need; the 30-minute cadence bounds the noise.
 *
 * Failure posture: DATABASE_URL unset = logged skip (boot-time schedule
 * stays harmless, same as the campaign monitor). A mid-run Postgres
 * error throws so BullMQ retries; the sweep is read-only, so a retry is
 * trivially safe. Novu-side failures never throw (emitPayrollAlert
 * contains them) and are logged; the next sweep retries the page.
 */

export interface PayrollMonitorConfig {
  /** 'queued' or 'pushing' for this many minutes = stuck. Default 60:
   * a push normally completes in seconds, and the full BullMQ retry
   * span (3 attempts, exponential backoff from 1s) is under a minute,
   * so an hour of no progress is unambiguous. */
  stuckPushMinutes: number;
}

export const DEFAULT_PAYROLL_MONITOR_CONFIG: PayrollMonitorConfig = {
  stuckPushMinutes: 60,
};

/** Parse a positive number from env, falling back on absent/garbage
 * (the campaign monitor's numFromEnv, same semantics). */
function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[payroll.monitor] ignoring ${name}="${raw}" (not a positive number); using ${fallback}`,
    );
    return fallback;
  }
  return value;
}

/** Threshold from the environment, mirroring monitorConfigFromEnv. */
export function payrollMonitorConfigFromEnv(): PayrollMonitorConfig {
  return {
    stuckPushMinutes: numFromEnv(
      "PAYROLL_ALERT_STUCK_PUSH_MINUTES",
      DEFAULT_PAYROLL_MONITOR_CONFIG.stuckPushMinutes,
    ),
  };
}

/** One stuck ledger row, as the sweep query returns it. */
export interface StuckPayrollRow {
  period: string;
  mbStaffId: number;
  itemId: string | null;
  status: "queued" | "pushing";
  minutesStuck: number;
}

/** The store seam, so the offline smoke runs every branch against an
 * in-memory fake (the MonitorStore injection pattern). */
export interface PayrollMonitorStore {
  /** Every payroll_invoices row in 'queued' or 'pushing' whose last
   * transition (updated_at) is older than thresholdMinutes. */
  stuckPayrollRows(thresholdMinutes: number): Promise<StuckPayrollRow[]>;
  /** Ledger rows for one period label, any status (the missed-run net:
   * zero for a period that has ended means the run never filed). */
  invoiceCountForPeriod(period: string): Promise<number>;
}

/**
 * The most recently ENDED period as of `today`, or null while the first
 * automated period is still open (nothing has ever been due) or before
 * the anchor entirely. Pure date math, exported for the smoke.
 */
export function lastEndedPeriod(today: string): PayPeriod | null {
  if (today < PAYROLL_ANCHOR) return null;
  const current = periodContaining(today);
  if (current.start === PAYROLL_ANCHOR) return null;
  const dayBefore = new Date(
    Date.parse(`${current.start}T00:00:00Z`) - 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  return periodContaining(dayBefore);
}

/** Production store over the shared pool (or any Queryable, so a db
 * smoke can run it inside a rolled-back transaction). */
export function pgPayrollMonitorStore(db?: Queryable): PayrollMonitorStore {
  const q = (): Queryable => db ?? getPool();
  return {
    async stuckPayrollRows(
      thresholdMinutes: number,
    ): Promise<StuckPayrollRow[]> {
      // updated_at is stamped on every status transition, so "no
      // transition for the threshold" is exactly "no progress".
      const { rows } = await q().query(
        `SELECT period,
                mb_staff_id,
                item_id::text AS item_id,
                status,
                floor(extract(epoch FROM now() - updated_at) / 60)::int
                  AS minutes_stuck
         FROM payroll_invoices
         WHERE status IN ('queued', 'pushing')
           AND updated_at < now() - make_interval(mins => $1)
         ORDER BY period, mb_staff_id`,
        [thresholdMinutes],
      );
      return (rows as Array<Record<string, unknown>>).map((r) => ({
        period: String(r.period),
        mbStaffId: Number(r.mb_staff_id),
        itemId: r.item_id === null ? null : String(r.item_id),
        status: r.status === "pushing" ? "pushing" : "queued",
        minutesStuck: Number(r.minutes_stuck),
      }));
    },
    async invoiceCountForPeriod(period: string): Promise<number> {
      const { rows } = await q().query(
        `SELECT COUNT(*) AS n FROM payroll_invoices WHERE period = $1`,
        [period],
      );
      return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
    },
  };
}

export interface PayrollMonitorResult {
  status: "checked" | "skipped";
  reason?: string;
  /** Stuck rows found this sweep (each one alerts). */
  stuck: number;
  /** Period label paged as a missed run this sweep, or null. */
  missedRun: string | null;
  /** Novu triggers actually sent. */
  notified: number;
  /** The payload of every alert (sent or degraded to a log line). */
  alerts: PayrollAlertPayload[];
  /** The done-when line, verbatim. */
  summary: string;
}

/** Injectable dependencies so the offline smoke runs without Postgres
 * or Novu. Production callers pass nothing. */
export interface PayrollMonitorDeps {
  store: PayrollMonitorStore;
  emit: (payload: PayrollAlertPayload) => Promise<EmitResult>;
  now: () => Date;
  log: (line: string) => void;
}

function defaultDeps(): PayrollMonitorDeps {
  return {
    store: pgPayrollMonitorStore(),
    emit: (payload) => emitPayrollAlert(payload),
    now: () => new Date(),
    log: (line) => console.log(line),
  };
}

/**
 * Run the stuck-row sweep once: query, alert per stuck row, report. No
 * writes, no dedupe (see module doc: a stuck money row pages every
 * sweep by design).
 */
export async function runPayrollMonitor(
  deps?: Partial<PayrollMonitorDeps>,
  config?: PayrollMonitorConfig,
): Promise<PayrollMonitorResult> {
  const cfg = config ?? payrollMonitorConfigFromEnv();
  if (!deps?.store && !process.env.DATABASE_URL) {
    console.log("[payroll.monitor] DATABASE_URL unset; skipping");
    return {
      status: "skipped",
      reason: "DATABASE_URL unset",
      stuck: 0,
      missedRun: null,
      notified: 0,
      alerts: [],
      summary: "payroll monitor skipped (DATABASE_URL unset)",
    };
  }
  const d: PayrollMonitorDeps = { ...defaultDeps(), ...deps };
  const at = d.now().toISOString();

  const stuckRows = await d.store.stuckPayrollRows(cfg.stuckPushMinutes);
  let notified = 0;
  const alerts: PayrollAlertPayload[] = [];
  for (const row of stuckRows) {
    const action =
      row.status === "pushing"
        ? "A worker likely crashed mid-push; verify in QuickBooks whether the Bill exists before moving the row on."
        : "No push is progressing; check the money queue's failed set, then reopen and re-approve.";
    const payload: PayrollAlertPayload = {
      alertType: "stuck_push",
      period: row.period,
      detail: `Payroll invoice for staff ${row.mbStaffId}, period ${row.period}${
        row.itemId ? `, item ${row.itemId}` : ""
      }, has been '${row.status}' for ${row.minutesStuck} minutes (threshold ${cfg.stuckPushMinutes} min). ${action}`,
      teachers: [],
      at,
    };
    alerts.push(payload);
    const result = await d.emit(payload);
    if (result.sent) {
      notified += 1;
    } else {
      // The next sweep re-pages regardless; log why this one degraded.
      d.log(
        `[payroll.monitor] stuck_push alert for ${row.period} staff ${row.mbStaffId} not delivered (${result.reason ?? "unknown"}); next sweep retries`,
      );
    }
  }

  // Missed-run net: the most recently ended period must have filed
  // SOMETHING (a blocked run alerted at block time but still counts as
  // missed here until a human files or the period ages out; an unfiled
  // payday is never quiet).
  let missedRun: string | null = null;
  const ended = lastEndedPeriod(studioToday(d.now()));
  if (ended) {
    const count = await d.store.invoiceCountForPeriod(ended.label);
    if (count === 0) {
      missedRun = ended.label;
      const payload: PayrollAlertPayload = {
        alertType: "missed_run",
        period: ended.label,
        detail: `Period ${ended.label} has ended but the payroll ledger has zero invoices for it. The payday run never filed anything (worker outage, lost schedule, or a blocked run left unresolved). Fire payroll.prepare manually for ${ended.label}; filing is idempotent per invoice. This page repeats every sweep until the period has ledger rows.`,
        teachers: [],
        at,
      };
      alerts.push(payload);
      const result = await d.emit(payload);
      if (result.sent) {
        notified += 1;
      } else {
        d.log(
          `[payroll.monitor] missed_run alert for ${ended.label} not delivered (${result.reason ?? "unknown"}); next sweep retries`,
        );
      }
    }
  }

  const summary = `${stuckRows.length} stuck payroll row(s), ${
    missedRun ? `missed run ${missedRun}` : "no missed run"
  }, ${notified} notified`;
  d.log(`[payroll.monitor] ${summary}`);
  return {
    status: "checked",
    stuck: stuckRows.length,
    missedRun,
    notified,
    alerts,
    summary,
  };
}
