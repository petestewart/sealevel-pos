import {
  pgCampaignStore,
  type CampaignStore,
  type ConsentState,
} from "../db/campaignContacts.js";
import { analyticsConfigured } from "../tools/analytics.js";
import {
  fetchAllClients,
  mindbodyConfigured,
  type MindbodyClientRecord,
} from "./mindbody.js";
import {
  reconcileIdMapping,
  type ReconciliationReport,
} from "./reconcile.js";

/**
 * Reason prefix for duplicate-mb_client_id flags. DELIBERATELY distinct
 * from reconcile.ts's SYNC_AMBIGUOUS_PREFIX ("sync:"): reconciliation
 * clears its own flags when an ID mapping resolves cleanly, but mapping
 * cleanliness says nothing about the two-records-one-Id consent conflict
 * this prefix marks, so these flags are only ever cleared by an operator.
 */
export const DUPLICATE_AMBIGUOUS_PREFIX = "sync-dupe:";

/**
 * campaigns.sync_contacts (SEA-81): the nightly Mindbody -> Postgres
 * contact sync plus the ID-mapping reconciliation report. Pure code, no
 * brain; runs as a named worker processor on the 05:00 PT schedule
 * (queue/schedules.ts campaignsSyncContactsSchedule).
 *
 * Why this exists: the analytics mirror carries NO PII by design (no
 * email, phone, or consent anywhere in it -- it is rebuilt nightly from a
 * git-committed sqlite). Email addresses therefore come from the Mindbody
 * Public API v6 directly into ai-manager's own Postgres (the SEA-80
 * schema), and consent lives in the append-only consent_events ledger.
 *
 * Consent policy (the legal-risk decisions, explicit):
 * - Mindbody SEEDS the ledger: a contact with no consent history gets one
 *   mindbody_sync event carrying Mindbody's current opt-in state
 *   (SendPromotionalEmails; see campaigns/mindbody.ts).
 * - After seeding, ai-manager is authoritative. A Mindbody flip is
 *   appended only while Mindbody is still the latest voice:
 *     - an opt-OUT from Mindbody is ALWAYS appended (never ignore an
 *       unsubscribe, whatever source last spoke);
 *     - an opt-IN from Mindbody is appended only when the latest ledger
 *       event is itself mindbody_sync. A local unsubscribe (link click,
 *       complaint, operator) is never overridden by a sync -- those
 *       held re-subscribes are counted and reported instead.
 * - Nothing here ever UPDATEs or DELETEs a ledger row (trigger-enforced).
 *
 * Failure posture: Mindbody unconfigured = logged skip (the boot-time
 * schedule is harmless, same as the Gmail poll). A mid-run Mindbody or
 * Postgres error throws, so BullMQ retries the run; the upsert and the
 * append-only ledger make a re-run safe, and the watermark only advances
 * on success. The reconciliation half degrades separately: analytics
 * unconfigured or unreadable produces a sync-only report rather than
 * failing the contact sync.
 */

export interface SyncContactsResult {
  status: "synced" | "skipped";
  reason?: string;
  /** Whether this run was a full pull or incremental (watermark-driven). */
  mode?: "full" | "incremental";
  /** Contacts inserted or refreshed this run. */
  synced: number;
  /** Live contacts whose current ledger state is 'subscribed'. */
  consented: number;
  /** Contacts excluded as ambiguous (any reason) after this run. */
  ambiguousExcluded: number;
  /** Analytics clients that resolve to no contact (unmappable). */
  unmappable: number;
  /** Mindbody clients skipped for having no email address. */
  noEmail: number;
  /** Consent events appended this run, by kind. */
  consentSeeded: number;
  consentChanged: number;
  /** Mindbody opt-ins held back because a local unsubscribe is latest. */
  heldResubscribes: number;
  /** Mindbody records flagged for a duplicate mb_client_id in the pull.
   * The first record keeps the row; the flag (sync-dupe:, never cleared
   * by reconciliation) excludes the contact until an operator resolves
   * it, and a duplicate's opt-out is still appended to the ledger. */
  duplicateMbIds: number;
  reconciliation: ReconciliationReport | null;
  /** The done-when line, verbatim ("N contacts synced, ..."). */
  summary: string;
}

/** Injectable dependencies so the offline smoke runs every branch without
 * Mindbody, Postgres, or the MCP server. Production callers pass nothing. */
