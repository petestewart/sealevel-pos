import type { DeliveryRecord } from "@ai-manager/core";
import { formatDateTime } from "../lib/emailDisplay";

/**
 * Delivery status line for a decided reply (GH-56, then GH-95 send).
 *
 * Until the send pipeline landed, approving only recorded a decision and
 * this line said so. Now an approved reply may actually be delivered
 * (Job B, gated behind the operator's Approve click and the deployment's
 * GMAIL_SEND_ENABLED flag), so this reflects real state from
 * payload.delivery: queued, sending, sent, failed, or skipped. When
 * sending is not enabled the item carries no delivery record and this keeps
 * the honest "approved, not sent" copy so an operator never assumes a reply
 * went out.
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
}: {
  approved: boolean;
  hasReply: boolean;
  /** The item's delivery record, when the send pipeline has touched it. */
  delivery?: DeliveryRecord | null;
  /** Whether outbound send is enabled for this deployment. */
  sendEnabled?: boolean;
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
  } else if (sendEnabled) {
    // Sending is on but no record yet (the send is being enqueued).
    copy = "Approved. Preparing to send to the customer.";
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
