import { getPool } from "./client.js";
import type { Item } from "./items.js";

/**
 * The payroll_invoices ledger (SEA-103/SEA-104): one row per teacher per
 * period, the OUTERMOST of the four idempotency layers against
 * double-invoicing (automation plan §2.8). Status transitions:
 *
 *   prepared -> queued -> pushing -> pushed
 *                  \______________-> failed  (reopen + re-approve retries)
 *
 * Every transition is a guarded UPDATE, so a concurrent double (double
 * approve, racing workers, a BullMQ retry after a mid-push crash) loses
 * cleanly at exactly one layer instead of writing a second Bill.
 */

export interface PayrollInvoiceRow {
  id: string;
  period: string;
  mb_staff_id: number;
  item_id: string | null;
  status: "prepared" | "queued" | "pushing" | "pushed" | "failed";
  qbo_ref: string | null;
}

const COLUMNS = `id::text, period, mb_staff_id, item_id::text, status, qbo_ref`;

/** Outcome of one atomic invoice filing (SEA-110 fix 1b). */
export interface FilePayrollInvoiceResult {
  /**
   * filed: new card + new ledger row. repaired: an unresolved card
   * already existed and the missing ledger row was inserted under it.
   * retargeted: the ledger row's prior card was decided (rejected) and
   * not pushed, so the row now points at the fresh card (the legitimate
   * re-run-after-reject path). already_prepared: card and ledger row
   * both exist and agree. conflict: the ledger row is queued, pushing,
   * or pushed under another card, so the new card was ROLLED BACK; a
   * human decides, nothing is silently duplicated or orphaned.
   */
  status: "filed" | "repaired" | "retargeted" | "already_prepared" | "conflict";
  item: Item | null;
  detail?: string;
}

/**
 * File one invoice ATOMICALLY: the approval card and its ledger row are
 * one transaction, so no code path can leave a card without a ledger row
 * behind it (the orphaned-card MAJOR: such a card approves "successfully"
 * while enqueueing nothing). The item insert replicates createItem's
 * race-safe dedupe (the 0004 partial unique index guards unresolved
 * items); the ledger insert is guarded by UNIQUE (period, mb_staff_id);
 * every disagreement between the two resolves inside the transaction per
 * FilePayrollInvoiceResult, and the card insert rolls back whenever the
 * ledger cannot honestly stand behind it.
 */
