import {
  sanitizeSuggestion,
  sanitizeTags,
  tagLabel,
  type AssigneeSuggestion,
  type DeliveryRecord,
  type DeliveryStatus,
  type Item,
} from "@ai-manager/core";
import type { ApprovalCardData } from "../components/ApprovalCard";
import type {
  RunTraceCallData,
  RunTraceData,
} from "../components/RunTrace";
import type { DecisionRecord } from "./approvals";
import {
  formatDateTime,
  formatCardTimestamp,
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
/** Prior drafts from payload.draft_revisions (GH-36), oldest first. */
function revisionsOf(payload: Record<string, unknown>) {
  const raw = payload.draft_revisions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const e = entry as {
      draft_subject?: unknown;
      draft_body?: unknown;
      revised_at?: unknown;
    };
    const body = str(e.draft_body);
    if (!body) return [];
    const at = typeof e.revised_at === "string" ? new Date(e.revised_at) : null;
    return [
      {
        subject: str(e.draft_subject) ?? "(no subject)",
        body,
        revisedAt:
          at !== null && !Number.isNaN(at.getTime()) ? formatDateTime(at) : "",
      },
    ];
  });
}

/**
 * Deploy-version stamp (GH-122) from payload.generated_by: which worker
 * build produced the current draft, written structurally by the draft and
 * revise jobs. Null for items that predate the stamp or a malformed value;
 * null renders nothing (back-compat). The timestamp is pre-formatted for
 * display; a missing/invalid `at` yields an empty string.
 */
function generatedByOf(payload: Record<string, unknown>) {
  const raw = payload.generated_by as
    | { commit?: unknown; at?: unknown }
    | undefined;
  const commit = str(raw?.commit);
  if (!commit) return null;
  const at = typeof raw?.at === "string" ? new Date(raw.at) : null;
  return {
    commit,
    at: at !== null && !Number.isNaN(at.getTime()) ? formatDateTime(at) : "",
  };
}

/** Strings only, deduplicated; anything else in the array is dropped. */
function strArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string"))];
}

const TRACE_OUTCOMES = ["ok", "empty", "error"] as const;

/** A non-negative finite number, or null. */
function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Run trace (GH-122) from payload.run_trace, validated into the display
 * shape, or null for items that predate it or a malformed value (null
 * renders nothing; back-compat like generated_by). Untrusted payload data:
 * malformed entries are dropped, unknown outcomes discard the entry, and
 * only expected primitives pass through. The run's cost summary comes
 * from payload.usage (GH-62), written by the same run's recordUsage hook.
 */
export function runTraceOf(
  payload: Record<string, unknown>,
): RunTraceData | null {
  const raw = payload.run_trace as
    | {
        calls?: unknown;
        dropped_calls?: unknown;
        toolset?: unknown;
        guidance?: unknown;
        degraded?: unknown;
        model?: unknown;
      }
    | undefined;
  if (typeof raw !== "object" || raw === null) return null;
  const calls: RunTraceCallData[] = Array.isArray(raw.calls)
    ? raw.calls.flatMap((entry) => {
        const e = entry as {
          tool?: unknown;
          ref?: unknown;
          outcome?: unknown;
          error?: unknown;
          result_chars?: unknown;
          duration_ms?: unknown;
        };
        const tool = str(e.tool);
        const outcome = (TRACE_OUTCOMES as readonly unknown[]).includes(
          e.outcome,
        )
          ? (e.outcome as RunTraceCallData["outcome"])
          : null;
        if (!tool || !outcome) return [];
        return [
          {
            tool,
            ref: str(e.ref) ?? "",
            outcome,
            error: outcome === "error" ? (str(e.error) ?? null) : null,
            resultChars: numOf(e.result_chars),
            durationMs: numOf(e.duration_ms),
          },
        ];
      })
    : [];
  const toolset = strArrayOf(raw.toolset);
  const guidance = strArrayOf(raw.guidance);
  const degraded = strArrayOf(raw.degraded);
  // An object with nothing displayable renders no section at all.
  if (
    calls.length === 0 &&
    toolset.length === 0 &&
    guidance.length === 0 &&
    degraded.length === 0
  ) {
    return null;
  }
  const usage = payload.usage as
    | { api_calls?: unknown; input_tokens?: unknown; output_tokens?: unknown }
    | undefined;
  const apiCalls = numOf(usage?.api_calls);
  const inputTokens = numOf(usage?.input_tokens);
  const outputTokens = numOf(usage?.output_tokens);
  return {
    calls,
    droppedCalls: numOf(raw.dropped_calls) ?? 0,
    toolset,
    guidance,
    degraded,
    model: str(raw.model) ?? null,
    usage:
      apiCalls !== null && inputTokens !== null && outputTokens !== null
        ? { apiCalls, inputTokens, outputTokens }
        : null,
  };
}

