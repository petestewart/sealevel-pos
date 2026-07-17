import { getPool } from "./client.js";
import type { Item } from "./items.js";

/**
 * Delivery-state helpers for approved email_reply items (GH-95, the send
 * half of the loop). These are the only writers of payload.delivery, and
 * they enforce the guardrails that keep a human-approved reply from being
 * sent twice:
 *
 *  - markDeliveryQueued: the console stamps 'queued' when it enqueues the
 *    send on approval, so the decided view can say "queued for delivery".
 *  - claimDeliveryForSend: the worker atomically flips 'queued'/'failed'/
 *    absent -> 'sending' in ONE guarded UPDATE and returns the row only if
 *    it won the claim; a message already 'sent' or 'sending' returns null
 *    and the worker skips it. This is what makes a BullMQ retry, a double
 *    enqueue, or two workers safe: exactly one claim wins.
 *  - recordDeliverySent / recordDeliveryFailed: the terminal write after
 *    the Gmail call, only meaningful for the claimer.
 *
 * Every claim/queue guard also re-checks that the item is a resolved,
 * approved, non-archived email_reply, so a rejected or reopened item can
 * never be delivered. The rejected test is byte-equivalent to the
 * canonical classifier (console lib/itemView.ts classifyDecision and the
 * approvals.ts REJECTED_SQL); keep the three in sync.
 */

export type DeliveryStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "skipped";

export interface DeliveryRecord {
  status: DeliveryStatus;
  /** ISO timestamp of this state. */
  at: string;
  /** Gmail message id of the sent reply (status 'sent'). */
  messageId?: string;
  /** Recipient the reply went to (status 'sent'). */
  to?: string;
  /** Error summary (status 'failed'). */
  error?: string;
}

/**
 * SQL predicate: this item is an approved, resolved, non-archived email
 * reply. Mirrors REJECTED_SQL / classifyDecision (approved == resolved and
 * NOT rejected). Inlined here so core has no dependency on the console lib.
 */
const APPROVED_EMAIL_REPLY_SQL = `
  status = 'resolved'
  AND type = 'email_reply'
  AND NOT (payload ? 'archived')
  AND NOT coalesce(
    (jsonb_typeof(payload->'decision') = 'string' AND payload->>'decision' = 'rejected')
    OR payload->'decision'->>'action' = 'rejected'
  , false)`;

/** Delivery statuses that must never be overwritten by a new send attempt. */
const TERMINAL_OR_INFLIGHT = "('sent', 'sending')";

function deliveryRecord(rec: Omit<DeliveryRecord, "at">): string {
  const full: DeliveryRecord = { ...rec, at: new Date().toISOString() };
  return JSON.stringify(full);
}

/**
 * Stamp payload.delivery = 'queued' when a send is enqueued on approval.
 * Guarded so it never clobbers an already sent/in-flight delivery (a
 * reopen -> re-approve on an item that already went out returns null and
 * the caller does not enqueue again). Returns the updated item, or null
 * when the item is not a fresh-approved deliverable.
 */
export async function markDeliveryQueued(id: string): Promise<Item | null> {
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = payload || jsonb_build_object('delivery', $2::jsonb)
     WHERE id = $1
       AND ${APPROVED_EMAIL_REPLY_SQL}
       AND coalesce(payload->'delivery'->>'status', '') NOT IN ${TERMINAL_OR_INFLIGHT}
     RETURNING *`,
    [id, deliveryRecord({ status: "queued" })],
  );
  return rows[0] ?? null;
}

/**
 * Atomically claim an approved reply for sending: flip delivery to
 * 'sending' only if it is not already 'sent' or 'sending'. Returns the
 * claimed item (whose payload holds the draft + email_meta the worker
 * needs), or null when there is nothing to send (already delivered, in
 * flight, rejected, reopened, or archived). This is the single point that
 * prevents a double-send.
 */
export async function claimDeliveryForSend(id: string): Promise<Item | null> {
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = payload || jsonb_build_object('delivery', $2::jsonb)
     WHERE id = $1
       AND ${APPROVED_EMAIL_REPLY_SQL}
       AND coalesce(payload->'delivery'->>'status', '') NOT IN ${TERMINAL_OR_INFLIGHT}
     RETURNING *`,
    [id, deliveryRecord({ status: "sending" })],
  );
  return rows[0] ?? null;
}

/** Terminal write after a successful Gmail send (claimer only). */
export async function recordDeliverySent(
  id: string,
  sent: { messageId: string; to: string },
): Promise<void> {
  await getPool().query(
    `UPDATE items SET payload = payload || jsonb_build_object('delivery', $2::jsonb)
     WHERE id = $1`,
    [id, deliveryRecord({ status: "sent", messageId: sent.messageId, to: sent.to })],
  );
}

/**
 * Terminal write after a DEFINITELY-FAILED send (the message was not
 * accepted). Records the error and reverts the 'sending' claim to 'failed'
 * so a later retry (BullMQ, or an operator) can re-claim it. Deliberately
 * unguarded on status: only the claimer reaches here, and this is
 * post-attempt metadata.
 */
export async function recordDeliveryFailed(
  id: string,
  error: string,
): Promise<void> {
  await getPool().query(
    `UPDATE items SET payload = payload || jsonb_build_object('delivery', $2::jsonb)
     WHERE id = $1`,
    [id, deliveryRecord({ status: "failed", error: error.slice(0, 500) })],
  );
}

/**
 * Write after an AMBIGUOUS send outcome (the message may already have gone
 * out). Keeps status 'sending' -- which the claim guard treats as in-flight
 * and refuses to re-claim -- so it is NEVER auto-resent, and attaches a note
 * so the console can surface it for a human to verify in Gmail. This is the
 * safe failure: a stuck, visible 'sending' over any risk of a duplicate
 * email. Unguarded on status for the same reason as recordDeliveryFailed.
 */
export async function recordDeliveryUncertain(
  id: string,
  note: string,
): Promise<void> {
  await getPool().query(
    `UPDATE items SET payload = payload || jsonb_build_object('delivery', $2::jsonb)
     WHERE id = $1`,
    [id, deliveryRecord({ status: "sending", error: note.slice(0, 500) })],
  );
}
