"use server";

import { getPool, reviseJobId } from "@ai-manager/core";
import { requireDecider } from "../../lib/requireDecider";
import { getJobsQueue } from "../../lib/reviseQueue";
import { INSTRUCTION_MAX_LENGTH } from "../../lib/reviseLimits";

/**
 * Server actions for the revise / Q&A box on the pending detail pane
 * (A3b, GH-37). The console never talks to the model directly: it
 * enqueues the item.revise job (docs/item-revise.md) and then polls the
 * item row until the payload changes, the BullMQ job reaches a terminal
 * state, or the client gives up (bounded polling in ReviseBox).
 *
 * Auth: every action re-checks approvals:decide via requireDecider, the
 * same gate the decide actions use. All SQL is parameterized.
 */

/**
 * Redo draft (GH-37) is implemented as a revise instruction, not a
 * re-enqueue of manual.email_draft. A true re-fire of the original job
 * cannot regenerate this item's draft: its jobId (email-draft-<messageId>)
 * is deduped while the record lives in Redis, and even when it runs, its
 * only write surface is create_item with dedupe_key = messageId, which
 * returns the EXISTING item untouched rather than replacing the draft.
 * The revise path writes through reviseEmailReplyDraft, which is exactly
 * the "replace the draft on this item" primitive, and it preserves the
 * revision history. The enqueue below uses a timestamped jobId so a
 * second Redo is never silently deduped into a no-op.
 */
const REDO_INSTRUCTION =
  "Redo this reply from scratch. Ignore the current draft's wording and structure entirely and write a fresh reply to the original email, as if drafting it for the first time.";

interface PendingDraftRow {
  status: string;
  type: string;
  draft_subject: string | null;
  draft_body: string | null;
  answer_at: string | null;
  answer_text: string | null;
}

async function loadDraftRow(itemId: string): Promise<PendingDraftRow | null> {
  const { rows } = await getPool().query<PendingDraftRow>(
    `SELECT status, type,
            payload->>'draft_subject' AS draft_subject,
            payload->>'draft_body' AS draft_body,
            payload->'last_answer'->>'at' AS answer_at,
            payload->'last_answer'->>'answer' AS answer_text
     FROM items WHERE id = $1`,
    [itemId],
  );
  return rows[0] ?? null;
}

/**
 * Snapshot of the poll-relevant payload fields at enqueue time
 * (docs/item-revise.md step 1). Deliberately NOT draft_revisions length:
 * the history caps at 5 entries so it stops changing.
 */
export interface ReviseSnapshot {
  draftSubject: string | null;
  draftBody: string | null;
  answerAt: string | null;
}

export type ReviseSubmitResult =
  | { ok: true; jobId: string; snapshot: ReviseSnapshot }
  | { ok: false; error: string };

const NOT_PENDING_ERROR =
  "This item has already been decided, so the draft can no longer be revised.";

async function enqueueRevise(
  itemId: string,
  instruction: string,
  jobId: string,
): Promise<ReviseSubmitResult> {
  await requireDecider();

  if (typeof itemId !== "string" || itemId.trim().length === 0) {
    return { ok: false, error: "Missing item id." };
  }
  const trimmed = instruction.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Type an instruction or question first." };
  }
  if (trimmed.length > INSTRUCTION_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep instructions to ${INSTRUCTION_MAX_LENGTH} characters or fewer.`,
    };
  }

  const row = await loadDraftRow(itemId);
  if (!row || row.type !== "email_reply") {
    return { ok: false, error: "No email reply item found for this id." };
  }
  if (row.status !== "pending_approval") {
    return { ok: false, error: NOT_PENDING_ERROR };
  }

  const snapshot: ReviseSnapshot = {
    draftSubject: row.draft_subject,
    draftBody: row.draft_body,
    answerAt: row.answer_at,
  };

  const queue = getJobsQueue();

  // A kept job record pins its deterministic jobId (docs/item-revise.md):
  // failed jobs are kept forever and completed ones linger for the
  // removeOnComplete window, so a same-id re-add would be a silent no-op
  // and the poll would misreport "the AI made no changes". Disambiguate:
  // - failed: surface it (the operator should reword);
  // - completed: the operator wants the same instruction applied AGAIN
  //   (e.g. "shorten it" twice), so re-enqueue under a timestamped id;
  // - waiting/active/delayed: a run is already in flight; poll that one
  //   instead of enqueueing a duplicate.
  let effectiveJobId = jobId;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      return {
        ok: false,
        error:
          "A previous run of this exact instruction failed. Reword the instruction and try again.",
      };
    }
    if (state === "completed") {
      effectiveJobId = `${jobId}-r${Date.now()}`;
    }
  }

  await queue.add(
    "item.revise",
    { itemId, instruction: trimmed },
    { jobId: effectiveJobId },
  );
  return { ok: true, jobId: effectiveJobId, snapshot };
}

/** Submit a one-shot revise/question instruction for a pending item. */
export async function submitReviseInstructionAction(
  itemId: string,
  instruction: string,
): Promise<ReviseSubmitResult> {
  const trimmed = instruction.trim();
  return enqueueRevise(itemId, trimmed, reviseJobId(itemId, trimmed));
}

/**
 * Redo the draft from scratch (see REDO_INSTRUCTION above for why this
 * rides the revise job). The timestamped jobId keeps repeat redos from
 * being deduped away.
 */
export async function redoDraftAction(
  itemId: string,
): Promise<ReviseSubmitResult> {
  return enqueueRevise(
    itemId,
    REDO_INSTRUCTION,
    `revise-${itemId}-redo-${Date.now()}`,
  );
}

export type RevisePollResult =
  | { status: "working" }
  | { status: "revised" }
  | { status: "answered"; answer: string }
  | { status: "noop" }
  | { status: "failed"; error: string };

/**
 * One poll tick (docs/item-revise.md): done when the draft content or
 * last_answer changed relative to the enqueue-time snapshot; otherwise
 * consult the BullMQ job state for terminal outcomes. The client calls
 * this every ~1.5s with a bounded attempt budget.
 */
export async function pollReviseAction(
  itemId: string,
  jobId: string,
  snapshot: ReviseSnapshot,
): Promise<RevisePollResult> {
  await requireDecider();

  const row = await loadDraftRow(itemId);
  if (!row) {
    return { status: "failed", error: "Item no longer exists." };
  }
  if (
    row.draft_subject !== snapshot.draftSubject ||
    row.draft_body !== snapshot.draftBody
  ) {
    return { status: "revised" };
  }
  if (row.answer_at !== snapshot.answerAt && row.answer_text) {
    return { status: "answered", answer: row.answer_text };
  }
  if (row.status !== "pending_approval") {
    return {
      status: "failed",
      error: "This item was decided while the request ran, so nothing changed.",
    };
  }

  const job = await getJobsQueue().getJob(jobId);
  if (job) {
    const state = await job.getState();
    if (state === "failed") {
      // Retries may still be pending; only a truly dead job reports failed.
      return {
        status: "failed",
        error:
          "The request failed. Reword the instruction and try again, or check the worker logs.",
      };
    }
    if (state === "completed") {
      return { status: "noop" };
    }
  }
  return { status: "working" };
}