export async function filePayrollInvoice(input: {
  period: string;
  mbStaffId: number;
  payload: Record<string, unknown>;
}): Promise<FilePayrollInvoiceResult> {
  const dedupeKey = `payroll-${input.period}-${input.mbStaffId}`;
  const payload = { ...input.payload, dedupe_key: dedupeKey };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // 1. The card: insert or adopt the unresolved survivor (createItem's
    // dedupe semantics, inlined so it can join this transaction).
    const { rows: inserted } = await client.query<Item>(
      `INSERT INTO items (type, domain, status, audience, assignee, payload)
       VALUES ('payroll_invoice', 'money', 'pending_approval', NULL, NULL, $1)
       ON CONFLICT (type, (payload->>'dedupe_key'))
         WHERE status <> 'resolved' AND payload->>'dedupe_key' IS NOT NULL
         DO NOTHING
       RETURNING *`,
      [JSON.stringify(payload)],
    );
    let item = inserted[0] ?? null;
    let createdItem = item !== null;
    if (!item) {
      const { rows: existing } = await client.query<Item>(
        `SELECT * FROM items
         WHERE type = 'payroll_invoice' AND status <> 'resolved'
           AND payload->>'dedupe_key' = $1
         LIMIT 1`,
        [dedupeKey],
      );
      item = existing[0] ?? null;
      if (!item) {
        throw new Error(
          `filePayrollInvoice: dedupe conflict for ${dedupeKey} but no surviving row`,
        );
      }
    }

    // 2. The ledger row.
    const { rows: ledgerInserted } = await client.query<PayrollInvoiceRow>(
      `INSERT INTO payroll_invoices (period, mb_staff_id, item_id)
       VALUES ($1, $2, $3::bigint)
       ON CONFLICT (period, mb_staff_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [input.period, input.mbStaffId, String(item.id)],
    );
    if (ledgerInserted[0]) {
      await client.query("COMMIT");
      return { status: createdItem ? "filed" : "repaired", item };
    }

    // 3. Ledger row already exists: reconcile inside the transaction.
    const { rows: ledgerRows } = await client.query<PayrollInvoiceRow>(
      `SELECT ${COLUMNS} FROM payroll_invoices
       WHERE period = $1 AND mb_staff_id = $2
       FOR UPDATE`,
      [input.period, input.mbStaffId],
    );
    const ledger = ledgerRows[0];
    if (!ledger) throw new Error("filePayrollInvoice: ledger row vanished");
    if (ledger.item_id === String(item.id)) {
      await client.query("COMMIT");
      return { status: "already_prepared", item };
    }
    // Points at another card. Retarget ONLY when that card was decided
    // and no push has been queued or made: the re-run-after-reject path.
    const { rows: priorRows } = await client.query<{ status: string }>(
      `SELECT status FROM items WHERE id = $1::bigint`,
      [ledger.item_id],
    );
    const priorResolved = priorRows[0]?.status === "resolved";
    if (priorResolved && (ledger.status === "prepared" || ledger.status === "failed")) {
      await client.query(
        `UPDATE payroll_invoices
         SET item_id = $2::bigint, status = 'prepared', updated_at = now()
         WHERE id = $1::bigint`,
        [ledger.id, String(item.id)],
      );
      await client.query("COMMIT");
      return { status: "retargeted", item };
    }
    // Queued, in flight, or already pushed under another card: the fresh
    // card must not exist. ROLLBACK undoes it (and is harmless when the
    // card pre-existed unresolved, which itself signals the same
    // conflict for a human).
    await client.query("ROLLBACK");
    return {
      status: "conflict",
      item: null,
      detail: `ledger for ${input.period} staff ${input.mbStaffId} is '${ledger.status}' under item ${ledger.item_id ?? "?"} (prior card ${priorResolved ? "resolved" : "still open"})`,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * How many ledger rows exist for one period label, any status. Cheap
 * count for the missed-run net: a recently ended period with ZERO rows
 * means payroll.prepare never ran for it (a normal blocked run also
 * files nothing, but it alerted at block time; this catches the tick
 * that never fired at all).
 */
export async function countPayrollInvoicesForPeriod(
  period: string,
): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM payroll_invoices WHERE period = $1`,
    [period],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The ledger row behind one approval item, or null. */
export async function payrollInvoiceForItem(
  itemId: string,
): Promise<PayrollInvoiceRow | null> {
  const { rows } = await getPool().query<PayrollInvoiceRow>(
    `SELECT ${COLUMNS} FROM payroll_invoices WHERE item_id = $1::bigint`,
    [itemId],
  );
  return rows[0] ?? null;
}

/**
 * Stamp the push as queued on approve (console side, before the enqueue).
 * Only a prepared or failed row qualifies, mirroring markDeliveryQueued:
 * an already queued/pushing/pushed invoice returns null and the caller
 * does not enqueue a redundant push.
 */
export async function markPayrollPushQueued(
  itemId: string,
): Promise<PayrollInvoiceRow | null> {
  const { rows } = await getPool().query<PayrollInvoiceRow>(
    `UPDATE payroll_invoices
     SET status = 'queued', updated_at = now()
     WHERE item_id = $1::bigint AND status IN ('prepared', 'failed')
     RETURNING ${COLUMNS}`,
    [itemId],
  );
  return rows[0] ?? null;
}

/** Revert a queued stamp whose enqueue failed (the honesty rollback the
 * email send path established): queued -> failed so the row never claims
 * a job that does not exist. */
export async function revertPayrollPushQueued(itemId: string): Promise<void> {
  await getPool().query(
    `UPDATE payroll_invoices
     SET status = 'failed', updated_at = now()
     WHERE item_id = $1::bigint AND status = 'queued'`,
    [itemId],
  );
}

/**
 * The atomic claim (idempotency layer 3): exactly one worker moves the
 * row queued -> pushing and gets it back; everyone else gets null and
 * skips. A crash mid-push leaves 'pushing', which is deliberately NOT
 * re-claimable by a blind retry: recordPayrollPushFailed (or a manual
 * reopen) must move it on, so a Bill can never be written twice on the
 * strength of a timeout.
 */
export async function claimPayrollPush(
  itemId: string,
): Promise<PayrollInvoiceRow | null> {
  const { rows } = await getPool().query<PayrollInvoiceRow>(
    `UPDATE payroll_invoices
     SET status = 'pushing', updated_at = now()
     WHERE item_id = $1::bigint AND status = 'queued'
     RETURNING ${COLUMNS}`,
    [itemId],
  );
  return rows[0] ?? null;
}

/**
 * Release a claim whose push failed RETRYABLY (network, 5xx): pushing ->
 * queued, so the BullMQ retry can re-claim. Terminal failures use
 * recordPayrollPushFailed instead; a crash that skips both leaves
 * 'pushing' parked for a human, never silently re-claimable.
 */
export async function revertPayrollPushClaim(itemId: string): Promise<void> {
  await getPool().query(
    `UPDATE payroll_invoices
     SET status = 'queued', updated_at = now()
     WHERE item_id = $1::bigint AND status = 'pushing'`,
    [itemId],
  );
}

/**
 * Record the Bill written: pushing -> pushed with the QBO reference.
 * Returns whether the guarded UPDATE matched a row (SEA-111 fix 2c). A
 * miss means a Bill exists in QuickBooks with no qbo_ref recorded here,
 * which the CALLER must alert on: this module stays notification-free
 * (core/db does not depend on notifications, matching every other db
 * module), so it reports the outcome and the worker fails loudly.
 */
export async function recordPayrollPushed(
  itemId: string,
  qboRef: string,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE payroll_invoices
     SET status = 'pushed', qbo_ref = $2, updated_at = now()
     WHERE item_id = $1::bigint AND status = 'pushing'`,
    [itemId, qboRef],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Record a failed push: pushing/queued -> failed (reopen + re-approve
 * is the retry path, exactly like a failed email send). Returns whether
 * the guarded UPDATE matched a row; a miss leaves the ledger claiming a
 * state the push outcome contradicts, and the caller must alert (same
 * layering as recordPayrollPushed).
 */
export async function recordPayrollPushFailed(itemId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE payroll_invoices
     SET status = 'failed', updated_at = now()
     WHERE item_id = $1::bigint AND status IN ('pushing', 'queued')`,
    [itemId],
  );
  return (rowCount ?? 0) > 0;
}
