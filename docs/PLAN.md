# Build plan

The executable companion to `docs/design/front-desk-pos.md`. That document
explains **why**; this one says **what to do next, in what order, and how to
know it is done**. When they disagree, the design doc is the reasoning of
record and this file is stale: fix this file.

Keep it current. An item that ships gets checked off in the same commit.

---

## Blocked on Pete

Nothing below waits on these except where named, but they are on the critical
path for the phase that carries them.

| # | Question | Blocks | Notes |
|---|---|---|---|
| P1 | Does a service account distort commission or payroll reporting? | Phase 1.5 auth | Rolling with the service account for now |
| P2 | Partial account credit: $12 sale against a $4 balance. Ignore the balance, or spend it and let the floor top it back up? | Phase 2 payments | Literal reading of the rule is "ignore" |
| P3 | How long does the $21 two-week upgrade last: that visit, that day, or longer? | Phase 2 offers | Decides whether the offer belongs to a roster row or to the client |
| P4 | Is the $10 minimum measured before or after tax? | Phase 2 payments | A $2.72 item is $3.00 charged |
| P5 | Where does the studio banner text live once an env var is not enough? | Phase 3 | Env var is fine until someone other than Pete edits it |

## Probes to run

Cheap, and each one removes a guess. All are read-only or `Test: true`.

| # | Probe | Answers | Status |
|---|---|---|---|
| B1 | `POST /sale/checkoutshoppingcart` with a candidate price/discount key in item `Metadata`, `Test: true`, compare returned total | Whether the POS can set a cart price directly. If yes, the $21 SKU is unnecessary | **Mostly answered from the spec (2026-08-30): CheckoutItemWrapper.DiscountAmount discounts a cart line directly, so the $21 SKU is unnecessary. One Test: true probe still owed for quantity semantics and permission gating; see TICKETS.** |
| B2 | `GET /sale/alternativepaymentmethods` with `LocationId=98` | The HTTP 400 that gates all Apple Pay scoping | Not run |
| B3 | Re-run `mindbody:probe-payments --live` against a client with a current card | Whether a charge actually settles through Stripe. Only ever reached "card is expired" | Not run |
| B4 | Confirm a per-client Mindbody-hosted card capture page exists and is reachable by URL | Whether Phase 3 card capture is buildable at all | Not run |

---

## Phase 1 — check-in, and knowing who you are talking to

No money moves. Most of the time saved at the door lives here.

**Status: 1.1-1.8 are code-complete on `feature/phase-1`**, each behind an
adversarial review pass; `docs/TICKETS.md` tracks the per-item state and the
live verifications still owed (watching a `SignedIn` flag flip, a real
booking, waiver and red-alert fields under live credentials). The done-when
criteria below that require live Mindbody remain open until those pass.

- [x] Roster for the classes around now
- [x] Walk-in search via `searchText`, debounced, abortable
- [x] Pessimistic check-in with a spinner
- [x] Check-out behind a confirmation
- [x] Dry run, target and write-guard safety
- [x] Dev drawer with call log and settings

**1.1 Verify check-in against a real class.** *Do this first.* Everything else
in Phase 1 is scaffolding around this one call and nobody has watched it work.
- `POST /client/updateclientvisit` `{VisitId, SignedIn}`
- Sandbox, drawer open. Flip it on, confirm in Mindbody, flip it off again.
- Done when: a `SignedIn` flag has been seen to change, both directions.

**1.2 Walk-in booking, the money-free half.** Without this the search box finds
a person and then cannot act: there is no visit to sign in.
- `POST /class/addclienttoclass`, permission `BookClassesAndEventsWithoutPayment`
  (already held). Supports `Test: true`, so rehearse free.
- `Waitlist: true` when the class is at capacity.
- Promotion off the waiting list by passing `WaitlistEntryId`.
- Done when: a walk-in can be booked and then checked in, and a full class
  offers the waiting list instead of failing.

**1.3 Header counters.** Signed up, checked in, waitlist.
- Signed up and checked in are free: roster length, and the count of `SignedIn`.
- Capacity is free too: `MaxCapacity` and `TotalBooked` on the class summary.
- Waitlist needs `GET /class/waitlistentries` by `ClassIds`, **fetched only
  when `TotalBooked >= MaxCapacity`.** A class with room cannot have a queue.
- Done when: the counters render with no extra call for a class that has room.

**1.4 Counter modals.** Tapping a counter lists the people behind it.
- Waitlisted visits are **stubs**: only `ClassId` and `ClientId` are populated,
  so they cannot use the normal row component. Names come from the same batched
  client lookup the roster uses.
- Done when: "is Dennis here yet" is answerable without scrolling the roster.

**1.5 Client context on the expanded row.** Fetched on row open, never per
roster.
- Pass and `Remaining` — `GET /client/clientservices`. **`Remaining: 1` is the
  highest-value prompt in the app**; surface it loudly.
- Account credit — `GET /client/clientaccountbalances`
- Recent visits — `GET /client/clientvisits` ("third visit this week")
- Habitual add-ons — `GET /client/clientpurchases`, needs a real pattern (say
  three of the last five) before it shows, or it is noise
- `Notes`, and `RedAlert` treated as blocking rather than decorative
- Done when: one tap answers "what do I need to know about this person".

**1.6 Waiver state.** Show it; the counter signing path is T18.
- `Liability.IsReleased` and `AgreementDate` on the client record
- Unmissable blocked state on the row. A teacher cannot simply tap it signed;
  since T18 (Pete, 2026-08-28) the gate dialog can show the real waiver text
  and record the STUDENT's agreement -- see the design doc's waiver addendum.
  The QR flow stays Phase 3.
