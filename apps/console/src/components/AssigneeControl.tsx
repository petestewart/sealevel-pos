"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  assignItemAction,
  type ApprovalActionState,
} from "../app/approvals/actions";
import type { AssignableUser } from "../lib/assignees";
import type { AssigneeSuggestionData } from "./ApprovalCard";

/**
 * Assignment picker for a pending item's card header (GH-79). A compact
 * select of assignable users (Clerk operators/owners) plus Unassigned;
 * changing it submits immediately. The form carries the last-seen
 * assignee id, so a lost race renders an inline stale message with a
 * Refresh affordance instead of silently overwriting another operator's
 * assignment.
 *
 * When the Clerk user list is unavailable (options === []), the select
 * still renders the current assignee (from stored display data) and the
 * Unassigned option, so unassign keeps working during a Clerk outage.
 */
export function AssigneeControl({
  itemId,
  assigneeId,
  assigneeName,
  options,
  canDecide,
  suggestion,
}: {
  itemId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  options: AssignableUser[];
  canDecide: boolean;
  /** AI assignee suggestion (GH-95), or null; shown only when unassigned. */
  suggestion?: AssigneeSuggestionData | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<ApprovalActionState | null>(null);
  const [isPending, startTransition] = useTransition();
  // Optimistic value so the select shows the chosen assignee during the
  // server round-trip instead of snapping back to the prop; reset to the
  // server truth on error or when the refreshed prop arrives.
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);

  // Once the refreshed server prop catches up with the optimistic value,
  // drop the override so later external changes are never masked by it.
  useEffect(() => {
    if (optimistic !== null && (assigneeId ?? "") === optimistic) {
      setOptimistic(null);
    }
  }, [assigneeId, optimistic]);

  if (!canDecide) {
    return assigneeName ? (
      <span className="assignee-label" title="Assigned to">
        {assigneeName}
      </span>
    ) : null;
  }

  // Ensure the current assignee is always present as an option, even if
  // the Clerk list omitted them (role changed, API degraded).
  const known = new Map(options.map((u) => [u.id, u.name]));
  if (assigneeId && !known.has(assigneeId)) {
    known.set(assigneeId, assigneeName ?? assigneeId);
  }

  // Match the suggested owner's display name to an eligible user: exact,
  // or by first name (routing owners are first names like "Pete"; Clerk
  // names may be full names). Case-insensitive. No match -> info-only chip.
  const suggestedUser =
    suggestion && suggestion.suggestedName
      ? options.find((u) => {
          const owner = suggestion.suggestedName.trim().toLowerCase();
          const name = u.name.trim().toLowerCase();
          return name === owner || name.split(/\s+/)[0] === owner;
        })
      : undefined;
  // The suggestion is only useful while the item is still unassigned.
  // (canDecide is already guaranteed here: the component early-returns above
  // when the viewer cannot decide.)
  const effectiveAssignee = optimistic ?? assigneeId ?? "";
  const showSuggestion = effectiveAssignee === "" && Boolean(suggestion);

  const submit = (value: string) => {
    if (value === (assigneeId ?? "")) return;
    const formData = new FormData();
    formData.set("id", itemId);
    formData.set("expected_assignee", assigneeId ?? "");
    formData.set("assignee_id", value);
    setState(null);
    setOptimistic(value);
    startTransition(async () => {
      const result = await assignItemAction({ error: null }, formData);
      setState(result);
      if (result.error) setOptimistic(null);
      else router.refresh();
    });
  };

  return (
    <span className="assignee-control">
      <label className="assignee-label" htmlFor={`assignee-${itemId}`}>
        Assignee
      </label>
      <select
        id={`assignee-${itemId}`}
        ref={selectRef}
        className="assignee-select"
        value={optimistic ?? assigneeId ?? ""}
        disabled={isPending}
        onChange={(e) => submit(e.target.value)}
      >
        <option value="">Unassigned</option>
        {[...known.entries()].map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {showSuggestion && suggestion ? (
        suggestedUser ? (
          <button
            type="button"
            className="assignee-suggest"
            title={
              suggestion.reason
                ? `AI suggestion: ${suggestion.reason}`
                : `Suggested from category: ${suggestion.category}`
            }
            disabled={isPending}
            onClick={() => submit(suggestedUser.id)}
          >
            <span className="assignee-suggest-spark" aria-hidden="true">
              &#9733;
            </span>
            Assign {suggestedUser.name}?
          </button>
        ) : (
          <span
            className="assignee-suggest assignee-suggest--info"
            title={
              suggestion.reason
                ? `AI suggestion: ${suggestion.reason}`
                : undefined
            }
          >
            <span className="assignee-suggest-spark" aria-hidden="true">
              &#9733;
            </span>
            AI suggests {suggestion.suggestedName}
          </span>
        )
      ) : null}
      {state?.error ? (
        <span className="assignee-error" role="alert">
          {state.error}{" "}
          {state.stale ? (
            <button
              type="button"
              className="approval-refresh-link"
              onClick={() => router.refresh()}
            >
              Refresh
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
