"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Layout shell for the inbox list + detail split (GH-78). The panes are
 * server-rendered and passed in as nodes; this component only owns the
 * "detail expanded to full width" UI state, so toggling never refetches.
 *
 * State rules (issue #78):
 * - Per-session, not URL: kept in sessionStorage so it survives item-to-item
 *   navigation within the tab but resets in a new tab/session.
 * - Initial render is always the split view (matches the server render, so
 *   hydration never mismatches -- same pattern as RecentlyDecidedSection);
 *   the stored preference applies in an effect.
 * - Clearing the selection restores the split view AND drops the stored
 *   flag, so the next selection starts from the normal split.
 *
 * The toggle only renders when something is selected (expanding an empty
 * placeholder is meaningless). CSS scopes the whole feature to the
 * side-by-side layout (>920px): below that the panes already stack or
 * alternate full-screen (A7), so the control is hidden and the class is
 * inert -- mobile behavior is untouched.
 */

const STORAGE_KEY = "detail-pane-expanded";

function ExpandIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 9 7" />
      <path d="M6.5 13.5h-4v-4" />
      <path d="M2.5 13.5 7 9" />
    </svg>
  );
}

function ContractIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 6.5h-4v-4" />
      <path d="M14 2 9.5 6.5" />
      <path d="M2.5 9.5h4v4" />
      <path d="M2 14l4.5-4.5" />
    </svg>
  );
}

export function ListDetailShell({
  hasSelection,
  list,
  detail,
}: {
  hasSelection: boolean;
  list: ReactNode;
  detail: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!hasSelection) {
      // Deselecting restores the split and forgets the preference, per the
      // issue: "going back to no-selection restores split".
      setExpanded(false);
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // Storage unavailable: nothing to forget.
      }
      return;
    }
    try {
      setExpanded(window.sessionStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Storage unavailable (private mode, blocked): stay in split view.
    }
  }, [hasSelection]);

  function toggle() {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.sessionStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Preference just won't persist across navigations.
      }
      return next;
    });
  }

  const isExpanded = expanded && hasSelection;

  return (
    <div
      className={`list-detail${hasSelection ? " has-selection" : ""}${
        isExpanded ? " is-expanded" : ""
      }`}
    >
      {list}
      <div className="detail-pane">
        {hasSelection ? (
          <div className="detail-toolbar">
            <button
              type="button"
              className="icon-btn detail-expand-toggle"
              aria-pressed={isExpanded}
              aria-label={
                isExpanded
                  ? "Restore split view"
                  : "Expand reply to full width"
              }
              title={isExpanded ? "Restore split view" : "Expand to full width"}
              onClick={toggle}
            >
              {isExpanded ? <ContractIcon /> : <ExpandIcon />}
            </button>
          </div>
        ) : null}
        {detail}
      </div>
    </div>
  );
}
