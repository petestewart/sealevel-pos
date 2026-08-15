/**
 * Smoke: SEA-112 follow-up — the payroll_invoices ledger state machine,
 * every guarded transition (automation plan §2.8, SEA-111 2c). The ledger
 * is the outermost idempotency layer against double-paying a teacher, so
 * each guard is exercised from EVERY state: the legal transition moves
 * the row, every illegal one changes nothing and (where the API reports)
 * returns null/false. DB-backed: needs DATABASE_URL (scratch Postgres
 * with migrations applied); self-skips without it, like filing.smoke.
 * Run: npm run smoke:payrollledger (from packages/core).
 */
import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import { closePool, getPool } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  claimPayrollPush,
  filePayrollInvoice,
  markPayrollPushQueued,
  recordPayrollPushed,
  recordPayrollPushFailed,
  revertPayrollPushClaim,
  revertPayrollPushQueued,
} from "./payrollInvoices.js";

const PERIOD = "2026-08-03..2026-08-16";
const STAFF = 991001;

type Status = "prepared" | "queued" | "pushing" | "pushed" | "failed";

async function cleanup(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM payroll_invoices WHERE mb_staff_id = $1`, [STAFF]);
  await pool.query(
    `DELETE FROM items WHERE type = 'payroll_invoice' AND payload->>'dedupe_key' LIKE '%-' || $1`,
    [String(STAFF)],
  );
}

/** Force the ledger row into a state (test scaffolding only; production
 * code never writes status unguarded). */
async function forceStatus(
  itemId: string,
  status: Status,
  qboRef: string | null = null,
): Promise<void> {
  await getPool().query(
    `UPDATE payroll_invoices SET status = $2, qbo_ref = $3 WHERE item_id = $1::bigint`,
    [itemId, status, qboRef],
  );
}

async function readRow(
  itemId: string,
): Promise<{ status: Status; qbo_ref: string | null }> {
  const { rows } = await getPool().query<{ status: Status; qbo_ref: string | null }>(
    `SELECT status, qbo_ref FROM payroll_invoices WHERE item_id = $1::bigint`,
    [itemId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no ledger row for item ${itemId}`);
  return row;
}

async function testQueuedGuard(itemId: string): Promise<void> {
  // queued is reachable ONLY from prepared or failed (the approve stamp).
  await forceStatus(itemId, "prepared");
  assert.ok(await markPayrollPushQueued(itemId), "prepared -> queued must stamp");
  assert.equal((await readRow(itemId)).status, "queued");

  await forceStatus(itemId, "failed");
  assert.ok(await markPayrollPushQueued(itemId), "failed -> queued must stamp (re-approve)");
  assert.equal((await readRow(itemId)).status, "queued");

  for (const from of ["queued", "pushing", "pushed"] as const) {
    await forceStatus(itemId, from, from === "pushed" ? "BILL-X" : null);
    assert.equal(
      await markPayrollPushQueued(itemId),
      null,
      `${from} -> queued must refuse (no double-queue)`,
    );
    assert.equal((await readRow(itemId)).status, from, `${from} unchanged after refused stamp`);
  }
  console.log("[smoke] ledger: queued only from prepared|failed");
}

async function testClaimGuard(itemId: string): Promise<void> {
  // pushing is reachable ONLY from queued (the worker's atomic claim).
  await forceStatus(itemId, "queued");
  const claim = await claimPayrollPush(itemId);
  assert.ok(claim, "queued -> pushing must claim");
  assert.equal(claim.period, PERIOD);
  assert.equal(claim.mb_staff_id, STAFF);
  assert.equal((await readRow(itemId)).status, "pushing");

  // A parked 'pushing' row (mid-push crash) is deliberately NOT
  // re-claimable: a blind retry can never write a second Bill.
  for (const from of ["prepared", "failed", "pushing", "pushed"] as const) {
    await forceStatus(itemId, from, from === "pushed" ? "BILL-X" : null);
    assert.equal(await claimPayrollPush(itemId), null, `${from} must refuse a claim`);
    assert.equal((await readRow(itemId)).status, from, `${from} unchanged after refused claim`);
  }
  console.log("[smoke] ledger: claim only from queued; parked pushing stays parked");
}