/**
 * Eval-case capture record (GH-128) from payload.eval_capture, validated
 * into a display shape, or null when absent/malformed (renders nothing;
 * back-compat like the trace). Written by the eval.capture worker job:
 * either a finished case (serialized here for the copy/download block) or
 * an honest failure note.
 */
export function evalCaptureOf(payload: Record<string, unknown>): {
  at: string;
  caseJson: string | null;
  fileName: string | null;
  error: string | null;
} | null {
  const raw = payload.eval_capture as
    | { at?: unknown; case?: unknown; error?: unknown }
    | undefined;
  if (typeof raw !== "object" || raw === null) return null;
  const at = str(raw.at);
  if (!at) return null;
  const kase =
    typeof raw.case === "object" && raw.case !== null
      ? (raw.case as Record<string, unknown>)
      : null;
  const caseId = kase ? str(kase.id) : undefined;
  return {
    at,
    caseJson: kase ? JSON.stringify(kase, null, 2) : null,
    fileName: kase ? `${caseId ?? "captured-case"}.json` : null,
    error: str(raw.error) ?? null,
  };
}

/** payload.last_answer (GH-36 Q&A) with both fields present, or null. */
function lastAnswerOf(payload: Record<string, unknown>) {
  const raw = payload.last_answer as
    | { question?: unknown; answer?: unknown }
    | undefined;
  const question = str(raw?.question);
  const answer = str(raw?.answer);
  return question && answer ? { question, answer } : null;
}

/**
 * Chip labels for an item's AI tags (GH-65). Untrusted payload.tags runs
 * through the registry gate (sanitizeTags), so unknown or malformed
 * values render as nothing rather than crashing or showing raw model
 * output; items predating tags simply return [].
 */
export function tagsOf(item: Item): string[] {
  return sanitizeTags(item.payload.tags).map((t) => tagLabel(t.tag));
}

/**
 * Display name for the item's assignee: payload.assignee_name (stored at
 * assignment time, GH-79), falling back to the raw assignee column for
 * rows assigned outside the audited path.
 */
export function assigneeNameOf(item: Item): string | null {
  if (!item.assignee) return null;
  return str(item.payload.assignee_name) ?? item.assignee;
}

const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "queued",
  "sending",
  "sent",
  "drafted",
  "failed",
  "skipped",
];

/**
 * The item's delivery record (GH-95), validated into a known shape, or
 * null when absent/malformed. Written only by the send pipeline
 * (core db/delivery.ts); the console reads it to show real send status on a
 * decided reply instead of the old "nothing is sent" placeholder.
 */
export function deliveryOf(item: Item): DeliveryRecord | null {
  const d = item.payload.delivery as Partial<DeliveryRecord> | undefined;
  if (
    typeof d === "object" &&
    d !== null &&
    typeof d.status === "string" &&
    (DELIVERY_STATUSES as readonly string[]).includes(d.status)
  ) {
    return d as DeliveryRecord;
  }
  return null;
}

/**
 * The item's AI assignee suggestion (GH-95), validated through the routing
 * registry gate, or null. Shown as a one-click suggestion chip on an
 * unassigned pending item; the operator confirms (no auto-assign, per the
 * locked decision).
 */
export function suggestionOf(item: Item): AssigneeSuggestion | null {
  return sanitizeSuggestion(item.payload.assignee_suggestion);
}

/**
 * The suggestion in the card's shape, or null. Only actionable suggestions
 * (a named default owner) are surfaced: a "general" route has no owner and
 * would offer nothing to click, so it is dropped rather than shown as a
 * dead chip.
 */
function suggestionForCard(item: Item): ApprovalCardData["suggestion"] {
  const s = suggestionOf(item);
  if (!s || s.suggestedName.length === 0) return null;
  return {
    category: s.category,
    suggestedName: s.suggestedName,
    reason: s.reason,
  };
}

