-- 0008_spam_signals: the spam learning store (GH-96).
--
-- When an operator confirms an item is spam, the sender (and its domain) are
-- recorded here. Inbound ingestion consults this table to pre-flag or
-- auto-trash mail from known-spam senders, so the system gets better at
-- catching junk the more the operator confirms. This is deliberately a
-- simple, inspectable signal list -- not a black-box model: every row is a
-- human-confirmed spam sender/domain the operator can see and remove.
--
-- kind: 'sender' (a full email address) or 'domain' (everything after @).
-- value is stored lowercased; the (kind, value) pair is unique so confirming
-- the same sender again bumps hit_count instead of inserting a duplicate.

CREATE TABLE spam_signals (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('sender', 'domain')),
  value        text NOT NULL CHECK (length(value) BETWEEN 1 AND 320),
  reason       text,
  hit_count    integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_by   text
);

CREATE UNIQUE INDEX spam_signals_kind_value_idx ON spam_signals (kind, value);
