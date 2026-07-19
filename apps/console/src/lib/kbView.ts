import {
  getItemById,
  kbProposalOf,
  kbWriteOf,
  type Item,
  type KbProposal,
  type KbWriteRecord,
} from "@ai-manager/core";
import {
  formatCardTimestamp,
  formatDateTime,
} from "./emailDisplay";
import { classifyDecision, isArchived, isTrashed, str } from "./itemView";

/**
 * View-model helpers for kb_update items (KB write-back epic GH-114): the
 * pending proposal card (GH-112) and the decided/Knowledge detail
 * (GH-113) both derive from the same validated shape here, mirroring how
 * itemView.ts serves the email card.
 */

/** Serializable card data for a kb_update item (pending or decided). */
export interface KbCardData {
  id: string;
  targetPage: string;
  changeKind: "edit" | "new_page";
  summary: string;
  rationale: string;
  baseContent: string;
  proposedContent: string;
  /** True when a human edited the proposed content before deciding. */
  edited: boolean;
  receivedTime: string;
  receivedFull: string;
  /** Detector confidence (0..1), or null (rollback / manual proposals). */
  confidence: number | null;
  /** Source email display bits, or null (e.g. rollback proposals). */
  source: { from: string | null; subject: string | null; itemId: string | null } | null;
  /** The written kb_update item this proposal reverts, or null. */
  revertOfItemId: string | null;
  /** The write outcome (payload.kb_write), or null (not yet decided/queued). */
  kbWrite: KbWriteRecord | null;
}

/** Validated proposal from an item, or null when malformed. */
export function kbProposalOfItem(item: Item): KbProposal | null {
  return kbProposalOf(item.payload);
}

export function toKbCardData(item: Item): KbCardData | null {
  const proposal = kbProposalOf(item.payload);
  if (!proposal) return null;
  const source = item.payload["source"] as Record<string, unknown> | undefined;
  const from = str(source?.["from"]) ?? null;
  const subject = str(source?.["subject"]) ?? null;
  const sourceItemId = str(source?.["item_id"]) ?? null;
  const revertOf = str(source?.["revert_of_item_id"]) ?? null;
  const detector = item.payload["detector"] as
    | { confidence?: unknown }
    | undefined;
  const confidence =
    typeof detector?.confidence === "number" &&
    Number.isFinite(detector.confidence)
      ? detector.confidence
      : null;
  return {
    id: String(item.id),
    targetPage: proposal.target_page,
    changeKind: proposal.change_kind,
    summary: proposal.summary,
    rationale: proposal.rationale,
    baseContent: proposal.base_content,
    proposedContent: proposal.proposed_content,
    edited: item.payload["proposal_edited"] === true,
    receivedTime: formatCardTimestamp(item.created_at),
    receivedFull: formatDateTime(item.created_at),
    confidence,
    source:
      from || subject || sourceItemId
        ? { from, subject, itemId: sourceItemId }
        : null,
    revertOfItemId: revertOf,
    kbWrite: kbWriteOf(item.payload),
  };
}

/**
 * Deep link to the inbox where a referenced item currently lives, or null
 * when it is unreachable (archived, missing). One by-id fetch; used to
 * link a kb_update card to its source email item (and a revert proposal
 * to the update it reverts) wherever that item has since moved: still
 * pending, decided into Approved/Rejected/No reply, trashed, or (for
 * kb_update sources) the Knowledge inbox.
 */
export async function itemInboxHref(itemId: string): Promise<string | null> {
  let item: Item | null;
  try {
    item = await getItemById(itemId);
  } catch {
    return null;
  }
  if (!item || isArchived(item)) return null;
  const query = `?item=${encodeURIComponent(String(item.id))}`;
  if (item.type === "kb_update") return `/items/knowledge${query}`;
  if (isTrashed(item)) return `/items/trash${query}`;
  if (item.status === "pending_approval") return `/items/pending${query}`;
  if (item.status === "resolved" && item.type === "email_reply") {
    switch (classifyDecision(item.payload)) {
      case "approved":
        return `/items/approved${query}`;
      case "rejected":
        return `/items/rejected${query}`;
      case "no_reply_needed":
        return `/items/no-reply${query}`;
      case "trashed":
      case "spam":
        return `/items/trash${query}`;
    }
  }
  return null;
}

/**
 * Operator-facing copy for a kb_write outcome (no em dashes). The stale
 * copy documents the recovery flow: a stale proposal is not blindly
 * retryable, since its base no longer matches the page; the honest path
 * is a fresh proposal (the detector will re-propose when the fact next
 * surfaces, or use Propose revert on the conflicting write).
 */
export function kbWriteStatusCopy(record: KbWriteRecord | null): {
  tone: "pending" | "ok" | "warn" | "error";
  text: string;
} {
  if (!record) {
    return {
      tone: "pending",
      text: "Not written. The write runs after this proposal is approved.",
    };
  }
  switch (record.status) {
    case "queued":
      return {
        tone: "pending",
        text: "Write queued. The worker is committing this update to the knowledge base.",
      };
    case "written":
      return {
        tone: "ok",
        text: `Written to the knowledge base${
          record.new_hash ? ` (content hash ${record.new_hash.slice(0, 12)})` : ""
        }.`,
      };
    case "stale":
      return {
        tone: "warn",
        text:
          "Not written: the page changed after this proposal was created, so writing it would overwrite someone else's change. Nothing was written. Review the current page and file a fresh proposal if the update still applies.",
      };
    case "denied":
      return {
        tone: "error",
        text: `Not written: the server refused this write. ${record.error ?? ""}`.trim(),
      };
    case "failed":
      return {
        tone: "error",
        text: `Write failed. ${record.error ?? ""} Reopen and approve again to retry.`.replace(/\s+/g, " "),
      };
    case "skipped":
      return {
        tone: "warn",
        text:
          record.error ??
          "Not written: the KB writer token is not configured. Reopen and approve again after configuring it.",
      };
  }
}
