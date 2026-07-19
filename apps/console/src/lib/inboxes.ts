import type { ItemStatusCounts } from "@ai-manager/core";
import type { DecisionAction, DecisionCounts } from "./approvals";

/**
 * Inbox registry (same plug-in philosophy as the widget and jobs
 * registries, A1b): the sidebar renders one entry per inbox listed here,
 * and /items/[status] resolves its slug against this list. Adding a
 * future inbox (a new item type or view) means adding an entry, not
 * restructuring routes or the sidebar.
 */

/** Everything the sidebar needs for the two count queries, prefetched once. */
export interface InboxCounts {
  statuses: ItemStatusCounts;
  decisions: DecisionCounts;
}

export type InboxTone = "pending" | "approved" | "rejected" | "noreply";

/**
 * Icon shown for the inbox when the sidebar is collapsed to a rail
 * (GH-77). Names map to inline SVGs in InboxSidebar; a new inbox picks an
 * existing glyph or adds one there.
 */
export type InboxIcon = "clock" | "check" | "x" | "bell-off";

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
 *
 * Adding a future source (a new item type, an assignee queue) means adding
 * a variant here and a matching branch in the route -- a TypeScript
 * exhaustiveness check makes the missing branch a compile error, never a
 * silent fall-through.
 */
export type InboxSource =
  | { kind: "pending" }
  | { kind: "decision"; decision: DecisionAction };

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
];

export function inboxBySlug(slug: string): InboxDefinition | undefined {
  return INBOXES.find((inbox) => inbox.slug === slug);
}
