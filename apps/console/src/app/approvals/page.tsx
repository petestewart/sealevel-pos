import { redirect } from "next/navigation";

/**
 * The approvals inbox moved to /items/pending (A1b sidebar inboxes).
 * This route stays as a redirect so old links and bookmarks keep working.
 * A temporary (307) redirect on purpose: browsers cache 308s aggressively.
 */
export default function ApprovalsPage() {
  redirect("/items/pending");
}
