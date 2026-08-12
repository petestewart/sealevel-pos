import type pg from "pg";

import { getPool } from "./client.js";
import type { ConsentState, Queryable } from "./campaignContacts.js";

/**
 * Audience persistence for campaigns.build_audience (SEA-82), over the
 * SEA-80 schema (migrations/0011_campaigns.sql). No new migration: the
 * SEA-80 tables carry everything the audience build needs.
 *
 * Two invariants from that schema are load-bearing here:
 *
 * 1. Consent is read from the append-only consent_events ledger (latest
 *    row per contact, ORDER BY at DESC, id DESC), NEVER a boolean on
 *    contacts. An empty ledger is NOT consent: a contact nobody has ever
 *    recorded an opt-in for must not be mailed.
 *
 * 2. suppressions keys on EMAIL ADDRESS, not contact id, so the candidate
 *    read joins suppressions on contacts.email (both sides normalized to
 *    lowercase by trigger, so plain equality matches).
 */

/**
 * One live contact eligible to be considered for an audience: carries a
 * proven 1:1 analytics mapping (contacts.analytics_client_id, stamped
 * exclusively by SEA-81's reconciliation) plus everything the filter
 * chain needs to admit or drop it in one read.
 */
export interface AudienceCandidate {
  contactId: string;
  analyticsClientId: string;
  email: string;
  isAmbiguous: boolean;
  ambiguousReason: string | null;
  /** Latest consent_events state, or null when the ledger is empty. */
  consentState: ConsentState | null;
  /** Whether the contact's address is on the suppressions list. */
  suppressed: boolean;
}

/**
 * All live contacts carrying an analytics_client_id stamp, with their
 * latest ledger state and suppression flag resolved in one query. Only
 * clean 1:1 matches ever carry the stamp (reconcile.ts owns it), so this
 * is the complete set of contacts an analytics-driven audience can reach;
 * bounded by the studio's real client count, low tens of thousands.
 */
export async function listAudienceCandidates(
  db: Queryable,
): Promise<AudienceCandidate[]> {
  const result = await db.query(
    `SELECT c.id, c.analytics_client_id, c.email, c.is_ambiguous,
            c.ambiguous_reason,
            latest.state AS consent_state,
            (s.email IS NOT NULL) AS suppressed
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT state FROM consent_events e
       WHERE e.contact_id = c.id
       ORDER BY e.at DESC, e.id DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN suppressions s ON s.email = c.email
     WHERE c.deleted_at IS NULL AND c.analytics_client_id IS NOT NULL
     ORDER BY c.id`,
  );
  return (
    result.rows as Array<{
      id: string;
      analytics_client_id: string;
      email: string;
      is_ambiguous: boolean;
      ambiguous_reason: string | null;
      consent_state: ConsentState | null;
      suppressed: boolean;
    }>
  ).map((r) => ({
    contactId: String(r.id),
    analyticsClientId: r.analytics_client_id,
    email: r.email,
    isAmbiguous: r.is_ambiguous,
    ambiguousReason: r.ambiguous_reason,
    consentState: r.consent_state,
    suppressed: r.suppressed,
  }));
}

/** A campaign row as the audience build reads it. */
export interface CampaignRow {
  id: string;
  key: string;
  name: string;
  status: string;
  audienceView: string;
  runSeq: number;
  /** Scheduled send time (0018). null = send on approval. */
  sendAt: Date | null;
}

/** Look a campaign up by its stable human-facing key. */
export async function getCampaignByKey(
  db: Queryable,
  key: string,
): Promise<CampaignRow | null> {
  const result = await db.query(
    `SELECT id, key, name, status, audience_view, run_seq, send_at
     FROM campaigns WHERE key = $1`,
    [key],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as {
    id: string;
    key: string;
    name: string;
    status: string;
    audience_view: string;
    run_seq: number;
    send_at: Date | null;
  };
  return {
    id: String(row.id),
    key: row.key,
    name: row.name,
    status: row.status,
    audienceView: row.audience_view,
    runSeq: Number(row.run_seq),
    sendAt: row.send_at,
  };
}

/** One survivor to freeze into campaign_audience. */
export interface AudienceEntry {
  contactId: string;
  segment: string;
}

/**
 * Replace a campaign's audience snapshot atomically: delete the previous
 * snapshot (a deliberate re-build supersedes it wholesale; a half-old,
 * half-new snapshot must never be observable) and insert the new one, all
 * rows stamped with ONE snapshot_at so the snapshot is a single frozen
 * moment, not a smear of insert times. Runs in an explicit transaction on
 * a dedicated connection; a retried job re-runs the whole replace and
 * lands identical rows, so the operation is idempotent.
 */
export async function replaceAudienceSnapshot(
  pool: pg.Pool,
  campaignId: string,
  entries: AudienceEntry[],
  snapshotAt: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM campaign_audience WHERE campaign_id = $1`, [
      campaignId,
    ]);
    if (entries.length > 0) {
      await client.query(
        `INSERT INTO campaign_audience (campaign_id, contact_id, segment, snapshot_at)
         SELECT $1, t.contact_id, t.segment, $4
         FROM unnest($2::bigint[], $3::text[]) AS t (contact_id, segment)`,
        [
          campaignId,
          entries.map((e) => e.contactId),
          entries.map((e) => e.segment),
          snapshotAt,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Snapshot size for a campaign (post-build verification and reporting). */
export async function countAudience(
  db: Queryable,
  campaignId: string,
): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS n FROM campaign_audience WHERE campaign_id = $1`,
    [campaignId],
  );
  return Number((result.rows[0] as { n: string }).n);
}

/**
 * The store interface campaigns.build_audience depends on, so the offline
 * smoke runs every branch against an in-memory fake (same injection
 * pattern as CampaignStore). pgAudienceStore is the production
 * implementation over the functions above.
 */
export interface AudienceStore {
  listAudienceCandidates(): Promise<AudienceCandidate[]>;
  getCampaignByKey(key: string): Promise<CampaignRow | null>;
  replaceAudienceSnapshot(
    campaignId: string,
    entries: AudienceEntry[],
    snapshotAt: Date,
  ): Promise<void>;
  countAudience(campaignId: string): Promise<number>;
}

/** Production store over the shared pool. */
export function pgAudienceStore(): AudienceStore {
  return {
    listAudienceCandidates: () => listAudienceCandidates(getPool()),
    getCampaignByKey: (key) => getCampaignByKey(getPool(), key),
    replaceAudienceSnapshot: (campaignId, entries, snapshotAt) =>
      replaceAudienceSnapshot(getPool(), campaignId, entries, snapshotAt),
    countAudience: (campaignId) => countAudience(getPool(), campaignId),
  };
}
