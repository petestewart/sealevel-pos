import type pg from "pg";

import { getPool } from "./client.js";

/**
 * Contact + consent persistence for campaigns.sync_contacts (SEA-81), over
 * the SEA-80 schema (migrations/0011_campaigns.sql). Two invariants from
 * that migration are load-bearing here:
 *
 * 1. contacts.mb_client_id uniqueness is a PARTIAL unique index scoped to
 *    live rows, so the upsert must name the predicate verbatim -- the bare
 *    `ON CONFLICT (mb_client_id)` form cannot infer a partial index and
 *    fails with 42P10.
 *
 * 2. consent_events is append-only, ENFORCED by trigger. This module only
 *    ever INSERTs there; "current state" is the latest row per contact.
 *
 * Every function takes a pg client/pool so the sync can hold one
 * connection for its whole run; `Queryable` covers both.
 */
export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/** One Mindbody client, normalized by the sync into upsertable shape. */
export interface ContactUpsert {
  mbClientId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Raw consent-related fields from the Mindbody payload, kept verbatim
   * as evidence (contacts.mb_opt_in_raw): consent is a legal question, so
   * the exact upstream field values must stay auditable. */
  optInRaw: Record<string, unknown>;
}

export interface UpsertedContact {
  id: string; // bigint comes back as text from pg
  email: string;
}

/**
 * Insert or refresh one contact keyed on mb_client_id. The conflict target
 * names the partial index predicate (see module note 1). deleted_at is
 * never touched: a retired contact stays retired, and the partial index
 * means a NEW row lands instead for a re-synced client.
 */
export async function upsertContact(
  db: Queryable,
  contact: ContactUpsert,
): Promise<UpsertedContact> {
  const result = await db.query(
    `INSERT INTO contacts
       (mb_client_id, email, first_name, last_name, mb_opt_in_raw, synced_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (mb_client_id)
       WHERE mb_client_id IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET
         email = EXCLUDED.email,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         mb_opt_in_raw = EXCLUDED.mb_opt_in_raw,
         synced_at = now(),
         updated_at = now()
     RETURNING id, email`,
    [
      contact.mbClientId,
      contact.email,
      contact.firstName,
      contact.lastName,
      JSON.stringify(contact.optInRaw),
    ],
  );
  const row = result.rows[0] as { id: string; email: string };
  return { id: String(row.id), email: row.email };
}

export type ConsentState = "subscribed" | "unsubscribed";
export type ConsentSource =
  | "mindbody_sync"
  | "unsubscribe_link"
  | "manual"
  | "complaint";

export interface LatestConsent {
  state: ConsentState;
  source: ConsentSource;
}

