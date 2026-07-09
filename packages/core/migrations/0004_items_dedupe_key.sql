-- Retry/race-safe item dedupe on a natural key (ARCHITECTURE.md
-- "retry-safe outbound / dedupe on a natural key").
--
-- Enforces DB-wide that at most one UNRESOLVED item of a given type
-- carries a given payload.dedupe_key. createItem inserts with
-- ON CONFLICT ... DO NOTHING against this index, so concurrent
-- executions (BullMQ retries, duplicate webhooks) cannot create
-- duplicates even under READ COMMITTED. Resolving an item frees the
-- key for a future item of the same type.
CREATE UNIQUE INDEX items_dedupe_key_unresolved_idx
  ON items (type, (payload->>'dedupe_key'))
  WHERE status <> 'resolved' AND payload->>'dedupe_key' IS NOT NULL;
