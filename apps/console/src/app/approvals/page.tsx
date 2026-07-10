import type { Item } from "@ai-manager/core";
import { StatusChip } from "../../components/StatusChip";
import { ReopenButton } from "../../components/ReopenButton";
import {
  ApprovalCard,
  type ApprovalCardData,
} from "../../components/ApprovalCard";
import { currentRole, hasPermission } from "../../lib/rbac";
import {
  pendingApprovals,
  recentlyDecided,
  type DecisionRecord,
} from "../../lib/approvals";
import {
  formatDateTime,
  formatDecidedAt,
  formatTime,
  humanizeType,
  initialsOf,
  parseSender,
} from "../../lib/emailDisplay";
import { parseAttachments } from "../../lib/emailText";

/**
 * Approval inbox (Console.dc.html approvals spec, GH-22): every item with
 * status pending_approval rendered as a two-pane email card, newest first,
 * plus the last ten decided email replies with their decision audit.
 * Nothing auto-sends in v1; approving records the decision only.
 */

interface OriginalEmail {
  from?: string;
  subject?: string;
  body?: string;
  /** Future ingestion will populate attachment names/sizes (GH-34). */
  attachments?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toCardData(item: Item): ApprovalCardData {
  const payload = item.payload;
  const original = (payload.original_email ?? {}) as OriginalEmail;
  const sender = parseSender(str(original.from));
  return {
    // Serial int at runtime despite the string type; normalize for React.
    id: String(item.id),
    // The triage job that classifies intent is a future ticket; until the
    // payload carries one, show the item type rather than inventing it.
    intent: str(payload.intent) ?? humanizeType(item.type),
    receivedTime: formatTime(item.created_at),
    receivedFull: formatDateTime(item.created_at),
    assignee: item.assignee,
    customer: sender.name,
    initials: initialsOf(sender.name),
    inboundSubject: str(original.subject)?.trim() || "(no subject)",
    inbound: str(original.body) ?? "(no message body)",
    attachments: parseAttachments(original.attachments),
    draftSubject: str(payload.draft_subject) ?? "(no subject)",
    draftBody: str(payload.draft_body)?.trim() ?? "",
    edited: payload.draft_edited === true,
  };
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

function DecidedRow({
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

export default async function ApprovalsPage() {
  const role = await currentRole();
  const canDecide = hasPermission(role, "approvals:decide");
  const [items, decided] = await Promise.all([
    pendingApprovals(),
    recentlyDecided(),
  ]);

  return (
    <div className="page page--approvals">
      <header className="page-head">
        <h1>Approvals</h1>
        <p>
          AI-drafted email replies awaiting your decision. Nothing is sent
          automatically in v1.
        </p>
      </header>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            {"◎"}
          </div>
          <div className="empty-state-title">You&apos;re all caught up</div>
          <div className="empty-state-sub">
            No drafts waiting for approval. New replies will appear here as
            they come in.
          </div>
        </div>
      ) : (
        <div className="approval-list">
          {items.map((item) => (
            <ApprovalCard
              key={item.id}
              item={toCardData(item)}
              canDecide={canDecide}
            />
          ))}
        </div>
      )}

      {decided.length > 0 ? (
        <>
          <div className="section-label">Recently decided</div>
          <div className="decided-list">
            {decided.map((item) => (
              <DecidedRow key={item.id} item={item} canDecide={canDecide} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
