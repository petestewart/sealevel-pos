"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { StatusChip } from "./StatusChip";
import { useToast } from "./Toast";
import { KbDiff } from "./KbDiff";
import type { KbCardData } from "../lib/kbView";
import {
  approveKbUpdateAction,
  rejectItemAction,
  saveKbEditsAction,
  type ApprovalActionState,
} from "../app/approvals/actions";

const initialActionState: ApprovalActionState = { error: null };

/**
 * Approval card for a pending kb_update proposal (GH-112): target page,
 * summary/rationale, source email link, and the proposed change rendered
 * as a diff against the page content the proposal was computed from.
 * Actions mirror the email card: Approve (records the decision and
 * enqueues the gated kb.write job), Edit (edit the proposed page content;
 * the AI original is preserved and the decision audit marks edited), and
 * Reject (records the decision, writes nothing). Same decider gate,
 * double-submit immunity, stale-conflict inline message, and advance-on-
 * decide behavior as ApprovalCard, without the email-only machinery
 * (signoff, revise, spam).
 */

const APPROVE_TOAST =
  "Approved. The update is being written to the knowledge base.";
const REJECT_TOAST = "Rejected. The knowledge base is unchanged.";

export function KbUpdateCard({
  item,
  canDecide,
  advanceHref,
  sourceHref,
  revertHref,
}: {
  item: KbCardData;
  canDecide: boolean;
  /** Where to advance selection after a decision (A2 pattern), if any. */
  advanceHref?: string;
  /** Deep link to the source email item, when it is still reachable. */
  sourceHref?: string | null;
  /** For a rollback proposal: deep link to the write being reverted. */
  revertHref?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [editing, setEditing] = useState(false);
  const [isDeciding, startDeciding] = useTransition();
  const [decideError, setDecideError] = useState<ApprovalActionState | null>(
    null,
  );

  // Double-click immunity when the footer swaps button sets (GH-40
  // pattern, same as ApprovalCard).
  const [armed, setArmed] = useState(true);
  useEffect(() => {
    if (armed) return;
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, [armed]);
  const toggleEditing = (next: boolean) => {
    setArmed(false);
    setEditing(next);
  };

  // No-JS fallback dispatchers (progressive enhancement, ApprovalCard
  // pattern): the buttons keep the raw server actions as formAction.
  const [approveState, approveDispatch] = useActionState(
    approveKbUpdateAction,
    initialActionState,
  );
  const [rejectState, rejectDispatch] = useActionState(
    rejectItemAction,
    initialActionState,
  );
  const [saveState, saveDispatch] = useActionState(
    saveKbEditsAction,
    initialActionState,
  );

  // Close the editor after a successful Save edits.
  const lastSaveState = useRef(saveState);
  useEffect(() => {
    if (saveState !== lastSaveState.current) {
      lastSaveState.current = saveState;
      if (!saveState.error) toggleEditing(false);
    }
  }, [saveState]);

  const decide =
    (
      action: (
        prev: ApprovalActionState,
        formData: FormData,
      ) => Promise<ApprovalActionState>,
      message: string,
    ) =>
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const form = formRef.current;
      if (!form) return; // fall through to the native POST
      event.preventDefault();
      const formData = new FormData(form);
      setDecideError(null);
      startDeciding(async () => {
        const result = await action(initialActionState, formData);
        if (result.error) {
          setDecideError(result);
          return;
        }
        toast.show(message);
        if (advanceHref) router.replace(advanceHref, { scroll: false });
      });
    };

  const errorState =
    [decideError, approveState, rejectState, saveState]
      .filter((s): s is ApprovalActionState => s !== null)
      .find((s) => s.error) ?? null;

  const isRevert = item.revertOfItemId !== null;

  return (
    <form className="approval-card" ref={formRef}>
      <input type="hidden" name="id" value={item.id} />

      <div className="approval-card-head">
        <span className="approval-card-id">#{item.id.slice(0, 8)}</span>
        <span className="intent-chip">
          {isRevert ? "KB revert" : "KB update"}
        </span>
        <span className="tag-chip">
          {item.changeKind === "new_page" ? "new page" : "edit"}
        </span>
        <span className="approval-card-time">{item.receivedTime}</span>
        <span className="approval-card-status">
          <StatusChip variant="pending" />
        </span>
      </div>

      <div className="kb-card-body">
        <div className="kb-card-meta">
          <div className="kb-card-page">
            <span className="micro-label">Wiki page</span>
            <span className="kb-page-name">{item.targetPage}</span>
          </div>
          {item.summary ? <p className="kb-card-summary">{item.summary}</p> : null}
          {item.rationale ? (
            <details className="draft-rationale" open>
              <summary className="draft-rationale-summary">
                <span className="micro-label">Why this update</span>
              </summary>
              <p className="draft-rationale-text">{item.rationale}</p>
            </details>
          ) : null}
          <div className="kb-card-source">
            {isRevert ? (
              revertHref ? (
                <Link href={revertHref} className="kb-source-link">
                  Reverts the update from item #{item.revertOfItemId!.slice(0, 8)}
                </Link>
              ) : (
                <span>
                  Reverts the update from item #{item.revertOfItemId!.slice(0, 8)}
                </span>
              )
            ) : item.source ? (
              sourceHref ? (
                <Link href={sourceHref} className="kb-source-link">
                  Source email: {item.source.subject ?? "(no subject)"}
                  {item.source.from ? ` from ${item.source.from}` : ""}
                </Link>
              ) : (
                <span>
                  Source email: {item.source.subject ?? "(no subject)"}
                  {item.source.from ? ` from ${item.source.from}` : ""}
                </span>
              )
            ) : null}
            {item.confidence !== null ? (
              <span
                className="kb-confidence"
                title="Detector confidence that this fact belongs in the wiki"
              >
                confidence {Math.round(item.confidence * 100)}%
              </span>
            ) : null}
            {item.edited ? (
              <span className="approval-pane-timestamp">edited</span>
            ) : null}
          </div>
        </div>

        {editing ? (
          <>
            <label className="field-label" htmlFor={`kb-content-${item.id}`}>
              Proposed page content
            </label>
            <textarea
              id={`kb-content-${item.id}`}
              name="proposed_content"
              defaultValue={item.proposedContent}
              required
              autoFocus
              className="draft-body-input kb-content-input"
            />
          </>
        ) : (
          <KbDiff
            before={item.baseContent}
            after={item.proposedContent}
            newPage={item.changeKind === "new_page"}
          />
        )}
      </div>

      {canDecide ? (
        <div className="approval-card-actions">
          {editing ? (
            <>
              <Button
                key="save-edits"
                type="submit"
                variant="primary"
                disabled={!armed || isDeciding}
                formAction={saveDispatch}
              >
                Save edits
              </Button>
              <Button
                key="cancel-edit"
                type="button"
                variant="outlined"
                disabled={!armed}
                onClick={(e) => {
                  e.preventDefault();
                  toggleEditing(false);
                }}
              >
                Cancel edit
              </Button>
            </>
          ) : (
            <>
              <Button
                key="approve"
                type="submit"
                variant="primary"
                disabled={!armed || isDeciding}
                formAction={approveDispatch}
                onClick={decide(approveKbUpdateAction, APPROVE_TOAST)}
                formNoValidate
              >
                Approve &amp; write
              </Button>
              <Button
                key="edit-toggle"
                type="button"
                variant="outlined"
                disabled={!armed}
                onClick={(e) => {
                  e.preventDefault();
                  toggleEditing(true);
                }}
              >
                Edit
              </Button>
            </>
          )}
          <Button
            key="reject"
            type="submit"
            variant="destructive-text"
            disabled={isDeciding}
            formAction={rejectDispatch}
            onClick={decide(rejectItemAction, REJECT_TOAST)}
            formNoValidate
            className="approval-reject"
          >
            Reject
          </Button>
          {errorState?.error ? (
            <span role="alert" className="approval-action-error">
              {errorState.error}
              {errorState.stale ? (
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
              ) : null}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="approval-card-actions approval-card-actions--readonly">
          Your role can view but not decide.
        </div>
      )}
    </form>
  );
}
