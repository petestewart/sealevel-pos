-- 0011_campaigns: campaign operational state (SEA-80).
--
-- This is OPERATIONAL state and lives in ai-manager's own Postgres, not in
-- the analytics mirror: the mirror is dropped and rebuilt nightly, and
-- consent, suppressions and send history must never be reconstructible
-- only from an upstream export.
--
-- Three design points are load-bearing and must not be "simplified" later:
--
-- 1. Consent is an APPEND-ONLY LEDGER (consent_events), never a boolean on
--    contacts. A boolean can say someone is unsubscribed; it cannot answer
--    "when, and through what, did this person opt out", which is exactly the
--    question a complaint or an audit asks. Current state is the latest row
--    per contact_id. Append-only is ENFORCED by trigger, not by convention,
--    and contacts carrying consent history cannot be deleted (ON DELETE
--    RESTRICT) because the routine "delete and re-sync from Mindbody" path
--    would otherwise erase exactly the record an audit asks for. Contacts are
--    retired by stamping contacts.deleted_at instead; the mb_client_id unique
--    index is scoped to live rows so the re-sync still lands.
--
-- 2. campaign_sends.dedupe_key is NOT NULL UNIQUE and deterministic, derived
--    by the enqueueing job and stored. A retried BullMQ job re-derives the
--    same key, so the second insert fails on the unique index and the double
--    send never happens. The guard is Postgres, not application logic.
--
--    The key is sha256 over the three inputs joined by US (U+001F), NOT bare
--    concatenation. Bare concatenation of two decimal bigints is ambiguous:
--    campaign 1 / contact 12 and campaign 11 / contact 2 both render
--    "112initial" and collide, so the second campaign's insert would fail as
--    a phantom "retry" and that contact would be silently dropped from the
--    send with no row to show for it. US cannot occur in a bigint's decimal
--    text and is excluded from `step` by CHECK, so the encoding is injective.
--
--    dedupe_key is the mandated retry-safe insert key, but it is not the only
--    guard: UNIQUE (campaign_id, contact_id, step) enforces the same property
--    structurally and cannot drift from the derivation, and
--    UNIQUE (campaign_id, email, step) additionally stops one ADDRESS being
--    mailed twice for a campaign when a household or a re-registered customer
--    has two contact rows (see design point 3 -- the address is the durable
--    identity, contact ids churn).
--
-- 3. suppressions keys on EMAIL ADDRESS, not contact id. An address must
--    stay suppressed across contact-record churn and must apply to every
--    contact sharing it, which happens when a household or a re-registered
--    customer has two Mindbody client records on one address.
--
-- Email addresses are normalized to lowercase by BEFORE INSERT OR UPDATE
-- trigger rather than by CHECK constraint, so the suppressions lookup is a
-- plain equality match. Deliberately a trigger: a CHECK on lower(email) is
-- re-validated by pg_restore, and lower() is collation-dependent for
-- non-ASCII input, so an ICU/glibc version bump underneath Railway could make
-- already-stored rows fail to restore from the mandated nightly pg_dump. A
-- normalizing trigger repairs instead of rejecting and is not re-run on
-- restore.

-- Normalizes an email column to lowercase, trimmed, on write.
CREATE FUNCTION campaigns_normalize_email() RETURNS trigger AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  IF NEW.email = '' THEN
    RAISE EXCEPTION 'email must not be empty';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Refuses UPDATE and DELETE, making an append-only ledger actually
-- append-only rather than append-only-by-comment.
CREATE FUNCTION campaigns_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

