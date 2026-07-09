-- 0003_notification_prefs: per-user notification routing preferences
-- (ARCHITECTURE.md "Notifications — adopt Novu").
--
-- This table records the routing INTENT per user, event type, and channel.
-- Enforcement of the routing (which channel actually fires, digest batching,
-- quiet hours) lives in Novu's workflow and subscriber preference config,
-- which is managed in the Novu dashboard; see docs/novu.md. Keeping the
-- intent here gives the console a source of truth to display/edit and a
-- record to sync into Novu later.

CREATE TABLE notification_prefs (
  user_id     text NOT NULL,            -- operator id, matches Novu subscriberId
  event_type  text NOT NULL,            -- e.g. item.pending_approval
  channel     text NOT NULL
              CHECK (channel IN ('sms', 'email', 'push', 'in_app', 'dashboard_only')),
  enabled     boolean NOT NULL DEFAULT true,
  digest      boolean NOT NULL DEFAULT false,  -- false = instant delivery
  quiet_hours jsonb,                    -- e.g. {"start": "22:00", "end": "07:00"}, NULL = none
  PRIMARY KEY (user_id, event_type, channel)
);

-- Seed: the differential routing for the first wired event. Same event,
-- two different treatments: Pete gets an instant SMS, Alison gets a
-- digested email.
INSERT INTO notification_prefs (user_id, event_type, channel, enabled, digest) VALUES
  ('pete',   'item.pending_approval', 'sms',   true, false),
  ('alison', 'item.pending_approval', 'email', true, true);
