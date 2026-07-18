import {
  claimDeliveryForSend,
  recordDeliveryDrafted,
  recordDeliveryFailed,
  recordDeliverySent,
  recordDeliveryUncertain,
} from "../db/delivery.js";
import { gmailClient, GmailSendError } from "./client.js";
import { gmailConfig, gmailSendConfigured, gmailSendMode } from "./config.js";
import { buildRawReply, extractAddress } from "./parse.js";

/**
 * Outbound send on approval (GH-95, ARCHITECTURE.md "Approvals": "the
 * approval ... triggers Job B, which performs the action via the idempotent
 * outbound tool"). This is Job B. It runs only after a human approved the
 * draft in the console -- the approval IS the send authorization, which is
 * how sending coexists with the CLAUDE.md "nothing auto-sends in v1" lock:
 * nothing leaves the building without a human clicking Approve, and even
 * then only when a human has explicitly enabled sending for the deployment
 * (GMAIL_SEND_ENABLED).
 *
 * Idempotency has two layers: a deterministic BullMQ jobId (send-<itemId>)
 * and, decisively, the atomic delivery claim (claimDeliveryForSend). The
 * claim flips the item to 'sending' in one guarded UPDATE and returns null
 * if another attempt already sent or is sending it, so a retry or a double
 * enqueue can never deliver twice.
 *
 * The no-double-send posture holds for BOTH failure shapes: a crash between
 * the Gmail accept and the 'sent' write leaves the item stuck 'sending'
 * (the claim guard then blocks every retry), and a CAUGHT ambiguous error
 * (a network timeout, or a 2xx whose body we could not read -- the message
 * may already be out) is likewise left 'sending' via recordDeliveryUncertain
 * and NOT retried. Only a definitely-not-sent error (a non-2xx response, or
 * a pre-send failure) reverts to 'failed' and retries. In every case the
 * bias is: never risk a duplicate email.
 *
 * Gmail send/draft mode (GH-97): when GMAIL_SEND_MODE is "draft", this same
 * routine parks a Gmail DRAFT instead of delivering -- a safer middle ground
 * where nothing reaches the customer until a human sends it from Gmail. The
 * mode branches only AFTER the atomic claim and the sendable-reply build, so
 * every claim / idempotency / customer-safe guarantee is identical across
 * modes; the draft path mirrors the send path's ambiguous-error handling
 * exactly, so a retry never creates a SECOND draft (no-double-draft is the
 * no-double-send guarantee applied to drafts.create, which likewise has no
 * idempotency key). 'drafted', like 'sent', is a terminal success the claim
 * guard refuses to re-claim.
 */

