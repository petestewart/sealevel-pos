# Teacher pay policy

The rules `payroll.prepare` implements. Decided by Pete 2026-08-11. Anything
not stated here is not implemented; add a rule to this doc before adding it to
the code, so a number on an invoice always traces to a line in this file.

## 1. Rate

Each teacher has their own rate. One rate applies to every class that teacher
teaches, regardless of class type, slot, or attendance. Pay for a period is:

    rate_cents * (classes taught in the period, excluding cancelled)

Stored in `teacher_pay_rates`, keyed on `mb_staff_id` (see §7). `rate_basis`
is `per_class` for every teacher today. The column and its CHECK constraint
already allow `per_head` so a future bonus structure is a data change plus a
calculation branch, not a migration.

Anticipated but NOT built: per-class-type rates, and a per-head or
attendance-threshold bonus for some teachers. Both are noted here so the
schema stays ready; neither is implemented.

## 2. Who is paid

Everyone who taught, on the same terms. Alison and Brooke are paid exactly
like any other teacher despite being owners: their `role` in the upstream
`teachers` table is informational, never a pay rule.

## 3. Substitutes

The teacher who actually taught the class is paid, at their own usual rate.
There is no substitute premium and no partial credit to the originally
scheduled teacher.

Consequence worth stating: **payroll does not depend on substitute tracking.**
`class_instances.teacher_id` records who actually taught, which is the only
fact this policy needs. The scheduled-versus-actual work (plan §5b) is for
reliability reporting, and payroll must not be sequenced behind it.

## 4. Attendance

Irrelevant to pay. A class with two students pays the same as a class with
twenty. Comps, late cancels, and no-shows have no effect. `payroll.prepare`
does not read `attendee_count`, `comp_count`, `late_cancel_count`, or
`no_show_count`.

They still appear on the invoice item's payload as context for the human
approving it. Context, not inputs.

## 5. Cancelled classes

Nobody is paid for a cancelled class, teacher or sub.

Implementation: `class_instances` keeps cancelled occurrences as rows, so the
period query filters `COALESCE(is_canceled, 0) = 0`. Verified: `is_canceled`
is populated (0 or 1) on every API-sourced row, 53 cancellations in the
dataset. It is NULL only on export-sourced rows, which stop at 2026-05-18 and
so can never fall inside a pay period. The COALESCE is belt and braces.

**Only classes that have already happened count.** `class_instances` also
carries future-dated rows: the sync pulls a forward window, so a class
scheduled for tonight is already a row, with `attendee_count` reflecting
current bookings rather than attendance. At the real run time this is moot,
because `payroll.prepare` fires after the period has ended and every row in
range is in the past. It stops being moot the moment anyone previews or
re-runs a period mid-flight, so the period query bounds on the period end
date and the job refuses to run for a period that has not closed.

## 6. Pay period

**Fortnightly, Monday through Sunday inclusive**, by class date in studio time
(America/Los_Angeles). Anchor: **2026-08-03**. Every period is the 14 days
beginning on the anchor plus a multiple of 14.

    2026-08-03 .. 2026-08-16   (the first automated period)
    2026-08-17 .. 2026-08-30
    2026-08-31 .. 2026-09-13

`payroll_invoices.period` uses the label form `2026-08-03..2026-08-16`.

**Run time is unresolved and matters.** The stated requirement is that payday
happens the evening of Sunday 2026-08-16, the last day of the period. That
conflicts with when the data becomes available, and resolving it wrong
silently underpays people.

Mindbody data reaches the analytics mirror only through the nightly sync
(`nightly-sync.yml`, cron `30 10 * * *` UTC). Observed D1 import completion
over the last three weeks lands between 04:00 and 05:32 PT, because GitHub
delays scheduled runs under load. So Sunday's classes are not queryable until
Monday morning, and a Sunday-evening run would omit them.

