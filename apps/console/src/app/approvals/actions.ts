"use server";

import { revalidatePath } from "next/cache";
import { auth, currentUser } from "@clerk/nextjs/server";
import { currentRole, hasPermission } from "../../lib/rbac";
import { reopenItem, ReopenConflictError } from "@ai-manager/core";
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

async function requireDecider(): Promise<{ id: string; name: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not signed in");

  const role = await currentRole();
  if (!hasPermission(role, "approvals:decide")) {
    throw new Error("Your role does not allow approval decisions");
  }

  const user = await currentUser();
  const name =
    user?.fullName ??
    user?.firstName ??
    user?.primaryEmailAddress?.emailAddress ??
    userId;
  return { id: userId, name };
}

function requireString(formData: FormData, field: string): string {
  const value = formData.get(field);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value;
}

async function decide(
  formData: FormData,
  decision: Decision,
  edits?: DraftEdits,
): Promise<void> {
  const decider = await requireDecider();
  const id = requireString(formData, "id");
  await decideItem(id, decision, decider, edits);
  revalidatePath("/approvals");
  revalidatePath("/");
}

export async function approveItemAction(formData: FormData): Promise<void> {
  await decide(formData, "approved");
}

export async function rejectItemAction(formData: FormData): Promise<void> {
  await decide(formData, "rejected");
}

/**
 * Save & approve: persist the operator's edited subject/body into the item
 * payload (keeping the original under original_draft) in the same atomic
 * guarded UPDATE that records the decision and resolves the item.
 */
export async function saveAndApproveItemAction(
  formData: FormData,
): Promise<void> {
  const edits: DraftEdits = {
    subject: requireString(formData, "subject").trim(),
    body: requireString(formData, "body").trim(),
  };
  await decide(formData, "approved", edits);
}

/**
 * Save edits without deciding (GH-25): persist the edited subject/body
 * (capturing original_draft on first edit, marking the draft edited) while
 * the item stays pending_approval. No decision is recorded.
 */
export async function saveEditsItemAction(formData: FormData): Promise<void> {
  await requireDecider();
  const id = requireString(formData, "id");
  const edits: DraftEdits = {
    subject: requireString(formData, "subject").trim(),
    body: requireString(formData, "body").trim(),
  };
  await saveDraftEdits(id, edits);
  revalidatePath("/approvals");
  revalidatePath("/");
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
    if (err instanceof Error && err.message.includes("no resolved item")) {
      revalidatePath("/approvals");
      return {
        error:
          "This item is not in a reopenable state anymore. It may have been reopened already.",
      };
    }
    throw err;
  }
  revalidatePath("/approvals");
  revalidatePath("/");
  return { error: null };
}
