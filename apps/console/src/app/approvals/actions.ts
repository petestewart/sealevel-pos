"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { currentRole, hasPermission } from "../../lib/rbac";
import { decideItem, type Decision } from "../../lib/approvals";

/**
 * Server actions for the approval inbox. Auth is enforced twice: Clerk
 * middleware protects the route, and each action re-checks the session and
 * the RBAC permission before touching the database.
 */

async function decide(formData: FormData, decision: Decision): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not signed in");

  const role = await currentRole();
  if (!hasPermission(role, "approvals:decide")) {
    throw new Error("Your role does not allow approval decisions");
  }

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Missing item id");
  }

  await decideItem(id, decision, userId);
  revalidatePath("/approvals");
  revalidatePath("/");
}

export async function approveItemAction(formData: FormData): Promise<void> {
  await decide(formData, "approved");
}

export async function rejectItemAction(formData: FormData): Promise<void> {
  await decide(formData, "rejected");
}
