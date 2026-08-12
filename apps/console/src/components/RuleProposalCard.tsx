"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { StatusChip } from "./StatusChip";
import { useToast } from "./Toast";
import { evidenceKindLabel } from "../lib/ruleProposalDisplay";
import { type RuleProposalCardData } from "../lib/ruleProposalView";
import {
  approveRuleProposalAction,
  rejectRuleProposalAction,
  saveRuleEditsAction,
  type ApprovalActionState,
} from "../app/approvals/actions";

const initialActionState: ApprovalActionState = { error: null };

/**
 * Approval card for a pending rule_proposal (learning loop, GH-127):
 * the proposed rule text (editable before approval, like draft edits),
 * the evidence it was mined from (before/after excerpts with item ids),
 * the miner confidence, and Approve/Reject through the standard guarded
 * decide path. Approving adds the rule to Settings (the only way a mined
 * lesson is ever learned); rejecting records the lesson in the negative
 * memory so rephrasings are not re-proposed. Same decider gate,
 * double-submit immunity, stale-conflict inline message, and advance-on-
 * decide behavior as the email and KB cards.
 */

const APPROVE_TOAST =
  "Approved. The rule was added to Settings and applies to future drafts.";
const REJECT_TOAST =
  "Rejected. This lesson will not be proposed again.";

export function RuleProposalCard({
  item,
  canDecide,
  advanceHref,
}: {
  item: RuleProposalCardData;
  canDecide: boolean;
  /** Where to advance selection after a decision (A2 pattern), if any. */
  advanceHref?: string;
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
  // pattern, same as ApprovalCard / KbUpdateCard).
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

  // No-JS fallback dispatchers (progressive enhancement).
  const [approveState, approveDispatch] = useActionState(
    approveRuleProposalAction,
    initialActionState,
  );
  const [rejectState, rejectDispatch] = useActionState(
    rejectRuleProposalAction,
    initialActionState,
  );
  const [saveState, saveDispatch] = useActionState(
    saveRuleEditsAction,
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

  return (
    <form className="approval-card" ref={formRef}>
      <input type="hidden" name="id" value={item.id} />

      <div className="approval-card-head">
        <span className="approval-card-id">#{item.id.slice(0, 8)}</span>
        <span className="intent-chip">Rule proposal</span>
        <span className="tag-chip">learned lesson</span>
        <span className="approval-card-time">{item.receivedTime}</span>
        <span className="approval-card-status">
          <StatusChip variant="pending" />
        </span>
      </div>

      <div className="kb-card-body">
        <div className="kb-card-meta">
          <p className="kb-card-summary">
            The system noticed a repeated pattern in recent operator
            corrections and proposes this drafting rule. Approving adds it
            to Settings, where it applies to every future draft and can be
            edited or deleted at any time. Nothing is learned without your
            approval.
          </p>
          <div className="kb-card-source">
            {item.confidence !== null ? (
              <span
                className="kb-confidence"
                title="Miner confidence that this pattern repeats across the evidence"
              >
                confidence {Math.round(item.confidence * 100)}%
              </span>
            ) : null}
            {item.minedWindow ? (
              <span className="approval-pane-timestamp">
                mined from {item.minedWindow.signals} correction
                {item.minedWindow.signals === 1 ? "" : "s"}
                {item.minedWindow.to ? ` through ${item.minedWindow.to}` : ""}
              </span>
            ) : null}
            {item.edited ? (
              <span className="approval-pane-timestamp">edited</span>
            ) : null}
          </div>
        </div>

        {editing ? (
          <>
            <label className="field-label" htmlFor={`rule-text-${item.id}`}>
              Proposed rule
            </label>
            <textarea
              id={`rule-text-${item.id}`}
              name="rule_text"
              defaultValue={item.ruleText}
              maxLength={500}
              required
              autoFocus
              className="draft-body-input settings-rule-input"
            />
          </>
        ) : (
          <div className="kb-card-page">
            <span className="micro-label">Proposed rule</span>
            <p className="draft-rationale-text">{item.ruleText}</p>
          </div>
        )}

        {item.evidence.length > 0 ? (
          <details className="draft-rationale" open>
            <summary className="draft-rationale-summary">
              <span className="micro-label">
                Evidence ({item.evidence.length})
              </span>
            </summary>
            {item.evidence.map((e, i) => (
              <div key={`${e.item_id}-${i}`} className="kb-card-meta">
                <span className="micro-label">
                  {evidenceKindLabel(e.kind)} (item #{e.item_id.slice(0, 8)})
                </span>
                {e.note ? (
                  <p className="draft-rationale-text">{e.note}</p>
                ) : null}
                {e.before !== undefined ? (
                  <>
                    <span className="micro-label">AI draft</span>
                    <p className="draft-rationale-text">{e.before}</p>
                  </>
                ) : null}
                {e.after !== undefined ? (
                  <>
                    <span className="micro-label">After the operator</span>
                    <p className="draft-rationale-text">{e.after}</p>
                  </>
                ) : null}
              </div>
            ))}
          </details>
        ) : null}
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
                onClick={decide(approveRuleProposalAction, APPROVE_TOAST)}
                formNoValidate
              >
                Approve rule
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
            onClick={decide(rejectRuleProposalAction, REJECT_TOAST)}
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
