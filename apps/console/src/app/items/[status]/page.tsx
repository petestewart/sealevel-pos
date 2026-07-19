import { notFound } from "next/navigation";
import {
  getItemById,
  gmailSendEnabled,
  gmailSendMode,
  type Item,
} from "@ai-manager/core";
import { ApprovalCard } from "../../../components/ApprovalCard";
import { DecidedDetail } from "../../../components/DecidedDetail";
import { ItemRow } from "../../../components/ItemRow";
import { ListDetailShell } from "../../../components/ListDetailShell";
import { ListScrollRestore } from "../../../components/ListScrollRestore";
import { MobileBackBar } from "../../../components/MobileBackBar";
import { RecentlyDecidedSection } from "../../../components/RecentlyDecidedSection";
import { currentRole, hasPermission } from "../../../lib/rbac";
import {
  adjacentPendingId,
  decidedItems,
  decisionCounts,
  pendingApprovals,
  recentlyDecided,
  trashedItems,
} from "../../../lib/approvals";
import { inboxBySlug, type InboxDefinition } from "../../../lib/inboxes";
import {
  effectiveSignoffDefault,
  type SignoffDefault,
} from "../../../lib/signoff";
import { assignableUsers, type AssignableUser } from "../../../lib/assignees";
import {
  classifyDecision,
  isArchived,
  isTrashed,
  toCardData,
  toRow,
} from "../../../lib/itemView";
import { ClearRejectedButton } from "../../../components/ClearRejectedButton";

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

/**
 * How many recently decided items trail the pending list (GH-54). Small on
 * purpose: enough that a just-decided item stays visible after the
 * decision, not so many that Pending reads as an everything-view.
 */
const RECENT_TAIL_LIMIT = 3;

