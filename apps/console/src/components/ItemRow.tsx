"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { RowView } from "../lib/itemView";
import { listScrollKey, MOBILE_MEDIA_QUERY } from "./ListScrollRestore";

/**
 * Compact, scannable inbox list row (A1c, GH-29): the collapsed state of
 * an item. A status dot (tone), sender, time, subject, and a truncated
 * preview. The whole row is a Link that sets ?item=<id>, so selection is
 * URL-driven: deep-linkable, shareable, and back-button friendly. The
 * active row is highlighted with the accent-soft selection token.
 *
 * At the mobile breakpoint tapping a row swaps the list for a full-screen
 * detail (A7, GH-35), so the tap first saves the list's scroll position
 * for ListScrollRestore to put back when the operator returns. Above the
 * breakpoint the handler is a no-op and navigation is unchanged.
 */
export function ItemRow({
  row,
  href,
  active,
  muted = false,
}: {
  row: RowView;
  href: string;
  active: boolean;
  /** Renders the row de-emphasized (the pending inbox's decided tail, GH-54). */
  muted?: boolean;
}) {
  const pathname = usePathname();

  const saveListScroll = () => {
    if (!window.matchMedia(MOBILE_MEDIA_QUERY).matches) return;
    sessionStorage.setItem(listScrollKey(pathname), String(window.scrollY));
  };

  return (
    <Link
      href={href}
      className={`item-row${active ? " is-active" : ""}${muted ? " is-muted" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={saveListScroll}
    >
      <span
        className={`status-dot dot--${row.tone}`}
        aria-hidden="true"
      />
      <span className="item-row-body">
        <span className="item-row-top">
          <span className="item-row-sender">{row.sender}</span>
          <span className="item-row-time">{row.time}</span>
        </span>
        <span className="item-row-subject">{row.subject}</span>
        <span className="item-row-preview">{row.preview}</span>
      </span>
    </Link>
  );
}
