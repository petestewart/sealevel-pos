"use server";

import { revalidatePath } from "next/cache";
import {
  assignItemAudited,
  createKbRevertProposal,
  enqueueEmailSend,
  enqueueGmailState,
  enqueueKbWrite,
  getItemById,
  getPool,
  getUserSettings,
  gmailSendEnabled,
  gmailStateActionForDecision,
  listStagedApprovedItems,
  markDeliveryQueued,
  markKbWriteQueued,
  recordDeliveryFailed,
  recordKbWrite,
  recordSpamSignal,
  reopenItem,
  ReopenConflictError,
  restoreTrashedItem,
  saveKbProposalEdits,
  trashItem,
  type Item,
} from "@ai-manager/core";
import { requireDecider } from "../../lib/requireDecider";
import { assignableUsers } from "../../lib/assignees";
import { classifyDecision, decisionPhrase } from "../../lib/itemView";
import { formatRelativeTime } from "../../lib/emailDisplay";
import {
  archiveAllRejected,
  archiveRejectedItem,
  clearSuspectedSpam,
  decideItem,
  saveDraftEdits,
  type Decision,
  type DraftEdits,
  type SignoffChoice,
} from "../../lib/approvals";

/**
 * Server actions for the approval inbox. Auth is enforced twice: Clerk
 * middleware protects the route, and each action re-checks the session and
 * the RBAC permission before touching the database. Every decision records
 * an audit (who via Clerk id + display name, when, edited or not) in the
 * item payload (GH-22).
 */

function requireString(formData: FormData, field: string): string {
  const value = formData.get(field);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value;
}

export interface ApprovalActionState {
  error: string | null;
  /**
   * True when the error is a stale-item conflict (the item was decided in
   * another tab or by another operator). The card renders a Refresh
   * affordance next to the message so the operator can resync (GH-31).
   */
  stale?: boolean;
}

const ALREADY_DECIDED_MESSAGE =
  "This item was already decided by another operator. Refresh to see the latest.";

/**
 * True when a guarded UPDATE in the approvals lib matched zero rows: the
 * item is no longer pending_approval (decided in another tab or by another
 * operator). Surfaced as an inline message, never an error page (GH-40).
 */
function isAlreadyDecided(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("no pending_approval item")
  );
}

/**
 * Rich already-decided conflict state (GH-31): look up what actually
 * happened to the item and say who decided it (decision.by.name, falling
 * back to "another operator" for partial/legacy audits), what the decision
 * was (via the canonical classifyDecision), and when (relative time from
 * decision.at, falling back to resolved_at). Any lookup failure falls back
 * to the generic message; this path must never throw, because the whole
 * point is to keep the stale card mounted with an inline message.
 */
async function staleDecideState(id: string): Promise<ApprovalActionState> {
  try {
    const { rows } = await getPool().query<{
      status: string;
      payload: Record<string, unknown>;
      resolved_at: Date | null;
    }>(`SELECT status, payload, resolved_at FROM items WHERE id = $1`, [id]);
    const row = rows[0];
    if (row && row.status === "resolved") {
      const action = classifyDecision(row.payload);
      const d = row.payload.decision as
        | { by?: { name?: unknown }; at?: unknown }
        | string
        | undefined;
      const byName =
        typeof d === "object" &&
        typeof d?.by?.name === "string" &&
        d.by.name.trim().length > 0
          ? d.by.name.trim()
          : "another operator";
      const atRaw =
        typeof d === "object" && typeof d?.at === "string"
          ? new Date(d.at)
          : row.resolved_at;
      const when =
        atRaw !== null && !Number.isNaN(atRaw.getTime())
          ? `, ${formatRelativeTime(atRaw)}`
          : "";
      return {
        error: `Already ${decisionPhrase(action)} by ${byName}${when}.`,
        stale: true,
      };
    }
  } catch {
    // Fall through to the generic message.
  }
  return { error: ALREADY_DECIDED_MESSAGE, stale: true };
}

