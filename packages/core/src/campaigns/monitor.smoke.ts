import assert from "node:assert/strict";

import type { Item } from "../db/items.js";
import {
  emitCampaignAlert,
  emitItemEvent,
  WORKFLOW_IDS,
  type CampaignAlertPayload,
  type EventPayload,
} from "../notifications/emit.js";
import {
  alertKey,
  DEFAULT_MONITOR_CONFIG,
  HARD_BOUNCE_PREDICATE,
  monitorConfigFromEnv,
  pgMonitorStore,
  runCampaignMonitor,
  type CampaignMonitorConfig,
  type CampaignRateStats,
  type MonitorStore,
  type RollingRateStats,
  type StuckCampaign,
  type ZeroRecipientCampaign,
} from "./monitor.js";

/**
 * Campaign alerting smoke check (SEA-92), fully offline: no Postgres, no
 * Novu, no network. Covers, in order:
 *
 *  1. campaign_approval event registration and emit payload shape (the
 *     SEA-83 call site's contract).
 *  2. emitCampaignAlert payload shape and workflow id.
 *  3. Each monitor condition fires AT its threshold and not below it:
 *     complaint rate (per campaign and rolling), hard bounce rate, stuck
 *     'sending', zero recipients.
 *  4. The min-sent floor keeps tiny sends from paging on one event.
 *  5. Dedupe: a persistent condition notifies once, is suppressed on the
 *     next run, re-pages after the re-alert window, and a resolved
 *     condition's state is cleared so a recurrence pages immediately.
 *  6. A failed emit does NOT mark the condition notified (next run
 *     retries).
 *  7. Resolution bound regression: a per-campaign rate condition and a
 *     zero_recipients condition on a terminal 'sent' campaign stop being
 *     evaluated once the campaign ages out of the rolling window, so
 *     their state clears (no re-page forever) and a fresh recurrence
 *     pages immediately.
 *  8. Hard-bounce classification is pinned to the SEA-85 raw shape
 *     (verbatim Resend body, raw->'data'->'bounce'->>'type'): the
 *     predicate string offline, and, when DATABASE_URL is set, the real
 *     SQL against seeded Permanent/Transient/Undetermined/missing
 *     bounces inside a rolled-back transaction (self-skips without a DB,
 *     same pattern as the learning smoke).
 *  9. monitorConfigFromEnv: overrides parse, garbage falls back.
 * 10. Without DATABASE_URL and without injected deps, the run is a
 *     logged skip.
 *
 * Run: npm run smoke:campaignmonitor --workspace @ai-manager/core
 */

/** A fake per-campaign stats row: status/lastSendAgeDays model the SQL's
 * activity-window bound (status defaults to 'sent', age to 0 = fresh). */
type FakeRateRow = CampaignRateStats & {
  status?: "sending" | "sent";
  lastSendAgeDays?: number;
};
type FakeZeroRow = ZeroRecipientCampaign & { ageDays?: number };

/** In-memory MonitorStore with a controllable clock for dedupe timing. */
class FakeStore implements MonitorStore {
  campaigns: FakeRateRow[] = [];
  rolling: RollingRateStats = { sent: 0, complained: 0 };
  stuck: StuckCampaign[] = [];
  zero: FakeZeroRow[] = [];
  /** alert_key -> last_notified_at epoch ms (null = detected, never sent). */
  state = new Map<string, number | null>();
  nowMs = Date.parse("2026-08-11T12:00:00Z");

