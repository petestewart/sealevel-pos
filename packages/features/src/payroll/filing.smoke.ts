/**
 * Smoke: SEA-110 — one invoice per person (grouping) and atomic filing
 * (card + ledger row as one transaction). The grouping tests are pure;
 * the filing tests need DATABASE_URL (a scratch Postgres with migrations
 * applied) and are skipped without it, mirroring the db smoke pattern.
 * Run: npm run smoke:payrollfiling (from packages/features).
 */
import assert from "node:assert/strict";

import {
  claimPayrollPush,
  filePayrollInvoice,
  getPool,
  closePool,
  markPayrollPushQueued,
  recordPayrollPushed,
  recordPayrollPushFailed,
  loadEnv,
} from "@ai-manager/core";
import { groupPeriodRows, type PeriodClassRow } from "./reads.js";

function row(
  staffId: number | null,
  name: string,
  date: string,
  time = "17:00",
): PeriodClassRow {
  return {
    mb_staff_id: staffId,
    name,
    role: "staff",
    date,
    time_norm: time,
    class_type: "Hot 26",
    attendees: 10,
  };
}

function testGroupingByStaffIdAlone(): void {
  // Two upstream teachers rows sharing one staff id (a rename): ONE
  // person, one invoice input covering all classes, newest name wins.
  const teachers = groupPeriodRows([
    row(100000106, "FRANKIE JAY", "2026-08-04"),
    row(100000106, "Frankie Grausam", "2026-08-11"),
    row(100000080, "Beth Gongaware", "2026-08-05"),
  ]);
  assert.equal(teachers.length, 2);
  const frankie = teachers.find((t) => t.mbStaffId === 100000106);
  assert.equal(frankie?.classes.length, 2);
  assert.equal(frankie?.name, "Frankie Grausam");
  console.log("[smoke] filing: one person, one group, newest name wins");
}

function testNullStaffIdsStaySplit(): void {
  // Unidentified teachers must NOT collapse into one blocker row.
  const teachers = groupPeriodRows([
    row(null, "Sharon", "2026-08-04"),
    row(null, "Tanja", "2026-08-05"),
  ]);
  assert.equal(teachers.length, 2);
  assert.ok(teachers.every((t) => t.mbStaffId === null));
  console.log("[smoke] filing: NULL staff ids stay split per name");
}

function testStringSerializedIdsStillGroup(): void {
  const teachers = groupPeriodRows([
    row(100000011, "Kate Jarvis", "2026-08-04"),
    { ...row(null, "Kate Jarvis", "2026-08-05"), mb_staff_id: "100000011" },
  ]);
  assert.equal(teachers.length, 1);
  assert.equal(teachers[0]?.classes.length, 2);
  console.log("[smoke] filing: string-serialized staff ids group correctly");
}

async function testAtomicFiling(): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    console.log("[smoke] filing: DATABASE_URL unset, db cases skipped");
    return;
  }
  const pool = getPool();
  const PERIOD = "2026-08-03..2026-08-16";
  const STAFF = 990001;
  await pool.query(`DELETE FROM payroll_invoices WHERE mb_staff_id = $1`, [STAFF]);
  await pool.query(
    `DELETE FROM items WHERE type = 'payroll_invoice' AND payload->>'dedupe_key' LIKE '%-' || $1`,
    [String(STAFF)],
  );
  const payload = { teacher_name: "Test Teacher", total_cents: 7500, period: PERIOD };

  // Fresh filing: card + ledger row, atomically.
  const first = await filePayrollInvoice({ period: PERIOD, mbStaffId: STAFF, payload });
  assert.equal(first.status, "filed");
  assert.ok(first.item);

  // Re-run: no new card, no new ledger row.
  const second = await filePayrollInvoice({ period: PERIOD, mbStaffId: STAFF, payload });
  assert.equal(second.status, "already_prepared");
  const { rows: cardCount } = await pool.query(
    `SELECT count(*)::int AS n FROM items
     WHERE type = 'payroll_invoice' AND payload->>'dedupe_key' = $1`,
    [`payroll-${PERIOD}-${STAFF}`],
  );
  assert.equal(cardCount[0]?.n, 1);
  console.log("[smoke] filing: re-run files nothing new");

  // Reject the card, re-run: ledger retargets to the fresh card; the old
  // card stays resolved; still exactly one ledger row.
  await pool.query(
    `UPDATE items SET status = 'resolved',
       payload = payload || '{"decision":{"action":"rejected"}}'::jsonb
     WHERE id = $1::bigint`,
    [String(first.item!.id)],
  );
  const third = await filePayrollInvoice({ period: PERIOD, mbStaffId: STAFF, payload });
  assert.equal(third.status, "retargeted");
  assert.notEqual(String(third.item!.id), String(first.item!.id));
  const { rows: ledger } = await pool.query(
    `SELECT item_id::text, status, count(*) OVER ()::int AS n
     FROM payroll_invoices WHERE period = $1 AND mb_staff_id = $2`,
    [PERIOD, STAFF],
  );
  assert.equal(ledger[0]?.n, 1);
  assert.equal(ledger[0]?.item_id, String(third.item!.id));
  assert.equal(ledger[0]?.status, "prepared");
  console.log("[smoke] filing: reject + re-run retargets the ledger row");

  // The orphan scenario is now impossible: push the ledger row on, mark
  // the surviving card resolved (freeing the dedupe key), re-run. The
  // fresh card must be ROLLED BACK, not left approvable.
  await pool.query(
    `UPDATE payroll_invoices SET status = 'pushed', qbo_ref = 'BILL-1'
     WHERE period = $1 AND mb_staff_id = $2`,
    [PERIOD, STAFF],
  );
  await pool.query(
    `UPDATE items SET status = 'resolved' WHERE id = $1::bigint`,
    [String(third.item!.id)],
  );
  const fourth = await filePayrollInvoice({ period: PERIOD, mbStaffId: STAFF, payload });
  assert.equal(fourth.status, "conflict");
  assert.equal(fourth.item, null);
  const { rows: orphans } = await pool.query(
    `SELECT count(*)::int AS n FROM items
     WHERE type = 'payroll_invoice' AND status = 'pending_approval'
       AND payload->>'dedupe_key' = $1`,
    [`payroll-${PERIOD}-${STAFF}`],
  );
  assert.equal(orphans[0]?.n, 0);
  console.log("[smoke] filing: pushed-elsewhere conflict rolls the card back");

  // And the console-side guard: a pending card with NO ledger row cannot
  // be stamped queued (markPayrollPushQueued matches nothing), which the
  // approve action now surfaces as an error instead of silent success.
  await pool.query(`DELETE FROM payroll_invoices WHERE mb_staff_id = $1`, [STAFF]);
  const stamp = await markPayrollPushQueued(String(third.item!.id));
  assert.equal(stamp, null);
  console.log("[smoke] filing: orphaned-card stamp refuses (console surfaces it)");
}