async function decide(
  formData: FormData,
  decision: Decision,
  edits?: DraftEdits,
): Promise<ApprovalActionState> {
  const decider = await requireDecider();
  const id = requireString(formData, "id");
  // Signoff for THIS email (GH-76): the card posts signoff_mode
  // (default | name | none), preselected from the user's global setting.
  // A missing or unrecognized value (legacy form, forged request) falls
  // back to the GH-66 global-setting behavior. A settings lookup failure
  // degrades to the studio default rather than blocking the decision.
  let signoff: SignoffChoice | undefined;
  if (decision === "approved") {
    const raw = formData.get("signoff_mode");
    const mode =
      raw === "default" || raw === "name" || raw === "none" ? raw : undefined;
    try {
      if (mode === "none" || mode === "default") {
        signoff = { mode };
      } else {
        // Explicit "name" choice, or no valid mode posted: both need the
        // user's settings (the latter to honor the global sign_with_name).
        const settings = await getUserSettings(decider.id);
        if (mode === "name" || settings.sign_with_name) {
          signoff = {
            mode: "name",
            name:
              settings.signature_name ??
              decider.name.split(/\s+/)[0] ??
              undefined,
          };
        }
      }
    } catch {
      signoff = mode === "none" ? { mode } : undefined;
    }
  }
  let decided: Item;
  try {
    decided = await decideItem(id, decision, decider, edits, signoff);
  } catch (err) {
    if (isAlreadyDecided(err)) {
      // No revalidate here: refreshing would unmount the stale card and
      // the inline message with it. The card stays until the user acts
      // (the inline Refresh affordance is that act, GH-31).
      return staleDecideState(id);
    }
    throw err;
  }
  // Read = decided (locked decision, CLAUDE.md 2026-07-19): every decision
  // flips the source Gmail message to read, via the worker's
  // email.gmailState job. The console only enqueues; the worker holds the
  // Gmail credentials (GH-116 gate split). Best-effort, after the decision
  // is durably recorded: a queue hiccup leaves the message unread, never
  // an undone decision.
  await queueGmailStateForDecision(decided, decision);
  // Outbound send on approval (GH-95, Job B). The operator's Approve click
  // is the send authorization -- this is how sending coexists with the
  // "nothing auto-sends in v1" lock -- and it only happens when a human has
  // explicitly enabled sending for the deployment (GMAIL_SEND_ENABLED).
  // Best-effort: a queue hiccup must never fail the recorded approval, and
  // it must not leave the item stuck showing "queued" with no job behind it
  // (queueSendIfEnabled reverts an un-enqueued stamp to 'failed').
  //
  // Review-queue mode (GH-106): when the APPROVING user's stage_approvals
  // setting is on, the delivery enqueue is skipped entirely and the item
  // waits in the Approved queue until released (Send approved). Only
  // DELIVERY is staged: the decision itself, and the mark-read Gmail job
  // enqueued above, happen immediately either way. The setting is read at
  // decision time; a settings lookup failure falls back to the default
  // (immediate delivery), so a hiccup never silently parks a reply for an
  // operator who never opted into staging.
  if (decision === "approved") {
    let stage = false;
    try {
      stage = (await getUserSettings(decider.id)).stage_approvals;
    } catch {
      stage = false;
    }
    if (!stage) await queueSendIfEnabled(id);
  }
  revalidatePath("/", "layout");
  return { error: null };
}

/** The item's source Gmail message id (payload.email_meta.gmailId), or null. */
function gmailIdOf(item: Item): string | null {
  const meta = (item.payload["email_meta"] ?? {}) as Record<string, unknown>;
  const gmailId = meta["gmailId"];
  return typeof gmailId === "string" && gmailId.length > 0 ? gmailId : null;
}

/**
 * Best-effort Gmail state enqueue for a decision (read = decided). The
 * decision -> Gmail op mapping is the shared gmailStateActionForDecision
 * table: approve / reject / no-reply mark the message read; trash moves it
 * to Gmail's trash (and marks read); spam reports it (and marks read).
 * Items without a Gmail message id (hand-fired runs, pre-Gmail items) are
 * a silent no-op. Never throws: the recorded decision is the source of
 * truth, and a failed enqueue only means the message stays unread/in
 * place in Gmail. No rollback bookkeeping is needed (unlike the send
 * path's queued-stamp rollback) because nothing on the item claims the
 * Gmail state changed; the operations are idempotent and re-enqueueable.
 */
