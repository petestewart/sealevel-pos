import type { Queryable } from "../db/campaignContacts.js";
import { getPool } from "../db/client.js";
import {
  emitCampaignAlert,
  type CampaignAlertPayload,
  type EmitResult,
} from "../notifications/emit.js";

/**
 * campaigns.monitor (SEA-92): the scheduled campaign health check. Pure
 * code, no brain; runs as a named worker processor on a 15-minute cadence
 * (queue/schedules.ts campaignsMonitorSchedule), reading the SEA-80 tables
 * (campaigns, campaign_sends, campaign_events) and alerting through the
 * existing Novu path (notifications/emit.ts, event type campaign_alert).
 *
 * READ-ONLY over the campaign tables by design: campaign_events ingestion
 * is SEA-85's lane, and the send pipeline is SEA-83/84's. The monitor's
 * only writes are to its own campaign_alert_state dedupe table (0015).
 *
 * Five conditions, thresholds from env (monitorConfigFromEnv, defaults
 * from the ticket):
 *
 * 1. complaint_rate: distinct complained sends / sent sends at or above
 *    COMPLAINT_RATE (default 0.1%), per campaign AND rolling across the
 *    last ROLLING_WINDOW_DAYS. The stop-everything signal.
 * 2. hard_bounce_rate: distinct hard-bounced sends / sent sends at or
 *    above HARD_BOUNCE_RATE (default 2%), per campaign. Means the
 *    audience data is wrong. Hard = Resend bounce type 'Permanent'
 *    (case-insensitive) read from the verbatim webhook body SEA-85
 *    stores in campaign_events.raw (see HARD_BOUNCE_PREDICATE);
 *    Transient/Undetermined/missing are soft and never counted, matching
 *    the ingestion's suppression logic exactly.
 * 3. stuck_sending: a campaign in status 'sending' with no send activity
 *    (no sent_at, falling back to approved_at/created_at) for
 *    STUCK_SENDING_MINUTES (default 120).
 * 4. zero_recipients: a campaign that reached 'sending'/'sent' but has NO
 *    campaign_sends rows at all, older than ZERO_RECIPIENT_GRACE_MINUTES
 *    (default 15). The silent no-op: an audience query that quietly
 *    returns nothing looks exactly like success.
 *
 * 5. overdue_scheduled (SEA-84): an APPROVED campaign whose due time has
 *    passed by OVERDUE_SCHEDULED_GRACE_MINUTES (default 30) with no send
 *    activity at all. Due time = send_at when scheduled (0018), else
 *    approved_at (an immediate send should have fired on approval). The
 *    scheduled twin of zero_recipients: a lost/dead-lettered enqueue
 *    looks exactly like a patient delay unless something is counting.
 *
 * Both rate checks require at least MIN_SENT sends (default 10) so a
 * five-person test send cannot page on a single event; the rolling check
 * has the same floor. Comparison is >= threshold (at the line fires).
 *
 * Resolution bound: the per-campaign rate checks and zero_recipients only
 * evaluate campaigns with activity inside ROLLING_WINDOW_DAYS ('sending'
 * campaigns always; 'sent' campaigns while their newest send, or their
 * approval for zero_recipients, is in the window). A terminal campaign's
 * numbers are frozen, so without this bound a once-crossed threshold
 * could never resolve and would re-page every REALERT_HOURS forever;
 * aging out of the window clears the alert state (clearResolvedAlerts),
 * and a recurrence on a fresh campaign pages immediately.
 *
 * Dedupe: one row per active condition in campaign_alert_state, keyed
 * "<alertType>:<scope>[:<campaignId>]". A condition notifies when the key
 * is new or its last notification is older than REALERT_HOURS (default
 * 24); a persistent condition therefore pages once a day, not every 15
 * minutes. Conditions that stop holding get their state row deleted, so a
 * recurrence pages immediately.
 *
 * Failure posture: DATABASE_URL unset = logged skip (boot-time schedule
 * stays harmless, same as the Gmail poll and the contact sync). A mid-run
 * Postgres error throws so BullMQ retries; every step is idempotent.
 * Novu-side failures never throw (emitCampaignAlert contains them) and do
 * NOT mark the condition notified, so the next run retries the page.
 */

