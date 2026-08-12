-- 0018_campaign_send: scheduled sends + the durable copy snapshot (SEA-84).
--
-- Two additions for the send job, one migration (per the ticket: one
-- migration for both send_at + copy snapshot is fine):
--
-- 1. campaigns.send_at, nullable timestamptz. NULL = send on approval
--    (the default, matching every campaign created before this column
--    existed); a value = the earliest moment the send may fire. The
--    approval enqueue schedules the BullMQ send job as a DELAYED job for
--    max(now, send_at); the send job itself re-checks suppressions and
--    consent PER RECIPIENT at send time, which is what makes a send_at
--    delay safe (someone can unsubscribe between approval and send).
--
-- 2. campaign_copy_snapshots: the subject + body ACTUALLY SENT, per
--    campaign run AND per segment variant. Until now nothing durable
--    stored the last-sent copy, which is why computeSendDiff's
--    copyChanged was pinned to null ("unknown"). The send job writes the
--    run's full copy set BEFORE the first message of the run leaves --
--    one row per SEA-88 segment variant, or a single row with
--    segment = '' for the un-briefed single-copy shape -- each row
--    ON CONFLICT DO NOTHING so a retried job keeps the first-written
--    copy: first write wins, because the first write is what the batch
--    that already left carried. The diff then compares the current
--    draft's copy set against the newest stored run's set, per segment.
--
--    Append-only by trigger (campaigns_append_only, defined in 0011):
--    this table is the audit answer to "what did we actually send",
--    so it must not be editable after the fact. Sends that predate this
--    migration have no snapshot; computeSendDiff keeps the honest null
--    ("unknown") for that history.

ALTER TABLE campaigns ADD COLUMN send_at timestamptz;

CREATE TABLE campaign_copy_snapshots (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES campaigns (id) ON DELETE RESTRICT,
  run_seq     integer NOT NULL CHECK (run_seq >= 1),
  -- '' = the single-copy shape; otherwise the SEA-88 segment label this
  -- variant was sent to. NOT NULL so the UNIQUE constraint actually
  -- dedupes (NULLs would never conflict).
  segment     text NOT NULL DEFAULT '',
  -- The template as sent (merge fields unresolved): rows describe the
  -- run's copy set, and per-recipient rendering is deterministic from it.
  subject     text NOT NULL,
  body        text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, run_seq, segment)
);

CREATE TRIGGER campaign_copy_snapshots_append_only
  BEFORE UPDATE OR DELETE ON campaign_copy_snapshots
  FOR EACH ROW EXECUTE FUNCTION campaigns_append_only();
