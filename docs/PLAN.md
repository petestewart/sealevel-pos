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
| P4 | ~~Is the $10 minimum measured before or after tax?~~ **Moot (T238, 2026-11-15): there is no card minimum any more.** | Phase 2 payments | A $2.72 item is $3.00 charged, on the card, as $3.00 |
| P5 | Where does the studio banner text live once an env var is not enough? | Phase 3 | Env var is fine until someone other than Pete edits it |
| P6 | Who owns the Stripe account: legal entity, bank account, who holds the login? | T237 | Phase 4 |
| P7 | The custom payment method's name in Mindbody, created on 471, and one on the sandbox | T222 | e.g. "Card (Stripe reader)" |
| P8 | Does the card tapped on the reader count as the customer's approval (T203)? | T230 | Recommended yes: approve-then-tap is the friction the brief rules out |
| P9 | Tipping on the reader? | T225 | Recommended none; a tip changes the held amount |
| P10 | ~~Does the $10 card minimum apply to the reader?~~ **Answered (Pete, 2026-11-15, T238): any amount, on the reader too.** The floor is retired everywhere | T226 | A $3 water by tap is the kind of sale being lost |
| P11 | Receipts: Mindbody's email only, or Stripe's as well? | T226 | |
| P12 | The statement descriptor | T237 | Ideally matching what Mindbody Payments shows |
| P13 | Who reconciles, who refunds, and where do they hear about a mismatch off the counter? | T231, T235 | |
| P14 | S700 or a second WisePOS E? | T237 | Recommended S700, so the two readers cannot be confused |
| P15 | The service charge on card transactions under $10 (Pete, 2026-11-15, T239: "we are eventually going to implement adding a service charge for CC transactions under $10"). **Planned, not built; until it is, a card is charged exactly the sale.** Undecided: the amount; whether it is a Mindbody product line on the cart or a fee outside it; whether it applies to the reader, a typed card and the card on file alike; and how it is shown to the student before the tap | Nothing yet | Not the retired $10 floor: nothing is bought as credit. Stripe's own $0.50 minimum still meets the reader (T226) |

## Probes to run

Cheap, and each one removes a guess. All are read-only or `Test: true`.

| # | Probe | Answers | Status |
|---|---|---|---|
| B1 | `POST /sale/checkoutshoppingcart` with a candidate price/discount key in item `Metadata`, `Test: true`, compare returned total | Whether the POS can set a cart price directly. If yes, the $21 SKU is unnecessary | **Mostly answered from the spec (2026-08-30): CheckoutItemWrapper.DiscountAmount discounts a cart line directly, so the $21 SKU is unnecessary. One Test: true probe still owed for quantity semantics and permission gating; see TICKETS.** |
| B2 | `GET /sale/alternativepaymentmethods` with `LocationId=98` | The HTTP 400 that gates all Apple Pay scoping | Not run. **Deprioritised 2026-11-15**: counter Apple Pay is Phase 4's reader, not this redirect flow |
| B3 | Re-run `mindbody:probe-payments --live` against a client with a current card | Whether a charge actually settles through Stripe. Only ever reached "card is expired" | **Answered by use (Pete, 2026-11-15)**: the counter has charged stored cards live for months, and typed cards in testing. Open only for T238's under-$10 charge |
| B4 | Confirm a per-client Mindbody-hosted card capture page exists and is reachable by URL | Whether Phase 3 card capture is buildable at all | Not run |
| B5 | `scripts/probe-promo-code.ts <client> <code> <option> --create 28`: makes a throwaway one-use code, prices the cart without it and with it twice, deactivates it | Whether Mindbody honours a promotion code on the rehearsal, whether SubTotal stays pre-discount, its refusal wording, and whether pricing spends a one-use code | **Answered, prod, 2026-11-14 (Pete, dummy client 100042041).** An inactive code: 4xx "Promotion code is not active.", repriced without it. A valid one-use code for 581: HONOURED on `Test: true`, $49.00 -> $21.00, DiscountTotal $28.00, SubTotal $49.00, T75 agreeing; priced twice, applied twice, so pricing does NOT spend it. Along the way: `addpromocode` takes `Amount`/`Percent` while the list reads `FlatRate`, and answers `PromotionID: 0` |
| R1 | `GET /sale/custompaymentmethods` on 471 and on -99 | What exists, and the response key: the spec says `PaymentMethods` (sale.yml:2798) while `scripts/probe-giftcard-free.ts` reads `CustomPaymentMethods`, so that script may have printed "none configured" wrongly. Read both | Not run (T222) |
| R2 | `checkoutshoppingcart`, `Test: true`, a Custom payment with the new id | Whether Mindbody accepts it, and in which key casing | Not run (T222) |
| R3 | R2 with a `Notes` key carrying a PaymentIntent id | Whether `SalePayment.Notes` (sale.yml:4557) can carry the link, which would make the match exact inside Mindbody | Not run (T222) |
| R4 | One real Custom sale for dummy client 100042041, then `/sale/sales` with `request.paymentMethodId` | How the sale reads back, whether the filter takes a custom id, how it shows in Pete's reports, and how a return of it reads | Not run (T231) |
| R5 | Three `Test: true` calls: (a) `purchasegiftcard` paid Custom; (b) `purchaseaccountcredit` paid Custom; (c) `purchasegiftcard` paid `DebitAccount` | Which gift card route the reader can use: directly (a), or Pete's credit-then-spend workaround (b then c). c asks against the client's existing balance, so "insufficient" there is about the balance, not the payment type | Not run (T222; `scripts/probe-custom-payment.ts`) |
| R6 | Stripe's simulated reader, test mode | Every (U) in Phase 4: `process_config` names, reader action statuses and failure codes, offline and busy errors, whether the reader times out by itself, how long a `card_present` hold lasts (believed about two days), metadata on capture, `amount_to_capture`, the simulated registration codes and test helper, test-mode decline behaviour | Not run (before T225 is done) |

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
- [x] A star beside the M on a student whose first class with the studio is the class on screen (Pete, 2026-11-07). **T216** (`FirstClassDate` from the roster's existing batched client lookup, no new call; the rule is `src/lib/firstclass.ts`). How Mindbody fills that field has not been seen live.
- [x] The star only on the FIRST class of the first day, not every booking that day (Pete, 2026-11-09). **T217** (`earlier` from one `/client/clientvisits` read per remaining candidate, cached two minutes, at most ten per roster).
- [x] A slow note is not a red "failed" on the guest sheet; the note wait is 15s (Pete, 2026-11-09). **T218**.

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

- [x] Auth: shared device PIN (T21); teacher identity only where it matters, a comp, by the teacher's own stored PIN (T48, superseding T44's shift sign-in)
- [ ] Railway service, deployed (steps in docs/DEPLOY.md)
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

