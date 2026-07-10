"use client";

import { useState } from "react";
import { useActionState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  removeRejectedAction,
  type ApprovalActionState,
} from "../app/approvals/actions";

/**
 * Per-item Remove for a rejected item (GH-55). Explicit two-step confirm:
 * the first click swaps in a Confirm/Cancel pair (no browser confirm()
 * dialog), the second actually archives. On success the detail selection
 * is cleared back to the inbox so the operator lands on the list, not a
 * placeholder for an item that no longer exists here. A lost race (item
 * reopened or removed elsewhere) renders inline with a Refresh link,
 * matching the Reopen conflict pattern.
 */
export function RemoveRejectedButton({ id }: { id: string }) {
  const router = useRouter();
  // The rejected DecidedDetail also appears in the pending inbox's
  // recently-decided tail, so on success return to the CURRENT inbox's
  // base URL (clearing ?item), not a hardcoded one.
  const pathname = usePathname();
  const [confirming, setConfirming] = useState(false);
  const initial: ApprovalActionState = { error: null };
  const [state, formAction, pending] = useActionState(
    async (prev: ApprovalActionState, formData: FormData) => {
      const next = await removeRejectedAction(prev, formData);
      if (next.error === null) {
        router.push(pathname);
      }
      return next;
    },
    initial,
  );

  return (
    <form action={formAction} className="decided-reopen-form decided-remove-form">
      <input type="hidden" name="id" value={id} />
      {confirming ? (
        <>
          <button
            type="submit"
            className="decided-remove decided-remove--confirm"
            disabled={pending}
          >
            {pending ? "Removing…" : "Confirm remove"}
          </button>
          <button
            type="button"
            className="decided-reopen"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="decided-remove"
          onClick={() => setConfirming(true)}
        >
          Remove
        </button>
      )}
      {state.error ? (
        <span role="alert" className="decided-reopen-error">
          {state.error}{" "}
          <button
            type="button"
            className="approval-refresh-link"
            onClick={(e) => {
              e.preventDefault();
              router.refresh();
            }}
          >
            Refresh
          </button>
        </span>
      ) : null}
    </form>
  );
}
