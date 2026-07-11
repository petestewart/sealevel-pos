import { clerkClient } from "@clerk/nextjs/server";

/**
 * Assignable users for the assignment picker (GH-79): every Clerk user
 * whose publicMetadata.role is operator or owner (the roles that can
 * work items; viewers are read-only and never assignment targets).
 *
 * Sourced live from the Clerk backend API on each server render of the
 * inbox page. The dev instance has a handful of users, so a single
 * 100-user page is plenty; pagination is a later problem, flagged here
 * deliberately rather than hidden.
 *
 * Graceful degradation: any Clerk API failure returns [] so the inbox
 * still renders; the picker shows only the unassign option and the
 * current assignee's name keeps rendering from payload.assignee_name
 * (stored at assignment time, no lookup needed).
 */
export interface AssignableUser {
  id: string;
  name: string;
}

export async function assignableUsers(): Promise<AssignableUser[]> {
  try {
    const client = await clerkClient();
    const { data } = await client.users.getUserList({ limit: 100 });
    return data
      .filter((u) => {
        const role = u.publicMetadata?.role;
        return role === "operator" || role === "owner";
      })
      .map((u) => ({
        id: u.id,
        name:
          u.fullName ??
          u.firstName ??
          u.primaryEmailAddress?.emailAddress ??
          u.id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.warn(
      `[assignees] Clerk user list failed; picker degrades to unassign-only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}
