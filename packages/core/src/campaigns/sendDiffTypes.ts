/**
 * Send-diff types (SEA-86), deliberately in their own zero-import module:
 * the SEA-83 approval card types itself against `SendDiff | null` without
 * pulling in pg, the analytics client, or anything else from the diff's
 * implementation. Keep this file free of imports.
 */

/** Bounded sample size for added/dropped recipient lists. The counts are
 * always exact; the sample is what a human skims on the approval card. */
export const SEND_DIFF_SAMPLE_LIMIT = 10;

/**
 * One side of the recipient delta: an exact count plus a bounded,
 * deterministically-ordered (ascending by address) sample of addresses.
 * sample.length < count means the list was truncated at sampleLimit.
 */
export interface RecipientDelta {
  /** Exact number of addresses in this delta. */
  count: number;
  /** Up to sampleLimit addresses, sorted ascending. */
  sample: string[];
  /** The bound the sample was truncated to (SEND_DIFF_SAMPLE_LIMIT). */
  sampleLimit: number;
}

/** Identity of the prior send the diff is computed against. */
export interface PriorSendInfo {
  campaignId: string;
  /** The campaign row's CURRENT run_seq (bumped for a deliberate re-send). */
  runSeq: number;
  /** Latest sent_at across the prior send's rows; null if none recorded. */
  sentAt: Date | null;
  /** Distinct addresses actually mailed (status = 'sent'). */
  sentCount: number;
  /** Distinct addresses recorded but held back as suppressed. */
  skippedSuppressedCount: number;
  /** Distinct addresses whose send attempt failed. */
  failedCount: number;
}

/**
 * "What changes about this send versus the last one of this campaign
 * key": the contract the SEA-83 approval card renders.
 *
 * Recipient identity is the EMAIL ADDRESS (lowercased), matching the
 * schema's design point that the address is the durable identity while
 * contact ids churn: campaign_sends snapshots the address actually
 * mailed, and the current side reads the live address of each contact in
 * the frozen campaign_audience snapshot. A contact whose address changed
 * since the last send therefore shows as one add plus one drop, which is
 * the truth of what the mail server will see.
 */
export interface SendDiff {
  campaignKey: string;
  /** In the current audience snapshot, not mailed by the prior send. */
  recipientsAdded: RecipientDelta;
  /** Mailed by the prior send, not in the current audience snapshot. */
  recipientsDropped: RecipientDelta;
  /**
   * Whether the copy changed since the prior send. null = UNKNOWN: no
   * durable artifact stores the last-sent subject/body yet (the send job
   * is SEA-84; until it snapshots the copy per run, no honest comparison
   * exists). Renderers must show null as "copy: unknown", never as
   * "unchanged".
   */
  copyChanged: boolean | null;
  /** Compact human-readable line about the copy comparison. */
  copySummary: string;
  /** Size of the current campaign_audience snapshot (distinct addresses). */
  currentAudienceCount: number;
  priorSend: PriorSendInfo;
  /** One-line human summary of the whole diff. */
  summary: string;
}
