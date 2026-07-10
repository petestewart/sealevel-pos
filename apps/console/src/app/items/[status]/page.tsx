import { notFound } from "next/navigation";
import { getItemById, type Item } from "@ai-manager/core";
import { ApprovalCard } from "../../../components/ApprovalCard";
import { DecidedDetail } from "../../../components/DecidedDetail";
import { ItemRow } from "../../../components/ItemRow";
import { ListScrollRestore } from "../../../components/ListScrollRestore";
import { MobileBackBar } from "../../../components/MobileBackBar";
import { currentRole, hasPermission } from "../../../lib/rbac";
import {
  adjacentPendingId,
  decidedItems,
  pendingApprovals,
  recentlyDecided,
} from "../../../lib/approvals";
import { inboxBySlug, type InboxDefinition } from "../../../lib/inboxes";
import { isApproved, toCardData, toRow } from "../../../lib/itemView";

/**
 * Inbox route /items/[status] as a LIST pane + DETAIL pane (A1c, GH-29).
 * The left pane is a list of compact rows (the collapsed state of each
 * item); selecting a row deep-links via ?item=<id> and renders the full
 * item in the right pane. Pending items open the interactive ApprovalCard;
 * decided items open the read-only DecidedDetail. No selection shows a
 * placeholder rather than auto-selecting, so the URL is the single source
 * of truth for what's open and an empty pane reads as "nothing chosen".
 *
 * Dispatch is on the inbox's declared source (GH-28), not its slug, so the
 * exhaustiveness check still guards new registry entries.
 */

