import { currentUser } from "@clerk/nextjs/server";

/**
 * Minimal RBAC stub (ARCHITECTURE.md "Operator console" and "Auth/identity").
 * v1 keeps this deliberately small: the role lives on the Clerk user's
 * publicMetadata.role, and a static map gates permissions. The users table,
 * per-user dashboard_layouts, and richer roles (manager, instructor,
 * collaborator) are later tickets.
 */

export type Role = "owner" | "operator" | "viewer";

export type Permission =
  | "items:view"
  | "campaigns:view"
  | "approvals:decide"
  | "settings:manage";

// campaigns:view gates a READ-ONLY surface (SEA-90), so it follows the
// items:view precedent: every role holds it. Campaign approve/reject is
// SEA-83 and will gate on a decide-class permission, not this one.
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    "items:view",
    "campaigns:view",
    "approvals:decide",
    "settings:manage",
  ],
  operator: ["items:view", "campaigns:view", "approvals:decide"],
  viewer: ["items:view", "campaigns:view"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

function isRole(value: unknown): value is Role {
  return value === "owner" || value === "operator" || value === "viewer";
}

/**
 * Resolve the signed-in user's role from Clerk publicMetadata.role.
 * Missing or unrecognized role resolves to "viewer" (least privilege): a
 * signed-in user cannot approve or reject anything until an owner sets
 * publicMetadata.role to "operator" or "owner" in the Clerk dashboard.
 */
export async function currentRole(): Promise<Role> {
  const user = await currentUser();
  const role = user?.publicMetadata?.role;
  return isRole(role) ? role : "viewer";
}
