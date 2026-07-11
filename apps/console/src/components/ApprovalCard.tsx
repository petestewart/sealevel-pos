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
import { AssigneeControl } from "./AssigneeControl";
import type { AssignableUser } from "../lib/assignees";
import { paragraphsOf } from "../lib/emailDisplay";
import { InboundEmail, type AttachmentInfo } from "./InboundEmail";
import { ReviseBox, type LastAnswerData } from "./ReviseBox";
import {
  approveItemAction,
  rejectItemAction,
  saveAndApproveItemAction,
  saveEditsItemAction,
  type ApprovalActionState,
} from "../app/approvals/actions";

const initialActionState: ApprovalActionState = { error: null };

/**
 * Truthful decision confirmations (A2, GH-30). Nothing auto-sends in v1, so
 * the toast states only that the decision was recorded and the reply is
 * ready for a human to send. No claim of sending; no em dashes.
 */
const APPROVE_TOAST = "Approved. Reply is ready. Nothing sends automatically in v1.";
const SAVE_APPROVE_TOAST =
  "Saved and approved. Reply is ready. Nothing sends automatically in v1.";
const REJECT_TOAST = "Rejected. No reply will be sent.";

/**
 * Two-pane approval card (Console.dc.html approvals spec): header row
 * (mono id, intent chip, time, assignee, Pending chip), original message
 * left, AI draft reply right on the --draft background, footer actions.
 * "Edit then approve" swaps the right pane to a subject input + body
 * textarea and the footer to Save & approve / Cancel edit / Reject.
 *
 * Truthful copy (DESIGN-NOTES.md adaptation 1): nothing sends in v1, so
 * the buttons say "Approve" / "Save & approve", never "& send".
 */

export interface ApprovalCardData {
  id: string;
  intent: string;
  /** AI tag chip labels (GH-65); [] when untagged. */
  tags: string[];
  receivedTime: string;
  receivedFull: string;
  /** Assignee Clerk user id (items.assignee), or null (GH-79). */
  assigneeId: string | null;
  /** Assignee display name (payload.assignee_name), or null. */
  assigneeName: string | null;
  customer: string;
  initials: string;
  /** Original email subject, or "(no subject)". */
  inboundSubject: string;
  inbound: string;
  /** Attachment descriptors from payload.original_email.attachments. */
  attachments: AttachmentInfo[];
  draftSubject: string;
  draftBody: string;
  /** True when the operator saved draft edits (payload.draft_edited). */
  edited: boolean;
  /**
   * Model's "why this draft" note (payload.draft_rationale, GH-38), or
   * null for items that predate it. Null renders no note at all.
   */
  rationale: string | null;
  /**
   * Prior drafts (payload.draft_revisions, GH-36/GH-37), oldest first,
   * each already display-formatted. Empty for never-revised items.
   */
  revisions: DraftRevision[];
  /** Stored Q&A note (payload.last_answer), or null. */
  lastAnswer: LastAnswerData | null;
}

export interface DraftRevision {
  subject: string;
  body: string;
  /** Display-formatted revised_at, or "" when the timestamp was absent. */
  revisedAt: string;
}