  async campaignRateStats(windowDays: number): Promise<CampaignRateStats[]> {
    // Mirrors the SQL's resolution bound: 'sending' always evaluated,
    // 'sent' only while the newest send is inside the window.
    return this.campaigns.filter(
      (c) =>
        (c.status ?? "sent") === "sending" ||
        (c.lastSendAgeDays ?? 0) <= windowDays,
    );
  }
  async rollingRateStats(): Promise<RollingRateStats> {
    return this.rolling;
  }
  async stuckCampaigns(): Promise<StuckCampaign[]> {
    return this.stuck;
  }
  async zeroRecipientCampaigns(
    _graceMinutes: number,
    windowDays: number,
  ): Promise<ZeroRecipientCampaign[]> {
    return this.zero.filter((z) => (z.ageDays ?? 0) <= windowDays);
  }
  async shouldNotify(
    key: string,
    _value: number,
    _detail: string,
    realertHours: number,
  ): Promise<boolean> {
    const lastNotified = this.state.get(key);
    if (!this.state.has(key)) this.state.set(key, null);
    if (lastNotified === undefined || lastNotified === null) return true;
    return this.nowMs - lastNotified >= realertHours * 3_600_000;
  }
  async markNotified(key: string): Promise<void> {
    this.state.set(key, this.nowMs);
  }
  async clearResolvedAlerts(activeKeys: string[]): Promise<void> {
    const keep = new Set(activeKeys);
    for (const key of [...this.state.keys()]) {
      if (!keep.has(key)) this.state.delete(key);
    }
  }
}

const cfg: CampaignMonitorConfig = { ...DEFAULT_MONITOR_CONFIG };

interface Harness {
  store: FakeStore;
  emitted: CampaignAlertPayload[];
  run: (config?: CampaignMonitorConfig) => ReturnType<typeof runCampaignMonitor>;
}

function harness(emitSent = true): Harness {
  const store = new FakeStore();
  const emitted: CampaignAlertPayload[] = [];
  return {
    store,
    emitted,
    run: (config = cfg) =>
      runCampaignMonitor(
        {
          store,
          emit: async (payload) => {
            emitted.push(payload);
            return emitSent ? { sent: true } : { sent: false, reason: "boom" };
          },
          now: () => new Date(store.nowMs),
          log: () => {},
        },
        config,
      ),
  };
}

async function checkEmitShapes(): Promise<void> {
  // Registration: both new event types map to workflow ids.
  assert.equal(WORKFLOW_IDS.campaign_approval, "campaign_approval");
  assert.equal(WORKFLOW_IDS.campaign_alert, "campaign_alert");

  process.env.NOVU_SECRET_KEY = "smoke-test-key";
  process.env.NOVU_SUBSCRIBER_PETE ??= "pete";
  process.env.NOVU_SUBSCRIBER_ALISON ??= "alison";

  // 1. campaign_approval: exactly the call SEA-83 will make.
  const item: Item = {
    id: "77",
    type: "campaign_approval",
    domain: "campaigns",
    status: "pending_approval",
    audience: null,
    assignee: "pete",
    payload: { campaignKey: "win-back-2026-08" },
    created_at: new Date("2026-08-11T09:00:00Z"),
    resolved_at: null,
  };
  const calls: Array<{ workflowId: string; subscriberIds: string[]; payload: EventPayload }> = [];
  const approval = await emitItemEvent("campaign_approval", item, "brain", async (args) => {
    calls.push(args);
  });
  assert.deepEqual(approval, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.workflowId, "campaign_approval");
  assert.deepEqual(calls[0]!.subscriberIds, [
    process.env.NOVU_SUBSCRIBER_PETE,
    process.env.NOVU_SUBSCRIBER_ALISON,
  ]);
  assert.equal(calls[0]!.payload.itemId, "77");
  assert.equal(calls[0]!.payload.itemType, "campaign_approval");
  assert.equal(calls[0]!.payload.status, "pending_approval");
  assert.equal(calls[0]!.payload.actor, "brain");
  assert.equal(calls[0]!.payload.createdAt, "2026-08-11T09:00:00.000Z");
  console.log("campaign_approval emit OK:", JSON.stringify(calls[0]!.payload));

  // 2. campaign_alert payload passes through verbatim.
  const alertPayload: CampaignAlertPayload = {
    alertType: "complaint_rate",
    scope: "campaign",
    campaignId: "3",
    campaignKey: "spring-sale",
    rate: 0.002,
    threshold: 0.001,
    numerator: 2,
    denominator: 1000,
    detail: "Complaint rate 0.2% on campaign spring-sale (2/1000, threshold 0.1%). Stop sending and investigate.",
    at: "2026-08-11T12:00:00.000Z",
  };
  calls.length = 0;
  const alert = await emitCampaignAlert(alertPayload, async (args) => {
    calls.push(args);
  });
  assert.deepEqual(alert, { sent: true });
  assert.equal(calls[0]!.workflowId, "campaign_alert");
  assert.deepEqual(calls[0]!.payload, alertPayload);

  // Containment: a throwing trigger is reported, never thrown.
  const contained = await emitCampaignAlert(alertPayload, async () => {
    throw new Error("boom");
  });
  assert.deepEqual(contained, { sent: false, reason: "boom" });
  console.log("campaign_alert emit OK (shape + containment)");
}

