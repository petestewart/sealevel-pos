-- 0015_campaign_alerting: Novu routing for campaign approvals + the
-- campaign monitor's alert dedupe state (SEA-92).
--
-- Two concerns, one ticket:
--
-- 1. notification_prefs seed rows for the two new event types, following
--    the 0003 seed exactly: the table records routing INTENT (the console's
--    source of truth); enforcement lives in Novu's dashboard config
--    (docs/novu.md).
--    - campaign_approval: a campaign approval item awaits a human. Same
--      differential treatment as item.pending_approval: Pete gets an
--      instant SMS (time sensitive; a campaign is parked until decided),
--      Alison gets a digested email.
--    - campaign_alert: the campaign monitor found a deliverability or
--      pipeline problem (complaint rate, hard bounces, stuck send, zero
--      recipients). Instant on BOTH channels: an alert that waits in a
--      digest defeats its purpose, so Alison's email is digest = false
--      here, unlike her approval rows.
--
-- 2. campaign_alert_state: dedupe memory for the monitor job
--    (packages/core/src/campaigns/monitor.ts). One row per active alert
--    condition, keyed by a deterministic alert_key
--    ("<alertType>:<scope>[:<campaignId>]"). A condition notifies when its
--    key has no row yet or the last notification is older than the
--    re-alert window; every run refreshes last_detected_at/last_value, and
--    rows for conditions that no longer hold are deleted so a RECURRENCE
--    pages immediately instead of waiting out a stale cooldown.

INSERT INTO notification_prefs (user_id, event_type, channel, enabled, digest) VALUES
  ('pete',   'campaign_approval', 'sms',   true, false),
  ('alison', 'campaign_approval', 'email', true, true),
  ('pete',   'campaign_alert',    'sms',   true, false),
  ('alison', 'campaign_alert',    'email', true, false);

CREATE TABLE campaign_alert_state (
  alert_key         text PRIMARY KEY,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at  timestamptz NOT NULL DEFAULT now(),
  -- NULL until the first Novu trigger actually goes out (with Novu
  -- unconfigured the condition is tracked but nothing is marked notified,
  -- so configuring Novu later pages on the next run, not never).
  last_notified_at  timestamptz,
  -- The observed value at last detection (a rate for the rate alerts,
  -- minutes for stuck_sending, 0 for zero_recipients). Diagnostic only.
  last_value        numeric,
  detail            text
);
