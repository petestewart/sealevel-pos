import { getPool } from "./client.js";
import type { Queryable } from "./campaignContacts.js";
import { getCampaignByKey, type CampaignRow } from "./campaignAudience.js";
import {
  getDraftCopy,
  getLatestCopySnapshot,
  type ApprovedCopy,
  type CopySnapshot,
} from "./campaignSend.js";

/**
 * DB reads for the send-diff tool (SEA-86), over the SEA-80 schema
 * (migrations/0011_campaigns.sql). Read-only: the diff describes state,
 * it never mutates it.
 *
 * Ground truth for "the last send": campaign_sends. campaign_audience is
 * a replace-on-rebuild snapshot (replaceAudienceSnapshot deletes the
 * previous snapshot wholesale), so after a rebuild the audience table has
 * ALREADY FORGOTTEN who the last send went to; campaign_sends rows are
 * immutable per (campaign, contact, step) and RESTRICT-protected, so they
 * are the durable record of who was actually mailed.
 *
 * Known limitation, stated rather than papered over: per-run identity in
 * campaign_sends lives only in the free-text `step` convention (e.g.
 * 'initial#2' after a run_seq bump) -- there is no run column, and
 * parsing the convention would be fragile (campaignStats.ts documents the
 * same constraint). The "prior send" here is therefore ALL non-queued
 * campaign_sends rows for the campaign row, which for a campaign key that
 * has re-run (run_seq > 1) is the union across every completed run, not
 * the latest run alone. For the v1 flow (one run per key, re-send is a
 * deliberate rarity) this is exact; a per-run diff needs a run column,
 * which is a schema change outside this lane.
 */

/** One prior send row, as the diff consumes it. */
export interface PriorSendRow {
  /** Address actually mailed, snapshotted at enqueue time (lowercased). */
  email: string;
  status: "queued" | "sent" | "failed" | "skipped_suppressed";
  sentAt: Date | null;
}

/** Every send row for the campaign; the diff filters/aggregates in code
 * (bounded by the studio's real client count, low tens of thousands). */
export async function listCampaignSendRows(
  db: Queryable,
  campaignId: string,
): Promise<PriorSendRow[]> {
  const result = await db.query(
    `SELECT email, status, sent_at
       FROM campaign_sends
      WHERE campaign_id = $1
      ORDER BY email`,
    [campaignId],
  );
  return (
    result.rows as Array<{
      email: string;
      status: PriorSendRow["status"];
      sent_at: Date | null;
    }>
  ).map((r) => ({ email: r.email, status: r.status, sentAt: r.sent_at }));
}

/**
 * The current audience snapshot's addresses: the frozen campaign_audience
 * rows joined to the LIVE contact address (the snapshot stores contact_id
 * + segment, not the address; the address that will actually be mailed is
 * whatever contacts.email says at enqueue time, so that is what the diff
 * must compare). Both sides are trigger-lowercased, but the diff
 * normalizes again defensively.
 */
export async function listAudienceEmails(
  db: Queryable,
  campaignId: string,
): Promise<string[]> {
  const result = await db.query(
    `SELECT c.email
       FROM campaign_audience ca
       JOIN contacts c ON c.id = ca.contact_id
      WHERE ca.campaign_id = $1
      ORDER BY c.email`,
    [campaignId],
  );
  return (result.rows as Array<{ email: string }>).map((r) => r.email);
}

/**
 * The store interface computeSendDiff depends on, so the offline smoke
 * runs every branch against an in-memory fake (same injection pattern as
 * AudienceStore). pgSendDiffStore is the production implementation.
 *
 * SEA-84 added the two copy readers: getLatestCopySnapshot reads the
 * durable per-run copy the send job stores (campaign_copy_snapshots,
 * 0018), and getDraftCopy reads the current run's draft copy back from
 * its campaign_approval item -- together they turn copyChanged from
 * always-null into a real comparison.
 */
export interface SendDiffStore {
  getCampaignByKey(key: string): Promise<CampaignRow | null>;
  listCampaignSendRows(campaignId: string): Promise<PriorSendRow[]>;
  listAudienceEmails(campaignId: string): Promise<string[]>;
  /** Newest run's full stored sent-copy set, or null (pre-snapshot
   * history). */
  getLatestCopySnapshot(campaignId: string): Promise<CopySnapshot | null>;
  /** The current run's draft copy (campaign_approval item), in either
   * the single or the per-segment variants shape, or null. */
  getDraftCopy(
    campaignId: string,
    runSeq: number,
  ): Promise<ApprovedCopy | null>;
}

/** Production store over the shared pool. */
export function pgSendDiffStore(): SendDiffStore {
  return {
    getCampaignByKey: (key) => getCampaignByKey(getPool(), key),
    listCampaignSendRows: (campaignId) =>
      listCampaignSendRows(getPool(), campaignId),
    listAudienceEmails: (campaignId) =>
      listAudienceEmails(getPool(), campaignId),
    getLatestCopySnapshot: (campaignId) =>
      getLatestCopySnapshot(getPool(), campaignId),
    getDraftCopy: (campaignId, runSeq) =>
      getDraftCopy(getPool(), campaignId, runSeq),
  };
}