async function queueGmailStateForDecision(
  item: Item,
  decision: Decision | "trashed" | "spam",
): Promise<void> {
  const gmailId = gmailIdOf(item);
  if (!gmailId) return;
  try {
    await enqueueGmailState({
      itemId: String(item.id),
      gmailId,
      action: gmailStateActionForDecision(decision),
    });
  } catch (err) {
    console.error(
      `[approvals] failed to enqueue gmail state for item ${item.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * When outbound send is enabled, stamp the item's delivery as queued and
 * enqueue Job B (the worker sends via Gmail). Deterministic jobId +
 * markDeliveryQueued's guard (won't re-queue an already sent/in-flight
 * item) make this safe on a re-approve after reopen -- and equally safe as
 * the RELEASE step of the review queue (GH-106), where it runs once per
 * staged item: a double release, or a release racing an approve, can never
 * double-send. Never throws; returns what happened so the release actions
 * can surface an inline message (decide() ignores the result).
 *
 * If the stamp succeeds but the enqueue fails (a Redis hiccup), the 'queued'
 * record would otherwise outlive the (nonexistent) job forever -- the item
 * would show "queued for delivery" and never send. So on an enqueue failure
 * we revert the stamp to 'failed', which is honest in the UI (red, "will be
 * retried") and lets a reopen + re-approve re-queue it.
 */
async function queueSendIfEnabled(
  id: string,
): Promise<"queued" | "disabled" | "ineligible" | "error"> {
  // Flag-only gate (gmailSendEnabled): the console decides whether to enqueue
  // Job B without needing Gmail credentials. The worker re-checks full creds
  // (gmailSendConfigured) before it actually sends, so a job enqueued while
  // the worker is unconfigured degrades to a clean skip.
  if (!gmailSendEnabled()) return "disabled";
  let queued = false;
  try {
    // markDeliveryQueued returns null when the item is not a fresh-approved
    // deliverable (already sent, in flight, rejected, archived); in that
    // case do not enqueue a redundant send.
    queued = Boolean(await markDeliveryQueued(id));
    if (queued) await enqueueEmailSend(id);
    return queued ? "queued" : "ineligible";
  } catch (err) {
    console.error(
      `[approvals] failed to enqueue send for item ${id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Roll back the optimistic 'queued' so it does not linger with no job.
    if (queued) {
      await recordDeliveryFailed(
        id,
        "could not queue the send; approve again to retry",
      ).catch(() => undefined);
    }
    return "error";
  }
}

/**
 * Release ONE staged approved reply from the Approved queue (GH-106):
 * runs the exact per-item queue-send path an immediate-mode approval
 * runs. Decider-gated like every approval mutation. Conflicts (already
 * released by another operator, reopened, no longer approved) surface as
 * an inline stale message, never a double-send: markDeliveryQueued's
 * guard plus the deterministic send jobId make release idempotent.
 */
export async function releaseApprovedItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  await requireDecider();
  const id = requireString(formData, "id");
  const outcome = await queueSendIfEnabled(id);
  switch (outcome) {
    case "queued":
      revalidatePath("/", "layout");
      return { error: null };
    case "disabled":
      return {
        error:
          "Sending is disabled for this studio, so nothing can be released.",
      };
    case "ineligible":
      return {
        error:
          "This reply is no longer waiting for release. It may have been released, reopened, or changed by another operator.",
        stale: true,
      };
    case "error":
      return {
        error: "Could not queue this reply for delivery. Try again.",
      };
  }
}

export interface SendApprovedState {
  error: string | null;
  /** How many staged replies this click released, on success. */
  released?: number;
}

/**
 * Send approved (GH-106): release EVERY staged reply in the Approved
 * queue. Each item goes through the same guarded per-item path as a
 * single release (markDeliveryQueued + deterministic jobId), so a
 * concurrent release, an item reopened mid-batch, or a double click can
 * never double-send; those items are simply skipped. Releasing an empty
 * queue is a valid no-op. The queue is global, so this releases staged
 * items regardless of which operator approved them.
 */
export async function sendApprovedBatchAction(
  _prev: SendApprovedState,
  _formData: FormData,
): Promise<SendApprovedState> {
  await requireDecider();
  if (!gmailSendEnabled()) {
    return {
      error:
        "Sending is disabled for this studio, so nothing can be released.",
    };
  }
  const staged = await listStagedApprovedItems();
  let released = 0;
  for (const item of staged) {
    if ((await queueSendIfEnabled(String(item.id))) === "queued") released++;
  }
  revalidatePath("/", "layout");
  return { error: null, released };
}

/**
 * Server-side guard for GH-33: approving must never resolve an item whose
 * STORED AI draft body is empty or missing. The UI disables the buttons,
 * but the action re-checks the live DB so a forged or stale form cannot
 * approve nothing. Returns an inline-able error message, or null when ok.
 */
async function emptyDraftError(id: string): Promise<string | null> {
  const { rows } = await getPool().query<{ draft_body: string | null }>(
    `SELECT payload->>'draft_body' AS draft_body FROM items WHERE id = $1`,
    [id],
  );
  const body = rows[0]?.draft_body;
  if (typeof body !== "string" || body.trim().length === 0) {
    return "Cannot approve: no draft generated for this item.";
  }
  return null;
}

export async function approveItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  // Auth first, then the live-DB empty-draft guard (GH-33), then decide.
  await requireDecider();
  const guardError = await emptyDraftError(requireString(formData, "id"));
  if (guardError) return { error: guardError };
  return decide(formData, "approved");
}

