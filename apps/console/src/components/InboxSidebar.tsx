"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { InboxIcon } from "../lib/inboxes";

/** Serializable sidebar entry, built server-side from the inbox registry. */
export interface InboxSidebarEntry {
  slug: string;
  label: string;
  tone: string;
  icon: InboxIcon;
  count: number;
}

/**
 * Left sidebar of inboxes (A1b, email-app shape): one link per registry
 * entry with a status dot and a live count pill. Active state follows the
 * current /items/[status] route.
 *
 * The sidebar can collapse into an icon-only rail (GH-77): labels and
 * pills give way to per-inbox glyphs with small count badges, and the
 * inbox name moves into the link's title tooltip. The preference is
 * stored in localStorage and applied in an effect (never in initial
 * state) so the first client render matches the always-expanded server
 * render -- the same hydration-safe pattern as RecentlyDecidedSection
 * (GH-64), at the cost of a one-frame expanded flash for rail users.
 * Mobile (<=720px) ignores the preference entirely: the toggle is hidden
 * and the collapsed styles are scoped to desktop widths, so the phone
 * layout is untouched.
 */

const STORAGE_KEY = "inbox-sidebar-collapsed";

/**
 * Inline glyphs for the collapsed rail, keyed by the registry's
 * InboxIcon. currentColor keeps them theme-correct in both palettes.
 */
function Glyph({ icon }: { icon: InboxIcon }) {
  const shared = {
    width: 17,
    height: 17,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (icon) {
    case "clock":
      return (
        <svg {...shared}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "check":
      return (
        <svg {...shared}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12.5 2.5 2.5 4.5-5" />
        </svg>
      );
    case "x":
      return (
        <svg {...shared}>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 9 6 6m0-6-6 6" />
        </svg>
      );
    default: {
      const _exhaustive: never = icon;
      throw new Error(`InboxSidebar: unhandled inbox icon ${_exhaustive}`);
    }
  }
}

/** Matches the globals.css desktop breakpoint for the collapsed rail. */
const DESKTOP_QUERY = "(min-width: 721px)";

export function InboxSidebar({ entries }: { entries: InboxSidebarEntry[] }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  // The stored pref only ever applies on desktop: the mobile layout has no
  // toggle, so a leaked collapsed state would strip the row labels with no
  // way to recover. Tracked live so narrowing the window restores labels.
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Storage unavailable (private mode, blocked): stay expanded.
    }
    const mq = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Preference just won't persist.
      }
      return next;
    });
  }

  const railed = collapsed && isDesktop;

  return (
    <nav
      className={`inbox-sidebar${railed ? " is-collapsed" : ""}`}
      aria-label="Inboxes"
    >
      <div className="inbox-sidebar-head">
        <div className="inbox-sidebar-label">Inboxes</div>
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={!railed}
          aria-label={railed ? "Expand sidebar" : "Collapse sidebar"}
          title={railed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggle}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`sidebar-toggle-glyph${railed ? " is-collapsed" : ""}`}
          >
            <path d="m14 7-5 5 5 5" />
          </svg>
        </button>
      </div>
      {entries.map((entry) => {
        const href = `/items/${entry.slug}`;
        const active = pathname === href;
        return (
          <Link
            key={entry.slug}
            href={href}
            className={`inbox-link${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            aria-label={railed ? `${entry.label} (${entry.count})` : undefined}
            title={railed ? `${entry.label} (${entry.count})` : undefined}
          >
            {railed ? (
              <span className="inbox-icon-wrap">
                <Glyph icon={entry.icon} />
                <span className="inbox-badge">{entry.count}</span>
              </span>
            ) : (
              <>
                <span
                  className={`status-dot dot--${entry.tone}`}
                  aria-hidden="true"
                />
                <span className="inbox-link-label">{entry.label}</span>
                <span className="inbox-pill">{entry.count}</span>
              </>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