export interface CampaignMonitorConfig {
  /** Fires at or above this complained/sent fraction. Default 0.001 (0.1%). */
  complaintRateThreshold: number;
  /** Fires at or above this hard-bounced/sent fraction. Default 0.02 (2%). */
  hardBounceRateThreshold: number;
  /** 'sending' with no send activity for this many minutes = stuck. */
  stuckSendingMinutes: number;
  /** How long after approval a sends-less 'sending'/'sent' campaign gets
   * before zero_recipients fires (the enqueue job needs a moment). */
  zeroRecipientGraceMinutes: number;
  /** How far past its due time (send_at, else approved_at) an 'approved'
   * campaign with no send rows gets before overdue_scheduled fires. */
  overdueScheduledGraceMinutes: number;
  /** Rolling complaint-rate window, in days. */
  rollingWindowDays: number;
  /** Minimum sent sends before either rate check applies. */
  minSentForRates: number;
  /** Cooldown before a still-active condition re-pages, in hours. */
  realertHours: number;
}

export const DEFAULT_MONITOR_CONFIG: CampaignMonitorConfig = {
  complaintRateThreshold: 0.001,
  hardBounceRateThreshold: 0.02,
  stuckSendingMinutes: 120,
  zeroRecipientGraceMinutes: 15,
  overdueScheduledGraceMinutes: 30,
  rollingWindowDays: 7,
  minSentForRates: 10,
  realertHours: 24,
};

