import { auth, currentUser } from "@clerk/nextjs/server";
import { currentRole, hasPermission } from "./rbac";

/**
 * Shared auth guard for server actions that mutate approval state
 * (decide, save edits, revise instructions). Auth is enforced twice:
 * Clerk middleware protects the route, and each action calls this to
 * re-check the session and the RBAC permission before touching the
 * database or the queue. Extracted from approvals/actions.ts for GH-37
 * so the revise actions reuse the exact same gate.
 */
export async function requireDecider(): Promise<{ id: string; name: string }> {
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
