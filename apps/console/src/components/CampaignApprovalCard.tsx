"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { StatusChip } from "./StatusChip";
import { useToast } from "./Toast";
import {
  audienceHeadline,
  copyStatusLine,
  deltaMoreSuffix,
  EXCLUSION_REASON_LABELS,
  sendDiffHeadline,
  totalExcluded,
  variantHeading,
  type CampaignApprovalCardData,
} from "../lib/campaignApprovalView";
import {
  approveCampaignAction,
  rejectCampaignAction,
  type CampaignActionState,
} from "../app/campaigns/actions";

const initialActionState: CampaignActionState = { error: null };

const APPROVE_TOAST =
  "Campaign approved. Sending is a separate step and has not started.";
const REJECT_TOAST =
  "Rejected. The campaign is back in draft; rebuild or redraft it any time.";

/**
 * Approval card for a pending campaign_approval item (SEA-83): ONE
 * campaign-level approval, showing all four elements the decision needs
 * (audience size + segments from the frozen snapshot, the exclusion
 * report from the audience build, the rendered email exactly as it will
 * send with one real recipient's merge fields resolved, and the send-diff
 * versus the last send of this campaign key). Approve/Reject go through
 * the campaigns:decide-gated server actions; approving flips the campaign
 * to approved and STOPS (the send job is SEA-84). Same double-submit
 * immunity, stale-conflict inline message, and advance-on-decide behavior
 * as the other cards.
 */