**2.3 The $10 card minimum.** **Retired 2026-11-15 by T238** (Pete: "that is
an old policy! ... change it so any amount can be charged"): every card is
charged what it pays in ONE checkout, no card sale buys account credit, and
the roster's pay dialog defaults to a covering balance but offers the card
beside it (and since T239 the Cart screen starts on it the same way). A
service charge on card sales under $10 is planned and not built (P15); until
it is, a card is charged exactly the sale. What follows is the plan as it was
built, kept for the record.
Not a refinement of 2.2, part of it.
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
- [x] The RETURNING student's version arrived first, as a Mindbody
  promotion code (Pete, 2026-11-14: per-student, single-use codes taking
  $28 off pass 581, "Welcome Back - 2 Weeks Unlimited ($49)", emailed to
  recent drop-ins; "that needs to be added immediately"). **T220**: a code
  field on the Cart screen and in the roster's "Pay and check in", sent as
  the cart's `PromotionCode` on the pricing, the rehearsal and every real
  checkout; the discount and total shown are Mindbody's; a refused code
  shows Mindbody's sentence and the ticket stays chargeable without it; a
  code refused at the charge refuses the sale with nothing charged; it is
  in T203's cart sha; refused beside a discount, a substitution, a T90
  line or a gift card. 581 is `IntroOfferType: "NewAndExistingClients"`
  and nothing in the app hides it from a returning client (the
  new-students-only rule above is for 414 and was never built).
- [x] Probe B5 on prod (2026-11-14): a code is honoured on the rehearsal
  and pricing does not spend it.
- [x] One real coded sale on the counter build (Pete, 2026-11-14): sale
  428528 to dummy client 100042041, 581 at $49.00 less $28.00, $21.00 cash.
- [x] 581 is one per client: the next pricing for that client was refused
  "Client has hit the purchase count for this intro series."
- [ ] Check the deployed drawer's Shelf tab does not hide `Service:581`.
  Then merge and deploy.

**2.6b Passes a client cannot buy.**
- [x] Greyed out before the tap, with Mindbody's reason, on the Cart
  screen and in the roster's pay dialog (Pete, 2026-11-14). **T221**
  (`/api/pass-availability`: each intro offer and member-only pass priced
  `Test: true` for the attached client, in parallel, cached two minutes;
  a tap on a greyed tile opens the refused-line notice instead).
- [x] Live on site 471 (2026-11-14): John NewGuy's Specials greyed 414,
  478 and 581 with Mindbody's reasons; a tap added nothing; Drop In priced.

**2.7 A pass that comes with a place.** A workshop sold as a pass also
signs the buyer up for it, so the counter does not stop at the sale.
- [x] Selling a configured pass books whoever it was bought for into its
  course or class, straight after the sale, under the teacher's token
  (Pete, 2026-11-09: the Gratitude Yin Sound Bath's two passes and the
  workshop on 11/25/26, "classID=743"). **T219** (`enrolments` in the
  shelf config, rows on the drawer's Shelf tab with a Check that says
  what an id is; run once in `/api/checkout` inside T113's record;
  `src/lib/enrolonpurchase.ts`). The next workshop is two rows in the
  drawer, not a deploy.
- [ ] Live, owed: `scripts/probe-signup-target.ts 743` on site 471 says
  what 743 is (a course, by Mindbody's workshop URL; studio class ids
  are six digits), and the same with a dummy client id rehearses the
  write with `Test: true`. Then one real sale to a dummy client, and a
  look at whether Mindbody spent the sold pass on the enrollment.
- [ ] Configure it on the counter: the drawer's Shelf tab, "sign up on
  purchase", one row per sound bath pass, course, 743, Check, Save.
  Needs `DATABASE_URL` (the shelf config lives there).

---

## Phase 2.5 — the customer-facing iPad

**Every item below is built, on `feature/customer-display`**, all three
probes ran on 2026-09-20, and Pete drove the phase on two iPads against
the sandbox the same day (T206 is what that drive sent back). What
remains is the counter itself: no item here has been driven against the
STUDIO's Mindbody site, or with a real student.

Design: `docs/design/customer-display.md`. A second iPad on the counter,
paired to the POS, that shows one scene at a time because a teacher put
it there. The display never writes to Mindbody: every result is finalised
from the teacher's iPad through the write routes that already exist.
Plumbing first, then one scene at a time, in this order.

- [x] Plumbing: `/display`, pairing code, `pos_display` cookie, `displays` and `display_requests` tables, the hub, both SSE routes, present/cancel/complete/refuse, header connection mark, drawer pair/unpair. Done when a paired iPad survives a restart on the idle screen. **T200** (the pairing survives a restart with a database; with none it re-pairs and says so).
- [x] Ticket, summary mode: live mirror of the priced cart and the post-sale summary. No writes. **T201** (a live ticket is replaced in place; a busy display skips the mirror in silence; the summary leaves the screen on the hub's own clock).
- [x] Waiver: sign on the display, signature kept in `waiver_receipts` and copied to Mindbody documents. **T202** (the scene is built server-side and carries no client id or hash; the signature is consumed BY ID, once, across a restart; the document copy is best effort and never fails the agreement). Probe D-B1 RAN (Pete, sandbox, 2026-09-20): the upload is accepted, and `MediaType` is a MIME type (`image/png`), not the extension the spec lists. Whether the file then shows on the client's Documents page has not been looked at.
- [x] Ticket approval: `customer_confirms_sale` in `app_settings`, admin-edited, enforced by `/api/checkout` on the server; teacher override by their own PIN (T48 idiom), filed on the client. **T203** (one cart hash, `src/lib/cartsha.ts`, computed server-side by both routes and holding everything that decides the total but not the total itself; the approval is spent only after the charge resolved; the setting only ever ADDS a precondition, which is why the drawer may hold it).
- [x] Sign-up, self-serve: "New here? Sign up" on the idle screen, form then waiver signature in one request, a tray with a gold count on the POS header, Create finalises client and waiver in one tap, pending sign-ups surface in walk-in search, take-over rule when the teacher needs the screen. Email and text opt-in ticked by default. Answers Pete's rush case (design doc, "Self-serve"). **T204** (`/api/display/start` is the one route the DISPLAY puts a scene up with; a sign-up has two clocks, four hours for the result and two minutes of no touch for the screen; the form and the signature are one request, and Create is one claim over the create AND the waiver, which is now one shared `src/lib/waiverfinalise.ts`). D-B3 RAN (Pete, sandbox, 2026-09-20) and `addclient` DROPS the three text flags, so the read-back finds them dropped every time and the T62-signed Notes line the route files on that evidence is the real record of the student's "Text me", not a fallback.
  - [x] And it finishes itself: `signup_mode` in `app_settings` (`POS_SIGNUP_MODE` with no database), **default automatic**, admin-edited beside the other two. Automatic has the signed-in teacher's iPad run Create, then the walk-in booking for the class on screen (the waiting list when it is full), then the check-in, with no tap; review is T204's tap, unchanged. **T207** (the same three EXISTING write routes from the teacher's own browser, so nothing new reaches Mindbody and every guard applies as it does to a tap; one attempt per request id per browser; two iPads settled by the create's own claim; the tray is the exception path, and a row whose client now exists taps through to the profile, never to Create). Not a rail: no server route reads the setting.
  - [x] Pete's SECOND drive, on two iPads in the sandbox: seven fixes. **T208** (an in-progress spinner in the tray while the run works; a class hours ahead is now booked AND checked in, the "ahead" outcome gone; a stale tray row lists, opens and CLEARS through one predicate, and the runner spends a sign-up the server no longer has; `/api/book` reads the class's capacity FRESH before a plain booking, because Mindbody's API enforces none, and queues it with `waitlisted: true` rather than overbooking; a duplicate create answers with the account Mindbody matched and the teacher decides between the two people side by side, with "use their existing account" filing the waiver and creating nobody; review mode says "Review sign-up" and runs the same booking and check-in after its tap; and the waiting list is a section at the BOTTOM of the roster).
  - [x] Pete's THIRD drive: with the approval on, the roster's "Pay and check in" charged without ever asking, because T203 wired the asking half into the Cart screen alone. **T209** (the flow is one shared piece, `src/app/useSaleApproval.ts` with `src/app/ApprovalWait.tsx`, and both charge screens call it; an unconnected screen gets the SAME panel with the line that names the PIN and never a PIN pad on its own; closing the dialog cancels the presented ticket; free entry presents nothing; those are the only two `/api/checkout` callers in the app).
  - [x] A teacher can go past the waiver gate with their own PIN and a reason, and reach that override however the dialog broke. **T211** (a sixth `CompPurpose`, `waiver`; the control is in EVERY shape of the T18/T19 dialog, including the close-only one a failed text fetch used to dead-end in; `/api/checkin`, `/api/book` and `/api/guest` take an optional `waiverOverride`, verify the purpose and this teacher's own staff id, spend it once before any Mindbody call and file the sentence on the client the way T45/T62 file a comp's reason; a suppressed write hands the PIN back; it NEVER marks the waiver signed, so the student is asked again next time).
  - [x] Pete's THIRD drive, second fix: the review sign-up's Create answered "Delegated staff does not belong to the subscriber." and nothing could get past it, which is Mindbody's answer to a staff token used with a SiteId it was not issued for. **T210** (migration 16 puts `site_id` on `staff_sessions` and `siteId` on the in-memory session; a session row for another site, or from before the column, is never restored and a foreign one in memory is dropped; the T206 borrow and `adoptServiceToken` refuse a token not issued for the site they were called with; that sentence is a dead token for this site, so the session ends, the write is refused 401 `reason: "staff"` and never retried as the service account, and the cached service token is forgotten so the next read reissues; the gate, the drawer, `/api/config` and the probe all name the two site ids).
  - [x] The target switch was only reachable signed in, so a counter on the studio nobody could sign in to was stuck there (Pete, 2026-09-25). **T212** (the sign-in gate offers both studios when the drawer's switch could work at all; signing in to the OTHER studio is checked against that studio, must be a named admin there, and moves the counter through the same `switchTarget` the drawer now calls; anybody else is refused in words with their id at that studio and the counter does not move. The "still says sandbox" half was the studio banner, `POS_BANNER_TEXT=Sandbox test` from the drive's setup steps, not the mode).
  - [x] The roster did not refresh itself: a student checked in from the Mindbody app, the kiosk or another iPad never appeared until the teacher switched classes (Pete, 2026-10-25). **T213** (a quiet re-read of the class on screen every 30 seconds while visible and on returning to the tab, tunable in the drawer, skipped and discarded around any write on this iPad, silent on failure; plus a refresh button beside the class picker).
  - [x] The sign-in gate's studio choice is gone and its form stays on screen with the keyboard up (Pete, on the counter iPad, 2026-11-04: "The production and sandbox options shouldn't be there, that should just be in settings. And the form goes out of view in the iPad when the keyboard shows."). **T215** (T212's gate picker and `studioChoice` removed; the drawer's switch is the only door, and `/api/teacher/signin` refuses a stale page's `target` with nothing sent; the gate's form is pinned high rather than centred, so its fields are above the keyboard and iOS has nothing to scroll; the refusal line moved above the fields so the sticky Sign in row cannot cover it). Not yet seen on the iPad.
- [x] Contract signature on the display, required by `contract_requires_signature` (default on) with the teacher's PIN override, sent as `ClientSignature`, `contract_receipts` row. **T205** (the scene is built server-side from Mindbody's own contract and its own `Test: true` rehearsal, and carries words only: no client id, no contract id, no hash; the purchase refuses unless the signature names THIS client, contract and start day AND the terms still hash to what was signed; the signature is claimed before the write and spent only after it answered, so a refusal leaves it usable for a retry). D-B2 RAN (Pete, sandbox, 2026-09-20): `ClientSignature` is accepted and does not move the rehearsal's Total (70.00 either way), so the rehearsal stays signature-free and the live purchase carries it, as built.

- [x] Pete's first drive on real hardware, 2026-09-20: the display mark notices a closed tab at once (the SSE teardown, counted so a reload cannot flap it), the approve scene reads Cancel | Approve, both sign-up forms ask a birth date when and only when the site's required list names one, the membership's no-card notice carries its own Add card (and any card saved anywhere makes the sale screen read again), a membership with no terms says so instead of blaming a connected screen, the contract modal ends above the nav bar, and the Buy screen is the Cart screen. **T206.**

Probes owed, both sandbox, `Test: true` where the endpoint takes it:

| # | Probe | Answers |
|---|---|---|
| D-B1 | `POST /client/uploadclientdocument` with a small PNG | **Run 2026-09-20 (Pete, sandbox client 100015484): ACCEPTED, `{FileSize: 72, FileName}`.** `MediaType` is a MIME type: `png`, `.png`, `PNG` and `Png` are each refused "Media type <x> is invalid" and `image/png` passes, whatever client.yml:7427 lists. The upload now sends `image/png`. Still to look at: whether the file shows on that client's Documents page in the sandbox's Mindbody. |
| D-B2 | `POST /sale/purchasecontract` `Test: true` with `ClientSignature` set | **Run 2026-09-20 (Pete, sandbox client 100015484, contract 347 "Corporate Monthly Membership", paid by account credit): ACCEPTED, and the Total did not move** (70.00 without the field, 70.00 with it; the answer carries no signature field of its own). The gate is cleared: the rehearsal stays signature-free and the live purchase carries it. Along the way: `GET /sale/contracts` REQUIRES `request.locationId` and lists per location, and a contract can be listed for a location and still refuse to sell there (354 and 356 at location 1: "cannot be purchased at location 1"), so a listed contract is not a sellable one until the rehearsal says so. Not seen: the `clientContractSignature-...` document Mindbody says it files on a REAL purchase. |
| D-B3 | `POST /client/addclient` in the sandbox with the three `Send*Texts` flags, then read the client back | **Run 2026-09-20 (Pete, sandbox, probe client 100015635): addclient DROPS the text opt-in.** All six flags sent `true`; the create's own answer and the read-back both say the three email flags `true` and the three text flags `false`. So the T204 Notes fallback is the real path, not a stopgap, and the "Text me" box records an intention a human sets in Mindbody. The sandbox also requires `BirthDate` on a create; what the studio's site requires has never been read live (T59b), and since T206 both sign-up forms ask for a birth date whenever the site's own list names one, and send none when it does not. |

D1 to D5 are all answered (2026-09-19) and folded into the design doc.

---

## Phase 3 — the customer's own phone

One QR mechanism, three outcomes. These were three ideas and are one piece of
work: all three put something in front of the student on their own device, off
the critical path.

- **Store a card.** Mindbody-hosted only. **We can never build our own form**:
  both API paths that store a card take a raw PAN. Blocked on B4.
- **Pay with Apple Pay.** *Dropped for counter payments (Pete, 2026-11-15):
  Phase 4's reader takes Apple Pay as a tap.* Type 801, Stripe only. Redirect flow via
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

## Phase 4 — the studio's own card reader (option C)

Decided by Pete, 2026-11-15: teachers report lost sales to students who can
only tap, dip or pay with Apple Pay or Google Pay. The studio gets a Stripe
smart reader on a Stripe account it owns, driven server-side from this app,
and the Mindbody sale is recorded under a Mindbody custom payment method.
Rejected by name: a hand-off to the Mindbody app (even as a stopgap) and any
flow on the student's own phone. Reasoning: design doc, "The card-present
problem" and option C. Do not re-argue it here.

**Stripe is unverified from here.** `docs.stripe.com` and `api.stripe.com`
were unreachable from the planning session, so every Stripe endpoint,
parameter and behaviour below is from memory and marked (U). Probe R6
settles them before T225 is called done, and both hosts must be allowed in
the cloud environment before live Stripe work. T224's fake lets the build
start without them.

**When the reader works, remove the student-typed card (T241).** Pete,
2026-11-17, on students typing their own card on the customer iPad: "i
think we can keep that for now and remove it once we actually have
stripe." It sits behind the `display_typed_card` setting (default on,
`POS_DISPLAY_TYPED_CARD` without a database) so he can turn it off
sooner. Once the reader is live, delete the feature with its setting:
`src/app/display/CardForm.tsx`, `/api/display/card`,
`src/lib/displaycard.ts`, the `typedcard` choice and checkout's
`displayCard` path. "A different card" then becomes the reader's "tap
your card".

