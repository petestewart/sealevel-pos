"use client";

import { useState } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import {
  clearRejectedAction,
  type ClearRejectedState,
} from "../app/approvals/actions";

/**
 * Clear all rejected items (GH-55), shown in the Rejected inbox list
 * header. Explicit two-step confirm (Confirm/Cancel swap, no browser
 * confirm() dialog); the action archives every rejected item in one
 * statement, so items rejected between arming and confirming are cleared
 * too, and clearing an already-empty inbox is a quiet no-op. On success
 * the selection is cleared back to the inbox base URL.
 */
export function ClearRejectedButton({ count }: { count: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const initial: ClearRejectedState = { error: null };
  const [, formAction, pending] = useActionState(
    async (prev: ClearRejectedState, formData: FormData) => {
      const next = await clearRejectedAction(prev, formData);
      if (next.error === null) {
        setConfirming(false);
        router.push("/items/rejected");
      }
      return next;
    },
    initial,
  );

  return (
    <form action={formAction} className="clear-rejected">
      {confirming ? (
        <>
          <span className="clear-rejected-prompt">
            Remove {count === 1 ? "1 rejected item" : `${count} rejected items`}{" "}
            from this inbox?
          </span>
          <button
            type="submit"
            className="decided-remove decided-remove--confirm"
            disabled={pending}
          >
            {pending ? "Clearing…" : "Confirm clear"}
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
          Clear all
        </button>
      )}
    </form>
  );
}
