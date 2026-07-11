-- 0007_studio_info_generic: studio info becomes generic key/value
-- entries (GH-74).
--
-- GH-71 shipped studio_info as a KV table restricted in code to 8 fixed
-- field keys. The fixed set was too rigid: the owners should be able to
-- record any customer-safe fact ("Showers", "Class temperature", ...)
-- as a labeled entry, like a customizable FAQ for the drafting model.
--
-- The table shape already fits; this migration:
--   1. relabels any rows saved under the GH-71 machine keys to their
--      human labels, so existing data carries over as visible entries;
--   2. bounds the key length the same way values are bounded, now that
--      keys are user-authored text.

UPDATE studio_info SET field = 'Booking link'        WHERE field = 'booking_url';
UPDATE studio_info SET field = 'Website'             WHERE field = 'website';
UPDATE studio_info SET field = 'Phone'               WHERE field = 'phone';
UPDATE studio_info SET field = 'Address'             WHERE field = 'address';
UPDATE studio_info SET field = 'Parking'             WHERE field = 'parking';
UPDATE studio_info SET field = 'Cancellation policy' WHERE field = 'cancellation_policy';
UPDATE studio_info SET field = 'Late arrival'        WHERE field = 'late_arrival';
UPDATE studio_info SET field = 'What to bring'       WHERE field = 'what_to_bring';

ALTER TABLE studio_info
  ADD CONSTRAINT studio_info_field_length
  CHECK (length(field) BETWEEN 1 AND 80);

-- Case-insensitive uniqueness as a DB invariant, not just an app-level
-- pre-check: concurrent adds of "Parking" and "parking" must not both
-- land. The app's dup check remains as the friendly-error fast path.
CREATE UNIQUE INDEX studio_info_field_lower_idx
  ON studio_info (lower(field));
