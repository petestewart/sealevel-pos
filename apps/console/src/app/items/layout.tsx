import {
  InboxSidebar,
  type InboxSidebarEntry,
} from "../../components/InboxSidebar";
import { decisionCounts, itemStatusCounts } from "../../lib/approvals";
import { INBOXES, type InboxCounts } from "../../lib/inboxes";

/**
 * Shell for the /items inbox routes (A1b): left sidebar of inboxes with
 * live count pills, content pane on the right. The sidebar is built from
 * the inbox registry, so future inboxes are additive entries.
 */

/** The shell must render even if Postgres is briefly down. */
async function loadCounts(): Promise<InboxCounts> {
  try {
    const [statuses, decisions] = await Promise.all([
      itemStatusCounts(),
      decisionCounts(),
    ]);
    return { statuses, decisions };
  } catch {
    return {
      statuses: { open: 0, unassigned: 0, pending_approval: 0, resolved: 0 },
      decisions: { approved: 0, rejected: 0 },
    };
  }
}

export default async function ItemsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const counts = await loadCounts();
  const entries: InboxSidebarEntry[] = INBOXES.map((inbox) => ({
    slug: inbox.slug,
    label: inbox.label,
    tone: inbox.tone,
    count: inbox.count(counts),
  }));

  return (
    <div className="items-shell">
      <InboxSidebar entries={entries} />
      <div className="items-content">{children}</div>
    </div>
  );
}
