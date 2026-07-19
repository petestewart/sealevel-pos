import Link from "next/link";
import type { Item } from "@ai-manager/core";
import { StatusChip } from "./StatusChip";
import { ReopenButton } from "./ReopenButton";
import { ProposeRevertButton } from "./ProposeRevertButton";
import { KbDiff } from "./KbDiff";
import { formatDecidedAt } from "../lib/emailDisplay";
import { classifyDecision, decisionOf } from "../lib/itemView";
import { kbWriteStatusCopy, toKbCardData } from "../lib/kbView";

/**
 * Read view for a decided kb_update item (GH-113): the decision audit,
 * the write outcome with honest status copy (written / stale / denied /
 * failed / skipped), the full provenance chain (source email link,
 * approver, diff of what was proposed against the base it was computed
 * from), and the human-gated controls: Reopen (back to pending, e.g. to
 * retry a failed or skipped write by re-approving) and, on a committed
 * write, Propose revert (files a NEW proposal restoring the prior
 * content; nothing is restored without a fresh approval).
 */
export function KbDecidedDetail({
  item,
  canDecide,
  sourceHref,
  revertHref,
}: {
  item: Item;
  canDecide: boolean;
  sourceHref?: string | null;
  revertHref?: string | null;
}) {
  const data = toKbCardData(item);
  const action = classifyDecision(item.payload);
  const approved = action === "approved";
  const decision = decisionOf(item);
  const decidedAt = decision
    ? formatDecidedAt(new Date(decision.at))
    : item.resolved_at
      ? formatDecidedAt(item.resolved_at)
      : null;
  const decidedLabel = approved ? "Approved" : "Rejected";
  const write = data?.kbWrite ?? null;
  const status = kbWriteStatusCopy(write);
  const isRevert = data?.revertOfItemId != null;

  if (!data) {
    return (
      <div className="approval-card">
        <div className="approval-card-head">
          <span className="approval-card-id">#{String(item.id).slice(0, 8)}</span>
          <span className="intent-chip">KB update</span>
        </div>
        <div className="kb-card-body">
          <p className="kb-card-summary">
            This knowledge base proposal is malformed and cannot be displayed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="approval-card">
      <div className="approval-card-head">
        <span className="approval-card-id">#{data.id.slice(0, 8)}</span>
        <span className="intent-chip">{isRevert ? "KB revert" : "KB update"}</span>
        <span className="tag-chip">
          {data.changeKind === "new_page" ? "new page" : "edit"}
        </span>
        <span className="approval-card-time">{data.receivedTime}</span>
        <span className="approval-card-status">
          <StatusChip variant={approved ? "approved" : "rejected"} />
        </span>
      </div>

      <div className="kb-card-body">
        <div className="kb-card-meta">
          <div className="kb-card-page">
            <span className="micro-label">Wiki page</span>
            <span className="kb-page-name">{data.targetPage}</span>
          </div>
          {data.summary ? <p className="kb-card-summary">{data.summary}</p> : null}

          {/* The write outcome, honest in every state: rejected proposals
              wrote nothing; approved ones show queued/written/stale/denied/
              failed/skipped from payload.kb_write. */}
          <div className={`kb-write-status kb-write-status--${status.tone}`} role="note">
            <span className="delivery-status-dot" aria-hidden="true" />
            <span>
              {approved
                ? status.text
                : "Not written. This proposal was rejected; the knowledge base is unchanged."}
            </span>
          </div>

          {data.rationale ? (
            <details className="draft-rationale">
              <summary className="draft-rationale-summary">
                <span className="micro-label">Why this update</span>
              </summary>
              <p className="draft-rationale-text">{data.rationale}</p>
            </details>
          ) : null}

          <div className="kb-card-source">
            {isRevert ? (
              revertHref ? (
                <Link href={revertHref} className="kb-source-link">
                  Reverts the update from item #{data.revertOfItemId!.slice(0, 8)}
                </Link>
              ) : (
                <span>
                  Reverts the update from item #{data.revertOfItemId!.slice(0, 8)}
                </span>
              )
            ) : data.source ? (
              sourceHref ? (
                <Link href={sourceHref} className="kb-source-link">
                  Source email: {data.source.subject ?? "(no subject)"}
                  {data.source.from ? ` from ${data.source.from}` : ""}
                </Link>
              ) : (
                <span>
                  Source email: {data.source.subject ?? "(no subject)"}
                  {data.source.from ? ` from ${data.source.from}` : ""}
                </span>
              )
            ) : null}
            {data.edited ? (
              <span className="approval-pane-timestamp">edited</span>
            ) : null}
          </div>
        </div>

        <KbDiff
          before={data.baseContent}
          after={data.proposedContent}
          newPage={data.changeKind === "new_page"}
        />
      </div>

      <div className="approval-card-actions approval-card-actions--decided">
        <span className="decided-audit">
          {decision
            ? `${decidedLabel} by ${decision.by.name}${
                decidedAt ? ` · ${decidedAt}` : ""
              }${decision.edited ? " · edited" : ""}`
            : `${decidedLabel}${decidedAt ? ` · ${decidedAt}` : ""}`}
        </span>
        {/* Rollback (GH-113): only offered on a committed write, and only
            as a new human-gated proposal. Not offered when the write
            created the page (no prior content exists to restore). */}
        {canDecide && write?.status === "written" && data.baseContent.trim().length > 0 ? (
          <ProposeRevertButton id={data.id} />
        ) : null}
        {canDecide ? <ReopenButton id={data.id} /> : null}
      </div>
    </div>
  );
}