async function checkComplaintRate(): Promise<void> {
  const h = harness();
  // Exactly at threshold: 1 complained / 1000 sent = 0.1% -> fires.
  // Just below: 1 / 1001 -> silent. Denominator is sent sends.
  h.store.campaigns = [
    { campaignId: "1", campaignKey: "at-threshold", sent: 1000, complained: 1, hardBounced: 0 },
    { campaignId: "2", campaignKey: "below", sent: 1001, complained: 1, hardBounced: 0 },
  ];
  const result = await h.run();
  assert.equal(result.status, "checked");
  assert.equal(result.conditions, 1);
  assert.equal(result.notified, 1);
  assert.equal(h.emitted.length, 1);
  const alert = h.emitted[0]!;
  assert.equal(alert.alertType, "complaint_rate");
  assert.equal(alert.scope, "campaign");
  assert.equal(alert.campaignKey, "at-threshold");
  assert.equal(alert.rate, 0.001);
  assert.equal(alert.threshold, cfg.complaintRateThreshold);
  assert.equal(alert.numerator, 1);
  assert.equal(alert.denominator, 1000);
  assert.ok(alert.detail.includes("at-threshold"));
  console.log("complaint rate per campaign OK: fires at 0.1%, not below");
}

async function checkRollingComplaintRate(): Promise<void> {
  const h = harness();
  // No single campaign over the line, but the rolling total is at it.
  h.store.campaigns = [
    { campaignId: "1", campaignKey: "a", sent: 1000, complained: 0, hardBounced: 0 },
    { campaignId: "2", campaignKey: "b", sent: 1000, complained: 0, hardBounced: 0 },
  ];
  h.store.rolling = { sent: 2000, complained: 2 };
  const result = await h.run();
  assert.equal(result.conditions, 1);
  const alert = h.emitted[0]!;
  assert.equal(alert.alertType, "complaint_rate");
  assert.equal(alert.scope, "rolling");
  assert.equal(alert.campaignId, null);
  assert.equal(alert.rate, 0.001);

  // And just below stays silent.
  const h2 = harness();
  h2.store.rolling = { sent: 2001, complained: 2 };
  const quiet = await h2.run();
  assert.equal(quiet.conditions, 0);
  console.log("rolling complaint rate OK: fires at threshold, not below");
}

async function checkHardBounceRate(): Promise<void> {
  const h = harness();
  // 2 hard bounces / 100 sent = 2% -> fires; 1 / 100 = 1% -> silent.
  h.store.campaigns = [
    { campaignId: "5", campaignKey: "bad-list", sent: 100, complained: 0, hardBounced: 2 },
    { campaignId: "6", campaignKey: "ok-list", sent: 100, complained: 0, hardBounced: 1 },
  ];
  const result = await h.run();
  assert.equal(result.conditions, 1);
  const alert = h.emitted[0]!;
  assert.equal(alert.alertType, "hard_bounce_rate");
  assert.equal(alert.campaignKey, "bad-list");
  assert.equal(alert.rate, 0.02);
  assert.equal(alert.threshold, cfg.hardBounceRateThreshold);
  console.log("hard bounce rate OK: fires at 2%, not below");
}