interface SendableDraft {
  subject: string;
  body: string;
  to: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Build the From header, keeping a friendly studio display name. */
function fromHeader(user: string): string {
  return user.includes("<") ? user : `Sealevel Hot Yoga <${user}>`;
}

/**
 * Derive the sendable reply from a claimed item's payload, or an error
 * string describing why it cannot be sent (missing draft or recipient).
 * The recipient is the original Reply-To, else the original From.
 */
function sendableFrom(
  payload: Record<string, unknown>,
): SendableDraft | { error: string } {
  const subject = str(payload["draft_subject"]);
  const body = str(payload["draft_body"]);
  if (!body) return { error: "no draft body to send" };

  const meta = (payload["email_meta"] ?? {}) as Record<string, unknown>;
  const original = (payload["original_email"] ?? {}) as Record<string, unknown>;
  const recipientRaw = str(meta["replyTo"]) ?? str(original["from"]);
  const to = extractAddress(recipientRaw);
  if (!to) return { error: "no recipient address on the original email" };

  return {
    subject: subject ?? "Re:",
    body,
    to,
    threadId: str(meta["threadId"]),
    inReplyTo: str(meta["messageIdHeader"]),
    references: str(meta["references"]),
  };
}

export interface SendResult {
  status: "sent" | "drafted" | "skipped" | "nothing_to_send";
  messageId?: string;
  /** Gmail draft id (status 'drafted', Gmail send/draft mode GH-97). */
  draftId?: string;
  to?: string;
  reason?: string;
}

/**
 * Send the approved reply for one item. Returns a structured result; throws
 * only on a transient Gmail/network failure (after recording 'failed'), so
 * BullMQ retries. A configuration gate miss, a lost claim, or an
 * unrecoverable payload problem return without throwing (no point retrying).
 */
export async function sendApprovedReply(itemId: string): Promise<SendResult> {
  if (!gmailSendConfigured()) {
    // The console gates enqueue on the same check, so this is defensive:
    // do not throw (a retry cannot fix config), just report skipped.
    console.warn(
      `[send] item ${itemId}: Gmail send not configured/enabled; skipping`,
    );
    return { status: "skipped", reason: "gmail send not configured" };
  }

  // Atomic claim: only the winner proceeds; a duplicate/retry gets null.
  const item = await claimDeliveryForSend(itemId);
  if (!item) {
    console.log(
      `[send] item ${itemId}: nothing to send (already sent, in flight, or not an approved reply)`,
    );
    return { status: "nothing_to_send" };
  }

  const sendable = sendableFrom(item.payload);
  if ("error" in sendable) {
    // Unrecoverable: retrying will not add a recipient or a draft body.
    await recordDeliveryFailed(itemId, sendable.error);
    console.warn(`[send] item ${itemId}: ${sendable.error}`);
    return { status: "skipped", reason: sendable.error };
  }

  const config = gmailConfig();
  const raw = buildRawReply({
    from: fromHeader(config.user),
    to: sendable.to,
    subject: sendable.subject,
    body: sendable.body,
    inReplyTo: sendable.inReplyTo,
    references: sendable.references,
  });

  // Gmail send/draft mode (GH-97): "draft" parks a Gmail draft, "send"
  // delivers. The branch is only for the success action; the claim above and
  // the ambiguous/failed handling below are identical across modes, so the
  // no-double-send guard doubles as the no-double-draft guard.
  const mode = gmailSendMode();
  try {
    if (mode === "draft") {
      // Draft mode: create a Gmail draft in the studio's Drafts folder,
      // threaded to the original. Nothing reaches the customer; a human
      // sends it manually from Gmail. 'drafted' is a terminal success the
      // claim guard refuses to re-claim, exactly like 'sent'.
      const draft = await gmailClient().createDraft(raw, sendable.threadId);
      await recordDeliveryDrafted(itemId, { draftId: draft.id, to: sendable.to });
      console.log(
        `[send] item ${itemId}: draft created for ${sendable.to} (gmail draft id ${draft.id}); awaiting manual send`,
      );
      return { status: "drafted", draftId: draft.id, to: sendable.to };
    }
    const sent = await gmailClient().sendMessage(raw, sendable.threadId);
    await recordDeliverySent(itemId, { messageId: sent.id, to: sendable.to });
    console.log(
      `[send] item ${itemId}: sent to ${sendable.to} (gmail id ${sent.id})`,
    );
    return { status: "sent", messageId: sent.id, to: sendable.to };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // AMBIGUOUS outcome: the message may already have been accepted by Gmail
    // ('send'), or a draft may already exist ('draft'). Leave the item
    // 'sending' (recordDeliveryUncertain) so the claim guard blocks any
    // re-attempt, surface it for a human to verify, and do NOT throw -- a
    // BullMQ retry could double-send OR double-draft. Bias to never-duplicate.
    if (err instanceof GmailSendError && err.ambiguous) {
      await recordDeliveryUncertain(itemId, message);
      console.warn(
        `[send] item ${itemId}: AMBIGUOUS ${mode} outcome, left in-flight for review (not retried): ${message}`,
      );
      return { status: "skipped", reason: `ambiguous ${mode} outcome: ${message}` };
    }
    // Definitely not sent/drafted (non-2xx, or a pre-request failure): revert
    // to 'failed' and throw so BullMQ retries; the claim guard re-claims
    // safely from 'failed'.
    await recordDeliveryFailed(itemId, message);
    throw new Error(`[send] item ${itemId} failed: ${message}`);
  }
}