/** All items an inbox lists, in display order (newest-relevant first). */
async function loadInboxItems(inbox: InboxDefinition): Promise<Item[]> {
  const source = inbox.source;
  switch (source.kind) {
    case "pending": {
      // Pending list = items awaiting a decision, then the recently
      // decided tail (GH-28). Both are selectable; the detail pane picks
      // the renderer from each item's status. This is what lets a just-
      // approved item stay visible (and selected) after the decision.
      // The tail is capped and rendered under a "Recently decided"
      // divider (GH-54) so Pending doesn't read as showing everything.
      const [pending, decided] = await Promise.all([
        pendingApprovals(),
        recentlyDecided(RECENT_TAIL_LIMIT),
      ]);
      return [...pending, ...decided];
    }
    case "decision":
      return decidedItems(source.decision);
    case "trash":
      // Trashed AND spam items share the Trash view (both carry the
      // payload.trashed marker), newest discard first.
      return trashedItems();
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
        : inbox.slug === "no-reply"
          ? "Emails filed as not needing a reply will appear here."
          : inbox.slug === "trash"
            ? "Emails you trash or confirm as spam will appear here."
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
 * whose decision classification (the ONE `classifyDecision` rule) matches
 * the route. An id that doesn't exist, or belongs
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
  // Archived items (GH-55) are hidden from every inbox; a deep link to
  // one falls back to the placeholder, never a detail view. Trashed items
  // (GH-115 follow-on) belong ONLY to the Trash inbox.
  if (isArchived(item)) return false;
  const source = inbox.source;
  if (source.kind !== "trash" && isTrashed(item)) return false;
  switch (source.kind) {
    case "pending":
      return item.status === "pending_approval";
    case "decision":
      // Three-way membership (GH-115): the item's canonical classification
      // (the ONE classifyDecision rule) must equal this inbox's decision.
      return (
        item.status === "resolved" &&
        item.type === "email_reply" &&
        classifyDecision(item.payload) === source.decision
      );
    case "trash":
      return isTrashed(item);
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
  signoffDefault,
  assignees,
}: {
  item: Item;
  canDecide: boolean;
  advanceHref?: string;
  signoffDefault?: SignoffDefault;
  assignees: AssignableUser[];
}) {
  if (item.status === "pending_approval") {
    return (
      <ApprovalCard
        assignees={assignees}
        sendEnabled={gmailSendEnabled()}
        sendMode={gmailSendMode()}
        // Keyed by item id so client state (edit mode, typed draft text)
        // resets when the selection changes. Without this, auto-advance
        // after a decide reuses the component instance and the NEXT item
        // renders mid-edit with the PREVIOUS item's subject/body staged.
        key={item.id}
        item={toCardData(item)}
        canDecide={canDecide}
        advanceHref={advanceHref}
        signoffDefault={signoffDefault}
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

  // Assignable users for the header picker (GH-79); only fetched when the
  // detail pane will render an interactive pending card.
  const assignees =
    selected != null && selected.status === "pending_approval" && canDecide
      ? await assignableUsers()
      : [];

  // Advance target for a decision (A2, GH-30), only meaningful when the
  // selected item is the interactive (pending) card. Looked up from the DB
  // so it is correct even for a deep-linked pending item beyond page 1.
  const advanceHref =
    selected != null && selected.status === "pending_approval"
      ? await advanceHrefFor(selected, inbox.slug)
      : undefined;

  // Preselection for the per-email signoff picker (GH-76): the deciding
  // user's effective global setting. Only looked up when the interactive
  // card will actually render.
  const signoffDefault =
    canDecide && selected != null && selected.status === "pending_approval"
      ? await effectiveSignoffDefault()
      : undefined;

  return (
    <div className="page page--inbox">
      <header className="page-head">
        <h1>{inbox.title}</h1>
        <p>{inbox.blurb}</p>
      </header>

      {/* has-selection drives the A7 mobile flow (GH-35): at phone width
          the list and the detail alternate as full-screen views, keyed off
          whether ?item resolved. The shell also owns the desktop full-width
          expand state (GH-78); both panes stay server-rendered. */}
      <ListDetailShell
        hasSelection={selected != null}
        list={
          <div className="list-pane" aria-label={`${inbox.title} list`}>
          {inbox.slug === "rejected" && canDecide && items.length > 0 ? (
            <div className="list-toolbar">
              <ClearRejectedButton count={(await decisionCounts()).rejected} />
            </div>
          ) : null}
          {selected == null ? <ListScrollRestore /> : null}
          {items.length === 0 ? (
            <ListEmpty inbox={inbox} />
          ) : (
            (() => {
              // In the pending inbox, everything after the pending block is
              // the recently-decided tail (GH-28/GH-54): loadInboxItems
              // appends it, so status is the split. The tail renders muted
              // inside a collapsible section (GH-64); other inboxes have no
              // tail and render a flat list.
              const isTail = (it: Item) =>
                inbox.source.kind === "pending" &&
                it.status !== "pending_approval";
              const head = items.filter((it) => !isTail(it));
              const tail = items.filter(isTail);
              const row = (it: Item, muted: boolean) => {
                const id = String(it.id);
                return (
                  <ItemRow
                    key={id}
                    row={toRow(it)}
                    href={`/items/${inbox.slug}?item=${encodeURIComponent(id)}`}
                    active={selected != null && String(selected.id) === id}
                    muted={muted}
                  />
                );
              };
              return (
                <>
                  {head.map((it) => row(it, false))}
                  {tail.length > 0 ? (
                    <RecentlyDecidedSection
                      count={tail.length}
                      autoExpand={
                        selected != null && isTail(selected)
                      }
                    >
                      {tail.map((it) => row(it, true))}
                    </RecentlyDecidedSection>
                  ) : null}
                </>
              );
            })()
          )}
        </div>
        }
        detail={
          <>
            {selected ? (
              <MobileBackBar
                href={`/items/${inbox.slug}`}
                label={inbox.label}
              />
            ) : null}
            {selected ? (
              <Detail
                item={selected}
                canDecide={canDecide}
                advanceHref={advanceHref}
                assignees={assignees}
                signoffDefault={signoffDefault}
              />
            ) : (
              <DetailPlaceholder hasItems={items.length > 0} />
            )}
          </>
        }
      />
    </div>
  );
}