-- contacts: one row per person we may email.
--
-- mb_client_id is the Mindbody client ID as a nullable, uniquely-indexed
-- external identifier column rather than a separate mapping table (Mindbody
-- has no many-to-many identity, so a mapping table would buy nothing).
-- Nullable because a contact can enter via email capture before any Mindbody
-- record exists, and Phase 2 Mindbody production API access is still pending.
--
-- NOTE for SEA-81's sync_contacts: the uniqueness is a PARTIAL unique index,
-- so the upsert must name the predicate verbatim --
--   INSERT ... ON CONFLICT (mb_client_id)
--     WHERE mb_client_id IS NOT NULL AND deleted_at IS NULL
--     DO UPDATE SET ...
-- The bare `ON CONFLICT (mb_client_id)` form cannot infer a partial index and
-- fails with 42P10. The reconciliation report reads unmatched ids straight
-- off this column; duplicate ids cannot be stored at all (that is the point
-- of the unique index), so the report detects those on the Mindbody side
-- before insert and records the loser as is_ambiguous with a reason.
--
-- is_ambiguous marks a contact whose Mindbody identity could not be resolved
-- confidently (for example two client records sharing one address);
-- ambiguous_reason carries why, so the reconciliation report can explain its
-- own rows without a follow-up migration. Ambiguous contacts stay queryable
-- but are excluded from campaign audiences.
--
-- deleted_at is SOFT delete, and it is not optional bookkeeping: every
-- referencing table is ON DELETE RESTRICT (see design point 1), so a contact
-- carrying consent history, an audience snapshot or a send record cannot be
-- hard-deleted at all. Retiring a contact means stamping deleted_at. Two
-- consequences that callers must honor:
--   * The mb_client_id unique index is scoped to deleted_at IS NULL, so a
--     retired contact does not block a later re-sync of the same Mindbody
--     client into a fresh row. This is what makes the "delete and re-sync"
--     path design point 3 anticipates work WITHOUT destroying the ledger.
--   * Soft-deleted contacts are excluded from campaign audiences, exactly as
--     ambiguous ones are, but remain fully readable for audit. The consent
--     ledger and suppressions are keyed so they survive independently: both
--     snapshot the address, and suppressions never referenced contacts at
--     all, so a retired contact's opt-out still suppresses the address.
CREATE TABLE contacts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mb_client_id        text,
  analytics_client_id text,
  email               text NOT NULL,
  first_name          text,
  last_name           text,
  is_ambiguous        boolean NOT NULL DEFAULT false,
  ambiguous_reason    text,
  mb_opt_in_raw       jsonb,
  synced_at           timestamptz,
  deleted_at          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER contacts_normalize_email
  BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION campaigns_normalize_email();

-- Scoped to live rows so a retired contact cannot block re-syncing the same
-- Mindbody client. Two soft-deleted rows may therefore share an mb_client_id;
-- that is history, not a conflict.
CREATE UNIQUE INDEX contacts_mb_client_id_idx
  ON contacts (mb_client_id)
  WHERE mb_client_id IS NOT NULL AND deleted_at IS NULL;
-- Full-table: address lookups must still reach retired rows during an audit.
CREATE INDEX contacts_email_idx ON contacts (email);
-- Audience building and sync only ever look at live rows.
CREATE INDEX contacts_active_email_idx ON contacts (email)
  WHERE deleted_at IS NULL AND NOT is_ambiguous;
CREATE INDEX contacts_analytics_client_id_idx
  ON contacts (analytics_client_id) WHERE analytics_client_id IS NOT NULL;

