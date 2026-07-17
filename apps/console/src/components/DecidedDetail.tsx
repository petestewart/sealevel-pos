import { gmailSendConfigured, type Item } from "@ai-manager/core";
import { StatusChip } from "./StatusChip";
import { DeliveryStatus } from "./DeliveryStatus";
import { ReopenButton } from "./ReopenButton";
import { RemoveRejectedButton } from "./RemoveRejectedButton";
import { InboundEmail } from "./InboundEmail";
import { paragraphsOf, formatDecidedAt } from "../lib/emailDisplay";
import { decisionOf, deliveryOf, isApproved, toCardData } from "../lib/itemView";

/**
 * Read view for a decided item in the detail pane (A1c, GH-29). Reuses the
 * approval-card two-pane shell and the shared toCardData derivation so a
 * decided item reads exactly like its pending form, minus the actions:
 * original message on the left, the final reply on the right, with a
 * DeliveryStatus line stating that nothing has been sent (GH-56). The
 * footer carries the decision audit and the Reopen control (GH-25), so
 * this is the decided counterpart of ApprovalCard, not a fork of its
 * interactive machinery.
 */
export function DecidedDetail({
  item,
  canDecide,
}: {
  item: Item;
  canDecide: boolean;
}) {
  const data = toCardData(item);
  const approved = isApproved(item);
  const decision = decisionOf(item);
  const decidedAt = decision
    ? formatDecidedAt(new Date(decision.at))
    : item.resolved_at
      ? formatDecidedAt(item.resolved_at)
      : null;
  const hasReply = data.draftBody.length > 0;
  const delivery = deliveryOf(item);
  const sendEnabled = gmailSendConfigured();

  return (
    <div className="approval-card">
      <div className="approval-card-head">
        <span className="approval-card-id">#{data.id.slice(0, 8)}</span>
        <span className="intent-chip">{data.intent}</span>
        {data.tags.map((t) => (
          <span key={t} className="tag-chip">
            {t}
          </span>
        ))}
        <span className="approval-card-time">{data.receivedTime}</span>
        {data.assigneeName ? (
          <span className="approval-card-time" title="Assigned to">
            · {data.assigneeName}
          </span>
        ) : null}
        <span className="approval-card-status">
          <StatusChip variant={approved ? "approved" : "rejected"} />
        </span>
      </div>

      <div className="approval-card-panes">
        <div className="approval-pane approval-pane--inbound">
          <div className="approval-customer">
            <div className="approval-avatar" aria-hidden="true">
              {data.initials}
            </div>
            <div className="approval-customer-meta">
              <div className="approval-customer-name">{data.customer}</div>
              <div className="approval-customer-sub">Inbound</div>
            </div>
          </div>
          <div className="approval-pane-labelrow">
            <span className="micro-label">Original message</span>
            <span className="approval-pane-timestamp">{data.receivedFull}</span>
          </div>
          <div className="inbound-subject">{data.inboundSubject}</div>
          <InboundEmail body={data.inbound} attachments={data.attachments} />
        </div>

        <div className="approval-pane approval-pane--draft">
          <div className="approval-pane-labelrow">
            <span className="micro-label micro-label--accent">
              <span className="micro-label-dot" aria-hidden="true" />
              {approved ? "Approved reply" : "Rejected draft"}
            </span>
            {data.edited ? (
              <span className="approval-pane-timestamp">edited</span>
            ) : null}
          </div>

          <DeliveryStatus
            approved={approved}
            hasReply={hasReply}
            delivery={delivery}
            sendEnabled={sendEnabled}
          />

          {hasReply ? (
            <>
              <div className="draft-subject">{data.draftSubject}</div>
              <div className="draft-body">
                {paragraphsOf(data.draftBody).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            </>
          ) : (
            <div className="draft-empty">(no draft generated)</div>
          )}

          {data.rationale ? (
            <details className="draft-rationale">
              <summary className="draft-rationale-summary">
                <span className="micro-label">Why this draft</span>
              </summary>
              <p className="draft-rationale-text">{data.rationale}</p>
            </details>
          ) : null}
        </div>
      </div>

      <div className="approval-card-actions approval-card-actions--decided">
        <span className="decided-audit">
          {decision
            ? `${approved ? "Approved" : "Rejected"} by ${decision.by.name}${
                decidedAt ? ` · ${decidedAt}` : ""
              }${decision.edited ? " · edited" : ""}`
            : `${approved ? "Approved" : "Rejected"}${
                decidedAt ? ` · ${decidedAt}` : ""
              }`}
        </span>
        {canDecide ? <ReopenButton id={data.id} /> : null}
        {canDecide && !approved ? <RemoveRejectedButton id={data.id} /> : null}
      </div>
    </div>
  );
}