This is not a rounding error. The studio runs four to five classes every
Sunday, and Frankie has taught the 17:00 and 18:30 Sunday classes every week
in the sample: a Sunday-excluded period would short Frankie two classes, every
period, permanently.

**Decided 2026-08-11: on-demand sync, then run.** The Sunday-evening payday is
preserved by making the data current before reading it, rather than by moving
the payday or the period boundary.

The sequence, every other Sunday:

1. **20:30 PT**: `payroll.prepare` fires. The last class of the day starts at
   18:30 and its roster has posted by then.
2. It dispatches `nightly-sync.yml` in `sealevel-analytics` via
   `workflow_dispatch`, which already accepts `start` / `end` inputs. Pass a
   window covering the last three days, wider than strictly needed so a
   late-posted roster is not missed.
3. It waits for that run to complete. Observed duration is about two and a
   half minutes end to end, including the D1 import.
4. **It verifies freshness before computing anything**: the maximum class date
   visible through the analytics seam must be greater than or equal to the
   period end, and the period's Sunday classes must be present. A stale read
   is indistinguishable from a light teaching day, so this check is what makes
   the whole approach safe.
5. Only then does it compute and file items.

**Failure is a block, never a short payment.** If the dispatch fails, the run
times out, or the freshness check does not pass, `payroll.prepare` files
nothing, leaves the period unprocessed, and notifies. A late payroll is a
scheduling annoyance; a payroll missing everyone's Sunday classes is a payment
error that someone has to notice and unwind.

This does not breach the scheduling ownership rule in the automation plan
§2.4. GitHub Actions still owns the data pipeline; ai-manager is asking it to
run, not pulling from Mindbody itself.

**New credential required**: a GitHub token with `actions:write` on
`petestewart/sealevel-analytics`, held by the worker only, never the console.
Same posture as the QBO refresh token.

Rejected alternatives, recorded so they are not relitigated: running Monday
07:00 PT (correct but moves payday a day); ending periods on Saturday
(preserves payday but permanently redefines the period and rolls Sundays
forward); and paying Sunday on Saturday-complete data with a true-up next
period, which shorts the same people every period and makes any single invoice
wrong on its face.

## 7. Teacher identity

Rates key on `mb_staff_id`, the stable Mindbody staff id, never on the
analytics repo's autoincrement `teachers.teacher_id` (see the automation plan
§2.11 for why). Verified 2026-08-11: all 18 teachers who taught in the
preceding two weeks carry a non-NULL `mb_staff_id`.

`payroll.prepare` fails the run, loudly and without filing any invoice, when a
teacher with classes in the period has:

- a NULL `mb_staff_id` (two such rows exist upstream, Sharon and Tanja,
  neither currently teaching), or
- no matching row in `teacher_pay_rates`, or
- the placeholder identity `TBA`.

A newly auto-onboarded teacher is a blocked run needing a rate, never a silent
zero and never a silent new payee.

## 8. Out of scope

Workshops, private sessions, desk and cleaning shifts, and any other non-class
work are not part of automated payroll and stay manual.

## 9. Rate changes

Rates do not change mid-period. `teacher_pay_rates` carries
`effective_from` / `effective_to`, and the period query selects the rate in
effect on the period's **start** date. A rate edited mid-period does not
retroactively alter the period in progress.

## 10. What lands in QuickBooks

**A Bill.** Confirmed 2026-08-11. Teacher pay is money owed to a contractor,
which is accounts payable, so `payroll.push` writes a Bill against a Vendor
record. Not an Invoice: an Invoice is accounts receivable and would post
teacher pay as revenue.

One Bill per teacher per period, `DocNumber` set to
`<period>-<mb_staff_id>`, which is also the outermost idempotency key that
makes a double-invoice impossible.

Still to confirm with the bookkeeper, none of them blocking the build:

- Does every current teacher already exist as a Vendor in QBO, or does
  `payroll.push` need to create missing ones?