### The money order

Rehearse, hold, sell, take.

1. Price and `Test: true`-rehearse the cart exactly as today. The rehearsed
   GrandTotal is the only amount ever sent to Stripe.
2. Create a PaymentIntent (`capture_method: manual`, `card_present`) for
   that total and hand it to the reader. The tap places a hold and takes
   nothing.
3. Run the real `checkoutshoppingcart` with a `Custom` payment.
4. The sale stands (T75 and T103 included): capture. Mindbody refuses:
   cancel the hold.
5. **Mindbody does not answer: keep the hold.** Neither capture nor cancel
   is safe blind, so the server reads `/sale/sales` for the sale, and a
   human decides if the read cannot. This is the one tender that can still
   go either way safely after an ambiguous answer.

The other two orders are worse. Capture first turns a Mindbody refusal into
a refund (fees, a visible charge, days to return). Mindbody first leaves a
declined card with a non-comp sale the API cannot return (`returnsale` is
comp-only).

### Architecture

- **`src/lib/stripe.ts`**, beside `mindbody.ts`: plain `fetch`,
  form-encoded, no `stripe` npm package, nothing imported from ai-manager.
  The call log must show exactly what was sent, and the proxy can inject the
  key.
- **Only `src/lib/readerpayment.ts` (the state machine and its rows) and
  `src/lib/readerrecon.ts` may import it.** `sale.ts` never does. Same shape
  as the display's "imports no `mindbody()`" rule.
