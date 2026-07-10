import type { Item } from "@ai-manager/core";
import type { ApprovalCardData } from "../components/ApprovalCard";
import type { DecisionRecord } from "./approvals";
import {
  formatDateTime,
  formatTime,
  formatDecidedAt,
  humanizeType,
  initialsOf,
  parseSender,
} from "./emailDisplay";
import { parseAttachments } from "./emailText";

/**
 * Shared view-model helpers for the list/detail inbox (A1c, GH-29). Both
 * the compact list row and the detail pane derive from the same Item, so
 * the mapping lives here rather than being duplicated per renderer.
 */

interface OriginalEmail {
  from?: string;
  subject?: string;
  body?: string;
  attachments?: unknown;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function originalOf(item: Item): OriginalEmail {
  return (item.payload.original_email ?? {}) as OriginalEmail;
}

/**
 * Map an item to the ApprovalCard's data shape (moved here from the inbox
 * route so DecidedDetail can reuse the exact same field derivation). For a
 * decided item the draft_* fields already hold the final/edited reply, so
 * this doubles as the decided read view's source.
 */
export function toCardData(item: Item): ApprovalCardData {
  const payload = item.payload;
  const original = originalOf(item);
  const sender = parseSender(str(original.from));
  return {
    id: String(item.id),
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
    rationale: str(payload.draft_rationale)?.trim() || null,
  };
}

/** Decision audit record on a resolved item, or null (legacy / missing). */
export function decisionOf(item: Item): DecisionRecord | null {
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

/**
 * THE canonical approved/rejected classifier for a resolved item's payload.
 * Every site that decides "which decision inbox does this belong to" -- the
 * SQL (decidedItems/decisionCounts REJECTED_SQL in approvals.ts), inbox
 * membership (belongsToInbox), row tone, and the decided detail title --
 * routes through this one rule so they can never disagree on an edge case
 * (GH-29 QA: a partial `{action:"rejected"}` was once counted rejected by
 * SQL but shown approved by the old full-audit check).
 *
 * Rule, byte-for-byte matching REJECTED_SQL:
 *   - legacy bare string "rejected"                -> rejected
 *   - any object with action === "rejected"
 *     (full audit record OR partial, by/at absent) -> rejected
 *   - everything else resolved (approved object,
 *     legacy bare "approved", missing decision,
 *     any other partial)                           -> approved
 *
 * SQL equivalence (approvals.ts REJECTED_SQL):
 *   (jsonb_typeof(payload->'decision')='string' AND payload->>'decision'='rejected')
 *   -> the bare-string branch;
 *   OR payload->'decision'->>'action'='rejected'
 *   -> the object branch (->> yields NULL for a bare string or missing key,
 *      so only an explicit action='rejected' matches). coalesce(...,false)
 *      makes every other resolved row approved. Identical to the below.
 */
export function classifyDecision(
  payload: Record<string, unknown>,
): "approved" | "rejected" {
  const d = payload.decision;
  if (typeof d === "string") return d === "rejected" ? "rejected" : "approved";
  if (
    typeof d === "object" &&
    d !== null &&
    (d as { action?: unknown }).action === "rejected"
  ) {
    return "rejected";
  }
  return "approved";
}

/** Whether a resolved item was approved (canonical rule). */
export function isApproved(item: Item): boolean {
  return classifyDecision(item.payload) === "approved";
}

export type RowTone = "pending" | "approved" | "rejected";

/** Semantic tone for a row's status dot, derived from item state. */
export function toneOf(item: Item): RowTone {
  if (item.status === "pending_approval") return "pending";
  return isApproved(item) ? "approved" : "rejected";
}

/** One-line, collapsed preview of the inbound message for a list row. */
export function previewOf(item: Item, max = 120): string {
  const body = str(originalOf(item).body) ?? "";
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "No message body";
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Compact list-row view model. */
export interface RowView {
  id: string;
  sender: string;
  initials: string;
  subject: string;
  time: string;
  preview: string;
  tone: RowTone;
}

export function toRow(item: Item): RowView {
  const original = originalOf(item);
  const sender = parseSender(str(original.from));
  const tone = toneOf(item);
  // Pending rows show arrival time; decided rows show the decision time.
  const decided = tone !== "pending";
  const time =
    decided && item.resolved_at
      ? formatDecidedAt(item.resolved_at)
      : formatTime(item.created_at);
  return {
    id: String(item.id),
    sender: sender.name,
    initials: initialsOf(sender.name),
    subject: str(original.subject)?.trim() || "(no subject)",
    time,
    preview: previewOf(item),
    tone,
  };
}
