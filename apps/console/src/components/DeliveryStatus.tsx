import type { DeliveryRecord } from "@ai-manager/core";
import { formatDateTime } from "../lib/emailDisplay";

/**
 * Delivery status line for a decided reply (GH-56, then GH-95 send, GH-97
 * draft mode).
 *
 * Until the send pipeline landed, approving only recorded a decision and
 * this line said so. Now an approved reply may actually be delivered
 * (Job B, gated behind the operator's Approve click and the deployment's
 * GMAIL_SEND_ENABLED flag), so this reflects real state from
 * payload.delivery: queued, sending, sent, drafted, failed, or skipped. When
 * sending is not enabled the item carries no delivery record and this keeps
 * the honest "approved, not sent" copy so an operator never assumes a reply
 * went out.
 *
 * Gmail send/draft mode (GH-97): in draft mode an approval parks a Gmail
 * draft instead of delivering, so 'drafted' reads "a draft was created ...
 * send it from your Drafts folder" and the pre-record "preparing" copy says
 * a draft is being prepared, not that a message is sending. The delivery
 * record is authoritative for a finished state; sendMode only tunes the
 * pre-record preparing copy.
 */

function statusLine(delivery: DeliveryRecord): {
  copy: string;
  tone: "pending" | "sent" | "failed";
} {
  const when = delivery.at ? formatDateTime(new Date(delivery.at)) : "";
  switch (delivery.status) {
    case "queued":
      return { copy: "Approved. Queued for delivery to the customer.", tone: "pending" };
    case "sending":
      // An error note on a 'sending' record means an AMBIGUOUS send outcome
      // (core recordDeliveryUncertain): the message may already have gone
      // out, so it is deliberately not retried. Surface it for a human.
      return delivery.error
        ? {
            copy: `Send status unclear: ${delivery.error}. Not retried automatically to avoid a duplicate; check the sent folder in Gmail.`,
            tone: "failed",
          }
        : { copy: "Approved. Sending to the customer now.", tone: "pending" };
    case "sent":
      return {
        copy: `Sent${delivery.to ? ` to ${delivery.to}` : ""}${
          when ? ` at ${when}` : ""
        }.`,
        tone: "sent",
      };
    case "drafted":
      // Draft mode (GH-97): the reply is NOT with the customer. A Gmail
      // draft is parked; a human sends it manually from the Drafts folder.
      return {
        copy: "Approved. A draft was created in Gmail; review and send it from your Drafts folder.",
        tone: "sent",
      };
    case "failed":
      return {
        copy: `Send failed${
          delivery.error ? `: ${delivery.error}` : ""
        }. It will be retried; check the queue if it persists.`,
        tone: "failed",
      };
    case "skipped":
      return {
        copy: `Not sent${delivery.error ? `: ${delivery.error}` : ""}.`,
        tone: "failed",
      };
  }
}

export function DeliveryStatus({
  approved,
  hasReply,
  delivery,
  sendEnabled,
  sendMode = "send",
  staged = false,
}: {
  approved: boolean;
  hasReply: boolean;
  /** The item's delivery record, when the send pipeline has touched it. */
  delivery?: DeliveryRecord | null;
  /** Whether outbound send is enabled for this deployment. */
  sendEnabled?: boolean;
  /**
   * The deployment's outbound mode (Gmail send/draft mode, GH-97). Only
   * tunes the pre-record "preparing" copy (a draft is being prepared vs a
   * message is sending); a finished delivery record is authoritative and
   * ignores this. Defaults to "send" so pre-GH-97 callers are unchanged.
   */
  sendMode?: "send" | "draft";
  /**
   * Review queue (GH-106): the item is approved but its delivery was
   * never queued, so it waits in the Approved queue for a release. The
   * copy is deliberately "not yet released" rather than "queued for
   * release" because a pre-send-pipeline approved item is
   * indistinguishable from a deliberately staged one; both read
   * correctly. Defaults to false so existing callers are unchanged.
   */
  staged?: boolean;
}) {
  // A real delivery record always wins: it is the source of truth.
  if (delivery) {
    const { copy, tone } = statusLine(delivery);
    return (
      <div className={`delivery-status delivery-status--${tone}`} role="note">
        <span className="delivery-status-dot" aria-hidden="true" />
        <span>{copy}</span>
      </div>
    );
  }

  // No delivery record: rejected, or approved with sending off/pending.
  let copy: string;
  let pending = false;
  if (!approved) {
    copy = "Not sent. Rejected drafts are never delivered.";
  } else if (!hasReply) {
    copy = "Approved, not sent. No draft was generated and nothing has gone to the customer.";
  } else if (sendEnabled && staged) {
    // Staged in the Approved queue (GH-106): nothing goes out until a
    // release. Draft mode releases into a parked Gmail draft, not a send.
    copy =
      sendMode === "draft"
        ? "Approved. Not yet released. Use Send approved in the Approved queue to park this reply as a Gmail draft."
        : "Approved. Not yet released. Use Send approved in the Approved queue to deliver this reply.";
    pending = true;
  } else if (sendEnabled) {
    // Sending is on but no record yet (the job is being enqueued). Draft
    // mode (GH-97) prepares a Gmail draft, not a delivery, so say so.
    copy =
      sendMode === "draft"
        ? "Approved. Preparing a draft in Gmail."
        : "Approved. Preparing to send to the customer.";
    pending = true;
  } else {
    copy = "Approved, not sent. Sending is disabled for this studio, so this reply has not gone to the customer.";
  }
  return (
    <div
      className={`delivery-status${pending ? " delivery-status--pending" : ""}`}
      role="note"
    >
      <span className="delivery-status-dot" aria-hidden="true" />
      <span>{copy}</span>
    </div>
  );
}