async function checkMinSentFloor(): Promise<void> {
  const h = harness();
  // 1 complaint in a 5-person test is 20%, way over 0.1%, but below the
  // min-sent floor (10): no page. Rolling has the same floor.
  h.store.campaigns = [
    { campaignId: "7", campaignKey: "tiny-test", sent: 5, complained: 1, hardBounced: 1 },
  ];
  h.store.rolling = { sent: 5, complained: 1 };
  const result = await h.run();
  assert.equal(result.conditions, 0);
  assert.equal(h.emitted.length, 0);
  console.log("min-sent floor OK: 5-send test with 1 complaint stays silent");
}

async function checkStuckSending(): Promise<void> {
  const h = harness();
  h.store.stuck = [
    { campaignId: "8", campaignKey: "stalled", minutesSinceActivity: 130, queued: 42 },
  ];
  const result = await h.run();
  assert.equal(result.conditions, 1);
  const alert = h.emitted[0]!;
  assert.equal(alert.alertType, "stuck_sending");
  assert.equal(alert.campaignKey, "stalled");
  assert.equal(alert.threshold, cfg.stuckSendingMinutes);
  assert.equal(alert.numerator, 42);
  assert.ok(alert.detail.includes("130 minutes"));

  // The store applies the threshold in SQL; an empty result = no alert.
  const h2 = harness();
  h2.store.stuck = [];
  assert.equal((await h2.run()).conditions, 0);
  console.log("stuck sending OK: fires past threshold, not before");
}

async function checkZeroRecipients(): Promise<void> {
  const h = harness();
  h.store.zero = [
    { campaignId: "9", campaignKey: "silent-noop", status: "sent", minutesSinceApproval: 30 },
  ];
  const result = await h.run();
  assert.equal(result.conditions, 1);
  const alert = h.emitted[0]!;
  assert.equal(alert.alertType, "zero_recipients");
  assert.equal(alert.campaignKey, "silent-noop");
  assert.ok(alert.detail.includes("zero recipients"));

  // Inside the grace window (SQL-filtered) or with sends: no alert.
  const h2 = harness();
  h2.store.zero = [];
  assert.equal((await h2.run()).conditions, 0);
  console.log("zero recipients OK");
}

async function checkDedupe(): Promise<void> {
  const h = harness();
  h.store.campaigns = [
    { campaignId: "1", campaignKey: "hot", sent: 1000, complained: 5, hardBounced: 0 },
  ];

  // Run 1: fires. Run 2 (15 min later, condition persists): suppressed.
  const first = await h.run();
  assert.equal(first.notified, 1);
  assert.equal(first.suppressed, 0);
  h.store.nowMs += 15 * 60_000;
  const second = await h.run();
  assert.equal(second.conditions, 1);
  assert.equal(second.notified, 0);
  assert.equal(second.suppressed, 1);
  assert.equal(h.emitted.length, 1);

  // Run 3, after the 24h re-alert window: pages again.
  h.store.nowMs += 24 * 3_600_000;
  const third = await h.run();
  assert.equal(third.notified, 1);
  assert.equal(h.emitted.length, 2);

  // Condition resolves: state row cleared...
  const key = alertKey("complaint_rate", "campaign", "1");
  h.store.campaigns = [
    { campaignId: "1", campaignKey: "hot", sent: 10000, complained: 5, hardBounced: 0 },
  ];
  h.store.nowMs += 15 * 60_000;
  const resolved = await h.run();
  assert.equal(resolved.conditions, 0);
  assert.equal(h.store.state.has(key), false);

  // ...so a recurrence pages immediately, no cooldown carryover.
  h.store.campaigns = [
    { campaignId: "1", campaignKey: "hot", sent: 1000, complained: 5, hardBounced: 0 },
  ];
  h.store.nowMs += 15 * 60_000;
  const recurrence = await h.run();
  assert.equal(recurrence.notified, 1);
  assert.equal(h.emitted.length, 3);
  console.log("dedupe OK: suppress, re-alert after window, clear on resolve");
}