- Done when: a student without a waiver cannot be checked in by reflex.

**1.7 Studio banner.** Text from an env var, shown until changed. No
scheduling, no targeting.

**1.8 Categories config.** Five entries, hardcoded, ordered by counter
frequency: Towel and Mat (-14), Food/Drink (36), passes, Accessories (32),
Clothing (26). Everything else behind "more". Not fetched.

---

## Phase 1.5 — put it at the counter

Not a feature, and the step that turns a laptop demo into something teachers
use. **Until this is done the app must not sit at the counter**: it is an open
endpoint against live student data.

- [x] Auth: shared device PIN (T21) plus a per-teacher session from the last four of their phone (T44)
- [ ] Railway service, deployed
- [ ] `POS_DEVTOOLS=false`, `POS_DRY_RUN=false`, mode banner verified
- [ ] Add to Home Screen on the studio iPad
- [ ] **Watch a teacher work a 6pm rush.** Fix what they actually hit before
      building any of Phase 2.

---

## Phase 2 — sales

Depends on B1 and B3. Nothing here should be built while B1 is unanswered,
because it decides whether prices are ours to set.

**2.1 Cart and catalog**, using the hardcoded categories. In-studio pricing:
read `Price`, not `OnlinePrice`, and send `LocationId: 1` with `InStore: true`
so the server prices what the screen showed. Assert the total: an in-studio
total is `Price x 1.1035` except for items in the "sales tax exempt" secondary
category (100000). A disagreement with the server is a bug, never something to
swallow.

**2.2 Payment chooser.** `StoredCard`, `DebitAccount`, cash, gift card, comp,
and whatever `GET /sale/custompaymentmethods` returns. Read balances before
offering a method: "account credit ($12)" greyed out beats a failure.

**2.3 The $10 card minimum.** Not a refinement of 2.2, part of it.
- Credit covers the total → paid entirely from credit, card not offered
- Otherwise card, charged `max(total, 10)`, excess to credit
- Three paths, and only the third is two calls:

| Case | Calls |
|---|---|
| Credit covers it | checkout on `DebitAccount` |
| Card, total ≥ $10 | checkout on `StoredCard` |
| Card, total < $10 | `purchaseaccountcredit` $10, then checkout on `DebitAccount` |

- **Do not collapse the card paths** by always routing through
  `purchaseaccountcredit`: it would record a $150 membership as a credit
  purchase plus redemption and wreck the reporting.
- The sub-$10 path has a real seam. Mitigate with `Test: true` on the cart
  *before* buying credit, and on a step-2 failure report the credit balance
  explicitly or a teacher will re-run it and charge a second $10.
- Blocked on P2 (partial credit) and P4 (tax).

**2.4 The unpaid row.** Today it can only offer free entry behind a confirming
tap, which is a stopgap. Here it sells the missing pass against the card on
file and checks them in, one gesture, with free entry kept as the deliberate
comp.

**2.5 Last-class renewal.** Phase 1 shows `Remaining: 1`; this sells the next
pack in the same gesture.

**2.6 The $49 two-week special and the $21 upgrade.**
- New students only, hardcoded. **Must not appear for anyone else** — it is a
  price a teacher might honour by mistake.
- Eligibility: no prior purchases and no prior visits, evaluated *before* the
  current visit counts, or the student loses the upgrade the instant their own
  drop-in is recorded.
- Upgrade: first-visit $28 drop-in applies toward the special, $21 difference.
- Blocked on B1 (can we set the price?) and P3 (how long the offer lasts).

---

## Phase 3 — the customer's own phone

One QR mechanism, three outcomes. These were three ideas and are one piece of
work: all three put something in front of the student on their own device, off
the critical path.

- **Store a card.** Mindbody-hosted only. **We can never build our own form**:
  both API paths that store a card take a raw PAN. Blocked on B4.
- **Pay with Apple Pay.** Type 801, Stripe only. Redirect flow via
  `initiatecheckoutshoppingcart` → callback → `completecheckoutshoppingcart`.
  Online store only, so it charges the **online** price. Blocked on B2.
- **Sign the waiver.** `GET /site/liabilitywaiver` returns the real text, so
  this half is entirely ours. Student reads and agrees, then
  `LiabilityRelease: true`.

**Also Phase 3: the database arrives.** Mindbody records *that* a waiver was
agreed but not *what to*, so keep a receipt: client id, timestamp, hash of the
text shown. The rule that comes with it, and it is enforced not assumed: **the
database holds what Mindbody has no home for, never a copy of what it does.**
Banner text, waiver receipts, shift records: yes. Clients, classes, passes,
prices, visits: never, including for speed.

---

## Phase 4 — Stripe Terminal

Ruled out by the data: 25 card-present sales and $1,377 a year against two
deposit streams, a nightly reconciliation job and a second reader. Keep the
payment interface seam so it stays possible. **Do not build it.**

---

## Cut, and why

- **Option A, the Mindbody handoff.** A deep link plus a polling loop to
  confirm an out-of-band sale, serving roughly one person a day. Phase 3 solves
  that person permanently. The fallback is the teacher using the Mindbody app,
  as today, which costs no code and is exactly as fast.
- **Offline support.** A sale must never be queued, and a queued check-in is
  the failure mode that optimistic check-in was overruled to avoid. If the
  network is gone, say so loudly. Revisit only if counter wifi proves bad.
- **The in-memory client index.** Deleted deliberately; see CLAUDE.md. Do not
  rebuild it by reflex.