export function toCardData(item: Item): ApprovalCardData {
  const payload = item.payload;
  const original = originalOf(item);
  const sender = parseSender(str(original.from));
  return {
    id: String(item.id),
    intent: str(payload.intent) ?? humanizeType(item.type),
    tags: tagsOf(item),
    receivedTime: formatCardTimestamp(item.created_at),
    receivedFull: formatDateTime(item.created_at),
    assigneeId: item.assignee,
    assigneeName: assigneeNameOf(item),
    suggestion: suggestionForCard(item),
    customer: sender.name,
    initials: initialsOf(sender.name),
    inboundSubject: str(original.subject)?.trim() || "(no subject)",
    inbound: str(original.body) ?? "(no message body)",
    attachments: parseAttachments(original.attachments),
    draftSubject: str(payload.draft_subject) ?? "(no subject)",
    draftBody: str(payload.draft_body)?.trim() ?? "",
    edited: payload.draft_edited === true,
    rationale: str(payload.draft_rationale)?.trim() || null,
    generatedBy: generatedByOf(payload),
    trace: runTraceOf(payload),
    evalCapture: evalCaptureOf(payload),
    revisions: revisionsOf(payload),
    lastAnswer: lastAnswerOf(payload),
    suspectedSpam: suspectedSpamOf(item),
  };
}

