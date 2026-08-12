import { currentUser } from "@clerk/nextjs/server";
import { hasPermission, isRole, type Permission, type Role } from "@ai-manager/core";

/**
 * Minimal RBAC (ARCHITECTURE.md "Operator console" and "Auth/identity").
 * The pure role -> permission POLICY moved to @ai-manager/core (SEA-83)
 * so the offline smoke suite asserts the gates in CI; this module keeps
 * the Clerk-bound role resolution and re-exports the policy so every
 * existing console import site is unchanged. Server-side only (Clerk).
 */

export { hasPermission };
export type { Permission, Role };

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
