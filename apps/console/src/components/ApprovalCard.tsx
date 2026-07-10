"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { StatusChip } from "./StatusChip";
import { paragraphsOf } from "../lib/emailDisplay";
import { InboundEmail, type AttachmentInfo } from "./InboundEmail";
import {
  approveItemAction,
  rejectItemAction,
  saveAndApproveItemAction,
  saveEditsItemAction,
  type ApprovalActionState,
} from "../app/approvals/actions";

const initialActionState: ApprovalActionState = { error: null };

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
  receivedTime: string;
  receivedFull: string;
  assignee: string | null;
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
}

export function ApprovalCard({
  item,
  canDecide,
}: {
  item: ApprovalCardData;
  canDecide: boolean;
}) {
  const [editing, setEditing] = useState(false);
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

  const actionError =
    approveState.error ??
    rejectState.error ??
    saveApproveState.error ??
    saveEditsState.error;

  return (
    <form className="approval-card">
      <input type="hidden" name="id" value={item.id} />

      <div className="approval-card-head">
        <span className="approval-card-id">#{item.id.slice(0, 8)}</span>
        <span className="intent-chip">{item.intent}</span>
        <span className="approval-card-time">{item.receivedTime}</span>
        {item.assignee ? (
          <span className="approval-card-time">· {item.assignee}</span>
        ) : null}
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
            {item.edited && !editing ? (
              <span className="approval-pane-timestamp">edited</span>
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
        </div>
      </div>

      {canDecide ? (
        <div className="approval-card-actions">
          {editing ? (
            <>
              <Button
                key="save-approve"
                type="submit"
                variant="primary"
                disabled={!armed || !hasDraft}
                formAction={saveApproveAction}
              >
                Save &amp; approve
              </Button>
              <Button
                key="save-edits"
                type="submit"
                variant="outlined"
                disabled={!armed}
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
                disabled={!armed || !hasDraft}
                formAction={approveAction}
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
            formAction={rejectAction}
            formNoValidate
            className="approval-reject"
          >
            Reject
          </Button>
          {actionError ? (
            <span role="alert" className="approval-action-error">
              {actionError}
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
