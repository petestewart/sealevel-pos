import { getPool } from "./client.js";
import type { Queryable, ConsentState } from "./campaignContacts.js";
import { getCampaignByKey, type CampaignRow } from "./campaignAudience.js";
// Deliberately the SAME validator the card and the draft job's
// self-check use (see copyFromApprovalPayload). This import forms a
// module cycle (draftCampaign -> sendDiff -> db/sendDiff -> here) that
// is safe because every use is inside a function body, never at module
// init.
import { campaignApprovalOf } from "../campaigns/draftCampaign.js";

/**
 * Persistence for campaigns.send (SEA-84), over the SEA-80 schema
 * (migrations/0011_campaigns.sql) plus 0018 (send_at + copy snapshots).
 * Four invariants from those migrations are load-bearing here:
 *
 * 1. campaign_sends.dedupe_key is NOT NULL UNIQUE and derived
 *    deterministically (sha256 over campaign_id / contact_id / step
 *    joined by US, 0011 design point 2). The claim insert here is
 *    ON CONFLICT (dedupe_key) DO NOTHING: a retried BullMQ job re-derives
 *    the same key, the second insert loses in Postgres, and the existing
 *    row's status decides what (if anything) remains to do. The guard is
 *    the database, not application logic.
 *
 * 2. skipped_suppressed is a RECORDED outcome (0011): a recipient dropped
 *    by the send-time suppression/consent re-check still gets a send row,
 *    so the campaign report can say how many were held back and why.
 *
 * 3. campaign_sends.email snapshots the address actually mailed; the
 *    inbound webhook (SEA-85) and the unsubscribe endpoint both key off
 *    it, so it is written at claim time from the live contact row.
 *
 * 4. campaign_copy_snapshots is append-only with UNIQUE (campaign_id,
 *    run_seq): insertCopySnapshot is first-write-wins (ON CONFLICT DO
 *    NOTHING, then read back), because the first write is what the
 *    messages that already left carried.
 */

/** One frozen-snapshot recipient as the send job consumes it. */
export interface SendRecipient {
  contactId: string;
  /** The LIVE contact address (what will actually be mailed). */
  email: string;
  firstName: string | null;
  segment: string;
}

/** Send-time gate state for one contact (re-checked at send, not just at
 * audience build: someone can unsubscribe between approval and send). */
export interface SendTimeBlock {
  /** The contact's address is on the suppressions list. */
  suppressed: boolean;
  /** Latest consent_events state; null = empty ledger (not consent). */
  consentState: ConsentState | null;
}

/** Existing-or-claimed campaign_sends row for one (campaign, contact, step). */
export interface ClaimedSend {
  id: string;
  status: "queued" | "sent" | "failed" | "skipped_suppressed";
  providerMessageId: string | null;
  /** True when THIS call inserted the row (fresh claim). */
  inserted: boolean;
}

/** One stored copy variant: segment '' = the single-copy shape,
 * otherwise the SEA-88 segment label the copy was sent to. */
export interface CopySnapshotVariant {
  segment: string;
  subject: string;
  body: string;
}

/** The template copy SET for one run, as durably stored (0018): one
 * variant per segment, or a single ''-segment variant. */
export interface CopySnapshot {
  runSeq: number;
  /** Ordered by segment ascending ('' first, so the base copy leads). */
  variants: CopySnapshotVariant[];
}

/** The approved draft copy in either SEA-83 (single) or SEA-88
 * (per-segment variants) shape, as the send job consumes it. */
export type ApprovedCopy =
  | { subject: string; body: string }
  | { variants: CopySnapshotVariant[] };

/** Normalize an ApprovedCopy to the stored variant-set shape: the
 * single copy becomes one ''-segment variant. Exported for the send. */
export function copyVariantsOf(copy: ApprovedCopy): CopySnapshotVariant[] {
  if ("variants" in copy) return copy.variants;
  return [{ segment: "", subject: copy.subject, body: copy.body }];
}

