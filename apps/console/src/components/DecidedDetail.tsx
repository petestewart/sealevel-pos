import { gmailSendEnabled, gmailSendMode, type Item } from "@ai-manager/core";
import { StatusChip } from "./StatusChip";
import { DeliveryStatus } from "./DeliveryStatus";
import { ReopenButton } from "./ReopenButton";
import { ReleaseItemButton } from "./ReleaseButtons";
import { RemoveRejectedButton } from "./RemoveRejectedButton";
import { RestoreTrashedButton } from "./RestoreTrashedButton";
import { InboundEmail } from "./InboundEmail";
import { RunTraceSection } from "./RunTrace";
import { EvalCaptureSection } from "./EvalCaptureSection";
import { paragraphsOf, formatDecidedAt } from "../lib/emailDisplay";
import {
  classifyDecision,
  decisionOf,
  deliveryOf,
  isStaged,
  toCardData,
} from "../lib/itemView";

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
  const action = classifyDecision(item.payload);
  const approved = action === "approved";
  const noReply = action === "no_reply_needed";
  // Trash and spam (GH-115 follow-on) share the Trash view; both suppress
  // the delivery line (nothing was ever sent) and swap Reopen for Restore.
  const trashed = action === "trashed" || action === "spam";
  const decision = decisionOf(item);
  const decidedAt = decision
    ? formatDecidedAt(new Date(decision.at))
    : item.resolved_at
      ? formatDecidedAt(item.resolved_at)
      : null;
  const hasReply = data.draftBody.length > 0;
  // Footer audit wording: sentence-initial form of the decision.
  const decidedLabel = approved
    ? "Approved"
    : noReply
      ? "Marked no reply needed"
      : action === "trashed"
        ? "Moved to Trash"
        : action === "spam"
          ? "Marked as spam"
          : "Rejected";
  const delivery = deliveryOf(item);
  const sendEnabled = gmailSendEnabled();
  const sendMode = gmailSendMode();
  // Staged (GH-106): approved with no delivery record, i.e. waiting in
  // the Approved queue for a release. Drives the delivery line's copy and
  // the per-item Release control (which only has teeth when sending is
  // enabled; with it off, releasing would be a no-op, so it is hidden).
  const staged = isStaged(item);

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
          <StatusChip
            variant={
              approved
                ? "approved"
                : noReply
                  ? "noreply"
                  : action === "trashed"
                    ? "trashed"
                    : action === "spam"
                      ? "spam"
                      : "rejected"
            }
          />
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
              {approved
                ? "Approved reply"
                : noReply
                  ? "No reply needed"
                  : action === "trashed"
                    ? "Trashed"
                    : action === "spam"
                      ? "Confirmed spam"
                      : "Rejected draft"}
            </span>
            {data.edited ? (
              <span className="approval-pane-timestamp">edited</span>
            ) : null}
          </div>

          {/* GH-115: a no-reply item never entered the send path, so the
              delivery line's approved/rejected copy does not apply; a
              plain truthful note replaces it. */}
          {noReply ? (
            <div className="delivery-status" role="note">
              <span className="delivery-status-dot" aria-hidden="true" />
              <span>
                Not sent. This email was filed as not needing a reply.
              </span>
            </div>
          ) : trashed ? (
            // GH-115 follow-on: a trashed/spam item never entered the send
            // path; a truthful note replaces the delivery line, and says
            // what happened to the source email in Gmail.
            <div className="delivery-status" role="note">
              <span className="delivery-status-dot" aria-hidden="true" />
              <span>
                {action === "spam"
                  ? "Not sent. Reported to Gmail as spam; the sender was added to the spam list."
                  : "Not sent. The email was moved to Gmail's trash."}
              </span>
            </div>
          ) : (
            <DeliveryStatus
              approved={approved}
              hasReply={hasReply}
              delivery={delivery}
              sendEnabled={sendEnabled}
              sendMode={sendMode}
              staged={staged}
            />
          )}

          {/* GH-115: why no reply is needed, from the decision audit (the
              tier's rule, the classifier's explanation, or the operator
              marker). Rendered like the draft rationale, but always open
              via the summary text since it IS the content here. */}
          {noReply && decision?.reason ? (
            <details className="draft-rationale" open>
              <summary className="draft-rationale-summary">
                <span className="micro-label">Why no reply</span>
              </summary>
              <p className="draft-rationale-text">
                {decision.reason}
                {typeof decision.tier === "number"
                  ? ` (detected by tier ${decision.tier})`
                  : ""}
              </p>
            </details>
          ) : null}

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
            <div className="draft-empty">
              {noReply || trashed
                ? "(no draft generated; drafting was skipped for this email)"
                : "(no draft generated)"}
            </div>
          )}

          {data.rationale ? (
            <details className="draft-rationale">
              <summary className="draft-rationale-summary">
                <span className="micro-label">Why this draft</span>
              </summary>
              <p className="draft-rationale-text">{data.rationale}</p>
            </details>
          ) : null}

          {/* GH-122: run trace for the run that produced the final draft,
              with the deploy-version stamp folded in; items that predate
              the trace keep the standalone stamp line. Same muted
              operator-facing metadata as pending. */}
          {data.trace ? (
            <RunTraceSection trace={data.trace} generatedBy={data.generatedBy} />
          ) : data.generatedBy ? (
            <div className="draft-generated-by">
              Drafted by {data.generatedBy.commit}
              {data.generatedBy.at ? ` at ${data.generatedBy.at}` : ""}
            </div>
          ) : null}

          {/* GH-128: one-click eval-case capture, operator-only. A decided
              item is exactly where a miss gets noticed, so the capture
              affordance lives here too, not just on the pending card. */}
          {canDecide ? (
            <EvalCaptureSection id={data.id} capture={data.evalCapture} />
          ) : null}
        </div>
      </div>

      <div className="approval-card-actions approval-card-actions--decided">
        <span className="decided-audit">
          {decision
            ? `${decidedLabel} by ${decision.by.name}${
                decidedAt ? ` · ${decidedAt}` : ""
              }${decision.edited ? " · edited" : ""}`
            : `${decidedLabel}${decidedAt ? ` · ${decidedAt}` : ""}`}
        </span>
        {/* Trashed items restore (clearing the trash marker and undoing the
            Gmail move) instead of reopening: a plain Reopen would leave the
            item both pending and trashed, an incoherent state. */}
        {/* Release (GH-106): queue this staged reply's delivery without
            waiting for the batch Send approved. */}
        {canDecide && staged && sendEnabled ? (
          <ReleaseItemButton id={data.id} />
        ) : null}
        {canDecide && trashed ? <RestoreTrashedButton id={data.id} /> : null}
        {canDecide && !trashed ? <ReopenButton id={data.id} /> : null}
        {canDecide && action === "rejected" ? (
          <RemoveRejectedButton id={data.id} />
        ) : null}
      </div>
    </div>
  );
}