- **Call log.** Each Stripe call goes through `record()` in `calllog.ts`
  with a new `service: "stripe"` field and a tag on the drawer row.
  Suppressed and refused-by-mode calls are recorded like dry-run ones.
  `client_secret` is struck. No PAN reaches a server-driven response (U).
- **The seam is the `CheckoutPayment` union** and `checkoutPaymentPayload`
  in `sale.ts` (the design doc's `payment/index.ts` was never built). It
  gains one variant, `{ type: "Custom"; amount; id }`, sent as
  `{ Type: "Custom", Metadata: { Amount, Id } }` (sale.yml:3934),
  PascalCase like every proven shape, never auto-retried in another.
- **One exit for the Stripe side.** `/api/checkout` has about a hundred
  return points, so the capture-or-release decision sits in `POST()` at the
  single exit, beside `enrolAfterCheckout` and inside T113's record. No
  branch can forget to release a hold. An outside tender has three verbs:
  hold, take, release.
- **No webhook in v1.** The browser polls our server each second (the
  `useSaleApproval` precedent) and the server reads the reader and the
  PaymentIntent. No public endpoint, no signing secret, works on localhost.
  A webhook is T236.

### Modes and safety

| Mindbody state | Stripe |
|---|---|
| Dry run (server or this iPad), or the write guard suppressing this client | The rehearsal is suppressed, so Stripe is never called. Amber answer as today, plus "The card reader was not used." |
| Target sandbox | Test mode always. The live key is never read. |
| Target prod, `POS_READER_LIVE` unset | Test mode. Reader sales refused unless the write guard narrows to a dummy client: a simulated tap must never hand a real student a pass. |
| Target prod, `POS_READER_LIVE=true` | Live. A deliberate deploy, like `POS_DRY_RUN=false`. |

- **`livemode` is asserted** on every Stripe response against the expected
  mode. A mismatch on PaymentIntent create cancels it and refuses the sale.
  This is the check that still works when the proxy injects the key.
- **Key prefix check where the key is real**: a `*_live_` key in a test
  variable is refused at startup. A dummy passes.
- **`modeNotice` gains one LOUD state**: target prod with the reader in test
  mode ("Card reader is in TEST mode. Reader sales take no money."). The
  tile wears a TEST tag and the done block says so. `/api/config` reports
  `reader: { configured, mode, simulated, label }`.
- **Target switch (T89)**: each attempt records target, site and livemode.
  A switch releases open holds, and `/api/checkout` refuses an attempt from
  the other studio.
- **Environment** (never committed; a dummy is enough where the proxy
  injects): `STRIPE_TEST_SECRET_KEY`, `STRIPE_LIVE_SECRET_KEY` (restricted
  keys: Terminal, PaymentIntents, Refunds read), `STRIPE_TEST_READER_ID`,
  `STRIPE_LIVE_READER_ID`, `POS_READER_LIVE`,
  `MINDBODY_SANDBOX_READER_PAYMENT_ID`, `MINDBODY_PROD_READER_PAYMENT_ID`,
  and `STRIPE_API_BASE_URL` for the fake only, like `MINDBODY_API_BASE_URL`.
- Nothing about the reader's mode is settable from the drawer.

### The state machine

One `reader_payments` row per attempt (migration 19). Mindbody has no home
for a PaymentIntent-to-sale link, so the T29 charter allows it.

- **Holds**: attempt id, tap key digest, state, target, site, livemode,
  staff id, reader id, client id, cart sha (`cartsha.ts`), amount in cents,
  PaymentIntent id, Mindbody sale id and cart GUID, brand and last four,
  failure text, timestamps.
- **Never holds**: a PAN, expiry, fingerprint, cardholder name, or any
  Mindbody price or line.
- **The database is required to START a reader sale and never to FINISH
  one.** No database: the tile is disabled with a reason and every other
  tender works. A row write failing mid-flow logs `NOT STORED` and the sale
  carries on. The PaymentIntent's metadata is the fallback journal: attempt
  id, site, staff id at create; sale id at capture (U: capture accepts
  metadata).

States: `created → collecting → authorized → selling → sold → captured`,
with `cancelled`, `unresolved` and `uncollected` as the other ends. Every
transition is a compare-and-set, so two iPads or a replay cannot both sell.

Routes, all behind the device session and `requireActor`:

| Route | Does |
|---|---|
| `POST /api/reader/collect` | Takes the checkout body and the tap's `Idempotency-Key`. Refuses unsupported shapes (below), verifies PIN tokens WITHOUT spending them, checks the reader is online and free, rehearses, creates the PaymentIntent, calls `process_payment_intent` with tipping skipped and customer cancellation on (U). |
| `GET /api/reader/attempt/:id` | The 1 second poll and the heartbeat. Reads Stripe, moves the row. |
| `POST /api/reader/attempt/:id/cancel` | `cancel_action`, then cancel the PaymentIntent, then confirm it reads `canceled`. |
| `POST /api/checkout` with `method: "reader"`, `reader: { attemptId }` | Same tap key. Every existing rail runs unchanged (tokens spent, T203, rehearsal, T75). Then it claims the row `authorized → selling` and sells with the Custom payment under the teacher's token. |
| `POST /api/reader/attempt/:id/resolve` | The human decision on an `unresolved` hold. |

Before the claim, `/api/checkout` checks the row against the request: same
teacher, target, client and cart sha; the amount equals the fresh rehearsal
to the cent; Stripe says `requires_capture` for that amount.

Failure windows:

| Window | What happens |
|---|---|
| Rehearsal refuses, or totals disagree | Nothing created. |
| Reader offline or busy | Refused in words. A second iPad reads "The reader is busy with another sale." One open collection per reader, by partial unique index. |
| Customer cancels, card declines, 90 seconds with no card | PaymentIntent cancelled. "Nothing was charged." No PIN was spent, so Try again is a fresh tap. |
| Authorized, browser never returns | A hold with no Mindbody attempt older than 3 minutes is released by an in-process sweep (Stripe calls only, never a Mindbody write). |
| Reload mid-flow | The cart is browser state and is gone. On load, an open `collecting` or `authorized` attempt for this teacher is released with one sentence. `selling` or `unresolved` reopens the resolution panel. |
| Any refusal after the tap (token, approval, drift, Mindbody 4xx, staff session gone) | The exit releases the hold and the answer adds "The card was not charged." |
| T103: the sale answered with an empty basket | NOT captured. Hold released, flagged at once as a Mindbody sale to void. T103's sentence says the payment was taken, so this path needs its own words. |
| Mindbody times out or 5xx | Hold kept. The server reads `/sale/sales` (client, reader payment method, amount, time floor, not already linked) for about 25 seconds. Found: capture. Not found: `unresolved`, with two controls after 2 minutes: "Sale is in Mindbody, charge the card" (only when the server's own read finds it, or an admin names the sale id) and "No sale, release the hold". |
| Capture does not answer | Retried three times in the request, then each minute by the sweep. Not a second charge: a PaymentIntent captures once (U), and the tap, the card and the sale already decided it. The teacher sees the sale as done with an amber line. |
| Capture definitively refused | `uncollected`: "Sold in Mindbody, but the card was NOT charged." in `--stop`, and a reconciliation row. |
| Server restart | Rows decide. `created`, `collecting`, `authorized`: release. `selling`: the ambiguous case, and a replayed checkout finds the row already claimed and can never sell twice, which T113's in-memory store alone could not promise. `sold`: capture retried. |

### First version: supported and refused

**In the first version (Pete, 2026-11-15: splits and tickets for several
people are not deferred):** a cart with a named client or the house client,
with a discount, a promotion code, an override or a substitution, from the
Cart screen and the roster's "Pay and check in", and:

- **Split tenders** (T233): the reader pays its share, entered on the
  existing keypad, beside cash, account credit or a gift card. Mindbody
  records every payment on a cart in ONE checkout, so it is still one hold,
  one checkout carrying the Custom payment beside the others, then one
  capture.
- **T90 tickets with lines for other people** (T234): one hold for the whole
  ticket, one Mindbody checkout per recipient as today, and a capture of
  exactly what stood. A second cart refused after the first stood captures
  only the first (`amount_to_capture`, U) and the rest of the hold is
  released.

**Gift cards** (T232), by whichever route probe R5 opens, in this order:

1. `purchasegiftcard` paid with the Custom payment directly (R5a), if
   Mindbody accepts it there. It already refuses Comp, so this is a real
   question.
2. Otherwise **Pete's own workaround, which the studio already does by
   hand**: sell the purchaser account credit on the reader
   (`purchaseaccountcredit` paid with Custom, R5b), then pay for the gift
   card from that credit (`purchasegiftcard` paid `DebitAccount`, R5c). It
   is the pattern the counter's under-$10 card path used until T238 retired
   it (credit first, then spend; `purchaseCredit` in `src/lib/sale.ts` is
   kept, unreached, for this), so nothing about it is new to Mindbody or to
   this app. Its limits: it
   needs a NAMED purchaser, never the house client, whose credit belongs to
   nobody; it records a credit purchase and a credit redemption rather than
   a card sale, which is the reporting cost the design doc's "$10 card
   minimum" section warns about, accepted here because the studio already
   books gift cards this way by hand; and its two calls cannot be atomic, so
   a gift card refused AFTER the credit stood captures the hold for the
   credit, leaves it on the purchaser's account, and says so in words
   ("$50.00 is on Sam's account as credit; the gift card was not issued"),
   with Try again spending that credit and charging nothing new.

Refused in words before any call:

- **Memberships** (`purchasecontract`): refused for good. The request takes
  only `CreditCardInfo`, `StoredCardInfo`, direct debit or account credit
  (sale.yml:6261 on), has no slot for an outside payment, and every autopay
  after the first bills the card on file. The path stays what it is today:
  type the card once with "keep on file" and sell against it. "A membership
  bills a card on file. Add a card first."

Not refused: a small sale. Since T238 (P10, answered) the reader charges any
amount above zero, as every other card does.

### The teacher's screen

- A **Card reader** tile beside the tenders, greyed with its reason
  ("Reader offline", "Not set up", "Needs the database"). It adds one line
  for the whole amount; Charge reads "Charge $28.00 on reader". Two taps
  for the teacher, like every tender; one tap for the student.
- One hook and one panel, `src/app/useReaderPayment.ts` and
  `src/app/ReaderWait.tsx`, used by BOTH charge screens from the day they
  are written (T209's lesson).
- Panel states, 64px controls, tokens only, no typed amount anywhere:
  - "Ready for card. $28.00" with Cancel
  - "Card approved. Finishing the sale." with no control
  - "Card declined. Nothing was charged." with Try another card and Other payment
  - "Cancelled on the reader. Nothing was charged."
  - "Mindbody did not answer. The card is on hold and has NOT been charged. Do not run the card again."
- The done block names the tender: "Card reader, Visa ending 4242".
- **Customer display**: the live ticket mirror gains one line, "Tap or
  insert your card on the reader", through the existing `present`. No new
  write path.
- **T203**: recommended that a card presented on a reader showing the
  amount, bound to the cart sha on the row, COUNTS as the customer's
  approval, checked at the same place in `/api/checkout`. Approve on the
  iPad and then tap the card is the friction the brief rules out. It
  relaxes a recorded rail, so it waits for Pete's word (P8). Until then the
  reader tender runs through `useSaleApproval` first.

### Reconciliation, refunds and returns

- **A daily match** for the studio day, in `readerrecon.ts`: our rows,
  Stripe's PaymentIntents, and Mindbody's `/sale/sales` filtered by
  `request.paymentMethodId` (sale.yml:1043, probe R4).
- **Mismatch kinds**: a sale with no capture, a capture with no sale,
  amounts that differ, a hold older than an hour, a Mindbody return with no
  Stripe refund, a Stripe refund with no return, and a Mindbody sale on the
  reader's payment method that this app did not make.
- **Where it shows**: an admin "Card reader" sheet behind the account modal
  (`POS_ADMIN_STAFF_IDS`), NOT the dev drawer, which is off on the deployed
  counter. A gold count in the header when anything is open. Yesterday is
  run on the first sign-in of the day; the app has no worker and gains
  none. Immediate mismatches are on the teacher's done block as above.
- **Returns**: a return in Mindbody records the return and moves no money.
  The refund is made in Stripe (the sheet shows each sale's PaymentIntent
  id), and the daily match catches a forgotten one. A PIN-gated refund
  button is T235, with its own seventh `CompPurpose`.

### Reader setup

- Pete creates the Stripe account, one Terminal Location at the studio
  address, and registers the reader from its pairing code in the Dashboard
  (U). `scripts/reader-status.ts` lists readers and their state.
- One reader, one location. The reader id is environment configuration; a
  drawer chooser is not built until a second reader exists.
- The reader talks to Stripe over its own wifi or ethernet, not to our
  server, so Railway hosting needs nothing on the studio LAN.
- Recommended: the S700 over a second WisePOS E. Two identical readers on
  one counter, one of which this app cannot drive, is a mistake waiting for
  a queue.
- Test mode: a simulated reader (`registration_code: simulated-wpe`) and the
  `present_payment_method` test helper (U), behind devtools-gated "Simulate
  tap" and "Simulate decline" buttons that refuse in live mode.
- **Costs, from third-party sources only (2026-11-15; stripe.com was not
  reachable to confirm):** about 2.7% + 5c per in-person transaction, +1.5%
  for international cards, $15 per dispute; an S700 at $299 or $349
  (sources disagree), an optional $49 dock; a WisePOS E around $249 and
  possibly no longer sold in the US; no monthly or per-reader fee found.
  Confirm on stripe.com/terminal and stripe.com/pricing before ordering.

### Work items

- [ ] **T222 Probes R1, R2, R3 and R5**, `scripts/probe-custom-payment.ts`
  (written 2026-11-15, not yet run; needs P7's method to exist). Done when
  it has been run on both sites and the answers are recorded in the probe
  table.
- [ ] **T223 The Stripe client and the mode.** `stripe.ts`, the call log's
  `service` field, the environment table, the `livemode` assertion,
  `/api/config`, the `modeNotice` state. Done when a reader read shows in
  the drawer tagged stripe, and a response with the wrong `livemode` is
  refused with nothing created.
- [ ] **T224 The fake and the row.** `scripts/training/fake-stripe.mjs`,
  migration 19, `readerpayment.ts` with compare-and-set transitions. Done
  when the transitions are driven end to end against the fake with no
  network.
- [ ] **T225 Collect, poll, cancel.** The three routes and the 90 second
  timeout. Done when a simulated tap moves a row to `authorized`, and
  cancel, decline and timeout each end `cancelled` with the PaymentIntent
  reading `canceled`.
- [ ] **T226 `method: "reader"` in `/api/checkout`.** The Custom variant,
  the claim, the single-exit capture or release, the refused shapes. Done
  when a sandbox sale stands with a captured test PaymentIntent linked to
  it, and a forced Mindbody refusal leaves the PaymentIntent cancelled.
- [ ] **T227 The Cart screen.** Tile, hook, panel, done block. **Done when a
  teacher sells a drop-in in the sandbox on Stripe's simulated reader, end
  to end, with no hardware.**
- [ ] **T228 The failure windows.** Ambiguous resolution, the sweep,
  restart recovery, reload, second iPad. Done when each row of the failure
  table is forced against the fake and ends as written, including a kill
  between `selling` and capture.
- [ ] **T229 Pay and check in.** The roster dialog through the same hook.
  Done when an unpaid row is paid on the simulated reader and checked in,
  and closing the dialog mid-wait releases the hold.
- [ ] **T230 Customer display and the approval rule.** The reader line on
  the mirror; P8's answer built. Done when the student's iPad shows the
  prompt, and the approval setting behaves as Pete chose on both screens.
- [ ] **T231 Reconciliation.** The match, the admin sheet, the header
  count. Done when a day with one planted mismatch of each kind lists all
  of them and a clean day lists none.
- [ ] **T232 Gift card sales on the reader**, by the route R5 opens (direct,
  or credit then `DebitAccount`). Done when a card is sold in the sandbox
  with `Value` and `AmountPaid` asserted, exactly the right amount captured,
  and, on the credit route, a forced gift card refusal leaves the credit on
  the account with the sentence above.
- [ ] **T233 Split with a reader leg (first version).** Done when reader plus
  cash stands as one sale, and a refusal releases the hold and takes no
  cash.
- [ ] **T234 T90 tickets (first version).** Done when two recipients' carts
  stand on one hold, and a refused second cart captures only the first.
- [ ] **T235 Refund on card.** Admin, PIN, its own purpose. Done when a test
  capture is refunded from the sheet and the match clears.
- [ ] **T236 Webhook hardening**, only if polling proves thin.
- [ ] **T237 Hardware day.** Register the reader, live key,
  `POS_READER_LIVE=true`, write guard on the dummy client. Done when Pete's
  own card buys the cheapest item, the sale reads back from Mindbody with
  the reader's payment method, the PaymentIntent is captured, both are
  refunded and voided, and the next day's match is clean. Then the training
  guide and `DEPLOY.md`.

T222 to T227 are the path to a working flow before hardware arrives. T233
and T234 belong to the first version and come straight after T229, before
the reader goes live (T237); T232 follows as soon as R5 has answered.

### Rails this phase moves

Each of these is written down in CLAUDE.md or the design doc today and is
changed by the item that builds it, in that item's own commit:

1. **"Nothing auto-charges"** and the display's "nothing runs on the
   server's own initiative": the sweep retries a capture and releases holds
   with no tap. Neither is a new charge and neither touches Mindbody, but it
   needs a recorded exception (T228).
2. **T203**: a charge carries a `displayApprovalId` or a PIN token. P8
   would add a third (T230).
3. **T113**: the idempotency store is deliberately not in Postgres. The
   reader needs a durable row to START, never to finish (T224, T226).
4. **The charter's "runs fully without `DATABASE_URL`"**: the reader tender
   does not; everything else still does (T224).
5. **T103**: "it cannot un-take the payment." On the reader it can, so the
   sold-nothing sentence and its client note need their own words for this
   path (T226).
6. **`modeNotice`'s "exactly four states"**: a fifth, loud, as the rule
   itself asks (T223).
7. **Option C's two outcomes** gain a third, hold kept while Mindbody's
   answer is unknown (design doc updated with this plan).
8. ~~**T93's $10 floor** "does not care whose card it is": at odds with the
   lost-sale brief until P10 is answered (T226).~~ Moved already: T238
   retired the floor on every card path, so T226 has none to apply.

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