-- consent_events: append-only, enforced. detail carries the human-readable
-- provenance (Mindbody field value, the unsubscribe token used, the
-- operator's note). email is snapshotted at write time so the ledger stays
-- answerable for an ADDRESS even after contact rows are rewritten by a sync,
-- matching how suppressions key (design point 3).
CREATE TABLE consent_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id bigint NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
  email      text NOT NULL,
  state      text NOT NULL CHECK (state IN ('subscribed', 'unsubscribed')),
  source     text NOT NULL
             CHECK (source IN ('mindbody_sync', 'unsubscribe_link', 'manual', 'complaint')),
  detail     text,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER consent_events_normalize_email
  BEFORE INSERT ON consent_events
  FOR EACH ROW EXECUTE FUNCTION campaigns_normalize_email();

CREATE TRIGGER consent_events_append_only
  BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION campaigns_append_only();

-- Latest-state-per-contact lookup: ORDER BY at DESC, id DESC LIMIT 1.
CREATE INDEX consent_events_contact_at_idx
  ON consent_events (contact_id, at DESC, id DESC);
-- Latest-state-per-ADDRESS, which is what a send-time check and a complaint
-- investigation actually ask.
CREATE INDEX consent_events_email_at_idx
  ON consent_events (email, at DESC, id DESC);

-- suppressions: the hard do-not-send list, keyed on address. See design
-- point 3. Presence of a row is the whole signal; there is no "unsuppress"
-- state, an address is removed by DELETE only through a deliberate
-- operator action.
CREATE TABLE suppressions (
  email  text PRIMARY KEY,
  reason text NOT NULL
         CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual')),
  at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER suppressions_normalize_email
  BEFORE INSERT OR UPDATE ON suppressions
  FOR EACH ROW EXECUTE FUNCTION campaigns_normalize_email();

-- campaigns: one row per send. key is the stable human-facing slug used by
-- jobs; audience_view names the analytics view or named segment the audience
-- is drawn from, audience_params its bound parameters.
--
-- run_seq makes a deliberate re-send expressible. Without it, re-running a
-- campaign has only two shapes and both are wrong: reuse the row and every
-- derived dedupe_key collides so the run enqueues nobody, or delete and
-- recreate the row and everyone gets mailed twice. Bumping run_seq (and
-- including it in `step`, e.g. 'initial#2') yields fresh keys deliberately.
--
-- Nothing sends without an approved_by/approved_at pair: the pairing CHECK
-- stops half-approved rows, and the status CHECK stops a campaign reaching a
-- sending state without one (v1 rule: every outbound send is a human
-- approval).
CREATE TABLE campaigns (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key             text NOT NULL,
  name            text NOT NULL,
  audience_view   text NOT NULL,
  audience_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_seq         integer NOT NULL DEFAULT 1 CHECK (run_seq >= 1),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'pending_approval', 'approved',
                                    'sending', 'sent', 'cancelled')),
  created_by      text,
  approved_by     text,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (status NOT IN ('approved', 'sending', 'sent')
         OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE UNIQUE INDEX campaigns_key_idx ON campaigns (key);
CREATE INDEX campaigns_status_idx ON campaigns (status)
  WHERE status NOT IN ('sent', 'cancelled');

-- campaign_audience: the audience SNAPSHOT, frozen at snapshot_at. The
-- audience view is recomputed continuously upstream; the campaign must send
-- to who qualified when it was built, and must still be able to say who that
-- was after the fact -- hence RESTRICT on the contact, so a sync cannot
-- quietly shrink a historical snapshot by deleting a row out of it.
CREATE TABLE campaign_audience (
  campaign_id bigint NOT NULL REFERENCES campaigns (id) ON DELETE RESTRICT,
  contact_id  bigint NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
  segment     text,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, contact_id)
);

CREATE INDEX campaign_audience_contact_idx ON campaign_audience (contact_id);

-- campaign_sends: one row per (campaign, contact, step) attempt.
-- skipped_suppressed is a recorded outcome, not an absence of a row: a
-- suppressed contact still gets a send row so the campaign report can say
-- how many were held back and why.
--
-- email is the address actually mailed, snapshotted at enqueue time.
-- contacts.email is mutable and is overwritten by the Mindbody sync, so
-- without this snapshot a bounce or complaint investigation cannot say which
-- address received the message, and an inbound provider webhook cannot be
-- mapped back to one.
--
-- RESTRICT throughout: deleting a campaign must not be able to erase its
-- send history, least of all the 'complained' and 'bounced' events hanging
-- off it. Cancel a campaign (status='cancelled'); do not delete it.
CREATE TABLE campaign_sends (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id         bigint NOT NULL REFERENCES campaigns (id) ON DELETE RESTRICT,
  contact_id          bigint NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
  email               text NOT NULL,
  step                text NOT NULL DEFAULT 'initial'
                      -- US (U+001F) is the dedupe_key delimiter; excluding it
                      -- here is what keeps that encoding unambiguous.
                      CHECK (step ~ '^[A-Za-z0-9_.#-]{1,64}$'),
  -- sha256(campaign_id || US || contact_id || US || step), hex. See point 2.
  dedupe_key          text NOT NULL CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'sent', 'failed', 'skipped_suppressed')),
  provider_message_id text,
  sent_at             timestamptz,
  error               text
);

CREATE TRIGGER campaign_sends_normalize_email
  BEFORE INSERT OR UPDATE ON campaign_sends
  FOR EACH ROW EXECUTE FUNCTION campaigns_normalize_email();

-- The double-send guards. dedupe_key is the mandated retry-safe insert key;
-- the two composite indexes enforce the same invariant structurally, one per
-- contact and one per address, and cannot drift from the derivation.
CREATE UNIQUE INDEX campaign_sends_dedupe_key_idx ON campaign_sends (dedupe_key);
CREATE UNIQUE INDEX campaign_sends_campaign_contact_step_idx
  ON campaign_sends (campaign_id, contact_id, step);
CREATE UNIQUE INDEX campaign_sends_campaign_email_step_idx
  ON campaign_sends (campaign_id, email, step);

CREATE INDEX campaign_sends_campaign_status_idx ON campaign_sends (campaign_id, status);
CREATE INDEX campaign_sends_contact_idx ON campaign_sends (contact_id);
CREATE INDEX campaign_sends_email_idx ON campaign_sends (email);
CREATE INDEX campaign_sends_provider_message_id_idx
  ON campaign_sends (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- campaign_events: provider delivery telemetry, append-only. raw keeps the
-- untouched webhook body so a later event type can be reinterpreted without
-- a backfill. A provider can deliver the same webhook twice, so this table
-- deliberately does NOT dedupe; readers aggregate DISTINCT on (send_id, type).
CREATE TABLE campaign_events (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  send_id bigint NOT NULL REFERENCES campaign_sends (id) ON DELETE RESTRICT,
  type    text NOT NULL
          CHECK (type IN ('delivered', 'opened', 'clicked', 'bounced', 'complained')),
  at      timestamptz NOT NULL DEFAULT now(),
  raw     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX campaign_events_send_idx ON campaign_events (send_id, type);