- Which expense account should the Bill line post to?
- Are the 1099 flags already set on those vendor records?

## 11. Administering rates

**Teachers are never created in ai-manager.** They arrive from Mindbody
through the analytics pipeline, so the console has no "add teacher" control
and never invents an identity. Rates attach to teachers that already exist
upstream, keyed on `mb_staff_id`.

**Where rates live**: a console page at Settings, "Teacher pay rates", gated
on `settings:manage` so only owners see it. It lists every teacher who has
taught in the last 90 days, read through the analytics seam, joined against
`teacher_pay_rates`. Each row is in one of three states: rate set (amount plus
effective date), no rate set (highlighted, needs attention), or unpayable
(NULL `mb_staff_id`, needs an upstream fix and cannot be resolved from the
console).

**A new teacher** is handled reactively, with no pre-registration step:

1. They teach a class. The nightly sync auto-creates their upstream
   `teachers` row as `role='staff'`.
2. They appear on the rates page as "no rate set."
3. `payroll.prepare` for any period containing their class fails the run and
   files a blocking notification, per §7. Nobody is invoiced until it is
   resolved.
4. The owner sets a rate. Re-run.

Step 3 is deliberately all-or-nothing: a blocked payroll is noticed
immediately, whereas seventeen correct invoices and one silently missing
teacher is not. The `UNIQUE (period, mb_staff_id)` constraint would make a
partial run safe to resume, so this is a reversible choice if it proves
annoying in practice.

**A rate change** never edits a row in place. "Change rate" asks for the new
amount and an effective date that **defaults to the next period start**,
computed from the anchor in §6. Saving writes a new `teacher_pay_rates` row
and closes the previous one by setting its `effective_to` to the day before.

The form refuses an effective date inside the currently open period, which
enforces §9 structurally rather than by convention. Keeping history rather
than overwriting is what lets a re-run of an old period reproduce exactly the
numbers that were approved at the time.

**Seeding** the current teachers uses the same page. No separate import path,
so there is one way to set a rate and one place to look for what a rate is.

The initial values supplied 2026-08-11, already resolved to `mb_staff_id`, are
in `docs/payroll-rates-initial.csv`. That file is a provenance record of what
was loaded and when: once seeded, `teacher_pay_rates` is authoritative and the
CSV is never read again. Do not edit it to change a rate.

## 12. Teachers who are not paid

Some teachers teach without being paid, by agreement: currently Naomi Clark,
who teaches as a trade. This needs its own state, because "unpaid" and "rate
not decided yet" must not look the same to the job.

- **No row in `teacher_pay_rates`** means nobody has decided. The run blocks
  (§7).
- **A row with `rate_cents = 0`** means somebody decided, and the answer was
  zero. The run proceeds.

`payroll.prepare` files no item and `payroll.push` writes no Bill for a
teacher whose computed total is zero, so a trade arrangement never produces a
$0 Bill cluttering QuickBooks. The zero-rate row still appears on the rates
page, with its `notes` explaining why, so the arrangement is visible rather
than an unexplained absence.

The `notes` column exists for exactly this: a rate of zero is a decision that
needs a reason attached, and so does an unusual rate.

Trade arrangements are worth revisiting periodically. A zero rate that
outlives its agreement is invisible in the invoices, since nothing is
generated, and only shows up on the rates page.

## 13. Unpaid class quotas (training payback)

Some teachers owe the studio a number of unpaid classes per month, working off
a teacher-training balance. Currently Kate Jarvis, at three classes per month.
This is a configurable arrangement per teacher, not a special case in code.

It is not the same as a zero rate (§12). Kate is paid her normal $75 for every
class beyond the quota; only the first ones each month are free.

Proposed shape, a separate table because it has its own lifecycle (it starts,
and it ends when the balance is worked off):

