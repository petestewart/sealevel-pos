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

/** AI assignee suggestion passed to the header chip (GH-95). */
export interface AssigneeSuggestionData {
  category: string;
  /** Default owner display name for the route ("" for general/none). */
  suggestedName: string;
  reason: string;
}

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
 * When outbound send is enabled for the deployment (GH-95), an Approve
 * actually delivers, so the confirmation says so instead of the v1
 * "nothing sends" copy. No em dashes.
 */
const APPROVE_SEND_TOAST = "Approved. Sending the reply to the customer.";
const SAVE_APPROVE_SEND_TOAST =
  "Saved and approved. Sending the reply to the customer.";

/**
 * Two-pane approval card (Console.dc.html approvals spec): header row
 * (mono id, intent chip, time, assignee, Pending chip), original message
 * left, AI draft reply right on the --draft background, footer actions.
 * "Edit" swaps the right pane to a subject input + body
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
  /**
   * AI assignee suggestion (GH-95), or null. Shown as a one-click chip on
   * an unassigned item; applying it assigns through the normal audited
   * path (AI suggests, human confirms).
   */
  suggestion: AssigneeSuggestionData | null;
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

export interface SignoffDefaultData {
  /** The user's effective global signoff setting (GH-66). */
  mode: "default" | "name";
  /** What "My name" signs with, or null when no usable name exists. */
  name: string | null;
}

export function ApprovalCard({
  item,
  canDecide,
  advanceHref,
  signoffDefault,
  assignees = [],
  sendEnabled = false,
}: {
  item: ApprovalCardData;
  canDecide: boolean;
  /** Assignable users for the header picker (GH-79). */
  assignees?: AssignableUser[];
  /**
   * Whether outbound send is enabled for this deployment (GH-95). Only
   * affects confirmation copy: an approval delivers when true, so the
   * toast says "sending" instead of the v1 "nothing sends" line.
   */
  sendEnabled?: boolean;
  /**
   * URL to move selection to after a successful decision (A2, GH-30): the
   * next still-pending row, or the inbox base when none remain. Optional so
   * the card still renders (and decides) if a caller omits it; without it a
   * decision falls back to the server's own revalidate (no advance).
   */
  advanceHref?: string;
  /**
   * Preselected signoff for the per-email picker (GH-76): the user's
   * global setting. Optional so callers without the lookup still render;
   * the picker then defaults to the studio signoff.
   */
  signoffDefault?: SignoffDefaultData;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [editing, setEditing] = useState(false);
  // Per-email signoff override (GH-76). Pending client state, keyed to
  // this card instance (the card is keyed by item.id upstream), so it
  // survives revisions and router.refresh() but resets with the item.
  // Posted as signoff_mode with every decide; the server treats a missing
  // value as "use the global setting".
  const [signoffMode, setSignoffMode] = useState<"default" | "name" | "none">(
    signoffDefault?.mode ?? "default",
  );
  // Redo-draft icon lives in the draft header but the run/poll machinery
  // lives in ReviseBox: each press bumps the signal, ReviseBox runs one
  // redo per bump, and reviseWorking mirrors its busy state back so the
  // icon disables while any revise/redo run is in flight.
  const [redoSignal, setRedoSignal] = useState(0);
  const [reviseWorking, setReviseWorking] = useState(false);
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
          suggestion={item.suggestion}
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
            {canDecide && !editing ? (
              <button
                type="button"
                className="icon-btn draft-redo"
                disabled={reviseWorking}
                aria-label="Redo draft"
                title="Redo draft"
                onClick={(e) => {
                  e.preventDefault();
                  setRedoSignal((s) => s + 1);
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 2.5v3h-3"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
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
        <ReviseBox
          itemId={item.id}
          lastAnswer={item.lastAnswer}
          redoSignal={redoSignal}
          onWorkingChange={setReviseWorking}
        />
      ) : null}

      {canDecide ? (
        <div className="approval-card-actions">
          <label className="signoff-picker">
            <span className="micro-label">Signoff</span>
            <select
              name="signoff_mode"
              className="signoff-select"
              value={signoffMode}
              onChange={(e) =>
                setSignoffMode(e.target.value as "default" | "name" | "none")
              }
              aria-label="Signoff for this email"
            >
              <option value="default">Sealevel Hot Yoga</option>
              {signoffDefault?.name ? (
                <option value="name">My name ({signoffDefault.name})</option>
              ) : null}
              <option value="none">No signoff</option>
            </select>
          </label>
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
                  sendEnabled ? SAVE_APPROVE_SEND_TOAST : SAVE_APPROVE_TOAST,
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
                onClick={decide(
                  approveItemAction,
                  sendEnabled ? APPROVE_SEND_TOAST : APPROVE_TOAST,
                  true,
                )}
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
                Edit
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