/** Decision audit record on a resolved item, or null (legacy / missing). */
export function decisionOf(item: Item): DecisionRecord | null {
  const d = item.payload.decision as Partial<DecisionRecord> | undefined;
  if (
    typeof d === "object" &&
    d !== null &&
    (d.action === "approved" ||
      d.action === "rejected" ||
      d.action === "no_reply_needed" ||
      d.action === "trashed" ||
      d.action === "spam") &&
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
 * Rule, byte-for-byte matching REJECTED_SQL / NO_REPLY_SQL /
 * DECISION_ACTION_SQL (approvals.ts), in precedence order:
 *   - legacy bare string "rejected"                -> rejected
 *   - any object with action === "rejected"
 *     (full audit record OR partial, by/at absent) -> rejected
 *   - any object with action === "no_reply_needed"
 *     (GH-115; no legacy bare-string form exists)  -> no_reply_needed
 *   - any object with action === "trashed"         -> trashed
 *   - any object with action === "spam"            -> spam
 *     (GH-115 follow-on; object-only, like no_reply_needed)
 *   - everything else resolved (approved object,
 *     legacy bare "approved", missing decision,
 *     any other partial)                           -> approved
 *
 * SQL equivalence (approvals.ts):
 *   (jsonb_typeof(payload->'decision')='string' AND payload->>'decision'='rejected')
 *   -> the bare-string branch;
 *   OR payload->'decision'->>'action'='rejected'
 *   -> the object branch (->> yields NULL for a bare string or missing key,
 *      so only an explicit action='rejected' matches). Then
 *   payload->'decision'->>'action'='no_reply_needed' -> no_reply_needed,
 *   then ='trashed' -> trashed, then ='spam' -> spam.
 *   coalesce(...,false) makes every other resolved row approved.
 *   DECISION_ACTION_SQL applies the same precedence. Identical to the below.
 */
export type DecisionClass =
  | "approved"
  | "rejected"
  | "no_reply_needed"
  | "trashed"
  | "spam";

export function classifyDecision(
  payload: Record<string, unknown>,
): DecisionClass {
  const d = payload.decision;
  if (typeof d === "string") return d === "rejected" ? "rejected" : "approved";
  if (typeof d === "object" && d !== null) {
    const action = (d as { action?: unknown }).action;
    if (action === "rejected") return "rejected";
    if (action === "no_reply_needed") return "no_reply_needed";
    if (action === "trashed") return "trashed";
    if (action === "spam") return "spam";
  }
  return "approved";
}

/**
 * Human phrasing for a decision class, lowercase for mid-sentence use
 * ("Already marked no reply needed by Sam"). No em dashes.
 */
export function decisionPhrase(action: DecisionClass): string {
  switch (action) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "no_reply_needed":
      return "marked no reply needed";
    case "trashed":
      return "moved to Trash";
    case "spam":
      return "marked as spam";
  }
}

/** Whether a resolved item was approved (canonical rule). */
export function isApproved(item: Item): boolean {
  return classifyDecision(item.payload) === "approved";
}

/**
 * Whether the item was archived out of the UI (GH-55). Matches the SQL
 * guard NOT_ARCHIVED_SQL in approvals.ts (presence of the payload key);
 * keep the two in sync. Archived items are hidden from every inbox,
 * count, and deep link, but their rows and audit stay in the database.
 */
export function isArchived(item: Item): boolean {
  return Object.prototype.hasOwnProperty.call(item.payload, "archived");
}

/**
 * Whether the item was trashed (trash/spam decision, GH-115 follow-on).
 * Matches the SQL guard NOT_TRASHED_SQL in @ai-manager/core (presence of
 * the payload key); keep the two in sync. Trashed items appear ONLY in
 * the Trash inbox and vanish from every other inbox and tail; the row and
 * its audit stay in the database and can be restored.
 */
export function isTrashed(item: Item): boolean {
  return Object.prototype.hasOwnProperty.call(item.payload, "trashed");
}

/**
 * The suspected-spam flag (payload.suspected_spam, stamped by the
 * ingestion spam-signal gate), validated, or null. Carries which
 * confirmed signal matched, for the card's chip tooltip.
 */
export function suspectedSpamOf(
  item: Item,
): { kind: string; value: string } | null {
  const raw = item.payload.suspected_spam as
    | { matched_signal?: { kind?: unknown; value?: unknown } }
    | undefined;
  if (typeof raw !== "object" || raw === null) return null;
  const kind = str(raw.matched_signal?.kind);
  const value = str(raw.matched_signal?.value);
  // A malformed flag still shows the chip (the item WAS gated), with a
  // generic label.
  return { kind: kind ?? "sender", value: value ?? "" };
}

/**
 * Whether an approved reply is STAGED: waiting in the Approved queue
 * (GH-106), i.e. approved but delivery never queued. Mirrors the SQL
 * predicate STAGED_APPROVED_SQL in @ai-manager/core db/delivery.ts; keep
 * the two in sync. The absence of a payload.delivery key is the test (a
 * queued/sent/failed item has one); items that predate the send pipeline
 * also match, which is honest: they too are approved and never released.
 */
export function isStaged(item: Item): boolean {
  const body = item.payload.draft_body;
  return (
    item.status === "resolved" &&
    item.type === "email_reply" &&
    !isArchived(item) &&
    !isTrashed(item) &&
    classifyDecision(item.payload) === "approved" &&
    !Object.prototype.hasOwnProperty.call(item.payload, "delivery") &&
    typeof body === "string" &&
    body.length > 0
  );
}

export type RowTone =
  | "pending"
  | "approved"
  | "rejected"
  | "noreply"
  | "trashed";

/** Semantic tone for a row's status dot, derived from item state. */
export function toneOf(item: Item): RowTone {
  if (item.status === "pending_approval") return "pending";
  switch (classifyDecision(item.payload)) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "no_reply_needed":
      return "noreply";
    case "trashed":
    case "spam":
      return "trashed";
  }
}

function flattenPreview(body: string, max: number, empty: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return empty;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** One-line, collapsed preview of the inbound message for a list row. */
export function previewOf(item: Item, max = 120): string {
  return flattenPreview(str(originalOf(item).body) ?? "", max, "No message body");
}

/**
 * One-line preview of the OUTGOING draft, for the Approved queue's rows
 * (GH-106): the queue exists to review what is about to go out, so its
 * rows preview the reply rather than the inbound message.
 */
export function draftPreviewOf(item: Item, max = 120): string {
  return flattenPreview(str(item.payload.draft_body) ?? "", max, "No draft");
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
  /** AI tag chip labels (GH-65); [] for untagged items. */
  tags: string[];
  /** Assignee display name (GH-79), or null; rows render an initials chip. */
  assigneeName: string | null;
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
      : formatCardTimestamp(item.created_at);
  return {
    id: String(item.id),
    sender: sender.name,
    initials: initialsOf(sender.name),
    subject: str(original.subject)?.trim() || "(no subject)",
    time,
    preview: previewOf(item),
    tone,
    tags: tagsOf(item),
    assigneeName: assigneeNameOf(item),
  };
}