/** Parse a positive number from env, falling back on absent/garbage. */
function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[campaigns.monitor] ignoring ${name}="${raw}" (not a positive number); using ${fallback}`,
    );
    return fallback;
  }
  return value;
}

/**
 * Thresholds from the environment (the repo's config pattern: env vars
 * with safe defaults, documented in docs/infrastructure.md), ticket
 * values as defaults. Rates are FRACTIONS (0.001 = 0.1%), not percents.
 */
export function monitorConfigFromEnv(): CampaignMonitorConfig {
  const d = DEFAULT_MONITOR_CONFIG;
  return {
    complaintRateThreshold: numFromEnv(
      "CAMPAIGN_ALERT_COMPLAINT_RATE",
      d.complaintRateThreshold,
    ),
    hardBounceRateThreshold: numFromEnv(
      "CAMPAIGN_ALERT_HARD_BOUNCE_RATE",
      d.hardBounceRateThreshold,
    ),
    stuckSendingMinutes: numFromEnv(
      "CAMPAIGN_ALERT_STUCK_SENDING_MINUTES",
      d.stuckSendingMinutes,
    ),
    zeroRecipientGraceMinutes: numFromEnv(
      "CAMPAIGN_ALERT_ZERO_RECIPIENT_GRACE_MINUTES",
      d.zeroRecipientGraceMinutes,
    ),
    overdueScheduledGraceMinutes: numFromEnv(
      "CAMPAIGN_ALERT_OVERDUE_SCHEDULED_GRACE_MINUTES",
      d.overdueScheduledGraceMinutes,
    ),
    rollingWindowDays: numFromEnv(
      "CAMPAIGN_ALERT_ROLLING_WINDOW_DAYS",
      d.rollingWindowDays,
    ),
    minSentForRates: numFromEnv("CAMPAIGN_ALERT_MIN_SENT", d.minSentForRates),
    realertHours: numFromEnv("CAMPAIGN_ALERT_REALERT_HOURS", d.realertHours),
  };
}

/** Per-campaign delivery stats for the rate checks. Counts are DISTINCT
 * send_id per event type: providers can deliver a webhook twice and
 * campaign_events does not always dedupe (0011 note; 0014 dedupes only
 * rows carrying a provider_event_id). Since 0014, campaign_events can
 * also hold UNCORRELATED rows with NULL send_id (webhook events matching
 * no send); the INNER JOIN on campaign_sends excludes those from every
 * count here by construction. */
export interface CampaignRateStats {
  campaignId: string;
  campaignKey: string;
  sent: number;
  complained: number;
  hardBounced: number;
}

export interface RollingRateStats {
  sent: number;
  complained: number;
}

export interface StuckCampaign {
  campaignId: string;
  campaignKey: string;
  minutesSinceActivity: number;
  queued: number;
}

export interface ZeroRecipientCampaign {
  campaignId: string;
  campaignKey: string;
  status: string;
  minutesSinceApproval: number;
}

export interface OverdueScheduledCampaign {
  campaignId: string;
  campaignKey: string;
  /** Minutes past the due time (send_at, else approved_at). */
  minutesOverdue: number;
  /** Whether the campaign carried an explicit send_at. */
  scheduled: boolean;
}

/**
 * The store interface the monitor depends on, so the offline smoke runs
 * every branch against an in-memory fake (same injection pattern as
 * campaignContacts.CampaignStore). pgMonitorStore is production.
 */
export interface MonitorStore {
  /** Rate stats for campaigns still worth evaluating: in 'sending', or
   * 'sent' with send activity inside the last windowDays. A terminal
   * campaign's historical rates never change, so without this bound a
   * once-crossed threshold would re-page every re-alert window FOREVER;
   * aging out of the window is how those conditions resolve. */
  campaignRateStats(windowDays: number): Promise<CampaignRateStats[]>;
  rollingRateStats(windowDays: number): Promise<RollingRateStats>;
  stuckCampaigns(thresholdMinutes: number): Promise<StuckCampaign[]>;
  /** Zero-recipient campaigns past the grace window but approved within
   * the last windowDays (same never-resolves reasoning as above: a
   * 'sent' campaign with no sends stays that way forever). */
  zeroRecipientCampaigns(
    graceMinutes: number,
    windowDays: number,
  ): Promise<ZeroRecipientCampaign[]>;
  /** Approved campaigns past their due time (send_at, else approved_at)
   * by more than graceMinutes with no campaign_sends rows, due within
   * the last windowDays (same never-resolves reasoning: an abandoned
   * approved campaign should stop paging once it ages out; the operator
   * either re-fires or cancels it). */
  overdueScheduledCampaigns(
    graceMinutes: number,
    windowDays: number,
  ): Promise<OverdueScheduledCampaign[]>;
  /** Upsert the condition as active and report whether it should notify
   * (no prior notification, or the last one is older than realertHours). */
  shouldNotify(
    alertKey: string,
    value: number,
    detail: string,
    realertHours: number,
  ): Promise<boolean>;
  /** Stamp last_notified_at = now for the key (call only after a
   * successful Novu trigger). */
  markNotified(alertKey: string): Promise<void>;
  /** Delete state rows whose condition no longer holds, so a recurrence
   * pages immediately. activeKeys empty = clear everything. */
  clearResolvedAlerts(activeKeys: string[]): Promise<void>;
}

/**
 * SQL predicate for a HARD bounce, matching SEA-85's ingestion exactly
 * (campaigns/resendWebhook.ts isHardBounce and the campaignEvents.ts
 * recordEvent that stores the VERBATIM Resend webhook body in
 * campaign_events.raw): the bounce type lives at
 * raw->'data'->'bounce'->>'type' with values Permanent / Transient /
 * Undetermined. Hard = 'permanent', case-insensitive, same as the
 * suppression logic; Transient, Undetermined and a missing type are NOT
 * hard (lower(NULL) is NULL, which never matches). Exported so the smoke
 * can pin the path and classification.
 */
export const HARD_BOUNCE_PREDICATE =
  `lower(e.raw->'data'->'bounce'->>'type') = 'permanent'`;

/** Production store over the shared pool (or any Queryable). */
export function pgMonitorStore(db?: Queryable): MonitorStore {
  const q = (): Queryable => db ?? getPool();
  return {
    async campaignRateStats(
      windowDays: number,
    ): Promise<CampaignRateStats[]> {
      const { rows } = await q().query(
        `SELECT c.id::text AS campaign_id,
                c.key AS campaign_key,
                (SELECT count(*)::int FROM campaign_sends s
                  WHERE s.campaign_id = c.id AND s.status = 'sent') AS sent,
                (SELECT count(DISTINCT e.send_id)::int
                   FROM campaign_events e
                   JOIN campaign_sends s ON s.id = e.send_id
                  WHERE s.campaign_id = c.id
                    AND e.type = 'complained') AS complained,
                (SELECT count(DISTINCT e.send_id)::int
                   FROM campaign_events e
                   JOIN campaign_sends s ON s.id = e.send_id
                  WHERE s.campaign_id = c.id
                    AND e.type = 'bounced'
                    AND ${HARD_BOUNCE_PREDICATE}) AS hard_bounced
         FROM campaigns c
         WHERE c.status = 'sending'
            OR (c.status = 'sent' AND EXISTS
                 (SELECT 1 FROM campaign_sends s
                   WHERE s.campaign_id = c.id AND s.status = 'sent'
                     AND s.sent_at >= now() - make_interval(days => $1)))
         ORDER BY c.id`,
        [windowDays],
      );
      return (rows as Array<Record<string, unknown>>).map((r) => ({
        campaignId: String(r.campaign_id),
        campaignKey: String(r.campaign_key),
        sent: Number(r.sent),
        complained: Number(r.complained),
        hardBounced: Number(r.hard_bounced),
      }));
    },

    async rollingRateStats(windowDays: number): Promise<RollingRateStats> {
      const { rows } = await q().query(
        `SELECT
           (SELECT count(*)::int FROM campaign_sends s
             WHERE s.status = 'sent'
               AND s.sent_at >= now() - make_interval(days => $1)) AS sent,
           (SELECT count(DISTINCT e.send_id)::int
              FROM campaign_events e
              JOIN campaign_sends s ON s.id = e.send_id
             WHERE e.type = 'complained'
               AND s.status = 'sent'
               AND s.sent_at >= now() - make_interval(days => $1)) AS complained`,
        [windowDays],
      );
      const r = rows[0] as { sent: number; complained: number };
      return { sent: Number(r.sent), complained: Number(r.complained) };
    },

    async stuckCampaigns(thresholdMinutes: number): Promise<StuckCampaign[]> {
      // "Activity" = the newest sent_at; a campaign mid-send refreshes it
      // continuously. Falls back to approved_at (when sending started at
      // the earliest) then created_at, so a 'sending' campaign that never
      // sent anything still ages into stuck.
      const { rows } = await q().query(
        `SELECT c.id::text AS campaign_id,
                c.key AS campaign_key,
                floor(extract(epoch FROM now() - coalesce(
                  (SELECT max(s.sent_at) FROM campaign_sends s
                    WHERE s.campaign_id = c.id),
                  c.approved_at, c.created_at)) / 60)::int AS minutes_since_activity,
                (SELECT count(*)::int FROM campaign_sends s
                  WHERE s.campaign_id = c.id AND s.status = 'queued') AS queued
         FROM campaigns c
         WHERE c.status = 'sending'
           AND coalesce(
                 (SELECT max(s.sent_at) FROM campaign_sends s
                   WHERE s.campaign_id = c.id),
                 c.approved_at, c.created_at)
               < now() - make_interval(mins => $1)
         ORDER BY c.id`,
        [thresholdMinutes],
      );
      return (rows as Array<Record<string, unknown>>).map((r) => ({
        campaignId: String(r.campaign_id),
        campaignKey: String(r.campaign_key),
        minutesSinceActivity: Number(r.minutes_since_activity),
        queued: Number(r.queued),
      }));
    },

    async zeroRecipientCampaigns(
      graceMinutes: number,
      windowDays: number,
    ): Promise<ZeroRecipientCampaign[]> {
      // The windowDays upper bound is what lets this condition resolve: a
      // 'sent' campaign with no sends stays that way forever, so without
      // it the alert would re-page every re-alert window indefinitely.
      const { rows } = await q().query(
        `SELECT c.id::text AS campaign_id,
                c.key AS campaign_key,
                c.status,
                floor(extract(epoch FROM now() -
                  coalesce(c.approved_at, c.created_at)) / 60)::int
                  AS minutes_since_approval
         FROM campaigns c
         WHERE c.status IN ('sending', 'sent')
           AND NOT EXISTS
             (SELECT 1 FROM campaign_sends s WHERE s.campaign_id = c.id)
           AND coalesce(c.approved_at, c.created_at)
               < now() - make_interval(mins => $1)
           AND coalesce(c.approved_at, c.created_at)
               >= now() - make_interval(days => $2)
         ORDER BY c.id`,
        [graceMinutes, windowDays],
      );
      return (rows as Array<Record<string, unknown>>).map((r) => ({
        campaignId: String(r.campaign_id),
        campaignKey: String(r.campaign_key),
        status: String(r.status),
        minutesSinceApproval: Number(r.minutes_since_approval),
      }));
    },

    async overdueScheduledCampaigns(
      graceMinutes: number,
      windowDays: number,
    ): Promise<OverdueScheduledCampaign[]> {
      // Due time: send_at when the campaign is scheduled (0018), else
      // approved_at (an immediate send should have fired on approval).
      const { rows } = await q().query(
        `SELECT c.id::text AS campaign_id,
                c.key AS campaign_key,
                (c.send_at IS NOT NULL) AS scheduled,
                floor(extract(epoch FROM now() -
                  coalesce(c.send_at, c.approved_at)) / 60)::int
                  AS minutes_overdue
         FROM campaigns c
         WHERE c.status = 'approved'
           AND NOT EXISTS
             (SELECT 1 FROM campaign_sends s WHERE s.campaign_id = c.id)
           AND coalesce(c.send_at, c.approved_at)
               < now() - make_interval(mins => $1)
           AND coalesce(c.send_at, c.approved_at)
               >= now() - make_interval(days => $2)
         ORDER BY c.id`,
        [graceMinutes, windowDays],
      );
      return (rows as Array<Record<string, unknown>>).map((r) => ({
        campaignId: String(r.campaign_id),
        campaignKey: String(r.campaign_key),
        minutesOverdue: Number(r.minutes_overdue),
        scheduled: Boolean(r.scheduled),
      }));
    },

    async shouldNotify(
      alertKey: string,
      value: number,
      detail: string,
      realertHours: number,
    ): Promise<boolean> {
      const { rows } = await q().query(
        `INSERT INTO campaign_alert_state (alert_key, last_value, detail)
         VALUES ($1, $2, $3)
         ON CONFLICT (alert_key) DO UPDATE SET
           last_detected_at = now(),
           last_value = EXCLUDED.last_value,
           detail = EXCLUDED.detail
         RETURNING (last_notified_at IS NULL
                    OR last_notified_at < now() - make_interval(hours => $4))
                   AS should_notify`,
        [alertKey, value, detail, realertHours],
      );
      return Boolean((rows[0] as { should_notify: boolean }).should_notify);
    },

    async markNotified(alertKey: string): Promise<void> {
      await q().query(
        `UPDATE campaign_alert_state SET last_notified_at = now()
         WHERE alert_key = $1`,
        [alertKey],
      );
    },

    async clearResolvedAlerts(activeKeys: string[]): Promise<void> {
      await q().query(
        `DELETE FROM campaign_alert_state
         WHERE NOT (alert_key = ANY($1::text[]))`,
        [activeKeys],
      );
    },
  };
}

export interface CampaignMonitorResult {
  status: "checked" | "skipped";
  reason?: string;
  /** Campaigns examined by the per-campaign rate checks. */
  campaignsChecked: number;
  /** Active alert conditions found this run. */
  conditions: number;
  /** Novu triggers actually sent. */
  notified: number;
  /** Conditions still active but inside the dedupe cooldown. */
  suppressed: number;
  /** The payloads of every active condition (sent or suppressed). */
  alerts: CampaignAlertPayload[];
  /** The done-when line, verbatim. */
  summary: string;
}

/** Injectable dependencies so the offline smoke runs every branch without
 * Postgres or Novu. Production callers pass nothing. */
export interface MonitorDeps {
  store: MonitorStore;
  emit: (payload: CampaignAlertPayload) => Promise<EmitResult>;
  now: () => Date;
  log: (line: string) => void;
}

function defaultDeps(): MonitorDeps {
  return {
    store: pgMonitorStore(),
    emit: (payload) => emitCampaignAlert(payload),
    now: () => new Date(),
    log: (line) => console.log(line),
  };
}

/** Deterministic dedupe key: "<alertType>:<scope>[:<campaignId>]". */
export function alertKey(
  alertType: CampaignAlertPayload["alertType"],
  scope: CampaignAlertPayload["scope"],
  campaignId?: string | null,
): string {
  return campaignId ? `${alertType}:${scope}:${campaignId}` : `${alertType}:${scope}`;
}

/** Render a fraction as a percent string for alert copy, e.g. "0.13%". */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

interface ActiveCondition {
  key: string;
  value: number;
  payload: CampaignAlertPayload;
}

/**
 * Run the campaign health check once. Collects every active condition,
 * dedupes against campaign_alert_state, emits campaign_alert for the ones
 * due, and clears state for conditions that resolved.
 */
export async function runCampaignMonitor(
  deps?: Partial<MonitorDeps>,
  config?: CampaignMonitorConfig,
): Promise<CampaignMonitorResult> {
  const cfg = config ?? monitorConfigFromEnv();
  const skipResult = (reason: string): CampaignMonitorResult => ({
    status: "skipped",
    reason,
    campaignsChecked: 0,
    conditions: 0,
    notified: 0,
    suppressed: 0,
    alerts: [],
    summary: `campaign monitor skipped (${reason})`,
  });
  if (!deps?.store && !process.env.DATABASE_URL) {
    console.log("[campaigns.monitor] DATABASE_URL unset; skipping");
    return skipResult("DATABASE_URL unset");
  }
  const d: MonitorDeps = { ...defaultDeps(), ...deps };
  const at = d.now().toISOString();
  const conditions: ActiveCondition[] = [];

  // 1 + 2. Per-campaign complaint and hard-bounce rates.
  const perCampaign = await d.store.campaignRateStats(cfg.rollingWindowDays);
  for (const c of perCampaign) {
    if (c.sent < cfg.minSentForRates) continue;
    const complaintRate = c.complained / c.sent;
    if (complaintRate >= cfg.complaintRateThreshold) {
      conditions.push({
        key: alertKey("complaint_rate", "campaign", c.campaignId),
        value: complaintRate,
        payload: {
          alertType: "complaint_rate",
          scope: "campaign",
          campaignId: c.campaignId,
          campaignKey: c.campaignKey,
          rate: complaintRate,
          threshold: cfg.complaintRateThreshold,
          numerator: c.complained,
          denominator: c.sent,
          detail: `Complaint rate ${pct(complaintRate)} on campaign ${c.campaignKey} (${c.complained}/${c.sent}, threshold ${pct(cfg.complaintRateThreshold)}). Stop sending and investigate.`,
          at,
        },
      });
    }
    const bounceRate = c.hardBounced / c.sent;
    if (bounceRate >= cfg.hardBounceRateThreshold) {
      conditions.push({
        key: alertKey("hard_bounce_rate", "campaign", c.campaignId),
        value: bounceRate,
        payload: {
          alertType: "hard_bounce_rate",
          scope: "campaign",
          campaignId: c.campaignId,
          campaignKey: c.campaignKey,
          rate: bounceRate,
          threshold: cfg.hardBounceRateThreshold,
          numerator: c.hardBounced,
          denominator: c.sent,
          detail: `Hard bounce rate ${pct(bounceRate)} on campaign ${c.campaignKey} (${c.hardBounced}/${c.sent}, threshold ${pct(cfg.hardBounceRateThreshold)}). The audience data looks wrong.`,
          at,
        },
      });
    }
  }

  // 1b. Rolling complaint rate across campaigns.
  const rolling = await d.store.rollingRateStats(cfg.rollingWindowDays);
  if (rolling.sent >= cfg.minSentForRates) {
    const rollingRate = rolling.complained / rolling.sent;
    if (rollingRate >= cfg.complaintRateThreshold) {
      conditions.push({
        key: alertKey("complaint_rate", "rolling"),
        value: rollingRate,
        payload: {
          alertType: "complaint_rate",
          scope: "rolling",
          campaignId: null,
          campaignKey: null,
          rate: rollingRate,
          threshold: cfg.complaintRateThreshold,
          numerator: rolling.complained,
          denominator: rolling.sent,
          detail: `Rolling ${cfg.rollingWindowDays}-day complaint rate ${pct(rollingRate)} (${rolling.complained}/${rolling.sent}, threshold ${pct(cfg.complaintRateThreshold)}). Stop all sending and investigate.`,
          at,
        },
      });
    }
  }

  // 3. Stuck in 'sending'.
  for (const s of await d.store.stuckCampaigns(cfg.stuckSendingMinutes)) {
    conditions.push({
      key: alertKey("stuck_sending", "campaign", s.campaignId),
      value: s.minutesSinceActivity,
      payload: {
        alertType: "stuck_sending",
        scope: "campaign",
        campaignId: s.campaignId,
        campaignKey: s.campaignKey,
        rate: null,
        threshold: cfg.stuckSendingMinutes,
        numerator: s.queued,
        denominator: null,
        detail: `Campaign ${s.campaignKey} has been in 'sending' with no activity for ${s.minutesSinceActivity} minutes (${s.queued} still queued, threshold ${cfg.stuckSendingMinutes} min).`,
        at,
      },
    });
  }

  // 4. Zero recipients.
  for (const z of await d.store.zeroRecipientCampaigns(
    cfg.zeroRecipientGraceMinutes,
    cfg.rollingWindowDays,
  )) {
    conditions.push({
      key: alertKey("zero_recipients", "campaign", z.campaignId),
      value: 0,
      payload: {
        alertType: "zero_recipients",
        scope: "campaign",
        campaignId: z.campaignId,
        campaignKey: z.campaignKey,
        rate: null,
        threshold: null,
        numerator: 0,
        denominator: null,
        detail: `Campaign ${z.campaignKey} is '${z.status}' but produced zero recipients (${z.minutesSinceApproval} minutes since approval). The audience query may have quietly returned nothing.`,
        at,
      },
    });
  }

  // 5. Overdue scheduled/approved sends (SEA-84).
  for (const o of await d.store.overdueScheduledCampaigns(
    cfg.overdueScheduledGraceMinutes,
    cfg.rollingWindowDays,
  )) {
    conditions.push({
      key: alertKey("overdue_scheduled", "campaign", o.campaignId),
      value: o.minutesOverdue,
      payload: {
        alertType: "overdue_scheduled",
        scope: "campaign",
        campaignId: o.campaignId,
        campaignKey: o.campaignKey,
        rate: null,
        threshold: cfg.overdueScheduledGraceMinutes,
        numerator: o.minutesOverdue,
        denominator: null,
        detail: o.scheduled
          ? `Campaign ${o.campaignKey} is approved with a scheduled send time that passed ${o.minutesOverdue} minutes ago, but no send has started (grace ${cfg.overdueScheduledGraceMinutes} min). The send job may not have been enqueued.`
          : `Campaign ${o.campaignKey} was approved ${o.minutesOverdue} minutes ago for an immediate send, but no send has started (grace ${cfg.overdueScheduledGraceMinutes} min). The send job may not have been enqueued.`,
        at,
      },
    });
  }

  // Dedupe, emit, and clear resolved state.
  let notified = 0;
  let suppressed = 0;
  for (const condition of conditions) {
    const due = await d.store.shouldNotify(
      condition.key,
      condition.value,
      condition.payload.detail,
      cfg.realertHours,
    );
    if (!due) {
      suppressed += 1;
      continue;
    }
    const result = await d.emit(condition.payload);
    if (result.sent) {
      notified += 1;
      await d.store.markNotified(condition.key);
    } else {
      // Not marked notified: the next run retries the page (e.g. Novu
      // still unconfigured, or a transient trigger failure).
      d.log(
        `[campaigns.monitor] alert ${condition.key} not delivered (${result.reason ?? "unknown"}); will retry next run`,
      );
    }
  }
  await d.store.clearResolvedAlerts(conditions.map((c) => c.key));

  const summary = `${perCampaign.length} campaigns checked, ${conditions.length} alert conditions, ${notified} notified, ${suppressed} suppressed by dedupe`;
  d.log(`[campaigns.monitor] ${summary}`);
  return {
    status: "checked",
    campaignsChecked: perCampaign.length,
    conditions: conditions.length,
    notified,
    suppressed,
    alerts: conditions.map((c) => c.payload),
    summary,
  };
}