/**
 * Extract the draft copy from a campaign_approval item payload, in
 * whichever shape it carries. Shape-checking is DELEGATED to
 * campaignApprovalOf -- the one validator the card, the draft job's
 * self-check, and now the send path all share -- so the send's idea of
 * a valid payload can never drift from the item validator again
 * (the SEA-88 near-miss: a send-path reader hardcoding the single
 * draft_subject/draft_body shape would dead-letter every briefed
 * campaign). Returns null when the payload does not validate.
 */
export function copyFromApprovalPayload(
  payload: Record<string, unknown>,
): ApprovedCopy | null {
  const validated = campaignApprovalOf(payload);
  if (!validated) return null;
  if (Array.isArray(validated.variants) && validated.variants.length > 0) {
    return {
      variants: validated.variants.map((v) => ({
        segment: v.segment,
        subject: v.draft_subject,
        body: v.draft_body,
      })),
    };
  }
  if (
    typeof validated.draft_subject === "string" &&
    typeof validated.draft_body === "string"
  ) {
    return { subject: validated.draft_subject, body: validated.draft_body };
  }
  return null;
}

/**
 * The frozen campaign_audience snapshot joined to live contacts, in
 * deterministic contact-id order so batches are stable across retries.
 * Soft-deleted contacts remain listed (the snapshot is history); the
 * send-time consent/suppression gate decides whether they are mailed.
 */
export async function listSendRecipients(
  db: Queryable,
  campaignId: string,
): Promise<SendRecipient[]> {
  const result = await db.query(
    `SELECT a.contact_id, c.email, c.first_name,
            coalesce(a.segment, 'default') AS segment
     FROM campaign_audience a
     JOIN contacts c ON c.id = a.contact_id
     WHERE a.campaign_id = $1
     ORDER BY a.contact_id`,
    [campaignId],
  );
  return (
    result.rows as Array<{
      contact_id: string;
      email: string;
      first_name: string | null;
      segment: string;
    }>
  ).map((r) => ({
    contactId: String(r.contact_id),
    email: r.email,
    firstName: r.first_name,
    segment: r.segment,
  }));
}

/**
 * Fresh suppression + consent state for a batch of contacts, read
 * immediately before that batch is mailed. This is THE send-time
 * re-check: the audience build filtered on this same state when the
 * snapshot froze, but an unsubscribe click, a complaint webhook, or a
 * manual suppression can land between approval and send (especially
 * across a send_at delay), and none of those people may be mailed.
 */
export async function sendTimeBlocks(
  db: Queryable,
  contactIds: string[],
): Promise<Map<string, SendTimeBlock>> {
  if (contactIds.length === 0) return new Map();
  const result = await db.query(
    `SELECT c.id,
            (s.email IS NOT NULL) AS suppressed,
            latest.state AS consent_state
     FROM contacts c
     LEFT JOIN suppressions s ON s.email = c.email
     LEFT JOIN LATERAL (
       SELECT state FROM consent_events e
       WHERE e.contact_id = c.id
       ORDER BY e.at DESC, e.id DESC
       LIMIT 1
     ) latest ON true
     WHERE c.id = ANY($1::bigint[])`,
    [contactIds],
  );
  const map = new Map<string, SendTimeBlock>();
  for (const row of result.rows as Array<{
    id: string;
    suppressed: boolean;
    consent_state: ConsentState | null;
  }>) {
    map.set(String(row.id), {
      suppressed: row.suppressed,
      consentState: row.consent_state,
    });
  }
  return map;
}

/**
 * Claim one send: INSERT the row (default status queued, or
 * skipped_suppressed when the send-time gate already dropped the
 * recipient) guarded by the dedupe_key unique index, then read back the
 * surviving row. On a retry the insert loses and the existing row's
 * status tells the caller what already happened.
 */