async function testRevertClaimGuard(itemId: string): Promise<void> {
  // pushing -> queued (retryable release) ONLY from pushing.
  await forceStatus(itemId, "pushing");
  await revertPayrollPushClaim(itemId);
  assert.equal((await readRow(itemId)).status, "queued");

  for (const from of ["prepared", "queued", "pushed", "failed"] as const) {
    await forceStatus(itemId, from, from === "pushed" ? "BILL-X" : null);
    await revertPayrollPushClaim(itemId);
    assert.equal((await readRow(itemId)).status, from, `${from} unchanged by revert-claim`);
  }
  console.log("[smoke] ledger: revert claim only from pushing");
}

async function testRevertQueuedGuard(itemId: string): Promise<void> {
  // queued -> failed (enqueue-failed honesty rollback) ONLY from queued.
  await forceStatus(itemId, "queued");
  await revertPayrollPushQueued(itemId);
  assert.equal((await readRow(itemId)).status, "failed");

  for (const from of ["prepared", "pushing", "pushed", "failed"] as const) {
    await forceStatus(itemId, from, from === "pushed" ? "BILL-X" : null);
    await revertPayrollPushQueued(itemId);
    assert.equal((await readRow(itemId)).status, from, `${from} unchanged by revert-queued`);
  }
  console.log("[smoke] ledger: revert queued-stamp only from queued");
}

async function testRecordPushedGuard(itemId: string): Promise<void> {
  // pushed (+ qbo_ref) ONLY from pushing; the boolean reports the miss.
  await forceStatus(itemId, "pushing");
  assert.equal(await recordPayrollPushed(itemId, "BILL-77"), true);
  const pushed = await readRow(itemId);
  assert.equal(pushed.status, "pushed");
  assert.equal(pushed.qbo_ref, "BILL-77");

  for (const from of ["prepared", "queued", "failed"] as const) {
    await forceStatus(itemId, from, null);
    assert.equal(
      await recordPayrollPushed(itemId, "BILL-MISS"),
      false,
      `${from} must miss recordPushed`,
    );
    const after = await readRow(itemId);
    assert.equal(after.status, from, `${from} unchanged after missed recordPushed`);
    assert.equal(after.qbo_ref, null, `${from} qbo_ref untouched after miss`);
  }
  // pushed is terminal: a double record can never rewrite the reference.
  await forceStatus(itemId, "pushed", "BILL-77");
  assert.equal(await recordPayrollPushed(itemId, "BILL-78"), false);
  const still = await readRow(itemId);
  assert.equal(still.status, "pushed");
  assert.equal(still.qbo_ref, "BILL-77");
  console.log("[smoke] ledger: recordPushed only from pushing, misses return false");
}

async function testRecordFailedGuard(itemId: string): Promise<void> {
  // failed from pushing (terminal push failure) or queued (skipped push);
  // never from prepared or pushed.
  for (const from of ["pushing", "queued"] as const) {
    await forceStatus(itemId, from);
    assert.equal(await recordPayrollPushFailed(itemId), true, `${from} -> failed must record`);
    assert.equal((await readRow(itemId)).status, "failed");
  }
  for (const from of ["prepared", "pushed", "failed"] as const) {
    // 'failed' itself misses too: the guard is IN ('pushing','queued').
    await forceStatus(itemId, from, from === "pushed" ? "BILL-X" : null);
    assert.equal(
      await recordPayrollPushFailed(itemId),
      false,
      `${from} must miss recordPushFailed`,
    );
    const after = await readRow(itemId);
    assert.equal(after.status, from, `${from} unchanged after missed recordPushFailed`);
    assert.equal(after.qbo_ref, from === "pushed" ? "BILL-X" : null);
  }
  console.log("[smoke] ledger: recordPushFailed only from pushing|queued");
}

async function main(): Promise<void> {
  loadEnv();
  if (!process.env["DATABASE_URL"]) {
    console.log("[smoke] ledger: DATABASE_URL unset, all cases skipped");
    return;
  }
  await runMigrations();
  await cleanup();
  const filed = await filePayrollInvoice({
    period: PERIOD,
    mbStaffId: STAFF,
    payload: { teacher_name: "Ledger Teacher", total_cents: 7500, period: PERIOD },
  });
  assert.equal(filed.status, "filed");
  const itemId = String(filed.item!.id);
  assert.equal((await readRow(itemId)).status, "prepared");

  try {
    await testQueuedGuard(itemId);
    await testClaimGuard(itemId);
    await testRevertClaimGuard(itemId);
    await testRevertQueuedGuard(itemId);
    await testRecordPushedGuard(itemId);
    await testRecordFailedGuard(itemId);
  } finally {
    await cleanup();
  }
  console.log("[smoke] ledger: all passed");
}

await main()
  .then(() => closePool().catch(() => undefined))
  .catch(async (err) => {
    console.error(err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
