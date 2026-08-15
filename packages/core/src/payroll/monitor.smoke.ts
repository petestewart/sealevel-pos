import assert from "node:assert/strict";

import { closePool, getPool } from "../db/client.js";
import { loadEnv } from "../env.js";
import type { PayrollAlertPayload } from "../notifications/emit.js";
import {
  DEFAULT_PAYROLL_MONITOR_CONFIG,
  lastEndedPeriod,
  payrollMonitorConfigFromEnv,
  pgPayrollMonitorStore,
  runPayrollMonitor,
  type PayrollMonitorStore,
  type StuckPayrollRow,
} from "./monitor.js";

/**
 * Payroll stuck-row sweeper smoke (SEA-111 fix 2b), following the
 * campaign monitor smoke's shape: the offline cases run every branch
 * against an in-memory store and a captured emitter; the SQL case runs
 * only with DATABASE_URL (a scratch Postgres with migrations applied)
 * inside a rolled-back transaction, and self-skips without it.
 *
 *  1. A row stuck past the threshold alerts (alertType stuck_push, the
 *     row's period, a detail naming status and minutes); a fresh row
 *     does not (threshold filter, mirrored from the SQL).
 *  2. 'pushing' and 'queued' both page, with state-specific guidance.
 *  3. NO dedupe by design: the same stuck row pages again on the next
 *     sweep (a stuck money row keeps summoning until resolved).
 *  4. A failed emit degrades to a log line, never a throw.
 *  5. payrollMonitorConfigFromEnv: override parses, garbage falls back.
 *  6. Without DATABASE_URL and without injected deps, the run is a
 *     logged skip.
 *  7. (DB only) the real query: queued/pushing rows past the threshold
 *     are returned with minutes; fresh, prepared, pushed, and failed
 *     rows are not.
 *
 * Run: npm run smoke:payrollmonitor --workspace @ai-manager/core
 */

/** In-memory store mirroring the SQL's threshold filter. */
class FakeStore implements PayrollMonitorStore {
  rows: StuckPayrollRow[] = [];
  /** Ledger row count per period label for the missed-run net; a label
   * absent from the map counts as filed (1) so the stuck-row cases stay
   * quiet on that axis. */
  periodCounts = new Map<string, number>();
  async stuckPayrollRows(thresholdMinutes: number): Promise<StuckPayrollRow[]> {
    return this.rows.filter((r) => r.minutesStuck >= thresholdMinutes);
  }
  async invoiceCountForPeriod(period: string): Promise<number> {
    return this.periodCounts.get(period) ?? 1;
  }
}

interface Captured {
  alerts: PayrollAlertPayload[];
  logs: string[];
}

async function runWith(
  store: FakeStore,
  opts?: { emitFails?: boolean; nowIso?: string },
): Promise<Captured & { notified: number; stuck: number; missedRun: string | null }> {
  const captured: Captured = { alerts: [], logs: [] };
  const result = await runPayrollMonitor(
    {
      store,
      emit: async (payload) => {
        captured.alerts.push(payload);
        return opts?.emitFails
          ? { sent: false, reason: "novu down" }
          : { sent: true };
      },
      now: () => new Date(opts?.nowIso ?? "2026-08-13T12:00:00Z"),
      log: (line) => captured.logs.push(line),
    },
    DEFAULT_PAYROLL_MONITOR_CONFIG,
  );
  assert.equal(result.status, "checked");
  return {
    ...captured,
    notified: result.notified,
    stuck: result.stuck,
    missedRun: result.missedRun,
  };
}

function stuckRow(overrides: Partial<StuckPayrollRow>): StuckPayrollRow {
  return {
    period: "2026-08-03..2026-08-16",
    mbStaffId: 100000011,
    itemId: "41",
    status: "queued",
    minutesStuck: 90,
    ...overrides,
  };
}