export async function rejectItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  return decide(formData, "rejected");
}

/**
 * One-click "No reply needed" (GH-115), symmetric with approve/reject:
 * resolves the item with a no_reply_needed decision audit (who, when, and
 * a reason recorded in the same payload field the classifier writes, so a
 * future learning pass can mine operator corrections). Nothing is sent;
 * the send path only ever runs on approval. Works regardless of whether a
 * draft exists, since dismissing an email needs no draft to dismiss.
 */
export async function noReplyItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  return decide(formData, "no_reply_needed");
}

/**
 * Save & approve: persist the operator's edited subject/body into the item
 * payload (keeping the original under original_draft) in the same atomic
 * guarded UPDATE that records the decision and resolves the item.
 */
export async function saveAndApproveItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  // Same GH-33 guard as plain Approve: the STORED draft must be non-empty.
  // requireString below only validates the submitted fields, so without
  // this a forged request carrying a typed body could approve an item
  // whose generated draft is empty. Auth first, then the live DB check.
  await requireDecider();
  const guardError = await emptyDraftError(requireString(formData, "id"));
  if (guardError) return { error: guardError };
  const edits: DraftEdits = {
    subject: requireString(formData, "subject").trim(),
    body: requireString(formData, "body").trim(),
  };
  return decide(formData, "approved", edits);
}

/**
 * Save edits without deciding (GH-25): persist the edited subject/body
 * (capturing original_draft on first edit, marking the draft edited) while
 * the item stays pending_approval. No decision is recorded.
 */
export async function saveEditsItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  await requireDecider();
  const id = requireString(formData, "id");
  const edits: DraftEdits = {
    subject: requireString(formData, "subject").trim(),
    body: requireString(formData, "body").trim(),
  };
  try {
    await saveDraftEdits(id, edits);
  } catch (err) {
    if (isAlreadyDecided(err)) {
      return staleDecideState(id);
    }
    throw err;
  }
  revalidatePath("/", "layout");
  return { error: null };
}

export interface ReopenState {
  error: string | null;
}

/**
 * Reopen a decided item (GH-25): status back to pending_approval, prior
 * decision preserved in payload.decision_history. Returns a state object
 * (for useActionState) so a dedupe conflict surfaces as a friendly inline
 * message instead of crashing the page.
 */
