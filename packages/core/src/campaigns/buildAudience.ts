import {
  pgAudienceStore,
  type AudienceCandidate,
  type AudienceStore,
} from "../db/campaignAudience.js";
import {
  analyticsBlackout,
  analyticsConfigured,
  pageSelect,
} from "../tools/analytics.js";

/**
 * campaigns.build_audience (SEA-82): materialize a campaign's audience
 * from an analytics view into a frozen campaign_audience snapshot. Pure
 * code, no LLM.
 *
 * The boundary contract: sealevel-analytics owns WHO qualifies (the
 * v_campaign_* views, e.g. v_campaign_post_first_visit, return client_id
 * + a segment label and NOTHING else -- no PII crosses that boundary).
 * ai-manager owns everything after: resolving client_id to a contact via
 * contacts.analytics_client_id (stamped exclusively by SEA-81's
 * reconciliation, so only PROVEN 1:1 matches are reachable), consent,
 * suppression, and the snapshot.
 *
 * The filter chain, every drop categorized (order matters -- each contact
 * is dropped for the FIRST reason that applies, so the exclusion counts
 * reconcile: view rows = audience + sum of drops):
 *   1. unmappable    -- no live contact carries the client_id stamp;
 *   2. ambiguous     -- the contact is flagged is_ambiguous (sync:/
 *                       sync-dupe:/operator reasons; the view already
 *                       excludes MIRROR-side is_ambiguous clients);
 *   3. no email      -- defensive: the schema makes email NOT NULL and
 *                       non-empty, but the audience must never trust that
 *                       from a distance;
 *   4. unsubscribed  -- the latest consent_events row is not 'subscribed';
 *                       an EMPTY ledger is also not consent;
 *   5. suppressed    -- the address is on the suppressions list (keyed on
 *                       email, not contact id, per SEA-80 design point 3).
 *
 * Dry-run is the headline deliverable: the full recipient list and per-
 * segment counts, computed identically, WITHOUT a campaign row and
 * WITHOUT writing the snapshot. A dry-run against the default view needs
 * nothing in the campaigns table at all, so there is no scratch-campaign
 * hack to clean up and no risk a scratch row reaches a send path.
 */

/** The default audience view for dry-runs (SEA-82's shipped segment). */
export const DEFAULT_AUDIENCE_VIEW = "v_campaign_post_first_visit";