async function testLedgerWriteGuards(): Promise<void> {
  // SEA-111 fix 2c: the post-push ledger writes report whether the
  // guarded UPDATE matched, so a guard miss (a Bill in QuickBooks with
  // no qbo_ref recorded) can alert instead of vanishing into a log line.
  if (!process.env["DATABASE_URL"]) {
    console.log("[smoke] filing: DATABASE_URL unset, ledger-guard cases skipped");
    return;
  }
  const pool = getPool();
  const PERIOD = "2026-08-03..2026-08-16";
  const STAFF = 990002;
  await pool.query(`DELETE FROM payroll_invoices WHERE mb_staff_id = $1`, [STAFF]);
  await pool.query(
    `DELETE FROM items WHERE type = 'payroll_invoice' AND payload->>'dedupe_key' LIKE '%-' || $1`,
    [String(STAFF)],
  );
  const filed = await filePayrollInvoice({
    period: PERIOD,
    mbStaffId: STAFF,
    payload: { teacher_name: "Guard Teacher", total_cents: 7500, period: PERIOD },
  });
  assert.equal(filed.status, "filed");
  const itemId = String(filed.item!.id);

  // A record against a row that is not 'pushing' is a MISS, not a
  // silent no-op: 'prepared' rows refuse both writes.
  assert.equal(await recordPayrollPushed(itemId, "BILL-MISS"), false);
  assert.equal(await recordPayrollPushFailed(itemId), false);

  // The happy path: queued -> pushing -> pushed records and returns true,
  // and the qbo_ref actually lands.
  assert.ok(await markPayrollPushQueued(itemId));
  assert.ok(await claimPayrollPush(itemId));
  assert.equal(await recordPayrollPushed(itemId, "BILL-42"), true);
  const { rows } = await pool.query(
    `SELECT status, qbo_ref FROM payroll_invoices WHERE item_id = $1::bigint`,
    [itemId],
  );
  assert.equal(rows[0]?.status, "pushed");
  assert.equal(rows[0]?.qbo_ref, "BILL-42");

  // Once pushed, both writers refuse (a pushed row is terminal): a
  // double-record can never rewrite history quietly.
  assert.equal(await recordPayrollPushed(itemId, "BILL-43"), false);
  assert.equal(await recordPayrollPushFailed(itemId), false);
  const { rows: after } = await pool.query(
    `SELECT status, qbo_ref FROM payroll_invoices WHERE item_id = $1::bigint`,
    [itemId],
  );
  assert.equal(after[0]?.qbo_ref, "BILL-42");
  console.log("[smoke] filing: ledger writes report guard misses (SEA-111 2c)");
}

async function main(): Promise<void> {
  loadEnv();
  testGroupingByStaffIdAlone();
  testNullStaffIdsStaySplit();
  testStringSerializedIdsStillGroup();
  await testAtomicFiling();
  await testLedgerWriteGuards();
  await closePool().catch(() => undefined);
  console.log("[smoke] filing: all passed");
}

await main();