async function checkFailedEmitRetries(): Promise<void> {
  const h = harness(/* emitSent */ false);
  h.store.campaigns = [
    { campaignId: "1", campaignKey: "hot", sent: 1000, complained: 5, hardBounced: 0 },
  ];
  const first = await h.run();
  assert.equal(first.conditions, 1);
  assert.equal(first.notified, 0);
  // Not marked notified, so the very next run tries again.
  h.store.nowMs += 15 * 60_000;
  const second = await h.run();
  assert.equal(second.suppressed, 0);
  assert.equal(h.emitted.length, 2);
  console.log("failed emit OK: condition not marked notified, retried next run");
}

function checkConfigFromEnv(): void {
  const saved = { ...process.env };
  try {
    delete process.env.CAMPAIGN_ALERT_COMPLAINT_RATE;
    delete process.env.CAMPAIGN_ALERT_HARD_BOUNCE_RATE;
    delete process.env.CAMPAIGN_ALERT_STUCK_SENDING_MINUTES;
    delete process.env.CAMPAIGN_ALERT_ZERO_RECIPIENT_GRACE_MINUTES;
    delete process.env.CAMPAIGN_ALERT_ROLLING_WINDOW_DAYS;
    delete process.env.CAMPAIGN_ALERT_MIN_SENT;
    delete process.env.CAMPAIGN_ALERT_REALERT_HOURS;
    assert.deepEqual(monitorConfigFromEnv(), DEFAULT_MONITOR_CONFIG);

    process.env.CAMPAIGN_ALERT_COMPLAINT_RATE = "0.005";
    process.env.CAMPAIGN_ALERT_STUCK_SENDING_MINUTES = "45";
    process.env.CAMPAIGN_ALERT_HARD_BOUNCE_RATE = "garbage";
    const parsed = monitorConfigFromEnv();
    assert.equal(parsed.complaintRateThreshold, 0.005);
    assert.equal(parsed.stuckSendingMinutes, 45);
    assert.equal(parsed.hardBounceRateThreshold, DEFAULT_MONITOR_CONFIG.hardBounceRateThreshold);
    console.log("config from env OK: overrides parse, garbage falls back");
  } finally {
    process.env = saved;
  }
}

async function checkSkipWithoutDatabase(): Promise<void> {
  const saved = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    const result = await runCampaignMonitor(undefined, cfg);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "DATABASE_URL unset");
    console.log("no-DB skip OK");
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
}

async function checkResolutionBound(): Promise<void> {
  // A terminal 'sent' campaign's numbers are frozen; once it ages out of
  // the rolling window it must stop being evaluated so its alert state
  // clears instead of re-paging every re-alert window forever.
  const h = harness();
  h.store.campaigns = [
    { campaignId: "1", campaignKey: "old-hot", status: "sent", lastSendAgeDays: 1, sent: 100, complained: 0, hardBounced: 2 },
  ];
  h.store.zero = [
    { campaignId: "2", campaignKey: "old-noop", status: "sent", minutesSinceApproval: 60, ageDays: 1 },
  ];
  const first = await h.run();
  assert.equal(first.conditions, 2);
  assert.equal(first.notified, 2);
  const bounceKey = alertKey("hard_bounce_rate", "campaign", "1");
  const zeroKey = alertKey("zero_recipients", "campaign", "2");
  assert.ok(h.store.state.has(bounceKey));
  assert.ok(h.store.state.has(zeroKey));

  // Both campaigns age past the window: no longer evaluated, state
  // cleared, and nothing pages even 24h+ later.
  h.store.campaigns[0]!.lastSendAgeDays = cfg.rollingWindowDays + 1;
  h.store.zero[0]!.ageDays = cfg.rollingWindowDays + 1;
  h.store.nowMs += 25 * 3_600_000;
  const agedOut = await h.run();
  assert.equal(agedOut.conditions, 0);
  assert.equal(agedOut.notified, 0);
  assert.equal(h.store.state.has(bounceKey), false);
  assert.equal(h.store.state.has(zeroKey), false);
  assert.equal(h.emitted.length, 2);

  // A fresh recurrence (new activity inside the window) pages
  // immediately, with no stale cooldown carried over.
  h.store.campaigns[0]!.lastSendAgeDays = 0;
  h.store.zero[0]!.ageDays = 0;
  h.store.nowMs += 15 * 60_000;
  const recurrence = await h.run();
  assert.equal(recurrence.conditions, 2);
  assert.equal(recurrence.notified, 2);
  assert.equal(h.emitted.length, 4);
  console.log(
    "resolution bound OK: aged-out rate + zero-recipient conditions clear, recurrence re-pages",
  );
}

