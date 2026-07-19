import {
  InboxSidebar,
  type InboxSidebarEntry,
} from "../../components/InboxSidebar";
import { ToastProvider } from "../../components/Toast";
import {
  decisionCounts,
  itemStatusCounts,
  stagedCount,
  trashedCount,
} from "../../lib/approvals";
import { INBOXES, type InboxCounts } from "../../lib/inboxes";

/**
 * Shell for the /items inbox routes (A1b): left sidebar of inboxes with
 * live count pills, content pane on the right. The sidebar is built from
 * the inbox registry, so future inboxes are additive entries.
 */

/** The shell must render even if Postgres is briefly down. */
async function loadCounts(): Promise<InboxCounts> {
  try {
    const [statuses, decisions, trashed, staged] = await Promise.all([
      itemStatusCounts(),
      decisionCounts(),
      trashedCount(),
      stagedCount(),
    ]);
    return { statuses, decisions, trashed, staged };
  } catch {
    return {
      statuses: { open: 0, unassigned: 0, pending_approval: 0, resolved: 0 },
      decisions: {
        approved: 0,
        rejected: 0,
        no_reply_needed: 0,
        trashed: 0,
        spam: 0,
      },
      trashed: 0,
      staged: 0,
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
    icon: inbox.icon,
    count: inbox.count(counts),
  }));

  return (
    <ToastProvider>
      <div className="items-shell">
        <InboxSidebar entries={entries} />
        <div className="items-content">{children}</div>
      </div>
    </ToastProvider>
  );
}
