"use server";

import { revalidatePath } from "next/cache";
import {
  enqueuePayrollPush,
  getPool,
  markPayrollPushQueued,
  payrollInvoiceForItem,
  revertPayrollPushQueued,
} from "@ai-manager/core";
import { decideItem } from "../../lib/approvals";
import { requireDecider } from "../../lib/requireDecider";

/**
 * Server actions for payroll_invoice approvals (SEA-104). The shipped
 * state machine, extended not forked (plan §2.6): decideItem records the
 * decision and flips status; approval then stamps the ledger queued and
 * enqueues payroll.push through the outbound-action map (money queue).
 * The worker re-checks its own QBO gate before writing anything.
 */

export interface PayrollActionState {
  error: string | null;
  stale?: boolean;
}

function fieldString(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

function isAlreadyDecided(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("no pending_approval item")
  );
}

const STALE: PayrollActionState = {
  error:
    "This invoice was already decided by another operator. Refresh to see the latest.",
  stale: true,
};

async function requirePayrollInvoice(id: string): Promise<string | null> {
  const { rows } = await getPool().query<{ type: string }>(
    `SELECT type FROM items WHERE id = $1`,
    [id],
  );
  return rows[0]?.type ?? null;
}

export async function approvePayrollInvoiceAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  const decider = await requireDecider();
  const id = fieldString(formData, "id").trim();
  if (id.length === 0) return { error: "Missing item id." };
  if ((await requirePayrollInvoice(id)) !== "payroll_invoice") {
    return { error: "This item is not a payroll invoice." };
  }
  try {
    await decideItem(id, "approved", decider);
  } catch (err) {
    if (isAlreadyDecided(err)) return STALE;
    throw err;
  }
  // Queue the QBO push, with the queued-stamp honesty pattern the email
  // send path established: stamp first (guarded, no double-queue), and
  // revert to failed when the enqueue itself fails so the ledger never
  // claims a job that does not exist. The decision above stands either
  // way; reopen + re-approve is the retry path.
  //
  // A null stamp is NOT automatically fine (SEA-110): it means the
  // guarded UPDATE matched nothing, which is benign only when a ledger
  // row exists and is already queued/pushing/pushed (double submit).
  // With NO ledger row behind the card, approving cannot ever act, and
  // saying "approved" would be the orphaned-card silent non-payment.
  let queued = false;
  try {
    // Keep the stamped ledger row: its (period, mb_staff_id) build the
    // deterministic jobId payroll-<period>-<mbStaffId> (SEA-113), which
    // stays stable even when a resolved card frees the item dedupe key
    // and a later prepare mints a fresh item id.
    const stamped = await markPayrollPushQueued(id);
    queued = stamped !== null;
    if (stamped) {
      await enqueuePayrollPush({
        itemId: id,
        period: stamped.period,
        // Integer column, but coerce defensively in case a driver or
        // upstream serialization hands the id back as a string.
        mbStaffId: Number(stamped.mb_staff_id),
      });
    } else {
      const ledger = await payrollInvoiceForItem(id);
      if (!ledger) {
        revalidatePath("/", "layout");
        return {
          error:
            "Approved, but this invoice has no payroll ledger row behind it, so no QuickBooks push can happen. Re-run payroll.prepare for the period and decide the fresh card.",
        };
      }
      if (ledger.status === "queued") {
        // NOT automatically benign: a 'queued' row can be a live
        // concurrent submit, or a dead end where BullMQ retries were
        // exhausted (the retryable path reverts pushing -> queued and the
        // failed job record is retained forever, so a plain re-enqueue
        // would dedupe into nothing while this branch reported SUCCESS).
        // Enqueue anyway: enqueuePayrollPush sweeps a retained
        // failed/completed record under the deterministic jobId first, so
        // this revives the dead end, and against a live job it dedupes,
        // so the concurrent-submit case stays a harmless no-op (the
        // ledger claim is the durable double-push guard regardless).
        await enqueuePayrollPush({
          itemId: id,
          period: ledger.period,
          mbStaffId: Number(ledger.mb_staff_id),
        });
      }
      // pushing/pushed: a concurrent submit already moved it on; truly
      // benign, nothing to enqueue.
    }
  } catch (err) {
    console.error(
      `[payroll] failed to enqueue push for item ${id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (queued) await revertPayrollPushQueued(id).catch(() => undefined);
    revalidatePath("/", "layout");
    return {
      error:
        "Approved, but the QuickBooks push could not be queued. Reopen and approve again to retry.",
    };
  }
  revalidatePath("/", "layout");
  return { error: null };
}

export async function rejectPayrollInvoiceAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  const decider = await requireDecider();
  const id = fieldString(formData, "id").trim();
  if (id.length === 0) return { error: "Missing item id." };
  if ((await requirePayrollInvoice(id)) !== "payroll_invoice") {
    return { error: "This item is not a payroll invoice." };
  }
  try {
    await decideItem(id, "rejected", decider);
  } catch (err) {
    if (isAlreadyDecided(err)) return STALE;
    throw err;
  }
  revalidatePath("/", "layout");
  return { error: null };
}
