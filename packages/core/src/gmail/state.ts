import { gmailClient } from "./client.js";
import { gmailConfigured } from "./config.js";

/**
 * Gmail state worker job (email.gmailState): the read = decided model's
 * acting half (locked decision, CLAUDE.md 2026-07-19).
 *
 * A Gmail message stays UNREAD until its item is decided (approve /
 * reject / no-reply / trash / spam). Ingestion stamps only the processed
 * label; each DECISION enqueues one of these jobs, and the worker -- the
 * only service holding Gmail credentials (the GH-116 gate split: the
 * console enqueues, the worker acts) -- applies the matching Gmail state:
 *
 *   approved / rejected / no_reply_needed  -> mark_read
 *   trashed                                -> trash   (also marks read)
 *   spam                                   -> spam    (also marks read)
 *   restore from Trash                     -> untrash / unspam
 *
 * Failure posture: fire-and-forget with retries. Every operation here is
 * idempotent on Gmail's side (see the client methods), so unlike the send
 * path there is no ambiguous-outcome bookkeeping: any failure just throws
 * and BullMQ retries the whole job. The enqueue is best-effort at the
 * decision site (a queue hiccup never fails or blocks the recorded
 * decision; the message merely stays unread, which is honest -- the inbox
 * then over-reports rather than under-reports pending work), and the job
 * itself degrades to a logged skip when Gmail is not configured.
 */

export type GmailStateAction =
  | "mark_read"
  | "trash"
  | "spam"
  | "untrash"
  | "unspam";

export const GMAIL_STATE_ACTIONS: readonly GmailStateAction[] = [
  "mark_read",
  "trash",
  "spam",
  "untrash",
  "unspam",
];

export function isGmailStateAction(value: unknown): value is GmailStateAction {
  return (GMAIL_STATE_ACTIONS as readonly unknown[]).includes(value);
}

/**
 * The Gmail mutations applyGmailState needs; GmailClient satisfies it.
 * Injectable so the offline smoke exercises the dispatch table without a
 * mailbox.
 */
export interface GmailStateClient {
  markRead(id: string): Promise<void>;
  trashMessage(id: string): Promise<void>;
  untrashMessage(id: string): Promise<void>;
  reportSpam(id: string): Promise<void>;
  unreportSpam(id: string): Promise<void>;
}

export interface GmailStateResult {
  status: "applied" | "skipped";
  reason?: string;
}

/**
 * Which Gmail state action a decision implies (the decision -> Gmail ops
 * wiring, one table shared by the console actions and the worker
 * preflight so they can never drift). Every decision marks the message
 * read; trash and spam do so as part of their move.
 */
export function gmailStateActionForDecision(
  decision: "approved" | "rejected" | "no_reply_needed" | "trashed" | "spam",
): GmailStateAction {
  switch (decision) {
    case "approved":
    case "rejected":
    case "no_reply_needed":
      return "mark_read";
    case "trashed":
      return "trash";
    case "spam":
      return "spam";
  }
}

/**
 * Apply one Gmail state action to one message. Config-gated: with Gmail
 * unconfigured this is a logged skip (never a throw -- a retry cannot
 * conjure credentials), so a job enqueued by a console that has Redis but
 * no mailbox degrades cleanly. Any Gmail/network failure throws so BullMQ
 * retries; all actions are idempotent, so retrying is always safe.
 */
export async function applyGmailState(
  action: GmailStateAction,
  gmailId: string,
  client?: GmailStateClient,
): Promise<GmailStateResult> {
  if (!gmailConfigured()) {
    console.warn(
      `[gmail-state] ${action} for message ${gmailId}: Gmail not configured; skipping`,
    );
    return { status: "skipped", reason: "gmail not configured" };
  }
  const c = client ?? gmailClient();
  switch (action) {
    case "mark_read":
      await c.markRead(gmailId);
      break;
    case "trash":
      // Trash first, then clear UNREAD: if the second call fails the
      // retry re-runs both, and both are idempotent.
      await c.trashMessage(gmailId);
      await c.markRead(gmailId);
      break;
    case "spam":
      // reportSpam clears UNREAD in the same modify call.
      await c.reportSpam(gmailId);
      break;
    case "untrash":
      // Restore does NOT re-add UNREAD: Gmail's read flag is a one-way
      // "a human decided" marker here, and un-reading mail the operator
      // demonstrably looked at would be false.
      await c.untrashMessage(gmailId);
      break;
    case "unspam":
      await c.unreportSpam(gmailId);
      break;
    default: {
      const _exhaustive: never = action;
      throw new Error(`applyGmailState: unhandled action ${_exhaustive}`);
    }
  }
  return { status: "applied" };
}
