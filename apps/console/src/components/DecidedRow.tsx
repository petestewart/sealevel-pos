import type { Item } from "@ai-manager/core";
import { StatusChip } from "./StatusChip";
import { ReopenButton } from "./ReopenButton";
import type { DecisionRecord } from "../lib/approvals";
import { formatDecidedAt, parseSender } from "../lib/emailDisplay";

/**
 * Decided-item row (GH-22 style): decision icon, id, status chip, outcome
 * line, and the decision audit. Shared by the pending inbox's "Recently
 * decided" section and the Approved / Rejected inboxes (A1b).
 */

interface OriginalEmail {
  from?: string;
  subject?: string;
  body?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decisionOf(item: Item): DecisionRecord | null {
  const d = item.payload.decision as Partial<DecisionRecord> | undefined;
  if (
    typeof d === "object" &&
    d !== null &&
    (d.action === "approved" || d.action === "rejected") &&
    typeof d.by === "object" &&
    d.by !== null &&
    typeof d.by.name === "string" &&
    typeof d.at === "string"
  ) {
    return d as DecisionRecord;
  }
  return null;
}

export function DecidedRow({
  item,
  canDecide,
}: {
  item: Item;
  canDecide: boolean;
}) {
  const decision = decisionOf(item);
  // Legacy rows (pre-audit schema) stored the decision as a bare string.
  const legacy = item.payload.decision;
  const approved = decision
    ? decision.action === "approved"
    : legacy !== "rejected";
  const sender = parseSender(
    str((item.payload.original_email as OriginalEmail | undefined)?.from),
  );
  const decidedAt = decision
    ? formatDecidedAt(new Date(decision.at))
    : item.resolved_at
      ? formatDecidedAt(item.resolved_at)
      : null;
  const verb = approved ? "Approved" : "Rejected";

  return (
    <div className="decided-row">
      <div
        className={`decided-icon decided-icon--${approved ? "approved" : "rejected"}`}
        aria-hidden="true"
      >
        {approved ? "✓" : "✕"}
      </div>
      <div className="decided-main">
        <div className="decided-meta-row">
          <span className="decided-id">#{String(item.id).slice(0, 8)}</span>
          <StatusChip variant={approved ? "approved" : "rejected"} />
        </div>
        <div className="decided-title">
          {approved
            ? `Draft approved for ${sender.name}`
            : `Draft rejected, nothing sent to ${sender.name}`}
        </div>
        <div className="decided-meta">
          {decision
            ? `${verb} by ${decision.by.name}${decidedAt ? ` · ${decidedAt}` : ""}${decision.edited ? " · edited" : ""}`
            : `${verb}${decidedAt ? ` · ${decidedAt}` : ""}`}
          {canDecide ? (
            <>
              {" · "}
              <ReopenButton id={String(item.id)} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
