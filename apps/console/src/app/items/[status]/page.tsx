import { notFound } from "next/navigation";
import type { Item } from "@ai-manager/core";
import {
  ApprovalCard,
  type ApprovalCardData,
} from "../../../components/ApprovalCard";
import { DecidedRow } from "../../../components/DecidedRow";
import { currentRole, hasPermission } from "../../../lib/rbac";
import {
  decidedItems,
  pendingApprovals,
  recentlyDecided,
  type DecisionAction,
} from "../../../lib/approvals";
import { inboxBySlug, type InboxDefinition } from "../../../lib/inboxes";
import {
  formatDateTime,
  formatTime,
  humanizeType,
  initialsOf,
  parseSender,
} from "../../../lib/emailDisplay";
import { parseAttachments } from "../../../lib/emailText";

/**
 * Inbox routes /items/pending, /items/approved, /items/rejected (A1b).
 * The slug resolves against the inbox registry; unknown slugs 404.
 *
 * Pending renders the approval card list (GH-22) plus the recently
 * decided tail; Approved and Rejected render decided rows, newest
 * decision first, one page at a time (page 1 for now; the list/detail
 * split is A1c/GH-29).
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
    // GH-38: older items predate the rationale field; null means no note.
    rationale: str(payload.draft_rationale)?.trim() || null,
  };
}

function EmptyState({ inbox }: { inbox: InboxDefinition }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        {"◎"}
      </div>
      {inbox.slug === "pending" ? (
        <>
          <div className="empty-state-title">You&apos;re all caught up</div>
          <div className="empty-state-sub">
            No drafts waiting for approval. New replies will appear here as
            they come in.
          </div>
        </>
      ) : (
        <>
          <div className="empty-state-title">Nothing here yet</div>
          <div className="empty-state-sub">
            {inbox.slug === "approved"
              ? "Replies you approve will appear here."
              : "Drafts you reject will appear here."}
          </div>
        </>
      )}
    </div>
  );
}

async function PendingInbox({
  inbox,
  canDecide,
}: {
  inbox: InboxDefinition;
  canDecide: boolean;
}) {
  const [items, decided] = await Promise.all([
    pendingApprovals(),
    recentlyDecided(),
  ]);

  return (
    <>
      {items.length === 0 ? (
        <EmptyState inbox={inbox} />
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
    </>
  );
}

async function DecidedInbox({
  inbox,
  canDecide,
  decision,
}: {
  inbox: InboxDefinition;
  canDecide: boolean;
  decision: DecisionAction;
}) {
  const items = await decidedItems(decision);

  return items.length === 0 ? (
    <EmptyState inbox={inbox} />
  ) : (
    <div className="decided-list">
      {items.map((item) => (
        <DecidedRow key={item.id} item={item} canDecide={canDecide} />
      ))}
    </div>
  );
}

export default async function InboxPage({
  params,
}: {
  params: Promise<{ status: string }>;
}) {
  const { status } = await params;
  const inbox = inboxBySlug(status);
  if (!inbox) notFound();

  const role = await currentRole();
  const canDecide = hasPermission(role, "approvals:decide");

  return (
    <div className="page page--approvals page--inbox">
      <header className="page-head">
        <h1>{inbox.title}</h1>
        <p>{inbox.blurb}</p>
      </header>
      <InboxBody inbox={inbox} canDecide={canDecide} />
    </div>
  );
}

/**
 * Dispatch on the inbox's DECLARED source, not on its slug. The switch is
 * exhaustive over InboxSource["kind"]: a future registry entry with a new
 * kind is a compile error here (the `never` assignment), never a silent
 * fall-through to the approved query. Adding a source means adding its
 * data layer plus a branch below -- both required, both checked.
 */
function InboxBody({
  inbox,
  canDecide,
}: {
  inbox: InboxDefinition;
  canDecide: boolean;
}) {
  const source = inbox.source;
  switch (source.kind) {
    case "pending":
      return <PendingInbox inbox={inbox} canDecide={canDecide} />;
    case "decision":
      return (
        <DecidedInbox
          inbox={inbox}
          canDecide={canDecide}
          decision={source.decision}
        />
      );
    default: {
      const _exhaustive: never = source;
      throw new Error(
        `InboxBody: unhandled inbox source ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}