async function testThresholdAndPayload(): Promise<void> {
  const store = new FakeStore();
  store.rows = [
    stuckRow({ minutesStuck: 90 }),
    stuckRow({ mbStaffId: 100000080, minutesStuck: 5 }), // fresh: no page
  ];
  const run = await runWith(store);
  assert.equal(run.stuck, 1);
  assert.equal(run.notified, 1);
  const alert = run.alerts[0];
  assert.equal(alert?.alertType, "stuck_push");
  assert.equal(alert?.period, "2026-08-03..2026-08-16");
  assert.match(alert?.detail ?? "", /staff 100000011/);
  assert.match(alert?.detail ?? "", /'queued' for 90 minutes/);
  assert.match(alert?.detail ?? "", /item 41/);
  console.log("[smoke] payroll.monitor: stuck row past threshold pages, fresh row does not");
}

async function testPushingRowGuidance(): Promise<void> {
  const store = new FakeStore();
  store.rows = [stuckRow({ status: "pushing", itemId: null, minutesStuck: 61 })];
  const run = await runWith(store);
  assert.equal(run.notified, 1);
  // A crashed-mid-push row is deliberately parked; the alert must send
  // the human to QuickBooks before anything moves.
  assert.match(run.alerts[0]?.detail ?? "", /crashed mid-push/);
  assert.match(run.alerts[0]?.detail ?? "", /QuickBooks/);
  assert.doesNotMatch(run.alerts[0]?.detail ?? "", /item /);
  console.log("[smoke] payroll.monitor: parked 'pushing' row summons a human");
}

async function testNoDedupeByDesign(): Promise<void> {
  const store = new FakeStore();
  store.rows = [stuckRow({})];
  const first = await runWith(store);
  const second = await runWith(store);
  assert.equal(first.notified, 1);
  assert.equal(second.notified, 1);
  console.log("[smoke] payroll.monitor: a still-stuck row re-pages every sweep (no dedupe)");
}

async function testFailedEmitLogsAndContinues(): Promise<void> {
  const store = new FakeStore();
  store.rows = [stuckRow({})];
  const run = await runWith(store, { emitFails: true });
  assert.equal(run.notified, 0);
  assert.equal(run.stuck, 1);
  assert.ok(
    run.logs.some((l) => l.includes("not delivered") && l.includes("novu down")),
  );
  console.log("[smoke] payroll.monitor: failed emit degrades to a log, next sweep retries");
}

function testConfigFromEnv(): void {
  const prev = process.env["PAYROLL_ALERT_STUCK_PUSH_MINUTES"];
  process.env["PAYROLL_ALERT_STUCK_PUSH_MINUTES"] = "15";
  assert.equal(payrollMonitorConfigFromEnv().stuckPushMinutes, 15);
  process.env["PAYROLL_ALERT_STUCK_PUSH_MINUTES"] = "garbage";
  assert.equal(
    payrollMonitorConfigFromEnv().stuckPushMinutes,
    DEFAULT_PAYROLL_MONITOR_CONFIG.stuckPushMinutes,
  );
  if (prev === undefined) delete process.env["PAYROLL_ALERT_STUCK_PUSH_MINUTES"];
  else process.env["PAYROLL_ALERT_STUCK_PUSH_MINUTES"] = prev;
  console.log("[smoke] payroll.monitor: env override parses, garbage falls back");
}

function testLastEndedPeriod(): void {
  // First automated period still open (or pre-anchor): nothing due yet.
  assert.equal(lastEndedPeriod("2026-07-30"), null);
  assert.equal(lastEndedPeriod("2026-08-03"), null);
  assert.equal(lastEndedPeriod("2026-08-16"), null);
  // Any day of the SECOND period sees the first as most recently ended,
  // whether the outage lasted one day or twelve.
  assert.equal(lastEndedPeriod("2026-08-17")?.label, "2026-08-03..2026-08-16");
  assert.equal(lastEndedPeriod("2026-08-29")?.label, "2026-08-03..2026-08-16");
  // The next period end rolls the check forward (the old page ages out).
  assert.equal(lastEndedPeriod("2026-08-31")?.label, "2026-08-17..2026-08-30");
  console.log("[smoke] payroll.monitor: lastEndedPeriod date math holds");
}

