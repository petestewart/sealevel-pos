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
          <path d="M12 2.5 L12 9.5 M9 7 L12 10 L15 7" />
          <path d="M4 12 L4 17 C4 18.6 5.4 20 7 20 L17 20 C18.6 20 20 18.6 20 17 L20 12" />
          <path d="M4 12 L8.5 12 L10 14.5 L14 14.5 L15.5 12 L20 12" />
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
          <path d="M9 3 L15 3 L16 5 L8 5 Z" />
          <path d="M6 5 L18 5 L17 18 C17 19.1 16.1 20 15 20 L9 20 C7.9 20 7 19.1 7 18 L6 5" />
          <path d="M10 9 L10 16 M12 9 L12 16 M14 9 L14 16" />
        </svg>
      );
    case "bell-off":
      // No reply needed (GH-115): a muted bell, "nothing to act on here".
      return (
        <svg {...shared}>
          <path d="M9.5 4.5 C10.2 4 11 3.7 12 3.7 C15 3.7 17 6 17 9 L17 13" />
          <path d="M7 7.5 L7 9 C7 12 6 14 5 15.5 L14.5 15.5" />
          <path d="M18 15.5 L19 15.5" />
          <path d="M10 18.5 C10.3 19.6 11.1 20.3 12 20.3 C12.9 20.3 13.7 19.6 14 18.5" />
          <path d="M4 4 L20 20" />
        </svg>
      );
    case "ban":
      // Trash / spam (GH-115 follow-on): a slashed circle, "junk lives
      // here". Distinct from the Rejected inbox's trash-can glyph.
      return (
        <svg {...shared}>
          <circle cx="12" cy="12" r="9" />
          <path d="M5.6 5.6 L18.4 18.4" />
        </svg>
      );
    case "send":
      // Approved queue (GH-106): a paper plane, "ready to go out".
      return (
        <svg {...shared}>
          <path d="m22 2-7 20-4-9-9-4Z" />
          <path d="M22 2 11 13" />
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