/** Every drop reason the exclusion report can carry, in filter order. */
export const EXCLUSION_REASONS = [
  "unmappable",
  "ambiguous",
  "no_email",
  "unsubscribed",
  "suppressed",
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** One admitted recipient (the dry-run list / the snapshot content). */
export interface AudienceRecipient {
  contactId: string;
  email: string;
  analyticsClientId: string;
  segment: string;
}

/** One categorized drop, self-explanatory for the exclusion report. */
export interface AudienceExclusion {
  reason: ExclusionReason;
  analyticsClientId: string;
  segment: string;
  contactId: string | null;
  /** Why, in words (the ambiguous_reason, the consent state, ...). */
  detail: string;
}

export interface BuildAudienceResult {
  status: "built" | "dry_run" | "skipped";
  reason?: string;
  campaignId: string | null;
  campaignKey: string | null;
  audienceView: string;
  /** Rows the analytics view returned (after in-run dedupe). */
  viewRows: number;
  /** Duplicate client_ids the view returned (dropped before counting). */
  duplicateViewRows: number;
  recipients: AudienceRecipient[];
  /** Recipients per segment label (passthrough from the view). */
  segmentCounts: Record<string, number>;
  /** Drops per reason; every key present, zero or not. */
  exclusionCounts: Record<ExclusionReason, number>;
  exclusions: AudienceExclusion[];
  /** The single frozen snapshot timestamp (null on dry-run/skip). */
  snapshotAt: Date | null;
  /** The done-when line, verbatim. */
  summary: string;
}

/** Injectable dependencies so the offline smoke runs every branch without
 * the MCP server or Postgres. Production callers pass nothing. */
export interface BuildAudienceDeps {
  pageSelect: typeof pageSelect;
  store: AudienceStore;
  log: (line: string) => void;
  now: () => Date;
}

function defaultDeps(): BuildAudienceDeps {
  return {
    pageSelect,
    store: pgAudienceStore(),
    log: (line) => console.log(line),
    now: () => new Date(),
  };
}

export interface BuildAudienceOptions {
  /** Campaign key to build FOR REAL (snapshot written). Omit for dry-run. */
  campaignKey?: string;
  /** View override for dry-runs; a real build uses the campaign row's
   * audience_view. Must be a bare identifier (defense in depth -- the
   * analytics identity is read-only anyway). */
  view?: string;
  /** Skip the analytics-mirror rebuild blackout guard (tests only). */
  ignoreBlackout?: boolean;
}

const VIEW_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function zeroCounts(): Record<ExclusionReason, number> {
  return {
    unmappable: 0,
    ambiguous: 0,
    no_email: 0,
    unsubscribed: 0,
    suppressed: 0,
  };
}

function skipped(
  reason: string,
  summary: string,
  audienceView: string,
): BuildAudienceResult {
  return {
    status: "skipped",
    reason,
    campaignId: null,
    campaignKey: null,
    audienceView,
    viewRows: 0,
    duplicateViewRows: 0,
    recipients: [],
    segmentCounts: {},
    exclusionCounts: zeroCounts(),
    exclusions: [],
    snapshotAt: null,
    summary,
  };
}

/** Bounded per-reason sample lines in the printed report; the full
 * exclusion list is always in the returned result. */
const REPORT_SAMPLES_PER_REASON = 5;

/**
 * Run the audience build. Dry-run (no campaignKey): compute everything,
 * write nothing. Real (campaignKey): additionally freeze the survivors
 * into campaign_audience under one snapshot_at and verify the stored
 * count matches.
 */
export async function buildAudience(
  options: BuildAudienceOptions = {},
  deps: BuildAudienceDeps = defaultDeps(),
): Promise<BuildAudienceResult> {
  const log = deps.log;
  const dryRun = !options.campaignKey;

  if (!analyticsConfigured()) {
    const summary =
      "campaigns.build_audience skipped: analytics identity is not configured (SEALEVEL_MCP_URL / SEALEVEL_MCP_ANALYTICS_TOKEN)";
    log(`[build_audience] ${summary}`);
    return skipped(
      "analytics_unconfigured",
      summary,
      options.view ?? DEFAULT_AUDIENCE_VIEW,
    );
  }
  if (!options.ignoreBlackout && analyticsBlackout(deps.now())) {
    const summary =
      "campaigns.build_audience skipped: inside the analytics-mirror rebuild blackout (02:15-06:00 PT, SEA-105); re-run after 06:00 PT";
    log(`[build_audience] ${summary}`);
    return skipped(
      "analytics_blackout",
      summary,
      options.view ?? DEFAULT_AUDIENCE_VIEW,
    );
  }

  // Resolve the campaign (real mode) and the view to read.
  let campaignId: string | null = null;
  let campaignKey: string | null = null;
  let view = options.view ?? DEFAULT_AUDIENCE_VIEW;
  if (!dryRun) {
    const campaign = await deps.store.getCampaignByKey(options.campaignKey!);
    if (!campaign) {
      throw new Error(
        `campaigns.build_audience: no campaign with key '${options.campaignKey}'`,
      );
    }
    // The audience snapshot is PART OF what a human approves: mutating it
    // after approval would make the approval ceremonial (the send would
    // reach people nobody signed off on). Rebuilding therefore requires
    // the campaign to be back in draft/pending_approval -- and once it is
    // sending or beyond, the snapshot is history and never rebuildable.
    if (
      ["approved", "sending", "sent", "cancelled"].includes(campaign.status)
    ) {
      throw new Error(
        `campaigns.build_audience: campaign '${campaign.key}' is ${campaign.status}; ` +
          (campaign.status === "approved"
            ? "its approved audience snapshot is frozen -- move it back to draft/pending_approval to rebuild"
            : "rebuilding its audience would break send reproducibility"),
      );
    }
    campaignId = campaign.id;
    campaignKey = campaign.key;
    view = campaign.audienceView;
  }
  if (!VIEW_NAME_RE.test(view)) {
    throw new Error(
      `campaigns.build_audience: audience view '${view}' is not a bare identifier`,
    );
  }

  // 1. Page WHO qualifies out of analytics: client_id + segment, nothing
  //    else. Deterministic ORDER BY per pageSelect's contract.
  const qualified = new Map<string, string>(); // client_id -> segment
  let duplicateViewRows = 0;
  for await (const rows of deps.pageSelect(
    `SELECT client_id, segment FROM ${view} ORDER BY client_id`,
    { maxRows: 100_000 },
  )) {
    for (const row of rows) {
      const clientId = String(row["client_id"]);
      const segment = String(row["segment"] ?? "default");
      if (qualified.has(clientId)) {
        duplicateViewRows += 1; // a view bug; count it, keep the first
        continue;
      }
      qualified.set(clientId, segment);
    }
  }

  // 2. Resolve client_id -> contact via the reconciliation's stamp. A
  //    stamp shared by several live contacts would mean the reconcile
  //    invariant broke; treat every such contact as ambiguous rather than
  //    guessing which one is the person.
  const candidates = await deps.store.listAudienceCandidates();
  const byAnalyticsId = new Map<string, AudienceCandidate[]>();
  for (const candidate of candidates) {
    const list = byAnalyticsId.get(candidate.analyticsClientId) ?? [];
    list.push(candidate);
    byAnalyticsId.set(candidate.analyticsClientId, list);
  }

  // 3. The filter chain. First matching reason wins, so the counts
  //    reconcile exactly: viewRows = recipients + sum(exclusions).
  const recipients: AudienceRecipient[] = [];
  const exclusions: AudienceExclusion[] = [];
  const exclusionCounts = zeroCounts();
  const segmentCounts: Record<string, number> = {};
  const drop = (
    reason: ExclusionReason,
    analyticsClientId: string,
    segment: string,
    contactId: string | null,
    detail: string,
  ): void => {
    exclusionCounts[reason] += 1;
    exclusions.push({ reason, analyticsClientId, segment, contactId, detail });
  };

  for (const [clientId, segment] of qualified) {
    const matched = byAnalyticsId.get(clientId) ?? [];
    if (matched.length === 0) {
      drop(
        "unmappable",
        clientId,
        segment,
        null,
        "no live contact carries this analytics_client_id (see the SEA-81 reconciliation report's zero-match count)",
      );
      continue;
    }
    if (matched.length > 1) {
      drop(
        "ambiguous",
        clientId,
        segment,
        null,
        `analytics_client_id stamped on ${matched.length} live contacts (${matched
          .map((c) => c.contactId)
          .join(", ")}); reconciliation should have prevented this`,
      );
      continue;
    }
    const contact = matched[0]!;
    if (contact.isAmbiguous) {
      drop(
        "ambiguous",
        clientId,
        segment,
        contact.contactId,
        contact.ambiguousReason ?? "flagged is_ambiguous",
      );
      continue;
    }
    if (!contact.email || contact.email.trim() === "") {
      drop("no_email", clientId, segment, contact.contactId, "contact has no email address");
      continue;
    }
    if (contact.consentState !== "subscribed") {
      drop(
        "unsubscribed",
        clientId,
        segment,
        contact.contactId,
        contact.consentState === null
          ? "consent ledger is empty (never opted in; an empty ledger is not consent)"
          : `latest consent event is '${contact.consentState}'`,
      );
      continue;
    }
    if (contact.suppressed) {
      drop(
        "suppressed",
        clientId,
        segment,
        contact.contactId,
        `address ${contact.email} is on the suppressions list`,
      );
      continue;
    }
    recipients.push({
      contactId: contact.contactId,
      email: contact.email,
      analyticsClientId: clientId,
      segment,
    });
    segmentCounts[segment] = (segmentCounts[segment] ?? 0) + 1;
  }

  // The reconciliation identity this whole report hangs on. If it ever
  // fails the filter chain has a hole, and no snapshot may be written.
  const dropped = Object.values(exclusionCounts).reduce((a, b) => a + b, 0);
  if (recipients.length + dropped !== qualified.size) {
    throw new Error(
      `campaigns.build_audience: counts do not reconcile (${qualified.size} view rows != ${recipients.length} recipients + ${dropped} drops)`,
    );
  }

  // 4. Freeze the snapshot (real mode only), one snapshot_at for the run.
  let snapshotAt: Date | null = null;
  if (!dryRun) {
    snapshotAt = deps.now();
    await deps.store.replaceAudienceSnapshot(
      campaignId!,
      recipients.map((r) => ({ contactId: r.contactId, segment: r.segment })),
      snapshotAt,
    );
    const stored = await deps.store.countAudience(campaignId!);
    if (stored !== recipients.length) {
      throw new Error(
        `campaigns.build_audience: snapshot verification failed (${stored} rows stored, ${recipients.length} expected)`,
      );
    }
  }

  // 5. The report. Pete reads this; every number must reconcile against
  //    the SEA-81 reconciliation report's counts.
  const mode = dryRun ? "DRY-RUN" : `campaign '${campaignKey}'`;
  const summary = `${qualified.size} qualified from ${view}, ${recipients.length} in audience, ${dropped} excluded (${exclusionCounts.unsubscribed} unsubscribed, ${exclusionCounts.suppressed} suppressed, ${exclusionCounts.ambiguous} ambiguous, ${exclusionCounts.no_email} no email, ${exclusionCounts.unmappable} unmappable)`;
  log(`[build_audience] ${mode}: ${summary}`);
  const segmentLine = Object.entries(segmentCounts)
    .map(([segment, count]) => `${segment}=${count}`)
    .join(", ");
  log(`[build_audience] segments: ${segmentLine || "(none)"}`);
  if (duplicateViewRows > 0) {
    log(
      `[build_audience] WARNING: ${duplicateViewRows} duplicate client_id rows returned by ${view} (kept first occurrence each)`,
    );
  }
  const perReason = new Map<ExclusionReason, number>();
  for (const exclusion of exclusions) {
    const shown = perReason.get(exclusion.reason) ?? 0;
    if (shown >= REPORT_SAMPLES_PER_REASON) continue;
    perReason.set(exclusion.reason, shown + 1);
    log(
      `[build_audience]   excluded (${exclusion.reason}): analytics client ${exclusion.analyticsClientId}${
        exclusion.contactId ? `, contact ${exclusion.contactId}` : ""
      } -- ${exclusion.detail}`,
    );
  }
  if (snapshotAt) {
    log(
      `[build_audience] snapshot frozen at ${snapshotAt.toISOString()} (${recipients.length} rows in campaign_audience)`,
    );
  }

  return {
    status: dryRun ? "dry_run" : "built",
    campaignId,
    campaignKey,
    audienceView: view,
    viewRows: qualified.size,
    duplicateViewRows,
    recipients,
    segmentCounts,
    exclusionCounts,
    exclusions,
    snapshotAt,
    summary,
  };
}
