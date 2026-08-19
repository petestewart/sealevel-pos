import {
  pgCampaignStore,
  type CampaignStore,
  type LiveContact,
} from "../db/campaignContacts.js";
import { pageSelect } from "../tools/analytics.js";

/**
 * Mindbody ID mapping reconciliation (SEA-81). Pete reads this output
 * personally; every number must be explainable from the rows behind it.
 *
 * Analytics (the D1 mirror, read via the analytics service identity)
 * carries a dual ID scheme: clients(client_id, name_key, is_ambiguous)
 * merged by "Last, First" name match, and client_source_ids(source_id,
 * client_id, id_format) mapping every Mindbody-side identifier -- legacy
 * and current -- onto one analytics client. Postgres contacts carry the
 * Mindbody client id the API returned (contacts.mb_client_id). The
 * reconciliation joins the two IN APPLICATION CODE (there is no join path
 * between D1 and Postgres) and reports, per analytics client, whether it
 * resolves to exactly one contact, zero, or several.
 *
 * Side effects on contacts (all conservative, all reversible):
 * - a clean 1:1 match against a non-ambiguous analytics client stamps
 *   contacts.analytics_client_id (SEA-82's audience join key);
 * - a match against an is_ambiguous analytics client, or an analytics
 *   client resolving to multiple contacts, marks every involved contact
 *   is_ambiguous with a "sync:" reason -- excluded from every targeted
 *   send until the mapping is proven;
 * - "sync:"-prefixed flags are cleared when a later run resolves cleanly.
 *   Operator-set flags (any other reason) are never touched.
 *
 * Source ids are matched case-insensitively: the n_prefixed format stores
 * both "N1" and "n9984" in the live mirror.
 */

/** Reason prefix for ambiguity flags set by the sync (see clearSyncAmbiguity). */
export const SYNC_AMBIGUOUS_PREFIX = "sync:";

export interface ReconciliationReport {
  /** Analytics clients seen in the mirror (all of them, ambiguous included). */
  analyticsClients: number;
  /** Analytics clients the mirror itself flags is_ambiguous (name collisions). */
  analyticsAmbiguous: number;
  /** Analytics clients resolving to exactly ONE live contact. */
  exactlyOne: number;
  /** Analytics clients resolving to NO contact (unmappable). */
  zero: number;
  /** Analytics clients resolving to MORE THAN ONE contact. */
  multiple: number;
  /** Live contacts with no mb_client_id at all (email-capture entries). */
  contactsWithoutMbId: number;
  /** Live contacts flagged is_ambiguous after this run (any reason). */
  ambiguousContacts: number;
  /** Human-readable per-count sample lines for the log (bounded). */
  samples: string[];
}

interface AnalyticsClient {
  clientId: string;
  isAmbiguous: boolean;
  sourceIds: string[];
}

/** Normalize a Mindbody-side identifier for matching (case-insensitive). */
export function normalizeSourceId(id: string): string {
  return id.trim().toUpperCase();
}

/** Injectable reads/writes so the offline smoke runs without D1 or Postgres. */
export interface ReconcileDeps {
  pageSelect: typeof pageSelect;
  store: CampaignStore;
}

function defaultDeps(): ReconcileDeps {
  return { pageSelect, store: pgCampaignStore() };
}

/** Page the mirror's clients + client_source_ids into memory (low tens of
 * thousands of rows; ~150 run_sql pages). */
async function loadAnalyticsClients(
  deps: ReconcileDeps,
): Promise<Map<string, AnalyticsClient>> {
  // Progress is part of correctness here (a quiet phase reads as a hang):
  // one line every PROGRESS_EVERY pages while the mirror streams in.
  const PROGRESS_EVERY = 20;
  const clients = new Map<string, AnalyticsClient>();
  let pages = 0;
  for await (const rows of deps.pageSelect(
    "SELECT client_id, is_ambiguous FROM clients ORDER BY client_id",
    { maxRows: 100_000 },
  )) {
    for (const row of rows) {
      const clientId = String(row["client_id"]);
      clients.set(clientId, {
        clientId,
        isAmbiguous: Number(row["is_ambiguous"]) === 1,
        sourceIds: [],
      });
    }
    pages += 1;
    if (pages % PROGRESS_EVERY === 0) {
      console.log(
        `[reconcile] loading mirror clients: ${clients.size} so far...`,
      );
    }
  }
  console.log(`[reconcile] mirror clients loaded: ${clients.size}`);
  let sourceIds = 0;
  pages = 0;
  for await (const rows of deps.pageSelect(
    "SELECT source_id, client_id FROM client_source_ids ORDER BY source_id",
    { maxRows: 100_000 },
  )) {
    for (const row of rows) {
      const client = clients.get(String(row["client_id"]));
      // A source id pointing at an unknown client would be a mirror bug;
      // skip rather than crash, the zero-match count will surface it.
      client?.sourceIds.push(normalizeSourceId(String(row["source_id"])));
      sourceIds += 1;
    }
    pages += 1;
    if (pages % PROGRESS_EVERY === 0) {
      console.log(
        `[reconcile] loading mirror source ids: ${sourceIds} so far...`,
      );
    }
  }
  console.log(`[reconcile] mirror source ids loaded: ${sourceIds}`);
  return clients;
}

const SAMPLE_LIMIT = 10;

/**
 * Run the reconciliation: read the mirror, read live contacts, match, stamp
 * analytics_client_id / ambiguity flags, and return the report.
 */