export interface SyncContactsDeps {
  fetchAllClients: typeof fetchAllClients;
  store: CampaignStore;
  reconcile: () => Promise<ReconciliationReport>;
  log: (line: string) => void;
}

function defaultDeps(): SyncContactsDeps {
  return {
    fetchAllClients,
    store: pgCampaignStore(),
    reconcile: () => reconcileIdMapping(),
    log: (line) => console.log(line),
  };
}

/** Upsert one Mindbody client and settle its consent ledger entry. */
async function syncOne(
  store: CampaignStore,
  record: MindbodyClientRecord & { email: string },
  counts: {
    consentSeeded: number;
    consentChanged: number;
    heldResubscribes: number;
  },
): Promise<{ id: string; email: string }> {
  const contact = await store.upsertContact({
    mbClientId: record.mbClientId,
    email: record.email,
    firstName: record.firstName,
    lastName: record.lastName,
    optInRaw: record.optInRaw,
  });
  const mbState: ConsentState = record.subscribed
    ? "subscribed"
    : "unsubscribed";
  const prior = await store.latestConsent(contact.id);
  if (!prior) {
    await store.appendConsentEvent({
      contactId: contact.id,
      email: contact.email,
      state: mbState,
      source: "mindbody_sync",
      detail: `seeded from Mindbody ${record.optInFieldName}=${String(record.optInValue)}`,
    });
    counts.consentSeeded += 1;
    return contact;
  }
  if (prior.state === mbState) return contact;
  if (mbState === "subscribed" && prior.source !== "mindbody_sync") {
    // A local unsubscribe (link, complaint, operator) outranks a Mindbody
    // opt-in. Held, counted, reported -- never silently applied.
    counts.heldResubscribes += 1;
    return contact;
  }
  await store.appendConsentEvent({
    contactId: contact.id,
    email: contact.email,
    state: mbState,
    source: "mindbody_sync",
    detail: `Mindbody ${record.optInFieldName} changed to ${String(record.optInValue)}`,
  });
  counts.consentChanged += 1;
  return contact;
}

/**
 * Overlap subtracted from the watermark. 25 hours, not minutes: besides
 * clock skew, Mindbody interprets some v6 date filters in SITE-LOCAL time
 * rather than UTC, and an unnoticed 7-8h misinterpretation of our
 * request.lastModifiedDate would silently drop a day's opt-outs. A 25h
 * overlap covers the nightly cadence plus any timezone reading of the
 * cutoff, and re-pulling ~2 days of changes is still tiny next to a full
 * pull. The upsert + ledger settlement are idempotent, so overlap costs
 * nothing but a few API pages.
 */
const WATERMARK_OVERLAP_MS = 25 * 60 * 60 * 1000;

/**
 * Run the sync: page Mindbody (incrementally, via the campaign_sync_state
 * watermark and request.lastModifiedDate -- per-call pricing means we do
 * not re-pull the world every night), upsert contacts, settle consent,
 * then reconcile against the analytics mirror and print the report.
 */
