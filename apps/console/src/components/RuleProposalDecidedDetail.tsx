import type { Item } from "@ai-manager/core";
import { StatusChip } from "./StatusChip";
import { ReopenButton } from "./ReopenButton";
import { formatDecidedAt } from "../lib/emailDisplay";
import { classifyDecision, decisionOf } from "../lib/itemView";
import {
  ruleInsertStatusCopy,
  toRuleProposalCardData,
} from "../lib/ruleProposalView";

/**
 * Read view for a decided rule_proposal item (learning loop, GH-127):
 * the decision audit, the rule text as decided, and the rule-insert
 * outcome with honest status copy (a rejected proposal added nothing; an
 * approved one shows inserted, or the failure that Reopen + re-approve
 * retries, e.g. the rule cap). Reopen is the human-gated retry path,
 * matching the KB decided view.
 */
export function RuleProposalDecidedDetail({
  item,
  canDecide,
}: {
  item: Item;
  canDecide: boolean;
}) {
  const data = toRuleProposalCardData(item);
  const action = classifyDecision(item.payload);
  const approved = action === "approved";
  const decision = decisionOf(item);
  const decidedAt = decision
    ? formatDecidedAt(new Date(decision.at))
    : item.resolved_at
      ? formatDecidedAt(item.resolved_at)
      : null;
  const decidedLabel = approved ? "Approved" : "Rejected";
  const status = ruleInsertStatusCopy(data?.ruleInsert ?? null);

  if (!data) {
    return (
      <div className="approval-card">
        <div className="approval-card-head">
          <span className="approval-card-id">
            #{String(item.id).slice(0, 8)}
          </span>
          <span className="intent-chip">Rule proposal</span>
        </div>
        <div className="kb-card-body">
          <p className="kb-card-summary">
            This rule proposal is malformed and cannot be displayed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="approval-card">
      <div className="approval-card-head">
        <span className="approval-card-id">#{data.id.slice(0, 8)}</span>
        <span className="intent-chip">Rule proposal</span>
        <span className="approval-card-time">{data.receivedTime}</span>
        <span className="approval-card-status">
          <StatusChip variant={approved ? "approved" : "rejected"} />
        </span>
      </div>

      <div className="kb-card-body">
        <div className="kb-card-meta">
          <div className="kb-card-page">
            <span className="micro-label">Proposed rule</span>
            <p className="draft-rationale-text">{data.ruleText}</p>
          </div>

          <div
            className={`kb-write-status kb-write-status--${status.tone === "ok" ? "ok" : status.tone === "error" ? "error" : "pending"}`}
            role="note"
          >
            <span className="delivery-status-dot" aria-hidden="true" />
            <span>
              {approved
                ? status.text
                : "No rule was added. This proposal was rejected and the lesson will not be proposed again."}
            </span>
          </div>

          <div className="kb-card-source">
            {data.minedWindow ? (
              <span className="approval-pane-timestamp">
                mined from {data.minedWindow.signals} correction
                {data.minedWindow.signals === 1 ? "" : "s"}
              </span>
            ) : null}
            {data.edited ? (
              <span className="approval-pane-timestamp">edited</span>
            ) : null}
          </div>
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
        {canDecide ? <ReopenButton id={data.id} /> : null}
      </div>
    </div>
  );
}
