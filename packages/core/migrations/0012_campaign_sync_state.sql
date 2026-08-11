-- 0012_campaign_sync_state: high-water mark for campaigns.sync_contacts
-- (SEA-81), same single-row pattern as learning_state (0010).
--
-- The nightly sync pages Mindbody's /client/clients with
-- request.lastModifiedDate so it does not re-pull the world every night
-- (per-call pricing). last_synced_at is the START time of the last
-- successful run; the next run asks Mindbody for clients modified after
-- (last_synced_at - a skew buffer, applied in code) and advances the mark
-- only after the run succeeds, so a failed run reprocesses the same
-- window on retry. 'epoch' means "never synced": the first run is a full
-- pull.

CREATE TABLE campaign_sync_state (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_synced_at  timestamptz NOT NULL DEFAULT 'epoch',
  runs            integer NOT NULL DEFAULT 0,
  contacts_synced integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO campaign_sync_state (id) VALUES (1);
