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

/**
 * Auth guard for campaign approval decisions (SEA-83): gates on the
 * DECIDE-class campaigns:decide permission (owner + operator), explicitly
 * NOT campaigns:view (per the SEA-90 review note: the read-only surface
 * is held by every role; the power to approve a send to a whole audience
 * is not). Same double enforcement as requireDecider: Clerk middleware
 * protects the route, and every campaign action re-checks here before
 * touching the database.
 */
export async function requireCampaignDecider(): Promise<{
  id: string;
  name: string;
}> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not signed in");

  const role = await currentRole();
  if (!hasPermission(role, "campaigns:decide")) {
    throw new Error("Your role does not allow campaign approval decisions");
  }

  const user = await currentUser();
  const name =
    user?.fullName ??
    user?.firstName ??
    user?.primaryEmailAddress?.emailAddress ??
    userId;
  return { id: userId, name };
}

/**
 * Auth guard for the settings actions (GH-66): owner-only
 * (settings:manage), enforced server-side on every mutation regardless
 * of what the UI renders.
 */
export async function requireSettingsManager(): Promise<{
  id: string;
  name: string;
}> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not signed in");

  const role = await currentRole();
  if (!hasPermission(role, "settings:manage")) {
    throw new Error("Your role does not allow managing settings");
  }

  const user = await currentUser();
  const name =
    user?.fullName ??
    user?.firstName ??
    user?.primaryEmailAddress?.emailAddress ??
    userId;
  return { id: userId, name };
}
