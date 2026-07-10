"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Serializable sidebar entry, built server-side from the inbox registry. */
export interface InboxSidebarEntry {
  slug: string;
  label: string;
  tone: string;
  count: number;
}

/**
 * Left sidebar of inboxes (A1b, email-app shape): one link per registry
 * entry with a status dot and a live count pill. Active state follows the
 * current /items/[status] route.
 */
export function InboxSidebar({ entries }: { entries: InboxSidebarEntry[] }) {
  const pathname = usePathname();

  return (
    <nav className="inbox-sidebar" aria-label="Inboxes">
      <div className="inbox-sidebar-label">Inboxes</div>
      {entries.map((entry) => {
        const href = `/items/${entry.slug}`;
        const active = pathname === href;
        return (
          <Link
            key={entry.slug}
            href={href}
            className={`inbox-link${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span
              className={`status-dot dot--${entry.tone}`}
              aria-hidden="true"
            />
            <span className="inbox-link-label">{entry.label}</span>
            <span className="inbox-pill">{entry.count}</span>
          </Link>
        );
      })}
    </nav>
  );
}
