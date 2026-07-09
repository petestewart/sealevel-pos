import { currentUser } from "@clerk/nextjs/server";

/**
 * Minimal RBAC stub (ARCHITECTURE.md "Operator console" and "Auth/identity").
 * v1 keeps this deliberately small: the role lives on the Clerk user's
 * publicMetadata.role, and a static map gates permissions. The users table,
 * per-user dashboard_layouts, and richer roles (manager, instructor,
 * collaborator) are later tickets.
 */

export type Role = "owner" | "operator" | "viewer";

export type Permission = "items:view" | "approvals:decide";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ["items:view", "approvals:decide"],
  operator: ["items:view", "approvals:decide"],
  viewer: ["items:view"],
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
