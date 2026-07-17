/**
 * Assignee routing registry (GH-95, ARCHITECTURE.md "Assignment &
 * routing"): the categories the AI may sort an inbound email into, each
 * with a default owner. The AI SUGGESTS a category; a human confirms in the
 * console (locked decision in CLAUDE.md: "AI suggests an assignee, human
 * confirms. No auto-assign in v1"). Nothing here assigns anything.
 *
 * Registry-style like tags.ts and the console inboxes: adding a route later
 * is additive (append an entry); the classifier prompt and the console
 * suggestion chip both derive from this list.
 *
 * The default owner is a display NAME, matched case-insensitively against
 * the live Clerk-sourced assignable users in the console; when no eligible
 * user matches (a name change, a not-yet-invited person), the suggestion
 * still shows as information and the operator assigns by hand. This keeps
 * the mapping owned here, not hardcoded to Clerk ids that churn.
 */

export interface RouteDefinition {
  /** Stable id stored on payloads and returned by the classifier. */
  id: string;
  /** Default owner's display name (matched to a Clerk user in the console). */
  defaultOwner: string;
  /** What belongs under this route; verbatim guidance for the classifier. */
  description: string;
}

export const ROUTING_REGISTRY: readonly RouteDefinition[] = [
  {
    id: "billing",
    defaultOwner: "Pete",
    description:
      "Payments, refunds, charges, receipts, membership billing, account balances, and money questions in either direction.",
  },
  {
    id: "schedule",
    defaultOwner: "Alison",
    description:
      "Class schedule, bookings, cancellations, waitlists, instructors, substitutions, and anything about who teaches what and when.",
  },
  {
    id: "finance",
    defaultOwner: "Brooke",
    description:
      "Ownership, investors, high-level business finance, accounting, legal, leases, and vendor contracts (not day-to-day customer billing).",
  },
  {
    id: "general",
    defaultOwner: "",
    description:
      "Anything that does not clearly fit the routes above: general questions, feedback, new-student inquiries, or unclear intent. Leave for manual triage.",
  },
] as const;

const ROUTE_IDS = new Set(ROUTING_REGISTRY.map((r) => r.id));

/** Whether a route id is in the registry. */
export function isKnownRoute(id: string): boolean {
  return ROUTE_IDS.has(id);
}

/** The default owner name for a route, or "" (general / unknown). */
export function routeOwner(id: string): string {
  return ROUTING_REGISTRY.find((r) => r.id === id)?.defaultOwner ?? "";
}

/** A suggested assignee, stored on the item payload as assignee_suggestion. */
export interface AssigneeSuggestion {
  /** The classified route id (registry member). */
  category: string;
  /** Default owner display name for the route ("" when general/none). */
  suggestedName: string;
  /** One short sentence on why, from the classifier. */
  reason: string;
  /** ISO timestamp the suggestion was made. */
  at: string;
}

/**
 * Validate an untrusted payload.assignee_suggestion into a clean object, or
 * null. Only registry categories survive (the model cannot invent routes);
 * an empty/general suggestion with no owner is still returned so the reason
 * can show. Never throws. Used by the console suggestion chip.
 */
export function sanitizeSuggestion(raw: unknown): AssigneeSuggestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as {
    category?: unknown;
    suggestedName?: unknown;
    reason?: unknown;
    at?: unknown;
  };
  if (typeof r.category !== "string") return null;
  const category = r.category.trim().toLowerCase();
  if (!isKnownRoute(category)) return null;
  return {
    category,
    // Trust the registry's owner over any stored name, so a routing change
    // takes effect for old items too.
    suggestedName: routeOwner(category),
    reason: typeof r.reason === "string" ? r.reason.trim() : "",
    at: typeof r.at === "string" ? r.at : "",
  };
}
