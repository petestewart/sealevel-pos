/**
 * CLIENT-SAFE view model + display helpers for campaign_approval items
 * (SEA-83). Deliberately imports nothing from @ai-manager/core so the
 * client card component can use these without pulling the core barrel
 * into a client bundle (the console `next build` note: add no NEW
 * client-side core imports). The server-side builder that validates an
 * item payload into this shape lives in campaignApprovalData.ts.
 */

/** One side of the recipient delta (structurally the serialized SEA-86
 * RecipientDelta): exact count + bounded ascending sample. */
export interface RecipientDeltaView {
  count: number;
  sample: string[];
  sampleLimit: number;
}

/** Prior-send identity (serialized SEA-86 PriorSendInfo: sentAt is an
 * ISO string in the JSON item payload, never a Date). */
export interface PriorSendInfoView {
  campaignId: string;
  runSeq: number;
  sentAt: string | null;
  sentCount: number;
  skippedSuppressedCount: number;
  failedCount: number;
}

/** Send-diff as the card renders it (structurally the serialized
 * canonical SendDiff from core sendDiffTypes.ts). */
export interface SendDiffView {
  campaignKey: string;
  recipientsAdded: RecipientDeltaView;
  recipientsDropped: RecipientDeltaView;
  /** null = UNKNOWN (no durable last-sent copy exists until SEA-84);
   * renderers must show it as "copy: unknown", never "unchanged". */
  copyChanged: boolean | null;
  copySummary: string;
  currentAudienceCount: number;
  priorSend: PriorSendInfoView;
  summary: string;
}

export interface ExclusionReportView {
  view_rows: number;
  counts: Record<string, number>;
  samples: Array<{ reason: string; detail: string; contact_id: string | null }>;
  built_at: string;
  summary: string;
}

export interface RenderedPreviewView {
  recipient: {
    contact_id: string;
    email: string;
    first_name: string | null;
    segment: string;
  };
  subject: string;
  body: string;
}

/** Serializable card data for a campaign_approval item. */
export interface CampaignApprovalCardData {
  id: string;
  campaignKey: string;
  campaignName: string;
  runSeq: number;
  audienceView: string;
  /** Element 1: frozen-snapshot recipient count + segment breakdown. */
  recipients: number;
  segments: Array<{ segment: string; count: number }>;
  snapshotAt: string;
  /** Element 2: the exclusion report from the audience build. */
  exclusions: ExclusionReportView;
  /** The stored draft (merge fields unresolved). */
  draftSubject: string;
  draftBody: string;
  /** Element 3: the email exactly as it will send, one real recipient's
   * merge fields resolved. */
  preview: RenderedPreviewView;
  /** Element 4: diff vs the last send; null = no completed prior send
   * (first send, or the prior run is still mid-flight). */
  sendDiff: SendDiffView | null;
  rationale: string;
  kbUnavailable: boolean;
  receivedTime: string;
  receivedFull: string;
}

/** Operator-facing labels for exclusion reasons, in filter-chain order.
 * No em dashes. */
export const EXCLUSION_REASON_LABELS: ReadonlyArray<[string, string]> = [
  ["unmappable", "No matching contact"],
  ["ambiguous", "Ambiguous identity"],
  ["no_email", "No email address"],
  ["unsubscribed", "Not subscribed"],
  ["suppressed", "Suppressed address"],
];

/**
 * One human line summarizing the audience ("1,247 recipients: 412 hot
 * only, ..."), the card's headline. No em dashes.
 */
export function audienceHeadline(data: CampaignApprovalCardData): string {
  const n = data.recipients.toLocaleString("en-US");
  const parts = data.segments.map(
    (s) => `${s.count.toLocaleString("en-US")} ${s.segment.replace(/_/g, " ")}`,
  );
  return `${n} recipient${data.recipients === 1 ? "" : "s"}${
    parts.length > 0 ? `: ${parts.join(", ")}` : ""
  }`;
}

/**
 * One human line for the send-diff section. No em dashes. The null case
 * covers BOTH a true first send and a prior run whose sends are all
 * still queued (computeSendDiff returns null for either), so the wording
 * claims only what is known.
 */
export function sendDiffHeadline(diff: SendDiffView | null): string {
  if (!diff) return "No completed prior send of this campaign.";
  const unchanged = diff.currentAudienceCount - diff.recipientsAdded.count;
  return `Versus the last send: ${diff.recipientsAdded.count} added, ${diff.recipientsDropped.count} dropped, ${unchanged} unchanged.`;
}

/**
 * Copy-comparison status line. copyChanged null is UNKNOWN by contract
 * (nothing durable stores the last-sent copy until SEA-84) and must
 * never be rendered as "unchanged".
 */
export function copyStatusLine(diff: SendDiffView): string {
  if (diff.copyChanged === null) return "Copy: unknown";
  return diff.copyChanged ? "Copy: changed" : "Copy: unchanged";
}

/** "and N more" suffix for a truncated delta sample; "" when complete. */
export function deltaMoreSuffix(delta: RecipientDeltaView): string {
  const more = delta.count - delta.sample.length;
  return more > 0 ? `and ${more} more` : "";
}

/** Total drops in an exclusion report. */
export function totalExcluded(exclusions: ExclusionReportView): number {
  return Object.values(exclusions.counts).reduce((a, b) => a + b, 0);
}
