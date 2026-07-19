"use client";

import { useState } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import {
  releaseApprovedItemAction,
  sendApprovedBatchAction,
  type ApprovalActionState,
  type SendApprovedState,
} from "../app/approvals/actions";

/**
 * Release controls for the Approved queue (GH-106).
 *
 * ReleaseItemButton releases ONE staged reply (queues its delivery); it
 * sits in the decided detail's action row next to Reopen. Conflicts
 * (already released, reopened, changed by another operator) render as an
 * inline message with a Refresh affordance, matching the app's other
 * guarded actions.
 *
 * SendApprovedButton releases EVERYTHING staged, from the queue's list
 * toolbar. Two-step confirm (Confirm/Cancel swap), consistent with the
 * app's other irreversible bulk action (Clear all): releasing hands the
 * replies to the send pipeline, which cannot be taken back. Items staged
 * between arming and confirming are released too, since the action lists
 * the queue at click time.
 */

export function ReleaseItemButton({ id }: { id: string }) {
  const router = useRouter();
  const initial: ApprovalActionState = { error: null };
  const [state, formAction, pending] = useActionState(
    releaseApprovedItemAction,
    initial,
  );

  return (
    <form action={formAction} className="decided-reopen-form">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="decided-reopen" disabled={pending}>
        {pending ? "Releasing…" : "Release"}
      </button>
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

export function SendApprovedButton({ count }: { count: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const initial: SendApprovedState = { error: null };
  const [state, formAction, pending] = useActionState(
    async (prev: SendApprovedState, formData: FormData) => {
      const next = await sendApprovedBatchAction(prev, formData);
      if (next.error === null) {
        setConfirming(false);
        router.push("/items/queue");
      }
      return next;
    },
    initial,
  );

  return (
    <form action={formAction} className="send-approved">
      {confirming ? (
        <>
          <span className="clear-rejected-prompt">
            Release{" "}
            {count === 1 ? "1 approved reply" : `${count} approved replies`} for
            delivery?
          </span>
          <button
            type="submit"
            className="send-approved-btn"
            disabled={pending}
          >
            {pending ? "Releasing…" : "Confirm release"}
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
          className="send-approved-btn"
          onClick={() => setConfirming(true)}
        >
          Send approved ({count})
        </button>
      )}
      {state.error ? (
        <span role="alert" className="decided-reopen-error">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
