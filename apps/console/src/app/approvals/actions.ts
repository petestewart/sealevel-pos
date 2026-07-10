"use server";

import { revalidatePath } from "next/cache";
import { getPool, reopenItem, ReopenConflictError } from "@ai-manager/core";
import { requireDecider } from "../../lib/requireDecider";
import { classifyDecision } from "../../lib/itemView";
import { formatRelativeTime } from "../../lib/emailDisplay";
import {
  decideItem,
  saveDraftEdits,
  type Decision,
  type DraftEdits,
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
      return { error: `Already ${action} by ${byName}${when}.`, stale: true };
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
  try {
    await decideItem(id, decision, decider, edits);
  } catch (err) {
    if (isAlreadyDecided(err)) {
      // No revalidate here: refreshing would unmount the stale card and
      // the inline message with it. The card stays until the user acts
      // (the inline Refresh affordance is that act, GH-31).
      return staleDecideState(id);
    }
    throw err;
  }
  revalidatePath("/", "layout");
  return { error: null };
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
        error: "Already reopened or changed by another operator.",
      };
    }
    throw err;
  }
  revalidatePath("/", "layout");
  return { error: null };
}