export async function reconcileIdMapping(
  deps: ReconcileDeps = defaultDeps(),
): Promise<ReconciliationReport> {
  console.log(
    "[reconcile] starting: paging the analytics mirror (~150 small queries, a couple of minutes)...",
  );
  const clients = await loadAnalyticsClients(deps);
  const contacts = await deps.store.listLiveContacts();

  // mb_client_id (normalized) -> contacts carrying it. The partial unique
  // index means at most one LIVE contact per exact id, but normalization
  // could collapse two case-variant ids, so keep a list and report it.
  const contactsByMbId = new Map<string, LiveContact[]>();
  let contactsWithoutMbId = 0;
  for (const contact of contacts) {
    if (!contact.mbClientId) {
      contactsWithoutMbId += 1;
      continue;
    }
    const key = normalizeSourceId(contact.mbClientId);
    const list = contactsByMbId.get(key) ?? [];
    list.push(contact);
    contactsByMbId.set(key, list);
  }

  const report: ReconciliationReport = {
    analyticsClients: clients.size,
    analyticsAmbiguous: 0,
    exactlyOne: 0,
    zero: 0,
    multiple: 0,
    contactsWithoutMbId,
    ambiguousContacts: 0,
    samples: [],
  };
  const sample = (line: string): void => {
    if (report.samples.length < SAMPLE_LIMIT) report.samples.push(line);
  };

  // What this run decided per contact id; applied after the full pass so a
  // contact matched by TWO analytics clients ends up ambiguous, not
  // whichever the loop saw last.
  const decisions = new Map<
    string,
    { contact: LiveContact; analyticsClientId: string | null; reason: string | null }
  >();
  const decide = (
    contact: LiveContact,
    analyticsClientId: string | null,
    reason: string | null,
  ): void => {
    const existing = decisions.get(contact.id);
    if (existing) {
      // Second analytics client claiming the same contact: ambiguous.
      existing.analyticsClientId = null;
      existing.reason = `${SYNC_AMBIGUOUS_PREFIX} matched by multiple analytics clients`;
      sample(
        `contact ${contact.id} (mb ${contact.mbClientId ?? "?"}) is claimed by multiple analytics clients`,
      );
      return;
    }
    decisions.set(contact.id, { contact, analyticsClientId, reason });
  };

  for (const client of clients.values()) {
    if (client.isAmbiguous) report.analyticsAmbiguous += 1;
    const matched: LiveContact[] = [];
    for (const sourceId of client.sourceIds) {
      for (const contact of contactsByMbId.get(sourceId) ?? []) {
        if (!matched.includes(contact)) matched.push(contact);
      }
    }
    if (matched.length === 0) {
      report.zero += 1;
      continue;
    }
    if (matched.length > 1) {
      report.multiple += 1;
      sample(
        `analytics client ${client.clientId} matches ${matched.length} contacts: ${matched
          .map((c) => c.id)
          .join(", ")}`,
      );
      for (const contact of matched) {
        decide(
          contact,
          null,
          `${SYNC_AMBIGUOUS_PREFIX} analytics client ${client.clientId} maps to ${matched.length} contacts`,
        );
      }
      continue;
    }
    report.exactlyOne += 1;
    const contact = matched[0]!;
    if (client.isAmbiguous) {
      decide(
        contact,
        null,
        `${SYNC_AMBIGUOUS_PREFIX} analytics client ${client.clientId} is name-match ambiguous in the mirror`,
      );
    } else {
      decide(contact, client.clientId, null);
    }
  }

  for (const { contact, analyticsClientId, reason } of decisions.values()) {
    if (reason) {
      if (contact.ambiguousReason !== reason) {
        await deps.store.markContactAmbiguous(contact.id, reason);
      }
      // An ambiguous mapping must not keep an old stamp: SEA-82 audiences
      // key on analytics_client_id, and a stale one points at a person
      // this contact may no longer be.
      if (contact.analyticsClientId !== null) {
        await deps.store.setAnalyticsClientId(contact.id, null);
      }
      continue;
    }
    // Clean 1:1: stamp the join key, clear any stale sync-set flag.
    if (contact.analyticsClientId !== analyticsClientId) {
      await deps.store.setAnalyticsClientId(contact.id, analyticsClientId);
    }
    if (contact.isAmbiguous) {
      await deps.store.clearSyncAmbiguity(contact.id, SYNC_AMBIGUOUS_PREFIX);
    }
  }

  // Reconciliation OWNS the stamp for every contact that carries a
  // Mindbody id: a contact matched by NO analytics client this run must
  // not keep a stamp from a previous run (the mirror re-merges nightly,
  // and a stale stamp would let an SEA-82 audience email the wrong,
  // former holder of that analytics id). Contacts without a Mindbody id
  // never participate in matching and are left alone.
  for (const contact of contacts) {
    if (
      contact.mbClientId &&
      contact.analyticsClientId !== null &&
      !decisions.has(contact.id)
    ) {
      await deps.store.setAnalyticsClientId(contact.id, null);
      sample(
        `contact ${contact.id} (mb ${contact.mbClientId}) lost its analytics match; stale stamp ${contact.analyticsClientId} cleared`,
      );
    }
  }

  // Final ambiguous count = flags that were already there (operator-set or
  // sync-set upstream) plus what this pass decided, minus what it cleared.
  const decided = new Set(
    [...decisions.values()].filter((d) => d.reason).map((d) => d.contact.id),
  );
  const cleared = new Set(
    [...decisions.values()]
      .filter(
        (d) =>
          !d.reason &&
          d.contact.isAmbiguous &&
          (d.contact.ambiguousReason ?? "").startsWith(SYNC_AMBIGUOUS_PREFIX),
      )
      .map((d) => d.contact.id),
  );
  report.ambiguousContacts = contacts.filter(
    (c) =>
      decided.has(c.id) || (c.isAmbiguous && !cleared.has(c.id)),
  ).length;

  return report;
}
