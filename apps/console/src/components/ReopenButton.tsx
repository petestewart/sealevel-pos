"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import {
  reopenItemAction,
  type ReopenState,
} from "../app/approvals/actions";

/**
 * Reopen control for a Recently decided row (GH-25). Sits inline in the
 * decided meta line where the design's Undo link lived (Console.dc.html
 * decided row). On a dedupe conflict the server action returns an error
 * message instead of throwing, rendered inline below the meta line.
 */
export function ReopenButton({ id }: { id: string }) {
  const router = useRouter();
  const initial: ReopenState = { error: null };
  const [state, formAction, pending] = useActionState(
    reopenItemAction,
    initial,
  );

  return (
    <form action={formAction} className="decided-reopen-form">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="decided-reopen" disabled={pending}>
        {pending ? "Reopening…" : "Reopen"}
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
