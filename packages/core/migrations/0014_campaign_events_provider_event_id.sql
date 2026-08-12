-- 0014_campaign_events_provider_event_id (SEA-85): webhook replay dedupe.
--
-- 0011 created campaign_events without a dedupe column, expecting readers
-- to aggregate DISTINCT over provider duplicates. The Resend ingest
-- (SEA-85) needs a stronger property: a replayed webhook must be a
-- structural no-op, because the handler chains side effects off "this
-- event row was newly inserted" (the complaint path appends to the
-- append-only consent ledger exactly once per provider event, not once
-- per delivery attempt of the same webhook).
--
-- provider_event_id is the delivery-stable id of the provider's event --
-- for Resend, the Svix message id (svix-id header), which is identical
-- across every retry of the same event. Nullable: rows ingested by other
-- paths (or by 0011-era readers) carry NULL, and the unique index is
-- scoped to non-NULL so those rows keep the 0011 "no dedupe" behavior.
-- The webhook handler inserts with
--   ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL
--   DO NOTHING
-- so the guard is Postgres, not application logic, matching the
-- campaign_sends.dedupe_key discipline (0011 design point 2).
ALTER TABLE campaign_events ADD COLUMN provider_event_id text;

CREATE UNIQUE INDEX campaign_events_provider_event_id_idx
  ON campaign_events (provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- Uncorrelated telemetry is still telemetry. A provider event whose
-- email_id matches no campaign_sends row (a send row not yet landed, a
-- transactional send outside campaigns, a dashboard test event) must be
-- STORED, not dropped with a 200: the verbatim raw body is what lets it
-- be re-correlated or reinterpreted later without a backfill. send_id
-- therefore becomes nullable -- NULL means "not correlated to a send" --
-- and such rows are exactly the webhook-ingested ones, so the CHECK
-- requires them to carry the provider_event_id that dedupes them.
-- Correlated rows keep full 0011 semantics (the FK and its ON DELETE
-- RESTRICT are unchanged; a NULL simply is not subject to the FK).
ALTER TABLE campaign_events ALTER COLUMN send_id DROP NOT NULL;

ALTER TABLE campaign_events
  ADD CONSTRAINT campaign_events_uncorrelated_needs_provider_id
  CHECK (send_id IS NOT NULL OR provider_event_id IS NOT NULL);

-- Uncorrelated rows are invisible to campaign_events_send_idx lookups
-- (NULL send_id); give re-correlation sweeps a cheap way to find them.
CREATE INDEX campaign_events_uncorrelated_idx
  ON campaign_events (provider_event_id)
  WHERE send_id IS NULL;