export async function reopenItemAction(
  _prev: ReopenState,
  formData: FormData,
): Promise<ReopenState> {
  await requireDecider();
  const id = requireString(formData, "id");
  try {
    await reopenItem(id);
  } catch (err) {
    if (err instanceof ReopenConflictError) {
      return {
        error:
          "Cannot reopen: a newer pending item for the same email already exists. Decide that one first, then try again.",
      };
    }
    // Lost a race: someone else reopened it (or it never was resolved).
    // No revalidate here, matching the decide conflict paths (GH-31): a
    // revalidation unmounts the row before the operator can read the
    // message. The message's Refresh affordance (or the next count-refresh
    // tick) resyncs the list on the operator's terms.
    if (err instanceof Error && err.message.includes("no resolved item")) {
      return {
        error: "Already reopened, removed, or changed by another operator.",
      };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  return { error: null };
}

/**
 * Per-item Remove from the Rejected inbox (GH-55): archive the item
 * (hidden everywhere, never deleted). The guarded UPDATE in
 * archiveRejectedItem matches only a resolved, rejected, not-yet-archived
 * item, so races (a concurrent Reopen, a double Remove, another operator
 * clearing all) surface as an inline message, never a crash or a state
 * overwrite.
 */
export async function removeRejectedAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const decider = await requireDecider();
  const id = requireString(formData, "id");
  const archived = await archiveRejectedItem(id, decider);
  if (!archived) {
    return {
      error:
        "Could not remove this item. It may have been reopened, removed already, or changed by another operator.",
      stale: true,
    };
  }
  revalidatePath("/", "layout");
  return { error: null };
}

export interface ClearRejectedState {
  error: string | null;
}

/**
 * Clear all rejected items (GH-55): archive every rejected, not-yet-
 * archived email reply in one statement. Clearing an already-empty inbox
 * is a valid no-op, not an error.
 */
export async function clearRejectedAction(
  _prev: ClearRejectedState,
  _formData: FormData,
): Promise<ClearRejectedState> {
  const decider = await requireDecider();
  await archiveAllRejected(decider);
  revalidatePath("/", "layout");
  return { error: null };
}

/**
 * Move a pending item to the Trash (GH-115 follow-on): a decision like
 * approve/reject, recorded by core trashItem in the same audit shape
 * (payload.decision = {action:"trashed", by, at}) plus the trashed marker
 * that gives the item a home in the Trash view and hides it everywhere
 * else. Read = decided: the source Gmail message is moved to Gmail's
 * trash and marked read (best-effort enqueue). The guarded UPDATE loses
 * cleanly to a concurrent decision.
 */
export async function trashItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const decider = await requireDecider();
  const id = requireString(formData, "id");
  const trashed = await trashItem(id, decider, "unwanted");
  if (!trashed) return staleDecideState(id);
  await queueGmailStateForDecision(trashed, "trashed");
  revalidatePath("/", "layout");
  return { error: null };
}

/**
 * Mark a pending item as spam (GH-115 follow-on): the trash decision's
 * stronger sibling. Records the decision (action:"spam"), moves the item
 * to the Trash view, enqueues the Gmail spam report + mark-read, AND
 * feeds the learning loop: the sender (and their domain) are recorded as
 * confirmed spam signals (recordSpamSignal), so future mail from them is
 * pre-flagged as suspected spam at ingestion without a draft being made.
 * The signal write is best-effort after the decision is durable; a
 * failure only means the system does not learn from this one confirm.
 */
