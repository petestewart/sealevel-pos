/**
 * Tag registry (GH-65): the single extensible list of categories the AI
 * may assign to an inbound email. Registry-style like the console's
 * inboxes: adding a tag later is additive (append an entry here); the
 * classifier prompt, payload validation, and console chips all derive
 * from this list, so no other site needs editing.
 *
 * Groundwork: tags will later feed assignee routing and inbox filters,
 * so the payload shape stays query-friendly (payload.tags is an array of
 * { tag, confidence? } objects; `payload->'tags'` is directly filterable
 * in SQL with jsonb containment).
 */

export interface TagDefinition {
  /** Stable id stored on payloads. Lowercase, no spaces. */
  id: string;
  /** Chip label shown in the console. */
  label: string;
  /** What belongs under this tag; verbatim guidance for the classifier. */
  description: string;
}

export const TAG_REGISTRY: readonly TagDefinition[] = [
  {
    id: "customer",
    label: "Customer",
    description:
      "A current or prospective student or client: class questions, memberships, pricing, bookings, feedback, complaints.",
  },
  {
    id: "vendor",
    label: "Vendor",
    description:
      "A supplier or service provider: invoices from suppliers, deliveries, maintenance, software or utility providers.",
  },
  {
    id: "spam",
    label: "Spam",
    description:
      "Unsolicited marketing, cold outreach, phishing, or bulk mail with no business relevance.",
  },
  {
    id: "billing",
    label: "Billing",
    description:
      "Money matters in either direction: payment issues, refunds, charges, receipts, account balances.",
  },
  {
    id: "staff",
    label: "Staff",
    description:
      "From or about employees or teachers: scheduling, substitutions, payroll questions, internal matters.",
  },
  {
    id: "other",
    label: "Other",
    description: "Legitimate mail that fits none of the categories above.",
  },
] as const;

const TAG_IDS = new Set(TAG_REGISTRY.map((t) => t.id));

/** One assigned tag on an item payload (payload.tags entries). */
export interface ItemTag {
  tag: string;
  /** Classifier confidence, 0..1, when the model provided one. */
  confidence?: number;
}

/** Whether a tag id is in the registry. */
export function isKnownTag(id: string): boolean {
  return TAG_IDS.has(id);
}

/**
 * Validate an untrusted payload.tags value into clean ItemTag entries:
 * only registry tags survive (the model cannot invent categories), each
 * at most once, confidence coerced to a 0..1 number or dropped. Order of
 * first appearance is preserved. Never throws.
 */
export function sanitizeTags(raw: unknown): ItemTag[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ItemTag[] = [];
  for (const entry of raw) {
    let tag: string | undefined;
    let confidence: number | undefined;
    if (typeof entry === "string") {
      tag = entry;
    } else if (typeof entry === "object" && entry !== null) {
      const e = entry as { tag?: unknown; confidence?: unknown };
      if (typeof e.tag === "string") tag = e.tag;
      if (typeof e.confidence === "number" && Number.isFinite(e.confidence)) {
        confidence = Math.min(1, Math.max(0, e.confidence));
      }
    }
    if (!tag) continue;
    const id = tag.trim().toLowerCase();
    if (!isKnownTag(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(confidence === undefined ? { tag: id } : { tag: id, confidence });
  }
  return out;
}

/** Chip label for a tag id; falls back to the id for unknown values. */
export function tagLabel(id: string): string {
  return TAG_REGISTRY.find((t) => t.id === id)?.label ?? id;
}
