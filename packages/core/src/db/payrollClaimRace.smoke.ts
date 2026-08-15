/**
 * Smoke: SEA-112 follow-up — the claim race (idempotency layer 3). Two
 * genuinely concurrent claimPayrollPush calls on the same queued row must
 * resolve to exactly ONE winner: the row moves to 'pushing' once, the
 * loser gets null and (per the worker) skips without touching QuickBooks.
 * The pool is pre-warmed to two physical connections so Promise.all races
 * two real Postgres sessions, not one serialized client. Also proves the
 * BullMQ-retry path: after revertPayrollPushClaim a fresh claim succeeds.
 * DB-backed: self-skips without DATABASE_URL, like filing.smoke.
 * Run: npm run smoke:payrollclaimrace (from packages/core).
 */
import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import { closePool, getPool } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  claimPayrollPush,
  filePayrollInvoice,
  markPayrollPushQueued,
  revertPayrollPushClaim,
} from "./payrollInvoices.js";

const PERIOD = "2026-08-03..2026-08-16";
const STAFF = 991002;
const ROUNDS = 5;

async function cleanup(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM payroll_invoices WHERE mb_staff_id = $1`, [STAFF]);
  await pool.query(
    `DELETE FROM items WHERE type = 'payroll_invoice' AND payload->>'dedupe_key' LIKE '%-' || $1`,
    [String(STAFF)],
  );
}

async function status(itemId: string): Promise<string> {
  const { rows } = await getPool().query<{ status: string }>(
    `SELECT status FROM payroll_invoices WHERE item_id = $1::bigint`,
    [itemId],
  );
  return rows[0]?.status ?? "(missing)";
}

/** Hold two pool clients at once so the pool owns >=2 physical
 * connections, then release them: the racing pool.query calls each get
 * their own connection instead of sharing one serialized session. */
async function warmTwoConnections(): Promise<void> {
  const pool = getPool();
  const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
  a.release();
  b.release();
  assert.ok(pool.totalCount >= 2, "pool must hold two physical connections");
}

async function main(): Promise<void> {
  loadEnv();
  if (!process.env["DATABASE_URL"]) {
    console.log("[smoke] claimrace: DATABASE_URL unset, all cases skipped");
    return;
  }
  await runMigrations();
  await cleanup();
  const filed = await filePayrollInvoice({
    period: PERIOD,
    mbStaffId: STAFF,
    payload: { teacher_name: "Race Teacher", total_cents: 7500, period: PERIOD },
  });
  assert.equal(filed.status, "filed");
  const itemId = String(filed.item!.id);
  assert.ok(await markPayrollPushQueued(itemId));
  await warmTwoConnections();

  try {
    for (let round = 1; round <= ROUNDS; round++) {
      // Two workers race the same queued row.
      const [a, b] = await Promise.all([
        claimPayrollPush(itemId),
        claimPayrollPush(itemId),
      ]);
      const winners = [a, b].filter(Boolean);
      assert.equal(
        winners.length,
        1,
        `round ${round}: exactly one claim must win (got ${winners.length})`,
      );
      const winner = winners[0]!;
      assert.equal(winner.period, PERIOD);
      assert.equal(winner.mb_staff_id, STAFF);
      assert.equal(await status(itemId), "pushing", `round ${round}: row is pushing`);

      // The loser holds null and must not proceed; a third latecomer is
      // also refused while the winner is in flight.
      assert.equal(await claimPayrollPush(itemId), null, `round ${round}: no re-claim in flight`);

      // Retryable-failure path: the winner releases the claim, and the
      // next attempt (the BullMQ retry) claims cleanly.
      await revertPayrollPushClaim(itemId);
      assert.equal(await status(itemId), "queued", `round ${round}: revert re-queues`);
    }
    const retry = await claimPayrollPush(itemId);
    assert.ok(retry, "post-revert claim must succeed");
    assert.equal(await status(itemId), "pushing");
    console.log(
      `[smoke] claimrace: ${ROUNDS} rounds, exactly one winner each; revert -> re-claim works`,
    );
  } finally {
    await cleanup();
  }
  console.log("[smoke] claimrace: all passed");
}

await main()
  .then(() => closePool().catch(() => undefined))
  .catch(async (err) => {
    console.error(err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