export async function claimSend(
  db: Queryable,
  send: {
    campaignId: string;
    contactId: string;
    email: string;
    step: string;
    dedupeKey: string;
    status: "queued" | "skipped_suppressed";
    /** Skip reason, recorded on the row's error column for the report. */
    detail?: string;
  },
): Promise<ClaimedSend> {
  const inserted = await db.query(
    `INSERT INTO campaign_sends
       (campaign_id, contact_id, email, step, dedupe_key, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id, status, provider_message_id`,
    [
      send.campaignId,
      send.contactId,
      send.email,
      send.step,
      send.dedupeKey,
      send.status,
      send.detail ?? null,
    ],
  );
  if (inserted.rows.length > 0) {
    const row = inserted.rows[0] as {
      id: string;
      status: ClaimedSend["status"];
      provider_message_id: string | null;
    };
    return {
      id: String(row.id),
      status: row.status,
      providerMessageId: row.provider_message_id,
      inserted: true,
    };
  }
  const existing = await db.query(
    `SELECT id, status, provider_message_id FROM campaign_sends
     WHERE dedupe_key = $1`,
    [send.dedupeKey],
  );
  const row = existing.rows[0] as {
    id: string;
    status: ClaimedSend["status"];
    provider_message_id: string | null;
  };
  return {
    id: String(row.id),
    status: row.status,
    providerMessageId: row.provider_message_id,
    inserted: false,
  };
}

/** Record a successful provider accept: queued -> sent, with the
 * provider message id the SEA-85 webhook correlates on. */
export async function markSendSent(
  db: Queryable,
  sendId: string,
  providerMessageId: string,
  sentAt: Date,
): Promise<void> {
  await db.query(
    `UPDATE campaign_sends
     SET status = 'sent', provider_message_id = $2, sent_at = $3, error = NULL
     WHERE id = $1 AND status = 'queued'`,
    [sendId, providerMessageId, sentAt],
  );
}

/** Record a provider rejection: queued -> failed with the error text.
 * failed is terminal for the run; the monitor surfaces it. */
export async function markSendFailed(
  db: Queryable,
  sendId: string,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE campaign_sends SET status = 'failed', error = $2
     WHERE id = $1 AND status = 'queued'`,
    [sendId, error],
  );
}

/**
 * Sends accepted by the provider inside the trailing window, ACROSS ALL
 * campaigns: the warmup ramp protects the sending domain, not one
 * campaign, so the budget is global.
 */
export async function countSentSince(
  db: Queryable,
  since: Date,
): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n FROM campaign_sends
     WHERE status = 'sent' AND sent_at >= $1`,
    [since],
  );
  return Number((result.rows[0] as { n: number }).n);
}

/** Flip approved -> sending (idempotent for a retried job already in
 * sending). Returns the resulting status, or null when the campaign is
 * in neither state (someone cancelled underneath; refuse upstream). */
export async function markCampaignSending(
  db: Queryable,
  campaignId: string,
): Promise<string | null> {
  const result = await db.query(
    `UPDATE campaigns SET status = 'sending'
     WHERE id = $1 AND status IN ('approved', 'sending')
     RETURNING status`,
    [campaignId],
  );
  const row = result.rows[0] as { status: string } | undefined;
  return row?.status ?? null;
}

/** Flip sending -> sent, guarded on no queued rows remaining so a
 * ramp-paused run can never be stamped complete early. Returns true when
 * the flip happened. */
