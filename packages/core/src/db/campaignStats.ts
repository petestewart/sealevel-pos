import { getPool } from "./client.js";

/**
 * Read-only campaign stats for the console (SEA-90), over the SEA-80
 * schema (migrations/0011_campaigns.sql). Two notes from that migration
 * are load-bearing here:
 *
 * 1. campaign_events deliberately does NOT dedupe (a provider can deliver
 *    the same webhook twice), so every aggregate below counts DISTINCT
 *    send ids per event type, never raw event rows.
 *
 * 2. Recipient counts come from campaign_audience, the frozen snapshot of
 *    who qualified when the campaign was built -- not from the live
 *    audience view and not from campaign_sends (sends only exist once the
 *    enqueue job has run).
 *
 * Everything here is a plain read; approve/reject actions are SEA-83 and
 * segment authoring lives in git, so no writes belong in this module.
 */

export const CAMPAIGN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sending",
  "sent",
  "cancelled",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Overview-card counts: campaigns waiting on a human, campaigns in flight. */
export interface CampaignOverviewCounts {
  pendingApproval: number;
  sending: number;
}

/** Per-type unique-recipient event counts for one campaign. */
export interface CampaignEventCounts {
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
}

export const CAMPAIGN_EVENT_TYPES = [
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
] as const satisfies readonly (keyof CampaignEventCounts)[];

/** One campaign row for the console detail list. */
export interface CampaignSummary {
  id: string; // bigint comes back as text from pg
  key: string;
  name: string;
  status: CampaignStatus;
  runSeq: number;
  createdAt: Date;
  approvedAt: Date | null;
  /**
   * Size of the frozen campaign_audience snapshot. The snapshot is keyed
   * (campaign_id, contact_id) with no run column, so after a re-run
   * (run_seq > 1) this is the union of every run's audience, not the
   * latest run's. The console labels it accordingly.
   */
  recipients: number;
  /**
   * Unique sends per event type, scoped to the CAMPAIGN ROW: a re-run
   * (run_seq > 1) creates fresh campaign_sends rows, and the schema
   * carries run identity only inside the free-text `step` (a convention,
   * e.g. 'initial#2', not a column), so per-run scoping is not possible
   * without a schema change. Counts for a re-run campaign therefore span
   * all runs, and e.g. delivered can exceed recipients; the console
   * labels multi-run results as totals across runs.
   */
  events: CampaignEventCounts;
}

/**
 * Fold the GROUP BY status rows into overview counts. Exported for the
 * offline smoke; statuses outside the two the overview cares about are
 * ignored by construction (the query only selects those two).
 */
export function foldOverviewCounts(
  rows: readonly { status: string; count: string }[],
): CampaignOverviewCounts {
  const counts: CampaignOverviewCounts = { pendingApproval: 0, sending: 0 };
  for (const row of rows) {
    if (row.status === "pending_approval") {
      counts.pendingApproval = Number(row.count);
    } else if (row.status === "sending") {
      counts.sending = Number(row.count);
    }
  }
  return counts;
}

/**
 * Overview-card counts via one indexed GROUP BY (the partial
 * campaigns_status_idx covers both statuses). Returns zeros on an empty
 * table: the widget renders sensibly before any campaign exists.
 */
export async function campaignOverviewCounts(): Promise<CampaignOverviewCounts> {
  const { rows } = await getPool().query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count
       FROM campaigns
      WHERE status IN ('pending_approval', 'sending')
      GROUP BY status`,
  );
  return foldOverviewCounts(rows);
}

interface CampaignSummaryRow {
  id: string;
  key: string;
  name: string;
  status: CampaignStatus;
  run_seq: number;
  created_at: Date;
  approved_at: Date | null;
  recipients: string;
  delivered: string;
  opened: string;
  clicked: string;
  bounced: string;
  complained: string;
}

/** Shape a raw summary row into the exported type. Exported for the smoke. */
export function toCampaignSummary(row: CampaignSummaryRow): CampaignSummary {
  return {
    id: String(row.id),
    key: row.key,
    name: row.name,
    status: row.status,
    runSeq: row.run_seq,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    recipients: Number(row.recipients),
    events: {
      delivered: Number(row.delivered),
      opened: Number(row.opened),
      clicked: Number(row.clicked),
      bounced: Number(row.bounced),
      complained: Number(row.complained),
    },
  };
}

/**
 * All campaigns, newest first, each with its audience-snapshot size
 * (campaign_audience, NOT campaign_sends: sends only exist once the
 * enqueue job has run, and the snapshot is the promised recipient list)
 * and per-type event counts aggregated from campaign_events via
 * campaign_sends. Both aggregates are LEFT JOINed pre-grouped subqueries,
 * so a draft campaign with no audience and no sends still lists with
 * zeros, and count(DISTINCT s.id) per type absorbs duplicate provider
 * webhooks (see module note 1).
 *
 * Both aggregates are scoped to the campaign ROW, which for run_seq > 1
 * means totals across every run: see the CampaignSummary field docs for
 * why per-run scoping needs a schema change the reader must not fake by
 * parsing `step` text.
 *
 * No pagination: this is a low-cardinality operational table (one row per
 * campaign ever run for one studio), same call as listRules().
 */
export async function listCampaignSummaries(): Promise<CampaignSummary[]> {
  const { rows } = await getPool().query<CampaignSummaryRow>(
    `SELECT c.id, c.key, c.name, c.status, c.run_seq, c.created_at,
            c.approved_at,
            coalesce(a.recipients, '0') AS recipients,
            coalesce(e.delivered, '0')  AS delivered,
            coalesce(e.opened, '0')     AS opened,
            coalesce(e.clicked, '0')    AS clicked,
            coalesce(e.bounced, '0')    AS bounced,
            coalesce(e.complained, '0') AS complained
       FROM campaigns c
       LEFT JOIN (
         SELECT campaign_id, count(*)::text AS recipients
           FROM campaign_audience
          GROUP BY campaign_id
       ) a ON a.campaign_id = c.id
       LEFT JOIN (
         SELECT s.campaign_id,
                count(DISTINCT s.id) FILTER (WHERE ev.type = 'delivered')::text  AS delivered,
                count(DISTINCT s.id) FILTER (WHERE ev.type = 'opened')::text     AS opened,
                count(DISTINCT s.id) FILTER (WHERE ev.type = 'clicked')::text    AS clicked,
                count(DISTINCT s.id) FILTER (WHERE ev.type = 'bounced')::text    AS bounced,
                count(DISTINCT s.id) FILTER (WHERE ev.type = 'complained')::text AS complained
           FROM campaign_sends s
           JOIN campaign_events ev ON ev.send_id = s.id
          GROUP BY s.campaign_id
       ) e ON e.campaign_id = c.id
      ORDER BY c.created_at DESC, c.id DESC`,
  );
  return rows.map(toCampaignSummary);
}