export function ApprovalCard({
  item,
  canDecide,
  advanceHref,
  assignees = [],
}: {
  item: ApprovalCardData;
  canDecide: boolean;
  /** Assignable users for the header picker (GH-79). */
  assignees?: AssignableUser[];
  /**
   * URL to move selection to after a successful decision (A2, GH-30): the
   * next still-pending row, or the inbox base when none remain. Optional so
   * the card still renders (and decides) if a caller omits it; without it a
   * decision falls back to the server's own revalidate (no advance).
   */
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

  // No draft generated (empty or missing draft_body): show a fallback in
  // the draft pane and keep approval blocked until edits produce a body.
  const hasDraft = item.draftBody.length > 0;

  // Double-click immunity (GH-40): when the footer swaps button sets, the
  // incoming buttons render at the same coordinates, so the second click
  // of a double-click would activate whatever replaced the toggle. The
  // toggle handlers disarm synchronously (setArmed(false) in the same
  // commit that swaps the buttons, so they MOUNT disabled -- an effect
  // would run after paint, leaving a gap the double-click slips through);
  // this effect only re-arms them after the immunity window.
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

  // Each decide action is bound through useActionState purely to obtain a
  // progressive-enhancement dispatcher for `formAction`: with JS off (or
  // pre-hydration) the native POST runs the server action and revalidates.
  // When JS is present the button's onClick preventDefaults and drives the
  // enhanced flow (toast + advance) instead, so these dispatchers are the
  // no-JS fallback path only.
  const [approveState, approveAction] = useActionState(
    approveItemAction,
    initialActionState,
  );
  const [rejectState, rejectAction] = useActionState(
    rejectItemAction,
    initialActionState,
  );
  const [saveApproveState, saveApproveAction] = useActionState(
    saveAndApproveItemAction,
    initialActionState,
  );
  // Save edits (non-deciding, GH-25) keeps the item pending, so unlike a
  // decision the card is NOT replaced and its effect can reliably close the
  // editor. It never advances or toasts.
  const [saveEditsState, saveEditsAction] = useActionState(
    saveEditsItemAction,
    initialActionState,
  );

  // Close the editor after a successful Save edits (state object identity
  // changes on every dispatch; the initial object means nothing ran yet).
  const lastSaveEditsState = useRef(saveEditsState);
  useEffect(() => {
    if (saveEditsState !== lastSaveEditsState.current) {
      lastSaveEditsState.current = saveEditsState;
      if (!saveEditsState.error) toggleEditing(false);
    }
  }, [saveEditsState]);

  /**
   * Progressive-enhancement decide handler (A2, GH-30). Each decide button
   * keeps the RAW server action as its `formAction`, so with JS disabled (or
   * before hydration) the native form POST still records the decision and
   * revalidates -- correct fallback state, just no in-place advance. When JS
   * is present this onClick takes over: it runs the SAME server action and,
   * on success, shows a truthful toast and soft-navigates selection to the
   * next pending item. Advancing here (before the revalidated tree can
   * commit) is what keeps the decided card from flashing its own resolved
   * view. On an error (empty-draft guard GH-33, already-decided race GH-40)
   * it surfaces the message inline and does not advance. A decision in
   * flight disables the footer so a rapid second click cannot double-submit.
   */
  const decide =
    (
      action: (
        prev: ApprovalActionState,
        formData: FormData,
      ) => Promise<ApprovalActionState>,
      message: string,
      validate: boolean,
    ) =>
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const form = formRef.current;
      if (!form) return; // fall through to the native POST (no JS takeover)
      event.preventDefault();
      // Preserve the edit-then-approve required-field UX that formNoValidate
      // would otherwise skip; Reject passes validate=false (formNoValidate).
      if (validate && !form.reportValidity()) return;
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

  // First state carrying an error wins, from whichever path produced it
  // (enhanced onClick flow or a no-JS useActionState dispatch). Keeping the
  // whole state (not just the message) preserves the stale flag that drives
  // the Refresh affordance (GH-31).
  const errorState =
    [decideError, approveState, rejectState, saveApproveState, saveEditsState]
      .filter((s): s is ApprovalActionState => s !== null)
      .find((s) => s.error) ?? null;
  const actionError = errorState?.error ?? null;

  return (
    <form className="approval-card" ref={formRef}>
      <input type="hidden" name="id" value={item.id} />

      <div className="approval-card-head">
        <span className="approval-card-id">#{item.id.slice(0, 8)}</span>
        <span className="intent-chip">{item.intent}</span>
        {item.tags.map((t) => (
          <span key={t} className="tag-chip">
            {t}
          </span>
        ))}
        <span className="approval-card-time">{item.receivedTime}</span>
        <AssigneeControl
          itemId={item.id}
          assigneeId={item.assigneeId}
          assigneeName={item.assigneeName}
          options={assignees}
          canDecide={canDecide}
        />
        <span className="approval-card-status">
          <StatusChip variant="pending" />
        </span>
      </div>

      <div className="approval-card-panes">
        <div className="approval-pane approval-pane--inbound">
          <div className="approval-customer">
            <div className="approval-avatar" aria-hidden="true">
              {item.initials}
            </div>
            <div className="approval-customer-meta">
              <div className="approval-customer-name">{item.customer}</div>
              <div className="approval-customer-sub">Inbound</div>
            </div>
          </div>
          <div className="approval-pane-labelrow">
            <span className="micro-label">Original message</span>
            <span className="approval-pane-timestamp">{item.receivedFull}</span>
          </div>
          <div className="inbound-subject">{item.inboundSubject}</div>
          <InboundEmail body={item.inbound} attachments={item.attachments} />
        </div>

        <div className="approval-pane approval-pane--draft">
          <div className="approval-pane-labelrow">
            <span className="micro-label micro-label--accent">
              <span className="micro-label-dot" aria-hidden="true" />
              {editing ? "Editing draft" : "AI draft reply"}
            </span>
            {!editing && (item.edited || item.revisions.length > 0) ? (
              <span className="approval-pane-timestamp">
                {[
                  // History caps at 5 kept entries, so past that the exact
                  // revision number is unknowable: show "revision 5+".
                  item.revisions.length > 0
                    ? item.revisions.length >= 5
                      ? "revision 5+"
                      : `revision ${item.revisions.length}`
                    : null,
                  item.edited ? "edited" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </div>

          {editing ? (
            <>
              <label className="field-label" htmlFor={`subject-${item.id}`}>
                Subject
              </label>
              <input
                id={`subject-${item.id}`}
                name="subject"
                defaultValue={item.draftSubject}
                required
                autoFocus
                className="draft-subject-input"
              />
              <label className="field-label" htmlFor={`body-${item.id}`}>
                Body
              </label>
              <textarea
                id={`body-${item.id}`}
                name="body"
                defaultValue={item.draftBody}
                required
                className="draft-body-input"
              />
            </>
          ) : hasDraft ? (
            <>
              <div className="draft-subject">{item.draftSubject}</div>
              <div className="draft-body">
                {paragraphsOf(item.draftBody).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            </>
          ) : (
            <div className="draft-empty">(no draft generated)</div>
          )}

          {/* GH-38: collapsed "Why this draft" rationale note. Only for
              items whose payload carries draft_rationale; absent means no
              note (back-compat with pre-GH-38 items). Hidden while editing
              so the editor keeps its focused layout. */}
          {!editing && item.rationale ? (
            <details className="draft-rationale">
              <summary className="draft-rationale-summary">
                <span className="micro-label">Why this draft</span>
              </summary>
              <p className="draft-rationale-text">{item.rationale}</p>
            </details>
          ) : null}

          {/* GH-37: prior drafts, read-only, collapsed by default. Shown
              newest first so the most recent superseded draft is on top.
              Hidden while editing, like the rationale note. */}
          {!editing && item.revisions.length > 0 ? (
            <details className="draft-rationale draft-revisions">
              <summary className="draft-rationale-summary">
                <span className="micro-label">
                  Previous versions ({item.revisions.length})
                </span>
              </summary>
              {[...item.revisions].reverse().map((rev, i) => (
                <div className="draft-revision" key={i}>
                  <div className="draft-revision-head">
                    <span className="micro-label">
                      Version {item.revisions.length - i}
                    </span>
                    {rev.revisedAt ? (
                      <span className="approval-pane-timestamp">
                        replaced {rev.revisedAt}
                      </span>
                    ) : null}
                  </div>
                  <div className="draft-revision-subject">{rev.subject}</div>
                  <div className="draft-revision-body">
                    {paragraphsOf(rev.body).map((para, j) => (
                      <p key={j}>{para}</p>
                    ))}
                  </div>
                </div>
              ))}
            </details>
          ) : null}
        </div>
      </div>

      {/* GH-37: revise / Q&A box. Decide permission is required to send
          instructions (the server action re-checks), and the box only
          exists on the pending card at all: decided items render
          DecidedDetail, which has no ReviseBox. Hidden while editing so
          the editor keeps its focused layout. */}
      {canDecide && !editing ? (
        <ReviseBox itemId={item.id} lastAnswer={item.lastAnswer} />
      ) : null}

      {canDecide ? (
        <div className="approval-card-actions">
          {editing ? (
            <>
              <Button
                key="save-approve"
                type="submit"
                variant="primary"
                disabled={!armed || !hasDraft || isDeciding}
                formAction={saveApproveAction}
                onClick={decide(
                  saveAndApproveItemAction,
                  SAVE_APPROVE_TOAST,
                  true,
                )}
              >
                Save &amp; approve
              </Button>
              <Button
                key="save-edits"
                type="submit"
                variant="outlined"
                disabled={!armed || isDeciding}
                formAction={saveEditsAction}
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
                disabled={!armed || !hasDraft || isDeciding}
                formAction={approveAction}
                onClick={decide(approveItemAction, APPROVE_TOAST, true)}
              >
                Approve
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
                Edit then approve
              </Button>
            </>
          )}
          <Button
            key="reject"
            type="submit"
            variant="destructive-text"
            disabled={isDeciding}
            formAction={rejectAction}
            onClick={decide(rejectItemAction, REJECT_TOAST, false)}
            formNoValidate
            className="approval-reject"
          >
            Reject
          </Button>
          {actionError ? (
            <span role="alert" className="approval-action-error">
              {actionError}
              {errorState?.stale ? (
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