export async function spamItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const decider = await requireDecider();
  const id = requireString(formData, "id");
  const trashed = await trashItem(
    id,
    decider,
    "spam",
    "Confirmed as spam by the operator.",
  );
  if (!trashed) return staleDecideState(id);
  const original = (trashed.payload["original_email"] ?? {}) as {
    from?: unknown;
  };
  const from = typeof original.from === "string" ? original.from : undefined;
  try {
    await recordSpamSignal(from, decider, "Confirmed spam in the console.");
  } catch (err) {
    console.error(
      `[approvals] failed to record spam signal for item ${id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  await queueGmailStateForDecision(trashed, "spam");
  revalidatePath("/", "layout");
  return { error: null };
}

/**
 * "Not spam" on a suspected-spam item (GH-115 follow-on): clears the
 * flag; the item stays pending and draftless (drafting was skipped by the
 * spam gate), and the operator can use Redo draft to generate a reply.
 * The matched signal is NOT deleted (see clearSuspectedSpam). Not a
 * decision: nothing resolves and no Gmail state changes.
 */
export async function notSpamItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  await requireDecider();
  const id = requireString(formData, "id");
  const cleared = await clearSuspectedSpam(id);
  if (!cleared) {
    return {
      error:
        "Could not clear the spam flag. The item may have been decided or changed by another operator.",
      stale: true,
    };
  }
  revalidatePath("/", "layout");
  return { error: null };
}

/**
 * Restore a trashed item (GH-115 follow-on): back to the status it had
 * before the trash/spam decision (core restoreTrashedItem, which moves
 * the decision onto decision_history like Reopen does). The Gmail side is
 * also restored best-effort: untrash for a trashed message, back out of
 * Spam for a spam-reported one. The read flag deliberately stays set (a
 * human looked at it; un-reading would be false).
 */
export async function restoreTrashedAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  await requireDecider();
  const id = requireString(formData, "id");
  let restored: Item | null;
  try {
    restored = await restoreTrashedItem(id);
  } catch (err) {
    if (err instanceof ReopenConflictError) {
      return {
        error:
          "Cannot restore: a newer pending item for the same email already exists. Decide that one first, then try again.",
      };
    }
    throw err;
  }
  if (!restored) {
    return {
      error:
        "Could not restore this item. It may have been restored already or changed by another operator.",
      stale: true,
    };
  }
  // Which discard the item is coming back from lives in the audit trail:
  // restoreTrashedItem appended the trash/spam decision to
  // decision_history, so the newest entry names the action to undo.
  const history = restored.payload["decision_history"];
  const last = Array.isArray(history) ? history[history.length - 1] : undefined;
  const lastAction = (last as { action?: unknown } | undefined)?.action;
  const gmailId = gmailIdOf(restored);
  if (gmailId) {
    try {
      await enqueueGmailState({
        itemId: String(restored.id),
        gmailId,
        action: lastAction === "spam" ? "unspam" : "untrash",
      });
    } catch (err) {
      console.error(
        `[approvals] failed to enqueue gmail restore for item ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  revalidatePath("/", "layout");
  return { error: null };
}

/**
 * Approve a pending kb_update proposal (GH-112): record the decision
 * through the same guarded decideItem path as email replies (identical
 * DecisionRecord audit; concurrent decisions lose cleanly with the stale
 * card affordance), then enqueue the kb.write job (GH-113) that commits
 * the change through the MCP server's gated write_wiki_page tool. The
 * Approve click is the write authorization; nothing was written before
 * it, and only the worker (holding the kb-writer token) writes after it.
 *
 * Server-side guard mirroring the email empty-draft guard (GH-33): the
 * STORED proposal must be a well-formed kb_update with page content; a
 * forged form cannot approve an empty or foreign item into a KB write.
 */
export async function approveKbUpdateAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const decider = await requireDecider();
  const id = requireString(formData, "id");
  const { rows } = await getPool().query<{
    type: string;
    proposed_content: string | null;
    target_page: string | null;
  }>(
    `SELECT type, payload->>'proposed_content' AS proposed_content,
            payload->>'target_page' AS target_page
     FROM items WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.type !== "kb_update") {
    return { error: "This item is not a knowledge base proposal." };
  }
  if (
    typeof row.proposed_content !== "string" ||
    row.proposed_content.trim().length === 0 ||
    typeof row.target_page !== "string" ||
    row.target_page.trim().length === 0
  ) {
    return { error: "Cannot approve: this proposal has no page content." };
  }
  try {
    await decideItem(id, "approved", decider);
  } catch (err) {
    if (isAlreadyDecided(err)) return staleDecideState(id);
    throw err;
  }
  await queueKbWrite(id);
  revalidatePath("/", "layout");
  return { error: null };
}

/**
 * Enqueue the kb.write job for a just-approved proposal, mirroring
 * queueSendIfEnabled's honesty guarantees: the guarded queued stamp
 * (markKbWriteQueued refuses rejected/reopened/already-written items),
 * the deterministic jobId, and the revert-to-failed when the enqueue
 * itself fails so the item never claims "queued" with no job behind it.
 * Never throws; the recorded decision is the source of truth either way,
 * and reopen + re-approve is the retry path.
 */
async function queueKbWrite(
  id: string,
): Promise<"queued" | "ineligible" | "error"> {
  let queued = false;
  try {
    queued = Boolean(await markKbWriteQueued(id));
    if (queued) await enqueueKbWrite(id);
    return queued ? "queued" : "ineligible";
  } catch (err) {
    console.error(
      `[approvals] failed to enqueue kb write for item ${id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (queued) {
      await recordKbWrite(id, {
        status: "failed",
        error:
          "could not queue the knowledge base write; reopen and approve again to retry",
      }).catch(() => undefined);
    }
    return "error";
  }
}

/**
 * Save a human edit to a pending proposal's page content (GH-112, the kb
 * analogue of Save edits): proposed_content is replaced, the AI original
 * is captured under original_proposal, and the eventual decision audit is
 * marked edited. The item stays pending; nothing is decided or written.
 */
export async function saveKbEditsAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  await requireDecider();
  const id = requireString(formData, "id");
  const content = requireString(formData, "proposed_content");
  if (content.trim().length === 0) {
    return { error: "The proposed page content cannot be empty." };
  }
  try {
    await saveKbProposalEdits(id, content);
  } catch (err) {
    if (isAlreadyDecided(err)) return staleDecideState(id);
    throw err;
  }
  revalidatePath("/", "layout");
  return { error: null };
}

