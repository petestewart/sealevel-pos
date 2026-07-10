import Link from "next/link";
import type { RowView } from "../lib/itemView";

/**
 * Compact, scannable inbox list row (A1c, GH-29): the collapsed state of
 * an item. A status dot (tone), sender, time, subject, and a truncated
 * preview. The whole row is a Link that sets ?item=<id>, so selection is
 * URL-driven: deep-linkable, shareable, and back-button friendly. The
 * active row is highlighted with the accent-soft selection token.
 */
export function ItemRow({
  row,
  href,
  active,
}: {
  row: RowView;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`item-row${active ? " is-active" : ""}`}
      aria-current={active ? "true" : undefined}
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
