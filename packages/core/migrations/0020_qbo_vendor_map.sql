-- 0020_qbo_vendor_map: explicit teacher -> QuickBooks vendor links (SEA-119).
--
-- Found during the sandbox QBO test push: resolving the payee by exact
-- DisplayName match on the card's teacher name means two teachers sharing a
-- display name would both post to one vendor, silently — no error, wrong
-- payee. The name also is not under our control (Mindbody display names,
-- US Bank payee names, and QBO vendor names all differ).
--
-- The link is keyed on mb_staff_id, the same stable identity the payroll
-- ledger and the Bill DocNumber use, and stores the QBO Vendor Id — never
-- another name. The push job looks the link up; a teacher without one is a
-- terminal honest failure ("link this teacher to a QuickBooks vendor"),
-- the same posture as a missing pay rate. Vendor records themselves stay
-- human-created in QBO (policy 10: a payee appearing in QBO is a decision,
-- not a side effect).

CREATE TABLE qbo_vendor_map (
  -- Upstream Mindbody staff id (same identity as teacher_pay_rates).
  mb_staff_id      integer PRIMARY KEY,
  -- QBO Vendor.Id in the connected company. Opaque string per the API.
  qbo_vendor_id    text NOT NULL CHECK (length(qbo_vendor_id) > 0),
  -- Convenience mirror of the vendor's QBO display name for console
  -- lists; never an identity, never matched against.
  qbo_vendor_name  text,
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Two teachers pointing at one vendor is exactly the silent wrong-payee
  -- bug this table exists to prevent, so it is refused structurally. The
  -- rare legitimate case (a teacher re-keyed under a new mb_staff_id)
  -- clears the stale link first.
  CONSTRAINT qbo_vendor_map_vendor_key UNIQUE (qbo_vendor_id)
);