export function CampaignApprovalCard({
  item,
  canDecide,
  advanceHref,
}: {
  item: CampaignApprovalCardData;
  canDecide: boolean;
  /** Where to advance selection after a decision (A2 pattern), if any. */
  advanceHref?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [isDeciding, startDeciding] = useTransition();
  const [decideError, setDecideError] = useState<CampaignActionState | null>(
    null,
  );

  // Double-click immunity (GH-40 pattern, same as the other cards).
  const [armed, setArmed] = useState(true);
  useEffect(() => {
    if (armed) return;
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, [armed]);

  // No-JS fallback dispatchers (progressive enhancement).
  const [approveState, approveDispatch] = useActionState(
    approveCampaignAction,
    initialActionState,
  );
  const [rejectState, rejectDispatch] = useActionState(
    rejectCampaignAction,
    initialActionState,
  );

  const decide =
    (
      action: (
        prev: CampaignActionState,
        formData: FormData,
      ) => Promise<CampaignActionState>,
      message: string,
    ) =>
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const form = formRef.current;
      if (!form) return; // fall through to the native POST
      event.preventDefault();
      const formData = new FormData(form);
      setDecideError(null);
      setArmed(false);
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
    [decideError, approveState, rejectState]
      .filter((s): s is CampaignActionState => s !== null)
      .find((s) => s.error) ?? null;

  const excluded = totalExcluded(item.exclusions);
  const nonZeroReasons = EXCLUSION_REASON_LABELS.filter(
    ([reason]) => (item.exclusions.counts[reason] ?? 0) > 0,
  );

  return (
    <form className="approval-card" ref={formRef}>
      <input type="hidden" name="id" value={item.id} />

      <div className="approval-card-head">
        <span className="approval-card-id">#{item.id.slice(0, 8)}</span>
        <span className="intent-chip">Campaign approval</span>
        <span className="tag-chip">
          {item.campaignKey}
          {item.runSeq > 1 ? ` · run ${item.runSeq}` : ""}
        </span>
        <span className="approval-card-time" title={item.receivedFull}>
          {item.receivedTime}
        </span>
        <span className="approval-card-status">
          <StatusChip variant="pending" />
        </span>
      </div>

      <div className="kb-card-body">
        <div className="kb-card-meta">
          <p className="kb-card-summary">
            {item.campaignName}: one approval for the whole campaign. Nothing
            has been sent, and approving does not send anything yet either; it
            marks the campaign approved for the separate send step. Rejecting
            returns it to draft.
          </p>
        </div>

        {/* 1. Audience: recipient count + segment breakdown (frozen snapshot). */}
        <div className="kb-card-page">
          <span className="micro-label">Audience (frozen snapshot)</span>
          <p className="draft-rationale-text">{audienceHeadline(item)}</p>
          <p className="approval-pane-timestamp">
            Snapshot frozen {item.snapshotAt} from {item.audienceView}.
          </p>
        </div>

        {/* 4. Send-diff vs the last send of this campaign key. */}
        <div className="kb-card-page">
          <span className="micro-label">Compared with the last send</span>
          <p className="draft-rationale-text">{sendDiffHeadline(item.sendDiff)}</p>
          {item.sendDiff ? (
            <>
              <p className="approval-pane-timestamp">{item.sendDiff.summary}</p>
              <p className="approval-pane-timestamp">
                Prior send: {item.sendDiff.priorSend.sentCount} mailed
                {item.sendDiff.priorSend.skippedSuppressedCount > 0
                  ? `, ${item.sendDiff.priorSend.skippedSuppressedCount} suppressed`
                  : ""}
                {item.sendDiff.priorSend.failedCount > 0
                  ? `, ${item.sendDiff.priorSend.failedCount} failed`
                  : ""}
                .
              </p>
              {/* copyChanged null is UNKNOWN by contract; never shown as
                  "unchanged" (sendDiffTypes.ts). */}
              <p
                className="approval-pane-timestamp"
                title={item.sendDiff.copySummary}
              >
                {copyStatusLine(item.sendDiff)}. {item.sendDiff.copySummary}
              </p>
              {item.sendDiff.recipientsAdded.sample.length > 0 ||
              item.sendDiff.recipientsDropped.sample.length > 0 ? (
                <details className="draft-rationale">
                  <summary className="draft-rationale-summary">
                    <span className="micro-label">Example changes</span>
                  </summary>
                  {item.sendDiff.recipientsAdded.sample.map((email) => (
                    <p key={`a-${email}`} className="draft-rationale-text">
                      added: {email}
                    </p>
                  ))}
                  {deltaMoreSuffix(item.sendDiff.recipientsAdded) ? (
                    <p className="approval-pane-timestamp">
                      added: {deltaMoreSuffix(item.sendDiff.recipientsAdded)}
                    </p>
                  ) : null}
                  {item.sendDiff.recipientsDropped.sample.map((email) => (
                    <p key={`r-${email}`} className="draft-rationale-text">
                      dropped: {email}
                    </p>
                  ))}
                  {deltaMoreSuffix(item.sendDiff.recipientsDropped) ? (
                    <p className="approval-pane-timestamp">
                      dropped: {deltaMoreSuffix(item.sendDiff.recipientsDropped)}
                    </p>
                  ) : null}
                </details>
              ) : null}
            </>
          ) : null}
        </div>

        {/* 2. Exclusion report from the audience build. */}
        <div className="kb-card-page">
          <span className="micro-label">
            Excluded by the audience build ({excluded})
          </span>
          <p className="approval-pane-timestamp">
            {item.exclusions.view_rows} qualified in the segment view;{" "}
            {item.recipients} in the audience, {excluded} excluded.
          </p>
          {nonZeroReasons.length === 0 ? (
            <p className="draft-rationale-text">Nobody was excluded.</p>
          ) : (
            <>
              {nonZeroReasons.map(([reason, label]) => (
                <p key={reason} className="draft-rationale-text">
                  {label}: {item.exclusions.counts[reason]}
                </p>
              ))}
              {item.exclusions.samples.length > 0 ? (
                <details className="draft-rationale">
                  <summary className="draft-rationale-summary">
                    <span className="micro-label">
                      Examples ({item.exclusions.samples.length})
                    </span>
                  </summary>
                  {item.exclusions.samples.map((s, i) => (
                    <p key={i} className="draft-rationale-text">
                      ({s.reason}) {s.detail}
                    </p>
                  ))}
                </details>
              ) : null}
            </>
          )}
        </div>

        {/* 3. The rendered email(s): one variant per segment for briefed
            campaigns (SEA-88), one whole-audience draft otherwise. Each
            preview is rendered for a real recipient from its segment. */}
        {item.variants.map((variant) => (
          <div className="kb-card-page" key={variant.segment || "single"}>
            <span className="micro-label">
              {variantHeading(variant, item.variants.length)}
            </span>
            <p className="draft-rationale-text">
              <strong>Subject:</strong> {variant.preview.subject}
            </p>
            {variant.preview.body.split(/\n{2,}/).map((para, i) => (
              <p key={i} className="draft-rationale-text">
                {para.split("\n").map((line, j) => (
                  <span key={j}>
                    {j > 0 ? <br /> : null}
                    {line}
                  </span>
                ))}
              </p>
            ))}
            <details className="draft-rationale">
              <summary className="draft-rationale-summary">
                <span className="micro-label">
                  Template with merge fields (what every{" "}
                  {item.variants.length > 1
                    ? `${variant.segment.replace(/_/g, " ")} recipient`
                    : "recipient"}{" "}
                  gets)
                </span>
              </summary>
              <p className="draft-rationale-text">
                <strong>Subject:</strong> {variant.draftSubject}
              </p>
              <p
                className="draft-rationale-text"
                style={{ whiteSpace: "pre-wrap" }}
              >
                {variant.draftBody}
              </p>
            </details>
          </div>
        ))}

        {item.rationale ? (
          <details className="draft-rationale" open>
            <summary className="draft-rationale-summary">
              <span className="micro-label">Why this draft</span>
            </summary>
            <p className="draft-rationale-text">{item.rationale}</p>
          </details>
        ) : null}
        {item.kbUnavailable ? (
          <p className="approval-pane-timestamp">
            Note: the knowledge base was unavailable during drafting; facts
            may be missing.
          </p>
        ) : null}
      </div>

      {canDecide ? (
        <div className="approval-card-actions">
          <Button
            key="approve"
            type="submit"
            variant="primary"
            disabled={!armed || isDeciding}
            formAction={approveDispatch}
            onClick={decide(approveCampaignAction, APPROVE_TOAST)}
            formNoValidate
          >
            Approve campaign
          </Button>
          <Button
            key="reject"
            type="submit"
            variant="destructive-text"
            disabled={isDeciding}
            formAction={rejectDispatch}
            onClick={decide(rejectCampaignAction, REJECT_TOAST)}
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
          Your role can view this campaign but not decide it.
        </div>
      )}
    </form>
  );
}