```
teacher_unpaid_quotas(
  id, mb_staff_id integer NOT NULL,
  kind text,                        -- 'training_payback'
  free_classes_per_month integer NOT NULL,
  obligation_cents integer NOT NULL, -- the balance to work off, in cents
  effective_from date NOT NULL, effective_to date,
  notes, created_by, created_at
)
```

**Decided 2026-08-11:**

- **No rollover.** Each calendar month independently allows up to N free
  classes. Teach two in a month with a quota of three and the third is gone,
  not carried forward.
- **Cancelled classes never draw against the quota.** They are unpaid anyway
  (§5), so they are invisible to this calculation entirely.
- **The system tracks a remaining balance and the arrangement ends
  automatically** when the obligation is worked off.

**Denominated in dollars** (decided 2026-08-11). `obligation_cents` is the
training price, and each free class credits against it **the same amount the
class would otherwise have paid**: the teacher's rate in effect for that
period, per §9. So a $75 rate works off $75 per free class, and if a rate ever
changes, the remaining classes change with it while the dollar balance stays
the agreement that was actually struck.

**The balance stays derived, like everything else here.** Store the original
`obligation_cents` as a constant and compute what remains by replaying the
free classes since `effective_from`. Never decrement a stored counter: a
counter drifts the moment a class is re-synced, back-dated, or a period is
re-run, and it would silently change what an already-approved invoice meant.

So a class is free when **both** hold at that point in the replay:

1. fewer than `free_classes_per_month` free classes have already been taken in
   that calendar month, and
2. the remaining obligation is greater than zero.

The second condition is what makes the tail correct. If two credits remain and
the monthly quota is three, only two classes that month are free and the third
is paid normally. Without it the last month would over-credit.

The arrangement is **active while remaining is greater than zero**, derived
rather than flagged, so nothing has to run to close it out. The rates page
shows the remaining balance and, once complete, the date it was paid off.

Worth adding when built: a notification the period a balance reaches zero, so
completion is announced rather than discovered. It is a good thing to be able
to tell someone.

A partial credit is possible at the very end: if $40 remains and a free class
would credit $75, the class works off the last $40 and Kate is paid the
remaining $35 for it. Rounding the tail either way would mean quietly
overcharging or overpaying, and the arithmetic is already on the invoice.

**The awkward part: the quota is monthly, the pay period is fortnightly.**
They do not align, and periods straddle month boundaries. `2026-08-31 ..
2026-09-13` contains one August day and thirteen September days, so a class on
August 31 draws against August's quota while September 1 onward draws against
a fresh one.

Rules that follow:

- Quota consumption is accounted **per calendar month**, never per period.
- The free classes are the **first N chronologically** within the calendar
  month, so a class's paid-or-free status does not depend on when payroll ran.
- Consumption is **derived, never stored as a counter**: count the teacher's
  qualifying classes from the first of the month up to the class in question.
  A stored counter would drift on any re-run; a derived one makes re-running an
  old period reproduce exactly what was approved.
- A period is only computable once every month it touches has its classes
  loaded, which the §6 freshness check already guarantees.

**The invoice must show the arithmetic.** Kate's item and Bill read as, for
example, six classes taught, three unpaid under training payback, three paid
at $75, total $225. An approver should never have to work out why the total is
not classes times rate.

If the quota consumes every class in a period the total is zero, and per §12
no item and no Bill are produced.

**Open before this is built:** Kate's actual outstanding balance, and the date
the arrangement started, since the replay runs from `effective_from` and any
free classes she has already taught before that date are not visible to it.

## 14. Staff records that are not people

Two upstream `teachers` rows are placeholders, not payees, and both carry real
`mb_staff_id` values so they cannot be excluded by a NULL check:

- `TBA` (`100000086`, `role='tba'`)
- `No Class No Class` (`100000040`)

`payroll.prepare` excludes both explicitly. A class attributed to either is a
scheduling artifact, and if one appears inside a pay period it is a data
problem to fix upstream, not a teacher to pay.
