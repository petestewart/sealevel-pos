-- 0016_payroll: teacher pay rates + per-period invoice ledger (SEA-103).
--
-- Engine B substrate for automated teacher payroll (docs/payroll-policy.md,
-- automation plan §7b). Two tables, three load-bearing decisions:
--
-- 1. Teachers are keyed on mb_staff_id, the stable Mindbody staff id, NEVER
--    on the analytics repo's teachers.teacher_id. That id is AUTOINCREMENT,
--    pipeline/build.py rebuilds mindbody.db from scratch on every run, and
--    d1_dump.py drops and recreates everything nightly, so it is only stable
--    while nobody re-runs the export build; mb_staff_id comes from Mindbody
--    and survives both (automation plan §2.11). teacher_display_name is a
--    convenience mirror for the console, never an identity. ai-manager never
--    maintains its own teacher list: rows here attach rates to identities
--    that already exist upstream.
--
-- 2. rate_cents = 0 is a DECISION ("this teacher is unpaid, by agreement" —
--    a trade arrangement, policy §12), distinct from having no row at all,
--    which means nobody has decided and payroll.prepare blocks the run.
--    notes carries the reason; a zero rate without an explanation is exactly
--    the state the column exists to prevent.
--
-- 3. Rate history is kept, never overwritten (policy §9/§11): a rate change
--    inserts a new row and closes the old one (effective_to = day before),
--    so re-running an old period reproduces exactly the numbers that were
--    approved at the time. The period query selects the rate in effect on
--    the period's START date. Non-overlap per teacher is enforced by an
--    EXCLUDE constraint (Postgres, not application convention): two rows
--    whose date ranges overlap for one mb_staff_id would make "the rate in
--    effect" ambiguous, which on an invoice is a money bug.
--
-- payroll_invoices is the OUTERMOST of the four idempotency layers that make
-- double-invoicing structurally impossible (automation plan §2.8):
-- UNIQUE (period, mb_staff_id) here, the deterministic BullMQ jobId
-- payroll-<period>-<mbStaffId>, an atomic claim in the worker, and the QBO
-- Bill's DocNumber <period>-<mb_staff_id>. A re-run of payroll.prepare for a
-- period with an existing row is a logged no-op per teacher, never a second
-- Bill.

-- For the EXCLUDE constraint below: btree_gist lets a GiST index mix the
-- equality column (mb_staff_id) with the range overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE teacher_pay_rates (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Upstream Mindbody staff id (analytics teachers.mb_staff_id). NOT NULL:
  -- a teacher without one is unpayable and is fixed upstream, not here.
  mb_staff_id           integer NOT NULL,
  -- Convenience mirror of the upstream display name for console lists.
  teacher_display_name  text,
  -- Per-class flat rate in cents (policy §1). 0 = decided-unpaid (§12).
  rate_cents            integer NOT NULL CHECK (rate_cents >= 0),
  -- per_class for everyone today; per_head admitted so a future bonus
  -- structure is a data change plus a calculation branch, not a migration.
  rate_basis            text NOT NULL DEFAULT 'per_class'
                          CHECK (rate_basis IN ('per_class', 'per_head')),
  -- Inclusive validity window. Open-ended rows have effective_to NULL.
  effective_from        date NOT NULL,
  effective_to          date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- The reason behind an unusual rate; REQUIRED in spirit for zero rates.
  notes                 text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- One rate in effect per teacher per day, enforced structurally: date
  -- ranges for the same mb_staff_id must not overlap. Inclusive bounds
  -- ('[]') match the inclusive effective_from/effective_to semantics.
  CONSTRAINT teacher_pay_rates_no_overlap EXCLUDE USING gist (
    mb_staff_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);

-- The period query's lookup: rate in effect on a given date for a teacher.
CREATE INDEX teacher_pay_rates_staff_from_idx
  ON teacher_pay_rates (mb_staff_id, effective_from DESC);

CREATE TABLE payroll_invoices (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Fortnightly period label, policy §6: '2026-08-03..2026-08-16'
  -- (14 days, Monday..Sunday inclusive, anchored 2026-08-03). The CHECK
  -- pins the label form so a malformed period can never mint a row that
  -- dodges the uniqueness guard.
  period       text NOT NULL
                 CHECK (period ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  mb_staff_id  integer NOT NULL,
  -- The payroll_invoice approval item this row tracks (one per teacher per
  -- period). ON DELETE SET NULL: the ledger row is the idempotency record
  -- and must survive item cleanup.
  item_id      bigint REFERENCES items(id) ON DELETE SET NULL,
  -- prepared: item filed, awaiting decision. queued: approved, push
  -- enqueued. pushed: Bill written (qbo_ref set). failed: push failed,
  -- surfaced for retry via reopen + re-approve (SEA-104 owns transitions).
  status       text NOT NULL DEFAULT 'prepared'
                 CHECK (status IN ('prepared', 'queued', 'pushed', 'failed')),
  -- QBO Bill id once pushed.
  qbo_ref      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- The outermost double-invoice guard (automation plan §2.8).
  CONSTRAINT payroll_invoices_period_staff_key UNIQUE (period, mb_staff_id)
);
