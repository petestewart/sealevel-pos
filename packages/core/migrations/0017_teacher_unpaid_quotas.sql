-- 0017_teacher_unpaid_quotas: monthly training-payback allowances (SEA-108).
--
-- Some teachers owe the studio a number of unpaid classes per month, working
-- off a teacher-training balance (docs/payroll-policy.md §13). Currently Kate
-- Jarvis at three per month. A configurable arrangement per teacher, not a
-- special case in code, and NOT the same as a zero rate (policy §12): the
-- teacher is paid their normal rate for every class beyond the quota.
--
-- Separate from teacher_pay_rates because it has its own lifecycle: it
-- starts, and it ends when the balance is worked off.
--
-- What is deliberately NOT here:
--
-- - No remaining-balance column. The balance is DERIVED by replaying the
--   free classes since effective_from against obligation_cents (the constant
--   agreement amount). A stored counter drifts the moment a class is
--   re-synced, back-dated, or a period is re-run, and it would silently
--   change what an already-approved invoice meant. Replay makes a re-run of
--   an old period reproduce exactly the numbers approved at the time.
-- - No active flag. The arrangement is active while the derived remaining
--   balance is greater than zero, so nothing has to run to close it out.
--
-- The replay itself (first-N-chronologically per calendar month, no
-- rollover, cancelled classes invisible, dollar-denominated credits at the
-- rate in effect, partial tail credit) lives in
-- packages/core/src/payroll/quota.ts; the rules trace to policy §13.

CREATE TABLE teacher_unpaid_quotas (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Upstream Mindbody staff id, same identity rule as teacher_pay_rates
  -- (automation plan §2.11).
  mb_staff_id             integer NOT NULL,
  -- The only kind today; a closed CHECK so a typo cannot mint a new
  -- arrangement type without a migration saying so.
  kind                    text NOT NULL DEFAULT 'training_payback'
                            CHECK (kind IN ('training_payback')),
  free_classes_per_month  integer NOT NULL CHECK (free_classes_per_month > 0),
  -- The dollar balance to work off, in cents: the training price as agreed.
  -- Constant for the arrangement's life; what remains is derived.
  obligation_cents        integer NOT NULL CHECK (obligation_cents > 0),
  -- The replay runs from effective_from, so any free classes taught before
  -- that date are invisible to it and the starting obligation must already
  -- account for them. effective_to is for ending an arrangement by
  -- agreement; normal completion is derived (remaining reaches zero).
  effective_from          date NOT NULL,
  effective_to            date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  notes                   text,
  created_by              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- One arrangement per teacher at a time, same structural guard as
  -- teacher_pay_rates: overlapping windows would make "which quota applies
  -- to this class" ambiguous, which on an invoice is a money bug.
  -- btree_gist already installed by 0016_payroll.
  CONSTRAINT teacher_unpaid_quotas_no_overlap EXCLUDE USING gist (
    mb_staff_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);

CREATE INDEX teacher_unpaid_quotas_staff_idx
  ON teacher_unpaid_quotas (mb_staff_id, effective_from DESC);