export async function markCampaignSent(
  db: Queryable,
  campaignId: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE campaigns SET status = 'sent'
     WHERE id = $1 AND status = 'sending'
       AND NOT EXISTS (
         SELECT 1 FROM campaign_sends s
         WHERE s.campaign_id = $1 AND s.status = 'queued'
       )
     RETURNING id`,
    [campaignId],
  );
  return result.rows.length > 0;
}

/**
 * Durably store the copy SET for one run, first-write-wins per
 * (run, segment): each variant row is ON CONFLICT DO NOTHING against
 * UNIQUE (campaign_id, run_seq, segment), then the full surviving set is
 * read back -- what a retried job must render from is what the messages
 * that already left carried, not whatever it arrived with.
 */
export async function insertCopySnapshot(
  db: Queryable,
  snapshot: {
    campaignId: string;
    runSeq: number;
    variants: CopySnapshotVariant[];
  },
): Promise<CopySnapshot> {
  for (const variant of snapshot.variants) {
    await db.query(
      `INSERT INTO campaign_copy_snapshots
         (campaign_id, run_seq, segment, subject, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (campaign_id, run_seq, segment) DO NOTHING`,
      [
        snapshot.campaignId,
        snapshot.runSeq,
        variant.segment,
        variant.subject,
        variant.body,
      ],
    );
  }
  const result = await db.query(
    `SELECT run_seq, segment, subject, body FROM campaign_copy_snapshots
     WHERE campaign_id = $1 AND run_seq = $2
     ORDER BY segment`,
    [snapshot.campaignId, snapshot.runSeq],
  );
  return {
    runSeq: snapshot.runSeq,
    variants: (
      result.rows as Array<{ segment: string; subject: string; body: string }>
    ).map((r) => ({ segment: r.segment, subject: r.subject, body: r.body })),
  };
}

/** Newest run's full stored copy set for a campaign (the prior-copy
 * side of computeSendDiff's per-segment comparison), or null when no
 * run has snapshotted. */
export async function getLatestCopySnapshot(
  db: Queryable,
  campaignId: string,
): Promise<CopySnapshot | null> {
  const result = await db.query(
    `SELECT run_seq, segment, subject, body FROM campaign_copy_snapshots
     WHERE campaign_id = $1
       AND run_seq = (SELECT max(run_seq) FROM campaign_copy_snapshots
                      WHERE campaign_id = $1)
     ORDER BY segment`,
    [campaignId],
  );
  if (result.rows.length === 0) return null;
  const rows = result.rows as Array<{
    run_seq: number;
    segment: string;
    subject: string;
    body: string;
  }>;
  return {
    runSeq: Number(rows[0]!.run_seq),
    variants: rows.map((r) => ({
      segment: r.segment,
      subject: r.subject,
      body: r.body,
    })),
  };
}

/**
 * The APPROVED draft copy for one campaign run, read back from the
 * campaign_approval item the operator decided (dedupe key
 * campaign-<id>-run-<seq>, the same key campaigns.draft files under),
 * in either the single or the SEA-88 per-segment variants shape --
 * shape validation delegated to campaignApprovalOf via
 * copyFromApprovalPayload. Returns null when no approved item exists
 * (or its payload does not validate) -- the send refuses to fire
 * without one, because the copy that sends must be the copy a human
 * approved, byte for byte.
 */
export async function getApprovedDraftCopy(
  db: Queryable,
  campaignId: string,
  runSeq: number,
): Promise<ApprovedCopy | null> {
  const result = await db.query(
    `SELECT payload FROM items
     WHERE type = 'campaign_approval'
       AND payload->>'dedupe_key' = $1
       AND status = 'resolved'
       AND payload->'decision'->>'action' = 'approved'
     ORDER BY id DESC
     LIMIT 1`,
    [`campaign-${campaignId}-run-${runSeq}`],
  );
  if (result.rows.length === 0) return null;
  return copyFromApprovalPayload(
    (result.rows[0] as { payload: Record<string, unknown> }).payload,
  );
}

/**
 * The CURRENT draft copy for one campaign run regardless of decision
 * state (pending or resolved), either shape: what computeSendDiff
 * compares against the stored prior copy when no explicit current copy
 * is supplied.
 */
export async function getDraftCopy(
  db: Queryable,
  campaignId: string,
  runSeq: number,
): Promise<ApprovedCopy | null> {
  const result = await db.query(
    `SELECT payload FROM items
     WHERE type = 'campaign_approval'
       AND payload->>'dedupe_key' = $1
     ORDER BY id DESC
     LIMIT 1`,
    [`campaign-${campaignId}-run-${runSeq}`],
  );
  if (result.rows.length === 0) return null;
  return copyFromApprovalPayload(
    (result.rows[0] as { payload: Record<string, unknown> }).payload,
  );
}

/**
 * Resolve the recipient a signed unsubscribe token names. Prefers the
 * campaign_sends row for (campaign, contact) because its email column
 * snapshots the address ACTUALLY MAILED (0011); falls back to the live
 * contact address for a click that arrives before the send row lands
 * (link previews, forwarded mail). Soft-deleted contacts still resolve:
 * a retired contact's opt-out must still suppress the address.
 */
export async function findUnsubscribeRecipient(
  db: Queryable,
  campaignId: string,
  contactId: string,
): Promise<{ contactId: string; email: string } | null> {
  const sent = await db.query(
    `SELECT contact_id, email FROM campaign_sends
     WHERE campaign_id = $1 AND contact_id = $2
     ORDER BY id DESC
     LIMIT 1`,
    [campaignId, contactId],
  );
  if (sent.rows.length > 0) {
    const row = sent.rows[0] as { contact_id: string; email: string };
    return { contactId: String(row.contact_id), email: row.email };
  }
  const contact = await db.query(
    `SELECT id, email FROM contacts WHERE id = $1`,
    [contactId],
  );
  if (contact.rows.length === 0) return null;
  const row = contact.rows[0] as { id: string; email: string };
  return { contactId: String(row.id), email: row.email };
}

/**
 * The store interface campaigns.send depends on, so the offline smoke
 * runs every branch against an in-memory fake (same injection pattern as
 * AudienceStore / ResendEventStore). pgCampaignSendStore is production.
 */
export interface CampaignSendStore {
  getCampaignByKey(key: string): Promise<CampaignRow | null>;
  listSendRecipients(campaignId: string): Promise<SendRecipient[]>;
  sendTimeBlocks(contactIds: string[]): Promise<Map<string, SendTimeBlock>>;
  claimSend(send: {
    campaignId: string;
    contactId: string;
    email: string;
    step: string;
    dedupeKey: string;
    status: "queued" | "skipped_suppressed";
    detail?: string;
  }): Promise<ClaimedSend>;
  markSendSent(
    sendId: string,
    providerMessageId: string,
    sentAt: Date,
  ): Promise<void>;
  markSendFailed(sendId: string, error: string): Promise<void>;
  countSentSince(since: Date): Promise<number>;
  markCampaignSending(campaignId: string): Promise<string | null>;
  markCampaignSent(campaignId: string): Promise<boolean>;
  insertCopySnapshot(snapshot: {
    campaignId: string;
    runSeq: number;
    variants: CopySnapshotVariant[];
  }): Promise<CopySnapshot>;
  getApprovedDraftCopy(
    campaignId: string,
    runSeq: number,
  ): Promise<ApprovedCopy | null>;
}

/** Production store over the shared pool (or any Queryable). */
export function pgCampaignSendStore(db?: Queryable): CampaignSendStore {
  const q = (): Queryable => db ?? getPool();
  return {
    getCampaignByKey: (key) => getCampaignByKey(q(), key),
    listSendRecipients: (campaignId) => listSendRecipients(q(), campaignId),
    sendTimeBlocks: (contactIds) => sendTimeBlocks(q(), contactIds),
    claimSend: (send) => claimSend(q(), send),
    markSendSent: (sendId, providerMessageId, sentAt) =>
      markSendSent(q(), sendId, providerMessageId, sentAt),
    markSendFailed: (sendId, error) => markSendFailed(q(), sendId, error),
    countSentSince: (since) => countSentSince(q(), since),
    markCampaignSending: (campaignId) => markCampaignSending(q(), campaignId),
    markCampaignSent: (campaignId) => markCampaignSent(q(), campaignId),
    insertCopySnapshot: (snapshot) => insertCopySnapshot(q(), snapshot),
    getApprovedDraftCopy: (campaignId, runSeq) =>
      getApprovedDraftCopy(q(), campaignId, runSeq),
  };
}
