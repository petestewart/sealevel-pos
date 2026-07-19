-- 0010_learning_loop: state for the learning loop (GH-127).
--
-- learning_state: a single-row table holding the miner's high-water mark
-- (last_mined_at) and lifetime counters. The learning.mine job reads
-- decided items whose resolved_at is AFTER the mark and advances it only
-- after a successful run, so each operator correction is examined exactly
-- once and a failed run reprocesses the same window on retry.
--
-- rule_proposal_memory: normalized fingerprints of REJECTED rule
-- proposals (negative dedup). A lesson the operator rejected is
-- remembered here so the miner does not re-propose rephrasings of it;
-- approved lessons need no memory because they dedupe against the active
-- rules table directly. Fingerprints are the normalized rule text
-- (lowercased, punctuation stripped, whitespace collapsed), so only
-- near-identical phrasings match; a genuinely different wording can still
-- surface and be rejected (and remembered) on its own.

CREATE TABLE learning_state (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_mined_at   timestamptz NOT NULL DEFAULT 'epoch',
  runs            integer NOT NULL DEFAULT 0,
  signals_seen    integer NOT NULL DEFAULT 0,
  proposals_filed integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO learning_state (id) VALUES (1);

CREATE TABLE rule_proposal_memory (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 600),
  rule_text   text NOT NULL CHECK (length(rule_text) BETWEEN 1 AND 500),
  rejected_at timestamptz NOT NULL DEFAULT now(),
  rejected_by text
);

CREATE UNIQUE INDEX rule_proposal_memory_fingerprint_idx
  ON rule_proposal_memory (fingerprint);
