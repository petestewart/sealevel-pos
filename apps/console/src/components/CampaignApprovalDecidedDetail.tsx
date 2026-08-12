import type { Item } from "@ai-manager/core";
import { toCampaignApprovalCardData } from "../lib/campaignApprovalData";
import {
  audienceHeadline,
  copyStatusLine,
  sendDiffHeadline,
  totalExcluded,
} from "../lib/campaignApprovalView";
import { formatDateTime } from "../lib/emailDisplay";
import { StatusChip } from "./StatusChip";

/**
 * Read-only detail for a DECIDED campaign_approval item (SEA-83): the
 * decision audit (who, what, when) over the same four data elements the
 * pending card showed, so what was approved stays reviewable verbatim.
 * Server component; no actions (re-running a campaign is a deliberate
 * run_seq bump + redraft, not a reopen).
 */
export function CampaignApprovalDecidedDetail({ item }: { item: Item }) {
  const data = toCampaignApprovalCardData(item);
  const decision = item.payload["decision"] as
    | { action?: string; by?: { name?: string }; at?: string }
    | undefined;
  const action = decision?.action === "approved" ? "approved" : "rejected";
  const decidedLine = [
    action === "approved" ? "Approved" : "Rejected",
    decision?.by?.name ? `by ${decision.by.name}` : null,
    decision?.at ? formatDateTime(new Date(decision.at)) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (!data) {
    return (
      <div className="detail-placeholder">
        <div className="detail-placeholder-title">Campaign approval</div>
        <div className="detail-placeholder-sub">{decidedLine}</div>
      </div>
    );
  }

  return (
    <div className="approval-card">
      <div className="approval-card-head">
        <span className="approval-card-id">#{data.id.slice(0, 8)}</span>
        <span className="intent-chip">Campaign approval</span>
        <span className="tag-chip">
          {data.campaignKey}
          {data.runSeq > 1 ? ` · run ${data.runSeq}` : ""}
        </span>
        <span className="approval-card-status">
          <StatusChip variant={action === "approved" ? "approved" : "rejected"} />
        </span>
      </div>

      <div className="kb-card-body">
        <div className="kb-card-meta">
          <p className="kb-card-summary">
            {data.campaignName}. {decidedLine}.
            {action === "approved"
              ? " Sending is a separate step (SEA-84) and is wired independently of this record."
              : " The campaign returned to draft."}
          </p>
        </div>

        <div className="kb-card-page">
          <span className="micro-label">Audience approved</span>
          <p className="draft-rationale-text">{audienceHeadline(data)}</p>
          <p className="approval-pane-timestamp">
            Snapshot frozen {data.snapshotAt} from {data.audienceView};{" "}
            {totalExcluded(data.exclusions)} excluded by the build.
          </p>
          <p className="approval-pane-timestamp">
            {sendDiffHeadline(data.sendDiff)}
            {/* copyChanged null is UNKNOWN by contract, never "unchanged". */}
            {data.sendDiff ? ` ${copyStatusLine(data.sendDiff)}.` : ""}
          </p>
        </div>

        <div className="kb-card-page">
          <span className="micro-label">
            The email as rendered for {data.preview.recipient.email}
          </span>
          <p className="draft-rationale-text">
            <strong>Subject:</strong> {data.preview.subject}
          </p>
          <p className="draft-rationale-text" style={{ whiteSpace: "pre-wrap" }}>
            {data.preview.body}
          </p>
        </div>

        {data.rationale ? (
          <div className="kb-card-page">
            <span className="micro-label">Why this draft</span>
            <p className="draft-rationale-text">{data.rationale}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