async function testMissedRunPages(): Promise<void> {
  const store = new FakeStore();
  // Monday 2026-08-17 08:00 PT: first period ended yesterday, zero rows.
  store.periodCounts.set("2026-08-03..2026-08-16", 0);
  const run = await runWith(store, { nowIso: "2026-08-17T15:00:00Z" });
  assert.equal(run.missedRun, "2026-08-03..2026-08-16");
  assert.equal(run.notified, 1);
  const alert = run.alerts[0];
  assert.equal(alert?.alertType, "missed_run");
  assert.equal(alert?.period, "2026-08-03..2026-08-16");
  assert.match(alert?.detail ?? "", /zero invoices/);
  assert.match(alert?.detail ?? "", /payroll\.prepare/);
  // Twelve days into the outage the same sweep still pages (the gap the
  // tick-based grace window left open).
  const late = await runWith(store, { nowIso: "2026-08-28T15:00:00Z" });
  assert.equal(late.missedRun, "2026-08-03..2026-08-16");
  console.log("[smoke] payroll.monitor: an unfiled ended period pages, even days later");
}

async function testFiledPeriodStaysQuiet(): Promise<void> {
  const store = new FakeStore();
  store.periodCounts.set("2026-08-03..2026-08-16", 17);
  const run = await runWith(store, { nowIso: "2026-08-17T15:00:00Z" });
  assert.equal(run.missedRun, null);
  assert.equal(run.notified, 0);
  // Mid-first-period: nothing has ever been due, count never queried.
  const early = await runWith(store, { nowIso: "2026-08-13T12:00:00Z" });
  assert.equal(early.missedRun, null);
  console.log("[smoke] payroll.monitor: filed and not-yet-due periods stay quiet");
}

async function testSkipsWithoutDatabase(): Promise<void> {
  const prev = process.env["DATABASE_URL"];
  delete process.env["DATABASE_URL"];
  const result = await runPayrollMonitor();
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "DATABASE_URL unset");
  if (prev !== undefined) process.env["DATABASE_URL"] = prev;
  console.log("[smoke] payroll.monitor: no DATABASE_URL is a logged skip");
}

async function testRealQuery(): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    console.log("[smoke] payroll.monitor: DATABASE_URL unset, SQL case skipped");
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // One row per status; the stuck ones aged past the threshold via
    // updated_at, the fresh 'queued' one left at now().
    const seed = async (
      staff: number,
      status: string,
      minutesAgo: number,
    ): Promise<void> => {
      await client.query(
        `INSERT INTO payroll_invoices (period, mb_staff_id, status, updated_at)
         VALUES ('2026-08-03..2026-08-16', $1, $2, now() - make_interval(mins => $3))`,
        [staff, status, minutesAgo],
      );
    };
    await seed(980001, "queued", 90);
    await seed(980002, "pushing", 120);
    await seed(980003, "queued", 5);
    await seed(980004, "prepared", 500);
    await seed(980005, "pushed", 500);
    await seed(980006, "failed", 500);
    const rows = await pgPayrollMonitorStore(client).stuckPayrollRows(60);
    const mine = rows.filter((r) => r.mbStaffId >= 980001 && r.mbStaffId <= 980006);
    assert.deepEqual(
      mine.map((r) => [r.mbStaffId, r.status]),
      [
        [980001, "queued"],
        [980002, "pushing"],
      ],
    );
    assert.ok(mine[0] && mine[0].minutesStuck >= 90);
    assert.ok(mine[1] && mine[1].minutesStuck >= 120);
    assert.equal(mine[0]?.itemId, null);
    console.log("[smoke] payroll.monitor: SQL returns exactly the stuck queued/pushing rows");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  loadEnv();
  await testThresholdAndPayload();
  await testPushingRowGuidance();
  await testNoDedupeByDesign();
  await testFailedEmitLogsAndContinues();
  testConfigFromEnv();
  testLastEndedPeriod();
  await testMissedRunPages();
  await testFiledPeriodStaysQuiet();
  await testSkipsWithoutDatabase();
  await testRealQuery();
  await closePool().catch(() => undefined);
  console.log("[smoke] payroll.monitor: all passed");
}

await main();