/** Latest ledger state for a contact, or null when the ledger is empty. */
export async function latestConsent(
  db: Queryable,
  contactId: string,
): Promise<LatestConsent | null> {
  const result = await db.query(
    `SELECT state, source FROM consent_events
     WHERE contact_id = $1
     ORDER BY at DESC, id DESC
     LIMIT 1`,
    [contactId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as LatestConsent;
  return { state: row.state, source: row.source };
}

/** Append one consent event. Never updates or deletes (trigger-enforced). */
export async function appendConsentEvent(
  db: Queryable,
  event: {
    contactId: string;
    email: string;
    state: ConsentState;
    source: ConsentSource;
    detail: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO consent_events (contact_id, email, state, source, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [event.contactId, event.email, event.state, event.source, event.detail],
  );
}

/**
 * Flag a contact ambiguous (excluded from every targeted send until the
 * mapping is proven -- SEA-81). Recording the reason on the row is what
 * lets the reconciliation report explain itself later.
 */
export async function markContactAmbiguous(
  db: Queryable,
  contactId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE contacts
     SET is_ambiguous = true, ambiguous_reason = $2, updated_at = now()
     WHERE id = $1`,
    [contactId, reason],
  );
}

/** Clear a previously-set ambiguity flag (the mapping resolved cleanly on
 * a later run). Only clears flags this sync set itself, recognizable by
 * reason prefix, so an operator's manual flag is never undone by a cron. */
export async function clearSyncAmbiguity(
  db: Queryable,
  contactId: string,
  reasonPrefix: string,
): Promise<void> {
  await db.query(
    `UPDATE contacts
     SET is_ambiguous = false, ambiguous_reason = NULL, updated_at = now()
     WHERE id = $1 AND is_ambiguous AND ambiguous_reason LIKE $2 || '%'`,
    [contactId, reasonPrefix],
  );
}

/** Set the analytics-side client id on a contact (a proven 1:1 mapping). */
export async function setAnalyticsClientId(
  db: Queryable,
  contactId: string,
  analyticsClientId: string | null,
): Promise<void> {
  await db.query(
    `UPDATE contacts
     SET analytics_client_id = $2, updated_at = now()
     WHERE id = $1`,
    [contactId, analyticsClientId],
  );
}

/** A live (not soft-deleted) contact row, as the reconciliation reads it. */
export interface LiveContact {
  id: string;
  mbClientId: string | null;
  email: string;
  isAmbiguous: boolean;
  ambiguousReason: string | null;
  analyticsClientId: string | null;
}

/** All live contacts (audit + reconciliation input; bounded by the studio's
 * real client count, low tens of thousands). */
export async function listLiveContacts(
  db: Queryable,
): Promise<LiveContact[]> {
  const result = await db.query(
    `SELECT id, mb_client_id, email, is_ambiguous, ambiguous_reason,
            analytics_client_id
     FROM contacts
     WHERE deleted_at IS NULL
     ORDER BY id`,
  );
  return (
    result.rows as Array<{
      id: string;
      mb_client_id: string | null;
      email: string;
      is_ambiguous: boolean;
      ambiguous_reason: string | null;
      analytics_client_id: string | null;
    }>
  ).map((r) => ({
    id: String(r.id),
    mbClientId: r.mb_client_id,
    email: r.email,
    isAmbiguous: r.is_ambiguous,
    ambiguousReason: r.ambiguous_reason,
    analyticsClientId: r.analytics_client_id,
  }));
}

/** Count of live contacts currently flagged ambiguous (any reason) --
 * i.e. excluded from every targeted send. */
export async function countAmbiguous(db: Queryable): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS n FROM contacts
     WHERE deleted_at IS NULL AND is_ambiguous`,
  );
  return Number((result.rows[0] as { n: string }).n);
}

/** Count of live contacts whose latest consent event is 'subscribed'. */
export async function countConsented(db: Queryable): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS n
     FROM contacts c
     JOIN LATERAL (
       SELECT state FROM consent_events e
       WHERE e.contact_id = c.id
       ORDER BY e.at DESC, e.id DESC
       LIMIT 1
     ) latest ON true
     WHERE c.deleted_at IS NULL AND latest.state = 'subscribed'`,
  );
  return Number((result.rows[0] as { n: string }).n);
}

/** The sync's high-water mark (0012_campaign_sync_state). 'epoch' means
 * never synced -- the next run is a full pull. */
export async function readSyncState(
  db: Queryable,
): Promise<{ lastSyncedAt: Date }> {
  const result = await db.query(
    `SELECT last_synced_at FROM campaign_sync_state WHERE id = 1`,
  );
  if (result.rows.length === 0) {
    throw new Error("campaign_sync_state row is missing; re-run migrations");
  }
  const row = result.rows[0] as { last_synced_at: Date };
  return { lastSyncedAt: new Date(row.last_synced_at) };
}

/** Advance the high-water mark AFTER a successful run (a failed run keeps
 * the old mark and reprocesses the same window on retry). */
export async function advanceSyncState(
  db: Queryable,
  runStartedAt: Date,
  contactsSynced: number,
): Promise<void> {
  await db.query(
    `UPDATE campaign_sync_state
     SET last_synced_at = $1,
         runs = runs + 1,
         contacts_synced = contacts_synced + $2,
         updated_at = now()
     WHERE id = 1`,
    [runStartedAt, contactsSynced],
  );
}

/**
 * The store interface the sync and reconciliation depend on, so the
 * offline smoke can run every branch against an in-memory fake (same
 * injection pattern as kb/write.ts). pgCampaignStore is the production
 * implementation over the functions above.
 */
export interface CampaignStore {
  upsertContact(contact: ContactUpsert): Promise<UpsertedContact>;
  latestConsent(contactId: string): Promise<LatestConsent | null>;
  appendConsentEvent(event: {
    contactId: string;
    email: string;
    state: ConsentState;
    source: ConsentSource;
    detail: string;
  }): Promise<void>;
  markContactAmbiguous(contactId: string, reason: string): Promise<void>;
  clearSyncAmbiguity(contactId: string, reasonPrefix: string): Promise<void>;
  setAnalyticsClientId(
    contactId: string,
    analyticsClientId: string | null,
  ): Promise<void>;
  listLiveContacts(): Promise<LiveContact[]>;
  countConsented(): Promise<number>;
  countAmbiguous(): Promise<number>;
  readSyncState(): Promise<{ lastSyncedAt: Date }>;
  advanceSyncState(runStartedAt: Date, contactsSynced: number): Promise<void>;
}

/** Production store over the shared pool (or any Queryable). */
export function pgCampaignStore(db?: Queryable): CampaignStore {
  const q = (): Queryable => db ?? getPool();
  return {
    upsertContact: (contact) => upsertContact(q(), contact),
    latestConsent: (contactId) => latestConsent(q(), contactId),
    appendConsentEvent: (event) => appendConsentEvent(q(), event),
    markContactAmbiguous: (contactId, reason) =>
      markContactAmbiguous(q(), contactId, reason),
    clearSyncAmbiguity: (contactId, reasonPrefix) =>
      clearSyncAmbiguity(q(), contactId, reasonPrefix),
    setAnalyticsClientId: (contactId, analyticsClientId) =>
      setAnalyticsClientId(q(), contactId, analyticsClientId),
    listLiveContacts: () => listLiveContacts(q()),
    countConsented: () => countConsented(q()),
    countAmbiguous: () => countAmbiguous(q()),
    readSyncState: () => readSyncState(q()),
    advanceSyncState: (runStartedAt, contactsSynced) =>
      advanceSyncState(q(), runStartedAt, contactsSynced),
  };
}
