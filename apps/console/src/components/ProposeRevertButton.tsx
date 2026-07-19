"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import {
  proposeKbRevertAction,
  type ApprovalActionState,
} from "../app/approvals/actions";

/**
 * "Propose revert" control for a committed KB write (GH-113). Files a NEW
 * pending kb_update whose proposed content is the prior page content; the
 * revert only takes effect after a human approves that proposal through
 * the standard gate, so this button never writes anything itself. Deduped
 * server-side; a second click surfaces the existing proposal's message.
 */
export function ProposeRevertButton({ id }: { id: string }) {
  const router = useRouter();
  const initial: ApprovalActionState = { error: null };
  const [state, formAction, pending] = useActionState(
    proposeKbRevertAction,
    initial,
  );

  return (
    <form action={formAction} className="decided-reopen-form">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="decided-reopen" disabled={pending}>
        {pending ? "Proposing…" : "Propose revert"}
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