function checkHardBouncePredicatePinned(): void {
  // Pin the classification to SEA-85's stored shape (the verbatim Resend
  // webhook body) and suppression semantics: hard = bounce type
  // 'Permanent' only, case-insensitive; no default-to-hard fallback.
  assert.equal(
    HARD_BOUNCE_PREDICATE,
    `lower(e.raw->'data'->'bounce'->>'type') = 'permanent'`,
  );
  console.log("hard-bounce predicate OK: pinned to raw->'data'->'bounce'->>'type' = permanent");
}

/**
 * DB-backed half: run the REAL campaignRateStats/zeroRecipientCampaigns
 * SQL against seeded rows in a rolled-back transaction. Self-skips
 * without DATABASE_URL (CI), same pattern as the learning smoke.
 */
async function checkAgainstRealDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log(
      "DATABASE_URL not set; DB-backed SQL checks skipped (run against docker compose or an ephemeral Postgres 16)",
    );
    return;
  }
  const { getPool } = await import("../db/client.js");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const store = pgMonitorStore(client);
    const contact = async (email: string): Promise<string> => {
      const { rows } = await client.query(
        `INSERT INTO contacts (email) VALUES ($1) RETURNING id`,
        [email],
      );
      return String((rows[0] as { id: string }).id);
    };
    const campaign = async (
      key: string,
      status: string,
      approvedAgo: string,
    ): Promise<string> => {
      const { rows } = await client.query(
        `INSERT INTO campaigns (key, name, audience_view, status, approved_by, approved_at)
         VALUES ($1, $1, 'v', $2, 'pete', now() - $3::interval) RETURNING id`,
        [key, status, approvedAgo],
      );
      return String((rows[0] as { id: string }).id);
    };
    const send = async (
      campaignId: string,
      contactId: string,
      email: string,
      sentAgo: string,
    ): Promise<string> => {
      const { createHash } = await import("node:crypto");
      const dedupeKey = createHash("sha256")
        .update(`${campaignId}${contactId}initial`)
        .digest("hex");
      const { rows } = await client.query(
        `INSERT INTO campaign_sends (campaign_id, contact_id, email, dedupe_key, status, sent_at)
         VALUES ($1, $2, $3, $4, 'sent', now() - $5::interval) RETURNING id`,
        [campaignId, contactId, email, dedupeKey, sentAgo],
      );
      return String((rows[0] as { id: string }).id);
    };
    const bounce = async (sendId: string, raw: string): Promise<void> => {
      await client.query(
        `INSERT INTO campaign_events (send_id, type, raw) VALUES ($1, 'bounced', $2::jsonb)`,
        [sendId, raw],
      );
    };

    // Campaign with four bounces in the exact #149 envelope: only the
    // Permanent one is hard; Transient, Undetermined and a bounce-less
    // raw are not.
    const c1 = await campaign("smoke-mon-rates", "sent", "1 hour");
    const emails = ["a", "b", "c", "d"].map((s) => `smoke-mon-${s}@example.com`);
    const sendIds: string[] = [];
    for (const email of emails) {
      sendIds.push(await send(c1, await contact(email), email, "1 hour"));
    }
    const envelope = (bounceField: string): string =>
      `{"type":"email.bounced","created_at":"2026-08-12T00:00:00.000Z",` +
      `"data":{"email_id":"re_x","to":["x@example.com"]${bounceField}}}`;
    await bounce(sendIds[0]!, envelope(`,"bounce":{"type":"Permanent","subType":"General"}`));
    await bounce(sendIds[1]!, envelope(`,"bounce":{"type":"Transient","subType":"MailboxFull"}`));
    await bounce(sendIds[2]!, envelope(`,"bounce":{"type":"Undetermined"}`));
    await bounce(sendIds[3]!, envelope(""));

    // A terminal campaign whose sends aged out of the window, still over
    // every threshold: must NOT be returned (the resolution bound).
    const c2 = await campaign("smoke-mon-aged", "sent", "30 days");
    const agedSend = await send(
      c2,
      await contact("smoke-mon-aged@example.com"),
      "smoke-mon-aged@example.com",
      "30 days",
    );
    await bounce(agedSend, envelope(`,"bounce":{"type":"Permanent"}`));

    // Zero-recipient campaigns: one recent (returned), one aged out (not).
    await campaign("smoke-mon-zero-new", "sent", "1 hour");
    await campaign("smoke-mon-zero-old", "sent", "30 days");

    // Uncorrelated event (0014, SEA-85 fix): NULL send_id, deduped by
    // provider_event_id. Must not count toward ANY campaign's rates (the
    // inner join excludes it). Skipped when 0014 is not applied yet.
    await client.query("SAVEPOINT uncorrelated");
    try {
      await client.query(
        `INSERT INTO campaign_events (send_id, type, raw, provider_event_id)
         VALUES (NULL, 'bounced', $1::jsonb, 'msg_smoke_mon_uncorrelated')`,
        [envelope(`,"bounce":{"type":"Permanent"}`)],
      );
      await client.query("RELEASE SAVEPOINT uncorrelated");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT uncorrelated");
      console.log(
        "0014 (nullable send_id) not applied here; uncorrelated-event insert skipped",
      );
    }

    const stats = await store.campaignRateStats(7);
    const mine = stats.filter((s) => s.campaignKey.startsWith("smoke-mon-"));
    assert.equal(mine.length, 1, "aged-out campaign must not be evaluated");
    assert.equal(mine[0]!.campaignKey, "smoke-mon-rates");
    assert.equal(mine[0]!.sent, 4);
    assert.equal(
      mine[0]!.hardBounced,
      1,
      "only the Permanent bounce is hard; Transient/Undetermined/missing are soft, and an uncorrelated NULL-send_id event counts nowhere",
    );

    const zeros = await store.zeroRecipientCampaigns(15, 7);
    const myZeros = zeros.filter((z) => z.campaignKey.startsWith("smoke-mon-"));
    assert.equal(myZeros.length, 1, "aged-out zero-recipient campaign must not re-page");
    assert.equal(myZeros[0]!.campaignKey, "smoke-mon-zero-new");

    console.log(
      "DB-backed SQL OK: Permanent counts hard, Transient/Undetermined/missing do not; aged-out campaigns drop out",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function main(): Promise<void> {
  await checkEmitShapes();
  await checkComplaintRate();
  await checkRollingComplaintRate();
  await checkHardBounceRate();
  await checkMinSentFloor();
  await checkStuckSending();
  await checkZeroRecipients();
  await checkDedupe();
  await checkFailedEmitRetries();
  await checkResolutionBound();
  checkHardBouncePredicatePinned();
  await checkAgainstRealDatabase();
  checkConfigFromEnv();
  await checkSkipWithoutDatabase();
  console.log("campaign monitor smoke: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
