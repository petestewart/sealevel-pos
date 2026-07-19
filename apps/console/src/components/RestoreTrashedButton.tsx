"use client";

import { useActionState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  restoreTrashedAction,
  type ApprovalActionState,
} from "../app/approvals/actions";

/**
 * Restore a trashed item (GH-115 follow-on) from the Trash view: back to
 * the status it had before the trash/spam decision, decision preserved on
 * decision_history, and the Gmail message pulled back out of Trash/Spam
 * (best-effort, via the worker). Single-click (restoring is safe and
 * reversible, unlike Remove's archive); on success the selection clears
 * back to the current inbox's list, matching RemoveRejectedButton. A lost
 * race renders inline with a Refresh link.
 */
export function RestoreTrashedButton({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const initial: ApprovalActionState = { error: null };
  const [state, formAction, pending] = useActionState(
    async (prev: ApprovalActionState, formData: FormData) => {
      const next = await restoreTrashedAction(prev, formData);
      if (next.error === null) {
        router.push(pathname);
      }
      return next;
    },
    initial,
  );

  return (
    <form action={formAction} className="decided-reopen-form">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="decided-reopen" disabled={pending}>
        {pending ? "Restoring…" : "Restore"}
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