/** All items an inbox lists, in display order (newest-relevant first). */
async function loadInboxItems(inbox: InboxDefinition): Promise<Item[]> {
  const source = inbox.source;
  switch (source.kind) {
    case "pending": {
      // Pending list = items awaiting a decision, then the recently
      // decided tail (GH-28). Both are selectable; the detail pane picks
      // the renderer from each item's status. This is what lets a just-
      // approved item stay visible (and selected) after the decision.
      const [pending, decided] = await Promise.all([
        pendingApprovals(),
        recentlyDecided(),
      ]);
      return [...pending, ...decided];
    }
    case "decision":
      return decidedItems(source.decision);
    default: {
      const _exhaustive: never = source;
      throw new Error(
        `loadInboxItems: unhandled inbox source ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function ListEmpty({ inbox }: { inbox: InboxDefinition }) {
  const sub =
    inbox.slug === "pending"
      ? "New replies will appear here as they come in."
      : inbox.slug === "approved"
        ? "Replies you approve will appear here."
        : "Drafts you reject will appear here.";
  return (
    <div className="list-empty">
      <div className="list-empty-title">
        {inbox.slug === "pending" ? "You're all caught up" : "Nothing here yet"}
      </div>
      <div className="list-empty-sub">{sub}</div>
    </div>
  );
}

function DetailPlaceholder({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="detail-placeholder">
      <div className="detail-placeholder-icon" aria-hidden="true">
        {"◎"}
      </div>
      <div className="detail-placeholder-title">
        {hasItems ? "Select an item to review" : "Nothing to review"}
      </div>
      <div className="detail-placeholder-sub">
        {hasItems
          ? "Choose a message on the left to see the full thread and draft reply."
          : "This inbox is empty right now."}
      </div>
    </div>
  );
}

/**
 * Whether an item is a canonical MEMBER of this inbox, used to validate a
 * deep-linked ?item=<id> that lies beyond the loaded page (the list is
 * paginated) before a by-id fetch renders it -- so we never render the
 * wrong view: a pending inbox's canonical members are pending_approval
 * items (ApprovalCard); a decision inbox's are resolved email_reply items
 * whose approved/rejected classification (the ONE `classifyDecision` rule,
 * via isApproved) matches the route. An id that doesn't exist, or belongs
 * to another inbox, fails this check and falls back to the placeholder.
 *
 * Note this is stricter than what the pending inbox LISTS: the pending
 * list also carries a bounded recently-decided tail (GH-28), so a handful
 * of resolved items appear there as on-page rows. Those on-page rows are
 * shown as-is (see resolveSelected); membership only gates the by-id
 * deep-link fallback, where "belongs to pending" means still-pending. Both
 * paths classify approved-vs-rejected identically (classifyDecision); they
 * differ only in inclusion policy, by design.
 */
function belongsToInbox(item: Item, inbox: InboxDefinition): boolean {
  const source = inbox.source;
  switch (source.kind) {
    case "pending":
      return item.status === "pending_approval";
    case "decision":
      return (
        item.status === "resolved" &&
        item.type === "email_reply" &&
        isApproved(item) === (source.decision === "approved")
      );
    default: {
      const _exhaustive: never = source;
      throw new Error(
        `belongsToInbox: unhandled inbox source ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Resolve the selected item for ?item=<id>.
 *
 * 1. Prefer an already-loaded page row (no extra query for the common
 *    case). On-page rows are trusted as-is: this page rendered them, so
 *    they are legitimately part of THIS inbox -- including the pending
 *    inbox's intentional recently-decided tail (GH-28), where a resolved
 *    row is a valid on-page selection that opens the DecidedDetail view.
 * 2. Otherwise fall back to a single by-id fetch for a deep link beyond
 *    page 1, gated by belongsToInbox so a foreign or nonexistent id yields
 *    null (placeholder), never a mismatched detail view.
 *
 * Both paths classify approved-vs-rejected through the same
 * `classifyDecision` rule (the Detail dispatch keys on item.status, and
 * belongsToInbox / DecidedDetail on classifyDecision), so on-page and
 * by-id selections can never disagree on how an item is shown. Loading all
 * pages is deliberately avoided.
 */
async function resolveSelected(
  selectedId: string | undefined,
  items: Item[],
  inbox: InboxDefinition,
): Promise<Item | null> {
  if (selectedId == null) return null;
  const onPage = items.find((it) => String(it.id) === selectedId);
  if (onPage) return onPage;
  const fetched = await getItemById(selectedId);
  return fetched && belongsToInbox(fetched, inbox) ? fetched : null;
}

/**
 * Where the detail pane should advance to after the selected pending item is
 * decided (A2, GH-30). To keep the operator's place, selection moves to the
 * NEXT still-pending row; if the decided item was the last pending one, it
 * falls back to the PREVIOUS pending row, and if none remain, to the inbox
 * base URL (no ?item) so the pane shows the "all caught up" placeholder
 * gracefully. Only truly-pending rows are candidates (the recently-decided
 * GH-28 tail is never an advance target). The neighbor is looked up straight
 * from the DB (adjacentPendingId), NOT from the loaded page, so the advance
 * stays correct even for a pending item deep-linked beyond the first page.
 * This is a JS-only enhancement layered on top of the server action; the
 * href is computed server-side and handed to the card, which navigates on a
 * successful decision.
 */
async function advanceHrefFor(selected: Item, slug: string): Promise<string> {
  const base = `/items/${slug}`;
  const nextId = await adjacentPendingId(selected);
  return nextId ? `${base}?item=${encodeURIComponent(nextId)}` : base;
}

function Detail({
  item,
  canDecide,
  advanceHref,
}: {
  item: Item;
  canDecide: boolean;
  advanceHref?: string;
}) {
  if (item.status === "pending_approval") {
    return (
      <ApprovalCard
        // Keyed by item id so client state (edit mode, typed draft text)
        // resets when the selection changes. Without this, auto-advance
        // after a decide reuses the component instance and the NEXT item
        // renders mid-edit with the PREVIOUS item's subject/body staged.
        key={item.id}
        item={toCardData(item)}
        canDecide={canDecide}
        advanceHref={advanceHref}
      />
    );
  }
  return <DecidedDetail key={item.id} item={item} canDecide={canDecide} />;
}

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ status: string }>;
  searchParams: Promise<{ item?: string }>;
}) {
  const { status } = await params;
  const { item: selectedId } = await searchParams;
  const inbox = inboxBySlug(status);
  if (!inbox) notFound();

  const role = await currentRole();
  const canDecide = hasPermission(role, "approvals:decide");
  const items = await loadInboxItems(inbox);

  // Resolve the selection from the loaded rows, or a scoped by-id fetch for
  // a deep link beyond page 1. A bad, stale, or foreign ?item resolves to
  // null and falls back to the placeholder -- never a crash, never the
  // wrong detail view.
  const selected = await resolveSelected(selectedId, items, inbox);

  // Advance target for a decision (A2, GH-30), only meaningful when the
  // selected item is the interactive (pending) card. Looked up from the DB
  // so it is correct even for a deep-linked pending item beyond page 1.
  const advanceHref =
    selected != null && selected.status === "pending_approval"
      ? await advanceHrefFor(selected, inbox.slug)
      : undefined;

  return (
    <div className="page page--inbox">
      <header className="page-head">
        <h1>{inbox.title}</h1>
        <p>{inbox.blurb}</p>
      </header>

      {/* has-selection drives the A7 mobile flow (GH-35): at phone width
          the list and the detail alternate as full-screen views, keyed off
          whether ?item resolved. Desktop ignores the class entirely. */}
      <div className={`list-detail${selected ? " has-selection" : ""}`}>
        <div className="list-pane" aria-label={`${inbox.title} list`}>
          {selected == null ? <ListScrollRestore /> : null}
          {items.length === 0 ? (
            <ListEmpty inbox={inbox} />
          ) : (
            items.map((it) => {
              const id = String(it.id);
              return (
                <ItemRow
                  key={id}
                  row={toRow(it)}
                  href={`/items/${inbox.slug}?item=${encodeURIComponent(id)}`}
                  active={selected != null && String(selected.id) === id}
                />
              );
            })
          )}
        </div>

        <div className="detail-pane">
          {selected ? (
            <MobileBackBar href={`/items/${inbox.slug}`} label={inbox.label} />
          ) : null}
          {selected ? (
            <Detail
              item={selected}
              canDecide={canDecide}
              advanceHref={advanceHref}
            />
          ) : (
            <DetailPlaceholder hasItems={items.length > 0} />
          )}
        </div>
      </div>
    </div>
  );
}
