import { getPool } from "./client.js";
import type { Queryable } from "./campaignContacts.js";

/**
 * Delivery-telemetry persistence for the Resend webhook ingest (SEA-85),
 * over the SEA-80 schema (migrations/0011_campaigns.sql + 0014). Three
 * invariants from those migrations are load-bearing here:
 *
 * 1. campaign_events dedupes on provider_event_id (0014): the insert uses
 *    ON CONFLICT ... DO NOTHING against the partial unique index, so a
 *    replayed webhook is a structural no-op. send_id is nullable (0014):
 *    an event whose provider message id matches no send row is stored
 *    uncorrelated (NULL send_id) rather than dropped, keeping the raw
 *    telemetry available for later re-correlation.
 *
 * 2. suppressions keys on EMAIL ADDRESS (0011 design point 3), presence of
 *    a row is the whole signal, and the insert is ON CONFLICT DO NOTHING:
 *    re-suppressing an already-suppressed address is harmless, and the
 *    original reason/timestamp (the audit answer) is never overwritten.
 *
 * 3. consent_events is append-only, trigger-enforced; this module only
 *    ever INSERTs there. The complaint append carries its OWN idempotence
 *    (INSERT ... WHERE NOT EXISTS on contact_id + source + detail, the
 *    detail embedding the svix id) so it does not depend on any other
 *    write winning: a webhook replay after a mid-handler crash completes
 *    a missing ledger row instead of losing it behind the event dedupe,
 *    and a full replay never double-appends.
 */

export type CampaignEventType =
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained";

export type SuppressionReason = "hard_bounce" | "complaint";

/** The campaign_sends row a provider message id resolves to. */
export interface CampaignSendRef {
  id: string; // bigint comes back as text from pg
  contactId: string;
  /** The address actually mailed, snapshotted at enqueue time (0011). */
  email: string;
}

/**
 * Resolve a provider message id (Resend email_id) to its send row. The
 * provider_message_id index is non-unique by schema, but the sender writes
 * one provider id per send; LIMIT 1 on the oldest row keeps a pathological
 * duplicate from making this throw.
 */
export async function findSendByProviderMessageId(
  db: Queryable,
  providerMessageId: string,
): Promise<CampaignSendRef | null> {
  const result = await db.query(
    `SELECT id, contact_id, email FROM campaign_sends
     WHERE provider_message_id = $1
     ORDER BY id
     LIMIT 1`,
    [providerMessageId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as {
    id: string;
    contact_id: string;
    email: string;
  };
  return { id: String(row.id), contactId: String(row.contact_id), email: row.email };
}

/**
 * Append one delivery event, deduped on the provider's delivery-stable
 * event id (0014). Returns true when THIS call inserted the row, false
 * when the event was already recorded (webhook replay). sendId null =
 * uncorrelated (no campaign_sends row matched the provider message id):
 * the event is stored with NULL send_id (0014) so the telemetry is kept
 * for later re-correlation instead of discarded.
 */
export async function insertCampaignEvent(
  db: Queryable,
  event: {
    sendId: string | null;
    type: CampaignEventType;
    providerEventId: string;
    at: Date;
    /** The verbatim webhook body (campaign_events.raw). */
    rawJson: string;
  },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO campaign_events (send_id, type, at, raw, provider_event_id)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL
       DO NOTHING`,
    [event.sendId, event.type, event.at, event.rawJson, event.providerEventId],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Add an address to the hard do-not-send list. Idempotent: an address
 * already suppressed (for any reason) keeps its original reason and
 * timestamp -- the first cause is the audit answer, and removal is a
 * deliberate operator DELETE only (0011).
 */
export async function upsertSuppression(
  db: Queryable,
  email: string,
  reason: SuppressionReason,
): Promise<void> {
  await db.query(
    `INSERT INTO suppressions (email, reason)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, reason],
  );
}

/**
 * Append one complaint row to the append-only consent ledger, idempotent
 * in its own right: the INSERT is guarded by WHERE NOT EXISTS on
 * (contact_id, source, detail), and the caller's detail embeds the svix
 * id, so retrying the same provider event completes a missing append
 * (crash window) without ever double-appending. consent_events has no
 * unique index (it is a ledger), so this guard is the dedupe; the
 * theoretical race of two concurrent replays of one delivery could pass
 * the guard together, which is acceptable ledger noise (same state, same
 * provenance) and vanishingly rare given provider retry pacing.
 * INSERT only -- the append-only trigger forbids anything else.
 */
export async function appendConsentEventOnce(
  db: Queryable,
  event: {
    contactId: string;
    email: string;
    state: "subscribed" | "unsubscribed";
    source: "complaint";
    detail: string;
  },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO consent_events (contact_id, email, state, source, detail)
     SELECT $1, $2, $3, $4, $5
     WHERE NOT EXISTS (
       SELECT 1 FROM consent_events
       WHERE contact_id = $1 AND source = $4 AND detail = $5
     )`,
    [event.contactId, event.email, event.state, event.source, event.detail],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * The store interface the webhook ingest depends on, so the offline smoke
 * can run every branch against an in-memory fake (same injection pattern
 * as campaignContacts.CampaignStore). pgResendEventStore is the production
 * implementation over the functions above.
 */
export interface ResendEventStore {
  findSendByProviderMessageId(
    providerMessageId: string,
  ): Promise<CampaignSendRef | null>;
  insertCampaignEvent(event: {
    sendId: string | null;
    type: CampaignEventType;
    providerEventId: string;
    at: Date;
    rawJson: string;
  }): Promise<boolean>;
  upsertSuppression(email: string, reason: SuppressionReason): Promise<void>;
  appendConsentEventOnce(event: {
    contactId: string;
    email: string;
    state: "subscribed" | "unsubscribed";
    source: "complaint";
    detail: string;
  }): Promise<boolean>;
}

/** Production store over the shared pool (or any Queryable). */
export function pgResendEventStore(db?: Queryable): ResendEventStore {
  const q = (): Queryable => db ?? getPool();
  return {
    findSendByProviderMessageId: (providerMessageId) =>
      findSendByProviderMessageId(q(), providerMessageId),
    insertCampaignEvent: (event) => insertCampaignEvent(q(), event),
    upsertSuppression: (email, reason) => upsertSuppression(q(), email, reason),
    appendConsentEventOnce: (event) => appendConsentEventOnce(q(), event),
  };
}
