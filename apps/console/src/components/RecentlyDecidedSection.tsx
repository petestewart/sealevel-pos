"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Collapsible wrapper for the pending inbox's recently-decided tail (GH-64).
 * The rows are server-rendered and passed as children; this component only
 * owns the open/closed state, so collapsing never refetches anything.
 *
 * The stored preference is read in an effect, not in the initial state, so
 * the first client render matches the server render (which is always
 * expanded) and hydration never mismatches. The cost is a one-frame flash
 * of the expanded list for users who keep it collapsed.
 *
 * When a tail row is the current selection (deep link, or the just-decided
 * item after an approve), the section auto-expands so the active row is
 * never hidden on arrival. It is an expansion, not a lock: the user can
 * still collapse it afterward, and the stored preference is untouched so
 * their choice reapplies on the next visit.
 */

const STORAGE_KEY = "pending-recent-tail-collapsed";

export function RecentlyDecidedSection({
  count,
  autoExpand,
  children,
}: {
  count: number;
  autoExpand: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (autoExpand) {
      // Selection moved onto a tail row: force the section open so the
      // active row is visible. This must SET state, not just skip the
      // storage read -- on a soft navigation the component instance
      // survives, so a previously applied collapsed pref would otherwise
      // keep hiding the active row.
      setCollapsed(false);
      return;
    }
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Storage unavailable (private mode, blocked): stay expanded.
    }
  }, [autoExpand]);

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

  return (
    <div className="list-tail-section">
      <button
        type="button"
        className="list-section-divider list-section-toggle"
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        <span
          className={`tail-chevron${collapsed ? " is-collapsed" : ""}`}
          aria-hidden="true"
        >
          {"▾"}
        </span>
        <span>
          Recently decided
          {collapsed ? ` (${count})` : ""}
        </span>
      </button>
      {collapsed ? null : children}
    </div>
  );
}
