import type { ItemStatusCounts } from "@ai-manager/core";
import type { DecisionAction, DecisionCounts } from "./approvals";

/**
 * Inbox registry (same plug-in philosophy as the widget and jobs
 * registries, A1b): the sidebar renders one entry per inbox listed here,
 * and /items/[status] resolves its slug against this list. Adding a
 * future inbox (a new item type or view) means adding an entry, not
 * restructuring routes or the sidebar.
 */

/** Everything the sidebar needs for the count queries, prefetched once. */
export interface InboxCounts {
  statuses: ItemStatusCounts;
  decisions: DecisionCounts;
  /** Trashed items (trash + spam decisions), keyed on payload.trashed. */
  trashed: number;
  /** Approved replies waiting for release (GH-106), no delivery record. */
  staged: number;
  /** Pending kb_update proposals (KB write-back, GH-112). */
  knowledgePending: number;
}

export type InboxTone =
  | "pending"
  | "approved"
  | "rejected"
  | "noreply"
  | "trashed";

/**
 * Icon shown for the inbox when the sidebar is collapsed to a rail
 * (GH-77). Names map to inline SVGs in InboxSidebar; a new inbox picks an
 * existing glyph or adds one there.
 */
export type InboxIcon =
  | "clock"
  | "check"
  | "x"
  | "bell-off"
  | "ban"
  | "send"
  | "book";

/**
 * Each inbox declares HOW its body is fetched and rendered, rather than
 * the route inferring it from the slug (A1b: "registry accepts future
 * entries"). The route dispatches on `source.kind`, so a new registry
 * entry MUST name its own source; there is no default that would silently
 * render another inbox's contents.
 *
 * - `pending`: the approval-card list (items awaiting a decision) plus the
 *   recently decided tail.
 * - `decision`: resolved email replies for one decision (Approved or
 *   Rejected), rendered as decided rows.
 * - `trash`: trashed items (trash + spam decisions, GH-115 follow-on),
 *   keyed on payload.trashed rather than a decision class so both discard
 *   flavors share one reviewable view with a Restore affordance.
 *
 * Adding a future source (a new item type, an assignee queue) means adding
 * a variant here and a matching branch in the route -- a TypeScript
 * exhaustiveness check makes the missing branch a compile error, never a
 * silent fall-through.
 */
export type InboxSource =
  | { kind: "pending" }
  | { kind: "decision"; decision: DecisionAction }
  | { kind: "trash" }
  /**
   * Approved replies waiting for release (GH-106): approved items whose
   * delivery was never queued. The review queue's home; releasing (Send
   * approved) queues delivery and the item leaves this view for Approved.
   */
  | { kind: "staged" }
  /**
   * Knowledge base write-back (GH-112/GH-113): every kb_update item,
   * pending proposals first for review and decided ones beneath them with
   * their write outcome and provenance -- the "recent committed writes"
   * view the audit ticket calls for, plus the Propose revert affordance.
   */
  | { kind: "knowledge" };

export interface InboxDefinition {
  /** URL segment: /items/<slug>. */
  slug: string;
  /** Sidebar label. */
  label: string;
  /** Status-dot color in the sidebar, from the semantic status palette. */
  tone: InboxTone;
  /** Glyph for the collapsed icon rail (GH-77). */
  icon: InboxIcon;
  /** Page heading. */
  title: string;
  /** Page subheading. */
  blurb: string;
  /** How this inbox's body is fetched and rendered. */
  source: InboxSource;
  /** Live count for the sidebar pill. */
  count: (counts: InboxCounts) => number;
}

export const INBOXES: readonly InboxDefinition[] = [
  {
    slug: "pending",
    label: "Pending",
    tone: "pending",
    icon: "clock",
    title: "Pending approvals",
    blurb:
      "AI-drafted email replies awaiting your decision. Nothing is sent automatically in v1.",
    source: { kind: "pending" },
    count: ({ statuses }) => statuses.pending_approval,
  },
  {
    slug: "approved",
    label: "Approved",
    tone: "approved",
    icon: "check",
    title: "Approved",
    blurb: "Replies you approved, newest decision first.",
    source: { kind: "decision", decision: "approved" },
    count: ({ decisions }) => decisions.approved,
  },
  {
    slug: "queue",
    label: "Approved queue",
    tone: "approved",
    icon: "send",
    title: "Approved queue",
    blurb:
      "Approved replies waiting for release. Nothing here goes out until you release it: use Send approved to release everything, or release items one at a time. Approvals land here when your settings queue approved replies.",
    source: { kind: "staged" },
    count: ({ staged }) => staged,
  },
  {
    slug: "rejected",
    label: "Rejected",
    tone: "rejected",
    icon: "x",
    title: "Rejected",
    blurb: "Drafts you rejected. Nothing was sent for these.",
    source: { kind: "decision", decision: "rejected" },
    count: ({ decisions }) => decisions.rejected,
  },
  {
    slug: "no-reply",
    label: "No reply",
    tone: "noreply",
    icon: "bell-off",
    title: "No reply needed",
    blurb:
      "Emails filed as not needing a reply, like automated notifications and receipts. Nothing was drafted or sent; each shows why it was filed.",
    source: { kind: "decision", decision: "no_reply_needed" },
    count: ({ decisions }) => decisions.no_reply_needed,
  },
  {
    slug: "knowledge",
    label: "Knowledge",
    tone: "pending",
    icon: "book",
    title: "Knowledge base",
    blurb:
      "Proposed knowledge base updates and their write history. A proposal only reaches the wiki after you approve it here; rolling back a written change files a new proposal through the same gate.",
    source: { kind: "knowledge" },
    count: ({ knowledgePending }) => knowledgePending,
  },
  {
    slug: "trash",
    label: "Trash",
    tone: "trashed",
    icon: "ban",
    title: "Trash",
    blurb:
      "Emails you trashed or confirmed as spam. Nothing was sent; items here can be restored. Confirming spam also teaches the system to flag that sender next time.",
    source: { kind: "trash" },
    count: ({ trashed }) => trashed,
  },
];

export function inboxBySlug(slug: string): InboxDefinition | undefined {
  return INBOXES.find((inbox) => inbox.slug === slug);
}