export async function syncContacts(
  deps: SyncContactsDeps = defaultDeps(),
  options: { full?: boolean } = {},
): Promise<SyncContactsResult> {
  const log = deps.log;
  if (!mindbodyConfigured()) {
    const summary =
      "campaigns.sync_contacts skipped: Mindbody API is not configured (MINDBODY_API_KEY / MINDBODY_SITE_ID)";
    log(`[sync_contacts] ${summary}`);
    return {
      status: "skipped",
      reason: "mindbody_unconfigured",
      synced: 0,
      consented: 0,
      ambiguousExcluded: 0,
      unmappable: 0,
      noEmail: 0,
      consentSeeded: 0,
      consentChanged: 0,
      heldResubscribes: 0,
      duplicateMbIds: 0,
      reconciliation: null,
      summary,
    };
  }

  const runStartedAt = new Date();
  const { lastSyncedAt } = await deps.store.readSyncState();
  const fullPull = options.full || lastSyncedAt.getTime() === 0;
  const modifiedSince = fullPull
    ? undefined
    : new Date(lastSyncedAt.getTime() - WATERMARK_OVERLAP_MS).toISOString();
  log(
    `[sync_contacts] ${fullPull ? "full pull" : `incremental since ${modifiedSince}`}`,
  );

  const counts = { consentSeeded: 0, consentChanged: 0, heldResubscribes: 0 };
  let synced = 0;
  let noEmail = 0;
  let duplicateMbIds = 0;
  // mb_client_id -> the contact row the FIRST record for that id landed on.
  const seenMbIds = new Map<string, { id: string; email: string }>();

  for await (const page of deps.fetchAllClients({ modifiedSince })) {
    for (const record of page) {
      if (!record.email) {
        noEmail += 1;
        continue;
      }
      const first = seenMbIds.get(record.mbClientId);
      if (first) {
        // Two records with one mb_client_id in a single pull cannot both
        // be stored (the partial unique index is the point), and which is
        // real cannot be known here. The first record won the row and its
        // data STAYS -- overwriting it would leave the ledger snapshotting
        // an address the row no longer carries. The contact is flagged
        // (operator-cleared only; reconciliation never touches this
        // prefix), and ONE consent rule still applies across the
        // conflict: if the duplicate says unsubscribed, the opt-out is
        // appended -- an opt-out is never dropped, whoever it belongs to.
        duplicateMbIds += 1;
        await deps.store.markContactAmbiguous(
          first.id,
          `${DUPLICATE_AMBIGUOUS_PREFIX} duplicate mb_client_id ${record.mbClientId} in Mindbody pull`,
        );
        if (!record.subscribed) {
          const latest = await deps.store.latestConsent(first.id);
          if (latest?.state !== "unsubscribed") {
            await deps.store.appendConsentEvent({
              contactId: first.id,
              email: first.email,
              state: "unsubscribed",
              source: "mindbody_sync",
              detail: `duplicate Mindbody record for id ${record.mbClientId} carries ${record.optInFieldName}=false; opt-out honored across the conflict`,
            });
            counts.consentChanged += 1;
          }
        }
        continue;
      }
      const contact = await syncOne(
        deps.store,
        { ...record, email: record.email },
        counts,
      );
      seenMbIds.set(record.mbClientId, contact);
      synced += 1;
    }
  }

  // Contact upserts are all in: advance the watermark to this run's START
  // so anything Mindbody changed mid-run is re-pulled next time.
  await deps.store.advanceSyncState(runStartedAt, synced);

  // Reconciliation: degrade to a sync-only report when the analytics
  // identity is absent or the read fails; the contact sync itself stands.
  let reconciliation: ReconciliationReport | null = null;
  if (analyticsConfigured()) {
    try {
      reconciliation = await deps.reconcile();
    } catch (err) {
      log(
        `[sync_contacts] reconciliation failed (sync itself succeeded): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    log(
      "[sync_contacts] reconciliation skipped: analytics identity not configured (SEALEVEL_MCP_ANALYTICS_TOKEN)",
    );
  }

  // Counted from the store, not the reconciliation report, so the line
  // stays honest when reconciliation is skipped or fails -- flags set by
  // THIS run (e.g. duplicates) must show in this run's summary.
  const consented = await deps.store.countConsented();
  const ambiguousExcluded = await deps.store.countAmbiguous();
  const unmappable = reconciliation?.zero ?? 0;

  // The done-when line. Pete reads this personally; the detail lines below
  // it are what let him believe every number.
  const summary = `${synced} contacts synced, ${consented} consented, ${ambiguousExcluded} ambiguous excluded, ${unmappable} unmappable`;
  log(`[sync_contacts] ${summary}`);
  log(
    `[sync_contacts] consent: ${counts.consentSeeded} seeded, ${counts.consentChanged} changed, ${counts.heldResubscribes} Mindbody re-subscribes HELD (local unsubscribe outranks the sync)`,
  );
  log(
    `[sync_contacts] skipped: ${noEmail} Mindbody clients with no email, ${duplicateMbIds} duplicate mb_client_ids flagged ambiguous`,
  );
  if (reconciliation) {
    log(
      `[sync_contacts] id mapping: ${reconciliation.analyticsClients} analytics clients -> ${reconciliation.exactlyOne} exactly-one, ${reconciliation.zero} zero, ${reconciliation.multiple} multiple; ${reconciliation.analyticsAmbiguous} name-ambiguous in the mirror; ${reconciliation.contactsWithoutMbId} contacts have no Mindbody id`,
    );
    for (const line of reconciliation.samples) {
      log(`[sync_contacts]   ${line}`);
    }
  }

  return {
    status: "synced",
    mode: fullPull ? "full" : "incremental",
    synced,
    consented,
    ambiguousExcluded,
    unmappable,
    noEmail,
    ...counts,
    duplicateMbIds,
    reconciliation,
    summary,
  };
}
