import { campaignApprovalOf, type Item } from "@ai-manager/core";
import { formatCardTimestamp, formatDateTime } from "./emailDisplay";
import type {
  CampaignApprovalCardData,
  VariantView,
} from "./campaignApprovalView";

/**
 * SERVER-SIDE builder for the campaign approval card's data (SEA-83):
 * validates an item payload through core campaignApprovalOf (all four
 * card elements present or nothing; covered by the core offline smoke)
 * and shapes it into the client-safe CampaignApprovalCardData. Kept
 * separate from campaignApprovalView.ts so the client component never
 * imports the core barrel.
 *
 * Element 3 is normalized to a variants ARRAY (SEA-88): a briefed
 * campaign's payload.variants maps through one to one; the single-draft
 * shape becomes one whole-audience variant, so the components render
 * exactly one code path.
 */
/** Format the payload's send_at (ISO string or null/absent) for display
 * (PT via formatDateTime); null = sends on approval. Items filed before
 * SEA-84 lack the field, which reads the same as null. */
function sendAtDisplay(sendAt: string | null | undefined): string | null {
  if (typeof sendAt !== "string" || sendAt.length === 0) return null;
  const date = new Date(sendAt);
  return Number.isNaN(date.getTime()) ? sendAt : formatDateTime(date);
}

export function toCampaignApprovalCardData(
  item: Item,
): CampaignApprovalCardData | null {
  const payload = campaignApprovalOf(item.payload);
  if (!payload) return null;
  const segments = Object.entries(payload.audience.segments)
    .map(([segment, count]) => ({ segment, count }))
    .sort((a, b) => b.count - a.count);
  const snapshotDate = new Date(payload.audience.snapshot_at);
  const variants: VariantView[] = payload.variants
    ? payload.variants.map((v) => ({
        segment: v.segment,
        recipientCount: v.recipient_count,
        draftSubject: v.draft_subject,
        draftBody: v.draft_body,
        preview: v.rendered_preview,
      }))
    : [
        {
          segment: "",
          recipientCount: payload.audience.recipients,
          // campaignApprovalOf guarantees the single trio when variants
          // is absent.
          draftSubject: payload.draft_subject!,
          draftBody: payload.draft_body!,
          preview: payload.rendered_preview!,
        },
      ];
  return {
    id: String(item.id),
    campaignKey: payload.campaign_key,
    campaignName: payload.campaign_name,
    runSeq: payload.run_seq,
    audienceView: payload.audience_view,
    recipients: payload.audience.recipients,
    segments,
    snapshotAt: Number.isNaN(snapshotDate.getTime())
      ? payload.audience.snapshot_at
      : formatDateTime(snapshotDate),
    exclusions: payload.exclusions,
    variants,
    sendDiff: payload.send_diff,
    sendAtDisplay: sendAtDisplay(payload.send_at),
    rationale: payload.rationale,
    kbUnavailable: payload.kb_unavailable === true,
    receivedTime: formatCardTimestamp(item.created_at),
    receivedFull: formatDateTime(item.created_at),
  };
}