/**
 * Propose reverting a committed KB write (GH-113): files a NEW pending
 * kb_update whose proposed content is the prior page content stored on
 * the written item. Rollback is a proposal, not a special power: nothing
 * is restored until a human approves the new item through the exact same
 * gate, so no unaudited write path exists. Deduped per source item, so a
 * double click surfaces the existing proposal instead of filing twice.
 */
export async function proposeKbRevertAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  await requireDecider();
  const id = requireString(formData, "id");
  const item = await getItemById(id);
  if (!item) {
    return { error: "This item no longer exists.", stale: true };
  }
  try {
    const { created } = await createKbRevertProposal(item);
    revalidatePath("/", "layout");
    return created
      ? { error: null }
      : {
          error:
            "A revert proposal for this update already exists in the pending queue.",
        };
  } catch (err) {
    return {
      error: `Cannot propose a revert: ${
        err instanceof Error && err.message.includes("no committed KB write")
          ? "this item has no committed knowledge base write to revert, or the page did not exist before it."
          : "the proposal could not be created. Refresh and try again."
      }`,
    };
  }
}

/**
 * Assign, re-assign, or unassign an item (GH-79). Decider-gated like every
 * approval mutation. The form carries the caller's last-seen assignee id
 * ("" for unassigned) so the guarded UPDATE (assignItemAudited) loses
 * cleanly when another operator changed the assignment first: the loser
 * gets an inline stale message and a Refresh affordance, never a silent
 * overwrite. Assignee display names travel with the form (picked from the
 * Clerk-sourced options list) so the audit trail and payload.assignee_name
 * never need a lookup at render time.
 */
export async function assignItemAction(
  _prev: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const by = await requireDecider();
  const id = requireString(formData, "id");
  const toId = formData.get("assignee_id");
  const expectedRaw = formData.get("expected_assignee");
  const expected =
    typeof expectedRaw === "string" && expectedRaw.length > 0
      ? expectedRaw
      : null;

  // The assignment TARGET is validated server-side against the live
  // Clerk-sourced eligible list (operator/owner roles), and the display
  // name comes from that same server lookup -- the client's option list
  // is presentation only. A forged form cannot assign to a viewer or a
  // made-up id, and cannot plant an attacker-chosen name in the audit
  // trail. During a Clerk outage the list is [], so new assigns are
  // rejected while unassign (which needs no lookup) keeps working.
  let to: { id: string; name: string } | null = null;
  if (typeof toId === "string" && toId.length > 0) {
    const eligible = (await assignableUsers()).find((u) => u.id === toId);
    if (!eligible) {
      return {
        error:
          "That user cannot be assigned items right now. Refresh and try again.",
      };
    }
    to = { id: eligible.id, name: eligible.name };
  }

  // No-op guard: re-assigning to the current assignee (or unassigning an
  // already-unassigned item) writes nothing -- keeps assignment_history
  // meaningful instead of accumulating from==to entries.
  if ((to?.id ?? null) === expected) {
    return { error: null };
  }

  const updated = await assignItemAudited(id, to, by, expected);
  if (!updated) {
    return {
      error:
        "Assignment changed by another operator, or the item is no longer assignable. Refresh to see the latest.",
      stale: true,
    };
  }
  revalidatePath("/", "layout");
  return { error: null };
}
