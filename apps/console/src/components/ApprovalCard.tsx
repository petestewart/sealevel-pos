"use client";

import { useState } from "react";
import { Button } from "./Button";
import { StatusChip } from "./StatusChip";
import { paragraphsOf } from "../lib/emailDisplay";
import {
  approveItemAction,
  rejectItemAction,
  saveAndApproveItemAction,
} from "../app/approvals/actions";

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
  inbound: string;
  draftSubject: string;
  draftBody: string;
}

export function ApprovalCard({
  item,
  canDecide,
}: {
  item: ApprovalCardData;
  canDecide: boolean;
}) {
  const [editing, setEditing] = useState(false);

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
          <div className="approval-inbound-text">{item.inbound}</div>
        </div>

        <div className="approval-pane approval-pane--draft">
          <div className="approval-pane-labelrow">
            <span className="micro-label micro-label--accent">
              <span className="micro-label-dot" aria-hidden="true" />
              {editing ? "Editing draft" : "AI draft reply"}
            </span>
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
          ) : (
            <>
              <div className="draft-subject">{item.draftSubject}</div>
              <div className="draft-body">
                {paragraphsOf(item.draftBody).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {canDecide ? (
        <div className="approval-card-actions">
          {editing ? (
            <>
              <Button
                type="submit"
                variant="primary"
                formAction={saveAndApproveItemAction}
              >
                Save &amp; approve
              </Button>
              <Button
                type="button"
                variant="outlined"
                onClick={() => setEditing(false)}
              >
                Cancel edit
              </Button>
            </>
          ) : (
            <>
              <Button
                type="submit"
                variant="primary"
                formAction={approveItemAction}
              >
                Approve
              </Button>
              <Button
                type="button"
                variant="outlined"
                onClick={() => setEditing(true)}
              >
                Edit then approve
              </Button>
            </>
          )}
          <Button
            type="submit"
            variant="destructive-text"
            formAction={rejectItemAction}
            formNoValidate
            className="approval-reject"
          >
            Reject
          </Button>
        </div>
      ) : (
        <div className="approval-card-actions approval-card-actions--readonly">
          Your role can view but not decide.
        </div>
      )}
    </form>
  );
}
