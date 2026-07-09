"use server";

import { revalidatePath } from "next/cache";
import { auth, currentUser } from "@clerk/nextjs/server";
import { currentRole, hasPermission } from "../../lib/rbac";
import { decideItem, type Decision, type DraftEdits } from "../../lib/approvals";

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
