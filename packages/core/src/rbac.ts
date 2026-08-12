/**
 * RBAC policy (SEA-83): the pure role -> permission map, moved here from
 * the console's lib/rbac.ts so the offline smoke suite can assert the
 * gates in CI (the console has no test runner). The console keeps the
 * Clerk-bound role RESOLUTION (currentRole) and re-exports this policy;
 * the worker never consults it (jobs are not user-gated).
 *
 * v1 keeps this deliberately small: the role lives on the Clerk user's
 * publicMetadata.role, and this static map gates permissions. The users
 * table, per-user dashboard_layouts, and richer roles (manager,
 * instructor, collaborator) are later tickets.
 */

export type Role = "owner" | "operator" | "viewer";

export type Permission =
  | "items:view"
  | "campaigns:view"
  | "campaigns:decide"
  | "approvals:decide"
  | "settings:manage";

// campaigns:view gates a READ-ONLY surface (SEA-90), so it follows the
// items:view precedent: every role holds it.
//
// campaigns:decide (SEA-83) is the campaign approve/reject gate: a
// DECIDE-class permission held by owner + operator and explicitly NOT by
// viewer, and explicitly NOT the same permission as campaigns:view (per
// the SEA-90 review note: viewing a campaign must never imply the power
// to send one to a thousand inboxes).
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    "items:view",
    "campaigns:view",
    "campaigns:decide",
    "approvals:decide",
    "settings:manage",
  ],
  operator: [
    "items:view",
    "campaigns:view",
    "campaigns:decide",
    "approvals:decide",
  ],
  viewer: ["items:view", "campaigns:view"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isRole(value: unknown): value is Role {
  return value === "owner" || value === "operator" || value === "viewer";
}
