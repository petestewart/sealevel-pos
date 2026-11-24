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
| P6 | The Square account: legal entity, bank account for payouts, who holds the login; and a Square developer application for the sandbox and production access tokens | T223, T237 | Phase 4, on Square since 2026-11-21 |
| P7 | ~~The custom payment method~~ **Done on 471 (2026-11-22): "Square Terminal", id 18** (`MINDBODY_PROD_READER_PAYMENT_ID=18`). Still owed: one on the sandbox site | T222 | Named for Apple Pay and Google Pay too, not just cards |
| P8 | Does the card tapped on the reader count as the customer's approval (T203)? | T230 | Recommended yes: approve-then-tap is the friction the brief rules out |
| P9 | Tipping on the reader? | T225 | Recommended none; a tip changes the held amount |
| P10 | ~~Does the $10 card minimum apply to the reader?~~ **Answered (Pete, 2026-11-15, T238): any amount, on the reader too.** The floor is retired everywhere | T226 | A $3 water by tap is the kind of sale being lost |
| P11 | Receipts: Mindbody's email only, or Square's printed or emailed receipt as well? The Terminal has a printer | T226 | |
| P12 | The statement descriptor | T237 | Ideally matching what Mindbody Payments shows |
| P13 | Who reconciles, who refunds, and where do they hear about a mismatch off the counter? | T231, T235 | |
| P14 | ~~S700 or a second WisePOS E?~~ **Moot (2026-11-21): Square Terminal.** | T237 | |
| P15 | The card processing fee on card sales under $10. **Decided 2026-11-23 and built as T297** (Pete: "add a feature to automatically add a credit card processing fee of 2.6% to credit card purchases under $10. we already have a sign at the front desk"; all card methods; skip on reader debit) | Pete: create the $0.01 tax-exempt product, set `POS_CARD_FEE_PRODUCT_ID` | See T297 |
| P16 | Where do incident alerts and diagnoses reach you? Recommended: one private Slack channel, GitHub issues as the record | T263, T264 | Phase 5 |
| P17 | Which Claude account runs the investigator's sessions, and the monthly ceiling | T264 | Estimated $30 to $80 in a normal month |
| P18 | Who may tap a one-tap repair: you alone, or anyone in `POS_ADMIN_STAFF_IDS`? | T269 | |
| P19 | When the second check disputes "nothing was sold" at the moment it happens, may the counter show an amber "We are checking this sale. Do not charge again." and hold off writing on the student's Notes until the check returns? | T267 | Changes what a rail says to a teacher |
| P20 | Client first name and last initial in Slack and GitHub, or ids only? And is incident evidence (ids, sale contents, first names, never cards) passing through a hosted agent session acceptable, as it does when you ask one by hand? | T264 | |
| P21 | May the app take back its own false note and hold with no tap, on two keys, once T265's rehearsal has passed in front of you? | T265's last box | Ships as `propose` until you say so |
| P22 | Should the agent be able to search Railway's logs? Needs a log drain, never the Railway token (it reads every secret) | Nothing yet | Recommended: not until an incident proves the trail was not enough |
| P23 | Should a retraction leave anything on the student's Notes? | T265 | Recommended: nothing; the incident and the audit row are the record |
| P24 | In an outage, keep the shelf only in memory (a server restarted during an outage has no shelf), or allow a last-known catalog in the database for outage use only, which is a copy of Mindbody's prices the charter forbids today? | T275 | Recommended memory only first; revisit if a restart mid-outage ever happens |
| P25 | A queued outage sale whose teacher has signed out: post it as the service account, naming the teacher on the client? | T277 | Recommended yes; the alternative is a queue that waits for that teacher to sign in again |

## Probes to run

Cheap, and each one removes a guess. All are read-only or `Test: true`.

| # | Probe | Answers | Status |
|---|---|---|---|
| B1 | `POST /sale/checkoutshoppingcart` with a candidate price/discount key in item `Metadata`, `Test: true`, compare returned total | Whether the POS can set a cart price directly. If yes, the $21 SKU is unnecessary | **Mostly answered from the spec (2026-08-30): CheckoutItemWrapper.DiscountAmount discounts a cart line directly, so the $21 SKU is unnecessary. One Test: true probe still owed for quantity semantics and permission gating; see TICKETS.** |
| B2 | `GET /sale/alternativepaymentmethods` with `LocationId=98` | The HTTP 400 that gates all Apple Pay scoping | Not run. **Deprioritised 2026-11-15**: counter Apple Pay is Phase 4's reader, not this redirect flow. A script exists if it is wanted (T255, Pete asked for Apple Pay 2026-11-09): `scripts/probe-applepay.ts`, read-only by default; `--initiate <clientId> <productId>` adds a `Test: true` initiate in each plausible Payments shape |
| B3 | Re-run `mindbody:probe-payments --live` against a client with a current card | Whether a charge actually settles through Stripe. Only ever reached "card is expired" | **Answered by use (Pete, 2026-11-15)**: the counter has charged stored cards live for months, and typed cards in testing. Open only for T238's under-$10 charge |
| B4 | Confirm a per-client Mindbody-hosted card capture page exists and is reachable by URL | Whether Phase 3 card capture is buildable at all | Not run |
| B5 | `scripts/probe-promo-code.ts <client> <code> <option> --create 28`: makes a throwaway one-use code, prices the cart without it and with it twice, deactivates it | Whether Mindbody honours a promotion code on the rehearsal, whether SubTotal stays pre-discount, its refusal wording, and whether pricing spends a one-use code | **Answered, prod, 2026-11-14 (Pete, dummy client 100042041).** An inactive code: 4xx "Promotion code is not active.", repriced without it. A valid one-use code for 581: HONOURED on `Test: true`, $49.00 -> $21.00, DiscountTotal $28.00, SubTotal $49.00, T75 agreeing; priced twice, applied twice, so pricing does NOT spend it. Along the way: `addpromocode` takes `Amount`/`Percent` while the list reads `FlatRate`, and answers `PromotionID: 0` |
| B6 | `scripts/probe-giftcard-free.ts <clientId>` | Whether ANY zero payment makes `purchasegiftcard` issue a card at face value, which is what a 100% discount on a gift card needs (Pete asked again 2026-11-09, T255) | Written 2026-09-19, not run |
| B7 | First, the drawer's record of the next refused gift card sale (which call, which payment, Mindbody's words). Then, if it is the tender: a `GiftCard` payment on `checkoutshoppingcart`, `Test: true`, a real barcode with a balance, once with T83's `Metadata` as a JSON STRING (what ships), once as an OBJECT `{amount, cardNumber}` | What Pete's "when finalizing a sale with a Gift card - 'missing key account' bug" (2026-11-09, T255) was: a gift card SPENT (the tender's Metadata shape) or a gift card SOLD from the account (T108, `purchasegiftcard` with `DebitAccount`), and which shape Mindbody reads | Not run. T255 claimed the string was the cause and switched to the object; the merge kept the string because no recorded call ties the refusal to the shape |
| B9 | Dummy client 100042041, write guard narrowed to it, `POS_DRY_RUN=false`, prod, from the deployed counter: $1.00 of account credit beside the cheapest retail item, paid in cash | That step 2's `DebitAccount` cart sale spends the credit step 1 just bought, the balance ends up by exactly $1.00, and Mindbody's sales list shows the two sales the done screen names (T256) | Not run. The credit-only shape is settled by the controlled run (sale 428953) |
| B8 | Dummy client 100042041, the write guard narrowed to it, `POS_DRY_RUN=false`, prod: ONE real `checkoutshoppingcart` (not `Test: true`) with two card payments, a good card (the stored card or a typed one, $1.00) beside a typed card number built to decline, for a small item. Then read `/sale/sales` for the client and look at the good card's own activity (the processor's dashboard or statement) for an authorization or a charge, and again a day later | Whether Mindbody voids card A's authorization when card B in the same checkout declines (T255 review). Until it is answered, `/api/checkout` answers a 4xx on a split with two or more card legs as AMBIGUOUS, holds the client (T253) and offers no retry | Not run |
| R1 | `GET /sale/custompaymentmethods` on 471 and on -99 | What exists, and the response key | **Answered on 471 (2026-11-22)**: the key is `PaymentMethods`; Pete created "Square Terminal" (Active, Allow >$0, Allow Refund, PayNotes "Square payment"), which reads back as `{Id: 18, Name: "Square Terminal"}` and on `/site/paymenttypes` as type 18. The sandbox site (-99) has none yet |
| R2 | `checkoutshoppingcart`, `Test: true`, a Custom payment with the new id | Whether Mindbody accepts it, and in which key casing | **Answered on 471 (2026-11-22)**: `{Type: "Custom", Metadata: {Amount: 28, Id: 18}}` for a Drop In (service 298) on dummy client 100042041 was accepted, GrandTotal $28.00, nothing moved |
| R3 | R2 with a `Notes` key carrying a Square payment id | Whether `SalePayment.Notes` (sale.yml:4557) can carry the link, which would make the match exact inside Mindbody | Not run (T222) |
| R4 | One real Custom sale for dummy client 100042041, then `/sale/sales` with `request.paymentMethodId` | How the sale reads back, whether the filter takes a custom id, how it shows in Pete's reports, and how a return of it reads | Not run (T231) |
| R5 | Three `Test: true` calls: (a) `purchasegiftcard` paid Custom; (b) `purchaseaccountcredit` paid Custom; (c) `purchasegiftcard` paid `DebitAccount` | Which gift card route the reader can use: directly (a), or Pete's credit-then-spend workaround (b then c). c asks against the client's existing balance, so "insufficient" there is about the balance, not the payment type | Not run (T222; `scripts/probe-custom-payment.ts`) |
| R6 | Square's sandbox and the real Terminal | What the docs leave open (checked 2026-11-22, see Phase 4): whether a sandbox checkout with `autocomplete: false` leaves an APPROVED payment that completes and cancels; whether a real Terminal payment carries `EDIT_AMOUNT_DOWN` (T234); pairing and `PING` on the real device (no Devices API in the sandbox); the cancel race on the real device; how a completed payment, its `reference_id` and a refund read back | **Sandbox half answered (2026-11-22, Pete's sandbox app, location LDZRV71GCET59, test device 9fa747a2...)**: a checkout with `autocomplete: false` reads COMPLETED with its payment APPROVED (VISA 1111, `reference_id` carried, `delayed_until` set from `delay_duration`), and the payment's `capabilities` include `EDIT_AMOUNT_DOWN` in the sandbox; CompletePayment and CancelPayment both work, and a second complete or cancel answers 200 with the same status (no error); a cancelled payment reads `card_details.status: VOIDED`; the buyer-cancel test device ends CANCELED `BUYER_CANCELED`; a pending checkout cancelled ends `SELLER_CANCELED`, and a second cancel answers 200. The app itself ran a full reader sale against the sandbox (hold, Mindbody sale on the fake, captured) and cancelled an approved hold (VOIDED). Still owed on the REAL Terminal: pairing and PING, the cancel race, and whether a card-present payment carries `EDIT_AMOUNT_DOWN` |
| A1 | Fire the investigator's scheduled task from the Railway service with a throwaway incident id | The fire endpoint and token shape, reachability from Railway, seconds from fire to the session's first tool call, any daily cap on fired runs | Not run (before T263 is done) |
| A2 | From the investigator's cloud environment: call this app with no token in hand, and call `api.mindbodyonline.com` | That the environment's proxy attaches the agent token so the session never sees it, and that Mindbody is unreachable from there | Not run (T262, T264) |
| A3 | An unattended fired session posts to the alert channel, opens an issue and pushes a branch | That the connectors and the repo grant work with nobody watching | Not run (T264) |
| A4 | Dummy client 100042041, write guard narrowed to it: file a T62 note, then `updateclient` with that one entry removed | That Mindbody accepts shortened Notes, and what a blank one reads back as | Half answered (T254's cleanup, prod, 2026-11-17): `updateclient` with `Notes: ""` through `updateClientAudited`, write guard narrowed to client 100036799, was accepted and read back as `""`, so a blank is accepted and reads back blank. A SHORTENED note (one entry of several removed) is still unseen |
| A5 | Read back a sale mixing a pass, a retail product and a discount, and one paid by split tender | Whether item amounts, payments and our paid figure agree to the cent in each shape, tax included: the witness's money check | Not run (T261) |

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
2.6% card processing fee on card sales under $10 is T297 (P15), off until
its product id is set. What follows is the plan as it was
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
- [x] Live on site 471 (Pete, 2026-11-09): configured in the drawer as
  course 743, and a real sale of the sound bath pass signed the buyer up.
  743 IS the course (enrollment) id from Mindbody's workshop URL. The
  first try booked nobody because no rule was saved: the feature does
  nothing until a row exists, and nothing on screen says so.
- [ ] Still unseen: whether Mindbody spends the sold pass on the
  enrollment (the request carries no `ClientServiceId`).

**Pete's counter list, 2026-11-09 (T255; written as T219 on its branch, renumbered when it met main's T219):**

- [x] Item search on the cart screen, over the loaded catalog and gift cards, no Mindbody call.
- [x] A sale split across up to four parts: the saved card and any number of typed cards beside the account, cash and a gift card, in one checkout call. Each card leg is charged exactly what it pays (T238: no $10 floor on any leg). A refusal of a split with two or more cards is held as ambiguous until B8 says what a decline does to the other card.
- [x] A payment line taken for the whole sale follows the total through a discount instead of having to be chosen again.
- [x] Account credit on the Cart screen (T256, Pete 2026-11-18): a keypad amount, alone or beside ordinary lines, one tender (cash, card on file, typed card) through `purchaseaccountcredit`; a mixed ticket buys credit for the whole total and pays the lines from the account. Owed: one real mixed sale on the dummy client (B9).
- [ ] The gift card tender's "missing key account" refusal at Finalize: waits on B7. The merge kept T83's string `Metadata`; the object form is the by-hand thing to try.
- [ ] A 100% discount on a gift card: waits on B6.
- [ ] Apple Pay: Phase 4's reader (2026-11-15), not the B2 redirect flow.

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

## Phase 4 — the studio's own card reader (option C, on Square)

Decided by Pete, 2026-11-15: teachers report lost sales to students who can
only tap, dip or pay with Apple Pay or Google Pay. **Vendor decided
2026-11-21: Square, not Stripe** ("let's go with square"). The studio gets a
**Square Terminal** on a Square account it owns, driven server-side from
this app through Square's Terminal API, and the Mindbody sale is recorded
under a Mindbody custom payment method. Reasoning, and why Square over
Stripe and the Terminal over the Square Stand: design doc, "The card-present
problem" and option C. Do not re-argue it here.

Rejected by name: any flow on the student's own phone, and a hand-off to
the Mindbody app as the ordinary path. **The one sanctioned hand-off** (Pete,
2026-11-21): when THIS APP is down, the teacher uses the Mindbody app and the
studio's existing reader, which records the sale in Mindbody directly and
needs nothing reconciled afterwards. The Square Terminal is only ever
driven from this app; it is never switched to Square's own POS app.

**Square's docs were checked on 2026-11-22** (the docs and the API hosts
are now allowed in the cloud environment; every claim below was read in
Square's own developer documentation, nothing yet observed against the
API). What they settled, and what they corrected in the first draft of
this plan:

- **Pairing** is as planned: `POST /v2/devices/codes`
  (`product_type: TERMINAL_API`), five minutes unused, then `PAIRED` with
  the `device_id` (the Terminal's serial), typed through the "Device Code"
  button on the Terminal's sign-in page. **There is no API to unpair or
  sign a Terminal out**: that is done on the device (Settings > Sign
  Out). **The Devices API does not work in Square's sandbox**, so pairing
  and device status are tested on the real Terminal only. A Terminal is
  paired to this app OR running Square's POS app, one at a time.
- **The hold** is as planned: `payment_options.autocomplete: false`, then
  `CompletePayment` or `CancelPayment`, at most 36 hours (send `PT35H` or
  less, one page says "less than"), `delay_action` CANCEL by default.
- **A checkout reads `COMPLETED` while its payment is only `APPROVED`**
  when autocomplete is off, so the state machine reads the PAYMENT, never
  the checkout's status, to know whether a hold exists.
- **A cancel can lose the race to the tap**: a cancelled checkout can end
  `COMPLETED`, and a timed-out one can read `CANCELED` and later turn
  `COMPLETED`. So every cancel is followed by a read of the checkout's
  `payment_ids`, and any approved payment found is cancelled with
  `CancelPayment` (the release path), for as long as the sweep looks.
- **`deadline_duration` is deprecated**, with a default and a maximum of
  five minutes; our own 90 second wait is the timeout that matters.
- **No `amount` on `CompletePayment`.** Taking less than was approved
  means `UpdatePayment` first, which works only when the payment's
  `capabilities` include `EDIT_AMOUNT_DOWN`, and "UpdatePayment requests
  aren't guaranteed to succeed". Unseen for a Terminal payment: R6, and
  T234 depends on it.
- **Never call the Dismiss endpoint** on a hold: it "attempts to capture"
  an authorized payment.
- **The US card minimum is $0.01**, not $1.00 ($1.00 is Afterpay's). No
  floor is needed on the reader.
- **The sandbox** answers Terminal checkouts on special test device ids;
  they approve at most $25 (anything larger stays PENDING until it times
  out), and there is no plain decline id. A sandbox checkout with
  `autocomplete: false` DOES leave an APPROVED payment that completes and
  cancels (R6, 2026-11-22).
- **Smaller points**: `idempotency_key` is required on a checkout and
  limited to 64 characters (128 on a device code, 45 on an update or a
  refund, so one key format must fit 45); the checkout's `reference_id`
  and `note` carry onto the payment; `Square-Version` is optional and
  pinned here to `2026-11-18`; a personal access token from the developer
  console is fine for our own account, sent as `Authorization: Bearer`;
  device status from the Devices API can be 15 to 30 minutes old, while
  the Terminal's `PING` action answers live (`device:<serial>` there,
  the bare serial on a checkout); a paired Terminal cannot use an
  external printer, takes no cash and cannot split a checkout; refunds
  take an idempotency key, may be partial, within a year, up to 20 per
  payment, and only on a COMPLETED payment (an approved one is
  cancelled instead); webhooks (`terminal.checkout.updated`) can arrive
  twice or out of order. US fees on the Terminal: 2.6% + 15c card
  present, 3.5% + 15c keyed. Square offers a US "Auto Card Surcharge"
  (Beta), which bears on P15.

Full notes with the doc URLs: kept with the session's research, and
re-checked by R6 before T225 is called done.

**When the reader works, remove the student-typed card (T241).** Pete,
2026-11-17, on students typing their own card on the customer iPad: "i
think we can keep that for now and remove it once we actually have
stripe" (the reader, now Square's). It sits behind the `display_typed_card`
setting (default on, `POS_DISPLAY_TYPED_CARD` without a database) so he can
turn it off sooner. Once the reader is live, delete the feature with its
setting: `src/app/display/CardForm.tsx`, `/api/display/card`,
`src/lib/displaycard.ts`, the `typedcard` choice and checkout's
`displayCard` path. "A different card" then becomes the reader's "tap your
card".

### The order of work

1. **T274, the transaction log, first.** Every money tap on every route
   gets a durable row (below). The reader's attempt, the outage queue and
   the daily check all hang off it, and it is worth having before any of
   them: it is how we see what Mindbody actually recorded.
2. T222 to T229, the reader on the ordinary path, to a working flow on
   Square's sandbox before hardware.
3. T233, T234, the first version's splits and T90 tickets.
4. T275 to T278, outage mode and its queue.
5. T237, hardware day, then T231, T232, T235.

### The transaction log (T274)

Pete, 2026-11-21: "for a queue, we will need a DB to store records of what
needs to be processed in MB anyway. so we should just log every transaction
to the DB. that gives us observability and insight to verify MB is
recording what we want it to, and identify and fix bugs more easily."

- **One `sale_log` row per money tap**, keyed by T113's idempotency key
  (a server-minted id when a tap has none), on every route that moves money
  or sells: `/api/checkout` in all its shapes (cart, split, T90 tickets,
  gift card, account credit, no-charge credit), `/api/purchase-contract`,
  `/api/guest`'s $0 comp, the reader's attempts and the outage queue.
- **Written AHEAD of the Mindbody call and updated as the tap moves**, the
  `charge_holds` way (`upsert` by id, one write after another per row):
  `started`, then the outcome. A row stuck at `started` is itself evidence.
- **Holds**: what we ASKED (client ids and UniqueIds, each line's type, id,
  quantity, unit price and T90 recipient, discount and its reason, promotion
  code, each tender as method and amount, the cart sha), what Mindbody
  ANSWERED (sale ids, SubTotal, tax, GrandTotal, AmountPaid, the basket
  audit's verdict, the refusal sentence), the outcome in the route's own
  words (`stood`, `refused`, `ambiguous`, `sold-nothing`, `partial`,
  `suppressed`, `queued`), the Square payment id and last four when the
  reader paid, the staff id, target, site, dry run and write guard state,
  and the time of each step.
- **Never holds**: a card number, CVV, expiry, gift card number, PIN or
  token, or any long digit run in free text (struck, as `charge_holds` does).
- **The check.** Once a day (the first sign-in of the day, as T231 planned;
  the app has no worker) and on demand, every `stood` row of the studio day
  is read back from Mindbody by sale id and compared line for line and
  payment for payment with what we asked. A difference is a row on the
  admin sheet. This is T103's and T254's lesson made routine: what the
  route believed and what Mindbody kept are compared every day, not only
  when a teacher notices.
- **Where it shows**: the admin "Sales" sheet behind the account modal
  (`POS_ADMIN_STAFF_IDS`, since the dev drawer is off on the deployed
  counter): the day's taps, each outcome, the check's differences, and a
  gold count in the header when one is open. Phase 5's incidents read the
  same rows.
- **Charter**: this is our record of our own actions, the `client_writes`
  and `charge_holds` precedent, never a copy of Mindbody consulted instead
  of Mindbody. Nothing reads a price, a client or a pass from it to answer
  a question Mindbody should answer.
- **A database that does not answer never blocks a sale.** The row logs
  `NOT STORED` every time, as `client_writes` does, and the sale runs. Two
  exceptions, because each needs the row to work at all: the reader needs
  a row to START a sale (never to finish one), and the outage queue IS rows.

### The money order

Hold, sell, take.

1. Price and `Test: true`-rehearse the cart exactly as today. The rehearsed
   GrandTotal is the only amount ever sent to Square.
2. Create a Terminal checkout (`POST /v2/terminals/checkouts`) for that
   total on the studio's device, with `payment_options.autocomplete: false`
   so the tap places a hold (the payment reads `APPROVED`) and takes
   nothing. Tipping off, the receipt screen per P11, `reference_id` the
   attempt id.
3. Run the real `checkoutshoppingcart` with a `Custom` payment.
4. The sale stands (T75 and T103 included): `CompletePayment`. Mindbody
   refuses: `CancelPayment`.
5. **Mindbody does not answer: keep the hold.** Neither complete nor cancel
   is safe blind, so the server reads `/sale/sales` for the sale, and a
   human decides if the read cannot. This is the one tender that can still
   go either way safely after an ambiguous answer.

A delayed payment must be completed or cancelled within Square's limit,
36 hours (we send less than that), and Square applies `delay_action`
(CANCEL by default) when it lapses. The sweep (below) acts long before; the lapse is
the backstop for a server that died holding one.

The other two orders are worse. Taking the money first turns a Mindbody
refusal into a refund (fees, a visible charge, days to return). Mindbody
first leaves a declined card with a non-comp sale the API cannot return
(`returnsale` is comp-only).

**Outage mode is the exception**: there is no Mindbody to sell against, so
the payment is completed at the tap and the Mindbody sale is queued (see
below).

### Architecture

- **`src/lib/square.ts`**, beside `mindbody.ts`: plain `fetch`, JSON, no
  Square SDK, nothing imported from ai-manager. The call log must show
  exactly what was sent, and the proxy can inject the token. Every create
  carries Square's own `idempotency_key`, derived from the attempt id.
- **Only `src/lib/readerpayment.ts` (the state machine), `src/lib/outage.ts`
  (the queue) and `src/lib/readerrecon.ts` may import it.** `sale.ts` never
  does. Same shape as the display's "imports no `mindbody()`" rule.
- **Call log.** Each Square call goes through `record()` in `calllog.ts`
  with a new `service: "square"` field and a tag on the drawer row.
  Suppressed and refused-by-mode calls are recorded like dry-run ones. No
  card number reaches a Terminal API response (a Terminal payment carries
  brand and last four only; R6 confirms on the real device).
- **The seam is the `CheckoutPayment` union** and `checkoutPaymentPayload`
  in `sale.ts`. It gains one variant, `{ type: "Custom"; amount; id }`,
  sent as `{ Type: "Custom", Metadata: { Amount, Id } }` (sale.yml:3934),
  the shape T259's "Other" payment already proved live for
  `purchaseaccountcredit`.
- **One exit for the Square side.** `/api/checkout` has about a hundred
  return points, so the complete-or-cancel decision sits in `POST()` at the
  single exit, beside `enrolAfterCheckout` and inside T113's record. No
  branch can forget to release a hold. An outside tender has three verbs:
  hold, take, release.
- **No webhook in v1.** The browser polls our server each second (the
  `useSaleApproval` precedent) and the server reads the checkout and the
  payment. No public endpoint, no signing secret, works on localhost. A
  webhook (`terminal.checkout.updated`, U) is T236.

### Modes and safety

| Mindbody state | Square |
|---|---|
| Dry run (server or this iPad), or the write guard suppressing this client | The rehearsal is suppressed, so Square is never called. Amber answer as today, plus "The card reader was not used." |
| Target sandbox | Square's sandbox (`connect.squareupsandbox.com`) always. The production token is never read. |
| Target prod, `POS_READER_LIVE` unset | Square's sandbox. Reader sales refused unless the write guard narrows to a dummy client: a simulated tap must never hand a real student a pass. |
| Target prod, `POS_READER_LIVE=true` | Production Square. A deliberate deploy, like `POS_DRY_RUN=false`. |

- **The environment is asserted**, since Square answers carry no
  `livemode`: the base URL and the token come from one named set, and at
  startup and on every checkout create the location id Square answers with
  must equal the configured location for that set. A mismatch refuses the
  sale with nothing created.
- **`modeNotice` gains one LOUD state**: target prod with the reader on
  Square's sandbox ("Card reader is in TEST mode. Reader sales take no
  money."). The tile wears a TEST tag and the done block says so. Outage
  mode adds a second (below). `/api/config` reports `reader: { configured,
  mode, paired, online, label }`.
- **Target switch (T89)**: each attempt records target and site. A switch
  releases open holds, and `/api/checkout` refuses an attempt from the
  other studio.
- **Environment** (never committed; a dummy is enough where the proxy
  injects): `SQUARE_SANDBOX_ACCESS_TOKEN`, `SQUARE_PROD_ACCESS_TOKEN`,
  `SQUARE_SANDBOX_LOCATION_ID`, `SQUARE_PROD_LOCATION_ID`,
  `POS_READER_LIVE`, `MINDBODY_SANDBOX_READER_PAYMENT_ID`,
  `MINDBODY_PROD_READER_PAYMENT_ID`, and `SQUARE_API_BASE_URL` for the fake
  only, like `MINDBODY_API_BASE_URL`. The paired device id lives in
  `app_settings` (it changes when the Terminal is re-paired), with
  `SQUARE_DEVICE_ID` as the no-database fallback.
- Nothing about the reader's MODE is settable from the drawer. Pairing is
  (below): it decides which Terminal, never whether money moves.
- **The whole reader is behind a switch** (Pete, 2026-11-22: "the square
  functionality should be behind a flag"). `card_reader` in
  `app_settings`, **DEFAULT OFF**, with `POS_CARD_READER` as the
  no-database fallback (only `true` or `1` turn it on), an admin-only
  64px control in the drawer's Settings tab, the log naming the staff id,
  read and stored the way T241's `display_typed_card` is (a store that
  goes quiet keeps the last answer it gave; here the environment's
  answer is the safe one, off). Off, the SERVER refuses `method:
  "reader"`, every `/api/reader/*` route and "Connect card reader" with
  one sentence and nothing sent to Square; the Card reader tile, the
  reader line on the customer screen and the outage mode's Terminal
  tender are not drawn; and every other tender is exactly as it is
  today. Turning it off with a hold open does not strand the hold: the
  sweep still releases or completes it, since that is cleaning up, not
  starting a sale. It is a fifth recorded Settings exception only in the
  sense T207's is: it can only REMOVE a way to pay. Built in T223, before
  any reader route exists.

### Pairing and reconnecting the Terminal

Pete, 2026-11-21: make reconnecting easy for a teacher.

- **"Connect card reader"**, in the display mark's Options menu and the
  account modal, any signed-in teacher: the server asks Square for a device
  code (`POST /v2/devices/codes`, `product_type: TERMINAL_API`, the studio
  location, U), and the screen shows it in large digits with a five minute
  countdown and "New code" (Square expires an unused code after five
  minutes). The teacher taps Device Code on the Terminal's sign-in screen
  (not "Sign in", which is Square's own POS app, U) and types it. The
  server polls the code until it reads `PAIRED`, stores the device id, and
  the screen says "Card reader connected". Logged with the staff id.
- **The reader tile says when it is not paired or offline**, so nobody
  charges into nothing. Whether Square reports a Terminal's online state
  through the Devices API lags 15 to 30 minutes, so the tile asks the
  Terminal's `PING` action, which answers live; if that cannot answer, the
  first checkout's refusal is the signal.

### The state machine

One `reader_payments` row per attempt, linked to its `sale_log` row.
Mindbody has no home for a Square-payment-to-sale link, so the T29 charter
allows it.

- **Holds**: attempt id, tap key digest, state, target, site, staff id,
  device id, client id, cart sha (`cartsha.ts`), amount in cents, Terminal
  checkout id, Square payment id, Mindbody sale id and cart GUID, brand and
  last four, failure text, timestamps.
- **Never holds**: a card number, expiry, fingerprint, cardholder name, or
  any Mindbody price or line (those are on the log row, as what we asked).
- **The database is required to START a reader sale and never to FINISH
  one.** No database: the tile is disabled with a reason and every other
  tender works. A row write failing mid-flow logs `NOT STORED` and the sale
  carries on. The checkout's `reference_id` and the payment's `note` carry
  the attempt id as the fallback journal (Square carries both onto the
  payment).

States: `created → collecting → authorized → selling → sold → captured`,
with `cancelled`, `unresolved` and `uncollected` as the other ends. Every
transition is a compare-and-set, so two iPads or a replay cannot both sell.

Routes, all behind the device session and `requireActor`:

| Route | Does |
|---|---|
| `POST /api/reader/collect` | Takes the checkout body and the tap's `Idempotency-Key`. Refuses unsupported shapes (below), verifies PIN tokens WITHOUT spending them, checks the reader is paired and free, rehearses, creates the Terminal checkout with `autocomplete: false`. |
| `GET /api/reader/attempt/:id` | The 1 second poll and the heartbeat. Reads the checkout and its payment, moves the row. |
| `POST /api/reader/attempt/:id/cancel` | Cancels the Terminal checkout, then the payment if one was approved, then confirms both read cancelled. |
| `POST /api/checkout` with `method: "reader"`, `reader: { attemptId }` | Same tap key. Every existing rail runs unchanged (tokens spent, T203, rehearsal, T75). Then it claims the row `authorized → selling` and sells with the Custom payment under the teacher's token. |
| `POST /api/reader/attempt/:id/resolve` | The human decision on an `unresolved` hold. |

Before the claim, `/api/checkout` checks the row against the request: same
teacher, target, client and cart sha; the amount equals the fresh rehearsal
to the cent; Square says the payment is `APPROVED` for that amount.

Failure windows:

| Window | What happens |
|---|---|
| Rehearsal refuses, or totals disagree | Nothing created. |
| Reader offline, unpaired or busy | Refused in words. A second iPad reads "The reader is busy with another sale." One open collection per device, by partial unique index. |
| Customer cancels, card declines, 90 seconds with no card | Checkout cancelled, then its `payment_ids` read: a cancel can lose the race to a tap, so any approved payment found is cancelled with `CancelPayment` before the screen says "Nothing was charged." No PIN was spent, so Try again is a fresh tap. |
| Authorized, browser never returns | A hold with no Mindbody attempt older than 3 minutes is released by an in-process sweep (Square calls only, never a Mindbody write). |
| Reload mid-flow | The cart is browser state and is gone. On load, an open `collecting` or `authorized` attempt for this teacher is released with one sentence. `selling` or `unresolved` reopens the resolution panel. |
| Any refusal after the tap (token, approval, drift, Mindbody 4xx, staff session gone) | The exit releases the hold and the answer adds "The card was not charged." |
| T103: the sale answered with an empty basket | NOT completed. Hold released, flagged at once as a Mindbody sale to void. T103's sentence says the payment was taken, so this path needs its own words. |
| Mindbody times out or 5xx | Hold kept. The server reads `/sale/sales` (client, reader payment method, amount, time floor, not already linked) for about 25 seconds. Found: complete. Not found: `unresolved`, with two controls after 2 minutes: "Sale is in Mindbody, charge the card" (only when the server's own read finds it, or an admin names the sale id) and "No sale, release the hold". |
| Complete does not answer | Retried three times in the request, then each minute by the sweep. Not a second charge: a payment completes once, and the tap, the card and the sale already decided it. The teacher sees the sale as done with an amber line. |
| Complete definitively refused | `uncollected`: "Sold in Mindbody, but the card was NOT charged." in `--stop`, and a row on the Sales sheet. |
| Server restart | Rows decide. `created`, `collecting`, `authorized`: release. `selling`: the ambiguous case, and a replayed checkout finds the row already claimed and can never sell twice, which T113's in-memory store alone could not promise. `sold`: complete retried. |

### First version: supported and refused

**In the first version (Pete, 2026-11-15: splits and tickets for several
people are not deferred):** a cart with a named client or the house client,
with a discount, a promotion code, an override or a substitution, from the
Cart screen and the roster's "Pay and check in", and:

- **Split tenders** (T233): the reader pays its share, entered on the
  existing keypad, beside cash, account credit or a gift card. Mindbody
  records every payment on a cart in ONE checkout, so it is still one hold,
  one checkout carrying the Custom payment beside the others, then one
  complete.
- **T90 tickets with lines for other people** (T234): one hold for the whole
  ticket, one Mindbody checkout per recipient as today, and a capture of
  exactly what stood. Square completes for less only through
  `UpdatePayment` on a payment that carries `EDIT_AMOUNT_DOWN`, which R6
  checks on a real Terminal payment; if it cannot, the hold is
  cancelled and the carts that stood are charged as one fresh tap, said so
  on the screen, or T234 ships refusing a second recipient on the reader.

**Gift cards** (T232), by whichever route probe R5 opens, in this order:

1. `purchasegiftcard` paid with the Custom payment directly (R5a), if
   Mindbody accepts it there. It already refuses Comp, so this is a real
   question.
2. Otherwise **Pete's own workaround, which the studio already does by
   hand**: sell the purchaser account credit on the reader
   (`purchaseaccountcredit` paid with Custom, R5b; T259 proved a Custom
   payment live there with "Other"), then pay for the gift card from that
   credit (`purchasegiftcard` paid `DebitAccount`, R5c). It needs a NAMED
   purchaser, never the house client; it records a credit purchase and a
   credit redemption rather than a card sale; and its two calls cannot be
   atomic, so a gift card refused AFTER the credit stood completes the
   payment for the credit, leaves it on the purchaser's account, and says
   so ("$50.00 is on Sam's account as credit; the gift card was not
   issued"), with Try again spending that credit and charging nothing new.

Refused in words before any call:

- **Memberships** (`purchasecontract`): refused for good. The request takes
  only `CreditCardInfo`, `StoredCardInfo`, direct debit or account credit
  (sale.yml:6261 on), has no slot for an outside payment, and every autopay
  after the first bills the card on file. "A membership bills a card on
  file. Add a card first."
- **Nothing else.** Square's US card minimum is $0.01, so the reader
  takes any amount above zero, as every other card does since T238.

### The teacher's screen

- A **Card reader** tile beside the tenders, greyed with its reason
  ("Reader not connected", "Not set up", "Needs the database"). It adds one
  line for the whole amount; Charge reads "Charge $28.00 on reader". Two
  taps for the teacher, like every tender; one tap for the student.
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
  approval, checked at the same place in `/api/checkout`. It relaxes a
  recorded rail, so it waits for Pete's word (P8). Until then the reader
  tender runs through `useSaleApproval` first.

### Outage mode: Mindbody down, the counter still sells (T275 to T278)

Pete, 2026-11-21: "if mindbody is down, our app could still make the sale
tho right? ... the app can still make a finalized sale like normal, why
would anything need to be typed?? ... we would change that note, this is a
scenario where we will queue. that's more reliable than hand-typed
records."

**What it is.** When Mindbody stops answering, the Cart screen keeps
working from what the server already holds, the teacher sells as normal on
the Square Terminal or in cash, and each sale goes into a durable queue
that posts to Mindbody by itself when Mindbody answers again.

- **Entering it**: the server counts Mindbody's answers. Transport
  failures, timeouts or 5xx on consecutive reads over about 30 seconds put
  it in outage; one good answer takes it out. Never a 4xx: that is
  Mindbody answering. `/api/config` reports `outage: { since }`.
- **`modeNotice` gains a LOUD state**: "Mindbody is not answering. Card
  and cash sales are saved and will be sent to Mindbody when it is back.
  Check-ins are saved too." The rule asks for exactly this: it changes
  what a tap does.
- **The shelf**: the catalog the server last read stays in MEMORY while
  Mindbody is down, past its 10 minute life, so tiles, names and prices are
  the ones the teacher saw a moment ago. It is never written to the
  database (P24). A server that restarts during an outage has no shelf and
  says so.
- **The student**: the roster for the classes around now is already in the
  browser's memory, so those students are picked as usual. Search needs
  Mindbody, so a student not on a roster is entered by name as a walk-in,
  and the queue asks a teacher to match them to a Mindbody client when it
  posts (a retail-only ticket may go to the house client instead).
- **Tenders**: the Square Terminal and cash only. The account, a gift card,
  the card on file and a typed card all need Mindbody and are greyed with
  the reason. A discount still takes the teacher's PIN (the PIN check is
  ours, `teacher_pins`). A promotion code is refused: only Mindbody can
  judge it.
- **Tax**: Mindbody normally prices the cart. In outage the server applies
  the studio's location tax, read from the location while Mindbody was up
  (10.35% at location 1), to the lines the catalog marks taxable, rounded
  per Mindbody's own rounding as best we know it. When the sale posts,
  Mindbody's own total is compared to what the student paid.
- **The money**: on the Terminal the payment is completed at the tap
  (`autocomplete: true`): there is no Mindbody sale to wait for, and a
  hold left open across an outage of unknown length is worse than a
  rare refund. Cash is cash.
- **Check-in**: a check-in tap during an outage is queued too, behind any
  queued sale for that student, so a student who just paid for their pass
  is checked in once the pass exists. The roster row reads "Queued".
- **Sign-in**: a teacher already signed in stays signed in; a new sign-in
  needs Mindbody and cannot happen. The gate says so.

**The queue (`outage_queue` rows, linked to `sale_log`).**

- Each row holds what the log row holds (the ticket as asked, the Square
  payment id or "cash", the amount actually taken, the staff id) plus its
  state: `queued → posting → posted`, with `needs-a-teacher` and
  `refunded` as the other ends. No card data.
- **No database, no outage mode**: the queue IS rows. The tile and the
  banner say "Mindbody is down and sales cannot be saved; use the Mindbody
  app." A row write that fails refuses the sale BEFORE the card is
  charged.
- **Posting**: when Mindbody answers again, the server posts the queue in
  the order the sales were made, one at a time, through the same
  `checkoutshoppingcart` path every sale takes, paid with the reader's
  Custom payment method (or Cash), rehearsed first. Each post is a
  compare-and-set claim, so two iPads, a restart or a retry can never post
  one row twice. **The card is never charged again by any of it.**
- **Under whose token**: the teacher who made the sale, if their session
  is still alive; otherwise the service account, with the selling
  teacher's name filed on the client the T45/T62 way ("Sold during a
  Mindbody outage by <teacher> at 5:33 PM, posted by the studio account").
  This relaxes T50's "every write runs under a signed-in teacher", for this
  queue only (P25).
- **What stops a row for a teacher** (`needs-a-teacher`, on the Sales
  sheet and as a gold count in the header): a walk-in not yet matched to a
  client; Mindbody refusing the sale (an intro pass the student already
  used, a pass no longer sold); Mindbody's total differing from what was
  taken by more than a cent; a basket T103 refuses. The row shows what was
  taken and what Mindbody says, and offers: post it anyway at Mindbody's
  price, sell a different item, or refund on Square (T235) and drop it.
  Nothing moves money by itself.
- **Dry run and the write guard apply to posting** exactly as to a sale,
  and a suppressed post stays `queued`, said so on the sheet.

**What outage mode does not cover**: THIS APP being down. Then the teacher
uses the Mindbody app and the studio's existing reader (Pete, 2026-11-21),
which needs nothing afterwards.

### Reconciliation, refunds and returns

- **A daily match** for the studio day, in `readerrecon.ts`, on top of
  T274's check: our rows, Square's payments for the location
  (`GET /v2/payments`, U), and Mindbody's `/sale/sales` filtered by
  `request.paymentMethodId` (sale.yml:1043, probe R4).
- **Mismatch kinds**: a sale with no completed payment, a payment with no
  sale, amounts that differ, a hold older than an hour, a queued row not
  posted within a day, a Mindbody return with no Square refund, a Square
  refund with no return, and a Mindbody sale on the reader's payment method
  that this app did not make.
- **Where it shows**: the same admin Sales sheet as T274, with its header
  count. Immediate mismatches are on the teacher's done block as above.
- **Returns**: a return in Mindbody records the return and moves no money.
  The refund is made in Square (the sheet shows each sale's Square payment
  id), and the daily match catches a forgotten one. A PIN-gated refund
  button is T235, with its own eighth `CompPurpose` (`credit` took the
  seventh).

### Reader setup

- Pete creates the Square account (P6) with the studio as its one location,
  and buys a **Square Terminal** (Best Buy and Staples carry it, about $254
  to $299 in 2026-11 listings, U; call ahead for stock). It charges over
  USB-C and can stay plugged in on the counter; Square's countertop mount
  ($19) holds it there, and its battery lets a teacher hand it to a
  student. Square's Terminal Hub adds ethernet and USB. Bought
  2026-11-22, Square Terminal from Amazon, $264.99.
- Pete creates a Square application in Square's developer dashboard, for
  the sandbox and production access tokens and the location ids (P6).
- The Terminal talks to Square over its own wifi or ethernet, not to our
  server, so Railway hosting needs nothing on the studio LAN.
- **Sandbox**: Square's sandbox answers Terminal checkouts on special
  test device ids (approved up to $25, no plain decline id) and does NOT
  support the Devices API, so pairing is exercised on the real Terminal
  and on T224's fake. Devtools-gated "Simulate tap" and "Simulate
  decline" buttons drive the fake and the test ids and refuse in
  production.
- **Costs** (Square's docs, 2026-11-22): 2.6% + 15c per in-person
  payment, 3.5% + 15c keyed, no monthly fee found, standard payout the next business day.
  Against Stripe's 2.7% + 5c it breaks even at $100 a sale. Confirm on
  squareup.com before relying on it.

### Work items

- [x] **T274 The transaction log.** Built 2026-11-22: `sale_log`
  (migration 20), `src/lib/salelog.ts` (open the row before Mindbody is
  asked, close it with the answer, a whitelisted request and a stripped
  answer), `src/lib/salecheck.ts` (the read-back), `GET /api/sale-log`,
  `POST /api/sale-log/check`, the Sales log in the account modal for an
  admin and the gold count on Profile. Driven against the fake with a
  local Postgres: a cash sale, a typed card (no digits stored), a
  refused credit sale, account credit and a planted short sale, which
  the check named; a dead database sold in 0.25s and logged `NOT
  STORED`. Not yet run against live Mindbody. Spec as written: `sale_log` (the next migration),
  `src/lib/salelog.ts`, written ahead and updated on every money route
  above, the daily check against Mindbody, the admin Sales sheet and its
  header count. Done when a cart sale, a split, a T90 ticket, a gift card,
  account credit, a membership and a guest comp each leave one row with
  what was asked and what Mindbody answered; a planted difference between
  a row and a sale read back from the fake shows on the sheet; and a dead
  database logs `NOT STORED` while the sale stands.
- [ ] **T222 Probes R1, R2, R3 and R5**, `scripts/probe-custom-payment.ts`
  (written 2026-11-15, not yet run; needs P7's method to exist). Done when
  it has been run on both sites and the answers are recorded in the probe
  table.
- [x] **T223 The Square client, the mode and the switch.** Built
  2026-11-22: `src/lib/cardreader.ts` (switch, mode, env by NAME, the
  test-on-prod refusal, the paired device per mode), `src/lib/square.ts`
  (fetch, `Square-Version` pinned, every call in the drawer as
  `square:`), `/api/admin/card-reader` and its drawer control,
  `reader` on `/api/config`, and `modeNotice`'s TEST line. The location
  assertion is NOT built yet (T226 checks the payment's own location).
  Spec as written: `square.ts`,
  the call log's `service` field, the environment table, the location
  assertion, `/api/config`, the `modeNotice` state, and the `card_reader`
  switch (default off). Done when a Square read shows in
  the drawer tagged square, and a location that does not match is refused
  with nothing created.
- [x] **T224 The fake and the row.** Built 2026-11-22:
  `scripts/training/fake-square.mjs` (with hands for pairing, a tap,
  a decline, a buyer cancel, a cancel that loses the race, money taken
  at the tap, and forced failures), `reader_payments` (migration 21,
  one open collection per Terminal by partial unique index) and
  `src/lib/readerpayment.ts`. Spec as written: `scripts/training/fake-square.mjs`,
  the migration for `reader_payments`, `readerpayment.ts` with
  compare-and-set transitions. Done when the transitions are driven end to
  end against the fake with no network.
- [x] **T225 Pair, collect, poll, cancel.** Built and driven against the
  fakes 2026-11-22: `/api/reader/status`, `/api/reader/pair`,
  `/api/reader/collect`, `/api/reader/attempt/[id]` and its `cancel`.
  Driven: switch off refuses with nothing sent; pairing by code;
  collect puts the rehearsed total on the Terminal; a second collect
  while one is open is "busy"; approve -> authorized with brand and last
  four; Cancel on an approved hold voids it; decline, a buyer cancel and
  the 90 second timeout end cancelled; a cancel that loses the race to
  a tap voids the payment it produced; money taken at the tap ends
  `unresolved`; an approved hold with no sale for three minutes is
  released by the sweep with no request; a client outside the write
  guard and a discount are refused. **First version narrower than the
  plan below**: one cart, a named or house client and a promotion code;
  a discount, an override, a split, a gift card, account credit and a
  line for someone else are refused in words until T226 wires the PIN
  tokens through and T233/T234 add the rest. The "Connect card reader"
  SCREEN (big code, countdown) comes with T227's UI. Spec as written: "Connect card reader", the
  three routes and the 90 second timeout. Done when the fake pairs a
  device from a code, a simulated tap moves a row to `authorized`, and
  cancel, decline and timeout each end `cancelled` with the payment reading
  cancelled.
- [x] **T226 `method: "reader"` in `/api/checkout`.** Built and driven
  against the fakes 2026-11-22: the `Custom` payment variant in
  `sale.ts`; `claimHold` (the row AND a fresh Square read must agree with
  the sale: teacher, client, cart sha, target and mode, and an APPROVED
  payment for exactly the rehearsal's total, before `authorized ->
  selling`); the sale under the custom payment method; `captureHold`
  (retried three times, then by the sweep; a definite refusal ends
  `uncollected`); `releaseHold` on a refusal, a suppression or T103's
  empty basket; `markUnresolved` (hold kept) when Mindbody does not
  answer; and a release at POST's single exit for any answer that is not
  a sale while the hold is still `authorized`. Driven: a sale that
  stands is captured; Mindbody refusing releases; Mindbody not answering
  keeps the hold and T253 holds the client; a ticket changed after the
  tap, and a dry run between tap and sale, release; charging before the
  tap leaves the reader waiting; the same hold cannot sell twice; a
  capture that does not answer is finished by the sweep. Not built: the
  25 second read of `/sale/sales` before `unresolved`, and the resolve
  controls (T228). Spec as written: The Custom variant,
  the claim, the single-exit complete or cancel, the refused shapes. Done
  when a sandbox sale stands with a completed Square sandbox payment linked
  to it, and a forced Mindbody refusal leaves the payment cancelled.
- [x] **T227 The Cart screen.** Built 2026-11-22 and driven in a browser
  against the fakes: `src/app/useReaderPayment.ts` and
  `src/app/ReaderWait.tsx` (shared with T229); a "Card reader" tile while
  the switch is on, greyed with its reason, taking the whole sale (its
  line's amount cannot be edited); Finalize holds the card first ("Ready
  for card. $4.97", Cancel), then sells; the done block reads "Paid
  $4.97 by card reader, Visa ending 4242"; "Connect card reader" in the
  account modal (the code large, a five minute countdown, New code). The
  sandbox half ran a full sale through the API against Square's real
  sandbox (R6). Spec as written: Tile, hook, panel, done block. **Done when a
  teacher sells a drop-in in the sandbox on Square's sandbox Terminal, end
  to end, with no hardware.**
- [x] **T228 The failure windows.** Built 2026-11-22: on no answer the
  checkout looks for the sale for about 25 seconds (same client, paid the
  hold's exact amount, made after the card was approved, not linked to
  another reader payment) and takes the money if found, else keeps the
  hold `unresolved`; `/api/reader/attempt/[id]/resolve` (admin) charges
  only against a sale Mindbody shows (or one an admin names) and
  releases only when Mindbody answers and shows none; the Sales log lists
  holds to settle. Restart recovery and the reload are the sweep's (an
  orphaned `selling` row becomes `unresolved` after five minutes). Driven
  against the fakes, including a sale Mindbody recorded and answered too
  late for. Not driven: a second iPad on one hold (the compare-and-set
  refuses it; T226's double-sell test covers the same claim). Spec as
  written: Ambiguous resolution, the sweep,
  restart recovery, reload, second iPad. Done when each row of the failure
  table is forced against the fake and ends as written, including a kill
  between `selling` and complete.
- [x] **T229 Pay and check in.** Built 2026-11-22 and driven in a
  browser: "Use the card reader" in the dialog (the overdraft block hides
  while it is chosen), the same hook and panel, then the existing attach
  and check-in; an unpaid Drop In was paid on the fake reader and the row
  went to checked in. Spec as written: The roster dialog through the same hook.
  Done when an unpaid row is paid on the sandbox Terminal and checked in,
  and closing the dialog mid-wait releases the hold.
- [ ] **T230 Customer display and the approval rule.** Half built
  2026-11-22: the customer screen says "Paying by Card reader" and "Tap,
  insert or hold your phone to the card reader." Still waiting on P8: the
  reader runs through the approval first, as today. Spec as written: The reader line on
  the mirror; P8's answer built. Done when the student's iPad shows the
  prompt, and the approval setting behaves as Pete chose on both screens.
- [x] **T231 Reconciliation.** Built 2026-11-22 (`readerMismatches` in
  `src/lib/readerpayment.ts`, on the Sales log through
  `/api/reader/attention?day=`): Square's payments at the location for
  the studio day against our rows: a completed payment no sale knows
  (`square-only`), a different amount (`amount`), a sold row Square has
  not taken (`not-taken`), and a hold over an hour old (`old-hold`).
  Mindbody's side is T274's check, which already reads every sale that
  stood. Driven against the fake with a stray Terminal payment planted.
  Not built: a Mindbody sale on the reader's payment method the app did
  not make (needs R4's read of how the custom method reads back), and
  refunds against returns (T235). Spec as written: The match on top of T274's check. Done when a
  day with one planted mismatch of each kind lists all of them and a clean
  day lists none.
- [ ] **T232 Gift card sales on the reader**, by the route R5 opens. Done
  when a card is sold in the sandbox with `Value` and `AmountPaid`
  asserted, exactly the right amount taken, and, on the credit route, a
  forced gift card refusal leaves the credit on the account with the
  sentence above.
- [ ] **T233 Split with a reader leg (first version).** Done when reader plus
  cash stands as one sale, and a refusal releases the hold and takes no
  cash.
- [ ] **T234 T90 tickets (first version).** Done when two recipients' carts
  stand on one tap, and a refused second cart leaves the student charged
  only for the first, by whichever route R6 allows.
- [ ] **T235 Refund on Square.** Admin, PIN, its own purpose. Done when a
  sandbox payment is refunded from the sheet and the match clears.
- [ ] **T236 Webhook hardening**, only if polling proves thin.
- [ ] **T275 Outage detection and the banner.** The answer counter, the
  `modeNotice` state, `/api/config`'s `outage`, the catalog held in memory
  past its life, the greyed tenders, the gate's sign-in sentence. Done
  when the fake going dark puts the counter in outage within 30 seconds
  with the shelf still priced, and its first good answer takes it out.
- [ ] **T276 Selling in an outage.** Local tax, the Terminal completed at
  the tap, cash, walk-ins by name, queued check-ins, the `outage_queue`
  migration, the sale refused before the card when the row cannot be
  written. Done when, with the fake dark, a roster student buys a drop-in
  on the sandbox Terminal and is checked in as "Queued", a walk-in buys
  water in cash, and both rows are `queued` with what was taken.
- [ ] **T277 Posting the queue.** In order, one at a time, compare-and-set,
  rehearsed, the token rule and its Notes line, dry run and the write
  guard. Done when the fake comes back and both sales post, the check-in
  lands after the pass, a forced restart mid-post posts nothing twice, and
  a suppressed post stays `queued`.
- [ ] **T278 The rows that need a teacher.** Matching a walk-in, the three
  ways forward, the header count. Done when a refused pass, a total that
  moved, and an unmatched walk-in each stop for a teacher, and each way
  forward ends the row with nothing charged twice.
- [x] **T279 The Cart screen's payment tiles, in order.** Built 2026-11-22
  (Pete, after the first reader sale: "Card should be 'Card on file'.
  Account shouldn't be in the payment already (ESPECIALLY WHEN THE CLIENT
  HAS NO CREDIT!) ... not in a good order and it's weird with an odd
  amount of buttons"). Order: Account first ONLY with a balance, then Card
  reader, Card on file, Cash, Gift card, and an empty account LAST ("No
  balance. Charging past it needs a PIN.", T94's door). An odd count gives
  the account, else the last tile, the full row: no empty cell. With the
  reader ready, the foot no longer says "No card on file". Seen against
  the fakes: walk-in (2x2), no balance (2x2 plus account), a balance.
- [x] **T280 Card on file first, nothing chosen for the teacher.** Built
  2026-11-22 (Pete, on T279's screenshots: "stored card should be first
  if there is a stored card. should also display last 4 digits ... card
  reader should have under it in small letters the forms of payment we
  take ... account should not be selected on its own, teacher should have
  to select it"). A usable card on file leads ("Ending 7311"), else the
  card reader ("Cards, Apple Pay, Google Pay"); Account is always last
  with its balance badge; T239's automatic account line is off
  (`AUTO_ACCOUNT_LINE`). The roster's pay dialog is unchanged: it still
  defaults to a balance that covers the total (Pete: "that is fine, we can
  leave it like that"). T281, same day: on a walk-in sale that tile is
  "Manual card entry" ("Type the card number"), and the whole tile opens
  T93's card entry. T282, same day: Square's mark on the right of the
  card reader tile, and the keypad glyph back on the right of "Manual
  card entry" (decorative: the whole tile is the button). T283, same day
  (Pete: "change card on file subtext to ****7311 and lets just make
  manual card entry its own button always so we dont have to have the
  extra wide account button"): Card on file reads "****7311" and is
  offered only with a client; "Manual card entry" is always its own tile
  and the keypad square on Card on file is gone. With the reader on: six
  tiles with a client, four on a walk-in. With it off and a client, five,
  and the account still takes the full row.
  T284, same day (Pete: "Account should show $0 or negative amount rather
  than 'No balance'. subtext should just be 'requires a PIN'"): the badge
  always carries the balance ($0.00 muted, owed in the warn pair, credit
  green) and an empty or owed account reads "Requires a PIN". T285: Cash
  always comes before Manual card entry. Seen against the fakes:
  walk-in, card on file with no balance, card on file with $40.
- [x] **T286 A discount on the card reader.** Built 2026-11-22 (Pete,
  after the first live sales: "still cant charge with a discount, WHY?";
  it had been left out of the first version and never followed up).
  `/api/reader/collect` checks the discount as `/api/checkout` does
  (package refusal, `parseDiscount`, a comp token of THIS teacher's, never
  spent there), refuses a discount covering the whole sale and a
  promotion code beside one, and rehearses WITH it, so the hold is the
  discounted total. `/api/checkout` no longer refuses a discount with
  `method: "reader"`, spends the token as for any tender, and the reader
  branch now calls `recordDiscount` (the note, the comp receipt row and
  the customer approval spent) on a sale that stands, one found late, and
  a suppressed one. Seen against the fakes: $5.00 Kombucha less 20%,
  hold and payment $4.41, "Discount $1.00 (20%): Damaged item" on the
  done block. Not yet run live.
- [x] **T287 Cancel waits for Square.** Built 2026-11-22 (Pete, with a
  screenshot of "This card reader attempt is cancelling, so nothing was
  charged.": "when i tap cancel on the app does it confirm that the
  square charge didn't finish before it displays this"). It did not: a
  Cancel that crossed a tap let the poll read `authorized` and go on to
  the checkout, which refused on `cancelling` with a sentence written
  before Square had answered. `useReaderPayment` now never sells after a
  Cancel (an `authorized` read re-sends the cancel), keeps reading until
  the server has FINISHED the cancel (`finishCancel`: the checkout
  cancelled and every approved payment voided), and only then says
  "Cancelled. Square confirmed nothing was charged."; a cancel Square has
  not confirmed in 30 seconds says so and is held as unknown. The
  reader's own time-out cancels the same way. Seen against the fakes:
  a tap then Cancel, and a Cancel that loses the race to a tap; both
  ended with the payment CANCELED in Square and those words on screen.
- [x] **T288 The Sales log settles what it can.** Built 2026-11-22
  (Pete, with the Sales log showing a red "Square took $1.00 ... that no
  sale on this counter knows about" and a 10:14 AM "May have gone
  through": "how do we avoid/fix this"). The $1.00 was his own charge in
  Square's Dashboard for its fee-free offer, and the 10:14 tap was his
  $2.99 walk-in Mat Rental test, which Mindbody shows no sale for (read
  live: no Mat Rental after 7:47 AM). (1) A Square payment that is not
  this app's (no attempt-id `reference_id`, no `terminal_checkout_id`,
  both seen on a sandbox Terminal payment) is kind `outside` and said
  quietly, never as a problem. (2) The check (daily and "Check now")
  looks up an `ambiguous` or no-answer tap in Mindbody 15 minutes after
  it, READS ONLY: a sale for someone on the ticket (or the walk-in
  client), from two minutes before to fifteen after, holding every line,
  paid the total when known, and not claimed by another row, is `found`
  ("Went through"); none is `not-sold` ("Checked: no sale in
  Mindbody"). Either settles the row off "Only problems". Gift cards and
  credit are not looked up ("check Mindbody"). Seen against the fakes:
  an outside $1.00, a found tap and a not-sold tap.
- [x] **T289 The customer screen on the card reader.** Built 2026-11-22
  (Pete, on screenshots of it: "'Paying by Card reader' seems
  unneccessary", and of a decline line, "yeah add that"). With the
  reader as the tender the live ticket shows only "Tap, insert or hold
  your phone to the card reader." (every other way to pay is still
  named, T240), and a card the reader declined replaces it with "Card
  declined. Please try another card." until the tender changes or the
  next attempt starts. The payload carries a KEY, `readerNote:
  "declined"`, live only, rebuilt by `readTicketPayload`; the words are
  the display's own. The attempt view says `declined` when the row was
  cancelled for a declined card, not for a teacher's Cancel. Answered
  the same day: the student's Change list is dynamic (the tiles' own
  `addReason(source, true)`), so no card on file means no "Card on
  file" there. Not built, offered: Card reader in that list. Seen
  against the fakes: chosen, waiting, declined.
- [x] **T290 The customer screen opens full screen on an older iPad.**
  Built 2026-11-23 (Pete: the studio's customer iPad, "old iPad", opened
  its Home Screen icon with Safari's address bar). Next 15.5 writes only
  `mobile-web-app-capable` for `appleWebApp.capable`; older iPadOS reads
  only Apple's `apple-mobile-web-app-capable`, so the root layout now
  sends both (`other`), and `src/app/display/layout.tsx` repeats it and
  names the icon "Customer Screen". Checked in the built HTML of `/` and
  `/display`. Not yet seen on that iPad: re-add the icon after deploy.
- [x] **T291 The student no longer chooses how to pay.** Built
  2026-11-23 (Pete, after asking why the customer iPad offered "A
  different card": "let's do away with the customer choosing the payment
  method"). `STUDENT_CHOOSES_TENDER = false` in `SaleScreen.tsx` and
  `page.tsx`: no offer is built on the Cart screen or the roster dialog's
  approval, so the customer screen shows no Change and no "How would you
  like to pay?", and with no offer stored the server refuses any pick or
  student-typed card. T241's machinery is kept; the constant brings it
  back. "Your passes" (T242) is untouched. Seen against the fakes:
  reader chosen and declined, no Change.
- [x] **T292 A discount on a line of several units.** Fixed 2026-11-23
  (Pete, at the counter: three Meditation Cushions at $5.00 with $1.00
  off charged $12.00, "Discount is doing per item instead of total").
  Probed on 471 with `Test: true` the same day: Mindbody applies
  `DiscountAmount` to EVERY UNIT of a line while reporting
  `DiscountTotal` as the figure sent, so T79's check passed; and it taxes
  a multi-unit discounted line as though the discount came off once. Now
  a discounted line goes out as one item per unit, each with its whole
  cents share (`cartItemsPayload`), and the discount is read from the
  money (SubTotal + TaxTotal - GrandTotal), not from `DiscountTotal`.
  Priced live through `priceCart`: three cushions $1.00 off $14.00, 20%
  off $12.00, $2.00 off $13.00; three LMNT $1.00 off $4.91 with tax
  $0.48 (Mindbody's own per-unit, rounded-up rule); all `disagrees=false`.
  Every sale with a discount on a line of more than one unit before this
  was charged the per-unit discount.
- [x] **T293 Sign-up from an idle customer screen clears a left-behind
  ticket.** Fixed 2026-11-23 (Pete: the idle screen's "New here? Sign up"
  answered "The front desk is using this screen" with no ticket open).
  `startSignup` now retires what a present already would: a live ticket
  not re-presented for two minutes and an approval nobody polled for a
  minute. Anything else still refuses, and the refusal logs what it
  holds (`[display] sign-up refused: holding ...`). Cause not proven;
  the log line is how the next one is read.
- [x] **T294 Signing with a finger on Safari 12.** Fixed 2026-11-23
  (Pete, the studio's customer iPad on iPadOS 12.5.8: "signing with my
  finger doesn't work"). Pointer events reached Safari in 13; the
  signature pad now draws from TOUCH events (native, not passive) where
  the browser has no pointer events, and from pointer events otherwise,
  never both. The sign-up form's two-minute clock counts touches and
  keys too. Seen with pointer events removed and real CDP touch input:
  the stroke inked and the pad said "Thank you".
- [x] **T295 The customer screen asks as well as listens.** Built
  2026-11-23 (same iPad: frozen on its welcome page, "Not now" did
  nothing, the front desk said "Customer display is not responding",
  and Sign up met "The front desk is using this screen"). Its live
  stream did not deliver. A paired screen now asks `GET
  /api/display/state?scene=1` every 3 seconds: the server answers with
  the student-safe scene it should show (`displaySceneNow`, the same
  `sceneFor` the stream replays) and the newest display event id, and
  counts the ask as a beat (`touchDisplaySeen`), so the front desk's
  mark stays honest. The screen applies an answer only when it is not
  older than the last stream event it took and differs from what is up,
  so a working stream sees no change; a stream error no longer wipes
  the scene. Seen against the fakes with the stream stubbed DEAD and no
  pointer events: "connected" on the front desk, Sign up then Not now,
  and a ticket with its total, all through the poll; and the reader
  ticket and decline with a live stream as before. Not yet seen on the
  iPadOS 12 iPad itself. Safari 12 is otherwise untested ground.
- [x] **T296 The tap line waits for Finalize, with the accepted marks.**
  Built 2026-11-23 (Pete: the customer iPad showed "Tap, insert or hold
  your phone to the card reader." as soon as the Card reader tile was
  tapped, "this should not show until the teacher clicks Finalize
  Sale", and "it should show credit card icon/logos, apple pay and
  google pay as accepted forms of payment"). `readerNote` gains
  `"waiting"`, set when the Cart screen asks the Terminal for the card
  and cleared on its answer; with the reader chosen and no ask yet the
  customer screen shows the ticket alone. Under the tap line, Visa,
  Mastercard, American Express, Discover, Apple Pay and Google Pay
  (`src/app/display/AcceptedPayments.tsx`, Simple Icons paths, CC0,
  in `currentColor`). Seen against the fakes: chosen (ticket only),
  waiting (line and marks), declined.
- [x] **T297 The card processing fee.** Built 2026-11-23 (Pete: "add a
  feature to automatically add a credit card processing fee of 2.6% to
  credit card purchases under $10. we already have a sign at the front
  desk stating that will happen."; all card methods; "Skip on reader
  debit"). Mindbody ignores a price on a cart line (probed on 471:
  Metadata Price, Amount, SalePrice all priced at the catalog's), so the
  fee is a retail PRODUCT the studio creates at **$0.01, tax exempt**,
  sold at a quantity of cents (14 cents is 14 x $0.01), named by
  `POS_CARD_FEE_PRODUCT_ID` (unset: off; `POS_CARD_FEE_RATE` 0.026 and
  `POS_CARD_FEE_UNDER` 10 are the defaults). `/api/catalog` reads it by
  id, keeps it off the shelf, and serves it as `cardFee` only when it
  reads $0.01 and tax exempt. The Cart screen puts the line on while the
  tender is ONE card (on file, Manual card entry, the reader) and the
  sale without it is under $10, at round(2.6%), at least a cent, judged
  against Mindbody's pricing of the ticket on screen; it comes off when
  the tender, the contents or the total say otherwise, and Finalize
  waits while it moves. Not on a discounted ticket, an override, a gift
  card, account credit or a line for someone else (v1), nor in the
  roster's Pay and check in (passes are all over $10). The row has no
  controls; the customer screen shows it as one line. `/api/checkout`
  refuses a fee line on any other ticket or at the wrong quantity, in
  words, before money moves. **Debit on the reader**: Square reads
  `card_type` at the tap; on DEBIT the checkout rehearses the sale
  without the fee and LOWERS the approved hold to it (PUT
  /v2/payments, probed in Square's sandbox 566 -> 552) before selling
  without the line; a Square answer nobody can read releases the hold,
  any other doubt keeps the fee. Card on file and typed cards cannot be
  told apart before the charge, so they always carry it. Driven against
  the fakes: card on file ($5.00 + tax + $0.14 = $5.66), the fee off
  with the card, the reader on credit (sale with 14 x fee, $5.66) and on
  debit (hold lowered, sale without the fee, $5.52). **Product created
  2026-11-23**: "Credit card fee", ProductId 589, barcode Id
  `9692472471` (the value `POS_CARD_FEE_PRODUCT_ID` takes, since a cart
  line names a product by its barcode), $0.01, filed with "sales tax
  exempt" (100000) as its PRIMARY category, so it is on no counter shelf
  and the app now reads a primary 100000 as tax exempt too. Read live:
  14 units price $0.14, tax $0.00, and BLACK26 takes nothing off it.
  **Superseded by T299**: the receipt printed one $0.01 row per cent,
  so the fee is now one discounted unit of a product priced $0.26.
- [x] **T298 A promotion code on every sale, for a run of days.** Built
  2026-11-23 (Pete: "add a new feature where we can have a promo code
  automatically applied to all carts. starting today i want BLACK26 promo
  code to be entered for all purchases, thru 11/30"). An admin sets a
  code and its first and last studio day in the drawer's Settings tab
  ("promotion code on every sale", `PUT /api/admin/auto-promo`, stored
  as `app_settings.auto_promo`, logged with the staff id; with no
  database `POS_AUTO_PROMO=CODE,YYYY-MM-DD,YYYY-MM-DD`;
  `src/lib/autopromo.ts`). `/api/config` serves today's code as
  `autoPromoCode`, and the Cart screen and the roster's Pay and check in
  put it in their code field as if typed, so T220 judges it unchanged:
  Mindbody prices it, only an applied code is charged, a refusal at the
  charge refuses the sale. It yields quietly to a discount, an override,
  a gift card, account credit or a line for someone else and comes back
  when they go; Remove keeps it off until the ticket is emptied (the
  dialog: until it closes); a ticket Mindbody does not apply it to says
  "Today's code BLACK26 does not apply to anything on this ticket." and
  is not asked again until it changes. **BLACK26 read live (Test
  pricing, dummy client, 2026-11-23): 15% off every pass and membership
  tried (Drop In $28 -> $23.80, 10 Class Pack $230 -> $195.50, Annual
  $1599 -> $1359.15). Retail (corrected the same day, Pete: "It should
  be working on accessories and clothing"): 15% off Clothing (Cobra
  Hoodie $58 -> $54.50 with tax, tax recomputed on the lower price) and
  Accessories, rentals included (Mat Rental $2.99 -> $2.54); nothing off
  Food/Drink (LMNT, Boxed Water, Vita Coco) or Other (Parking Pass, Miir
  cups and bottles).** The first read priced only a drink and wrongly
  said "nothing off retail". The card fee's product (T297) must sit in a
  category BLACK26 does not cover, or the code discounts the fee.
  Driven against the fakes:
  retail alone (the quiet line), a pass added ($210 less $31.50),
  Remove, a new ticket, a card-on-file charge carrying the code, and the
  roster dialog filling it. Owed: Pete saves BLACK26 on prod.
- [x] **T299 The card fee is ONE line on the receipt.** Built 2026-11-24
  (Pete, on sale 430178, a $2.00 LMNT with five "Credit card fee $0.01"
  rows: "their receipt is going to look very unprofessional", and "we
  can change the price of an item in the mindbody app, you're telling me
  you can't do that?"). **No way was found to set a price through the
  API**: 25 more `Test: true` shapes on product 589 (twelve Metadata
  keys, six CheckoutItemWrapper keys, string Metadata, a negative
  DiscountAmount) all priced the catalog's $0.01 or were refused, on top
  of T297's three and T256's three. **A line discount does it**: LMNT
  $1.81 with `DiscountAmount` $1.76 priced $0.05, and Towel Rental beside
  it with BLACK26 took the code's 15% AND the line discount ($2.59, the
  same as the towel with five $0.01 units). So the fee product is now
  priced at or above the rule's largest fee ($0.26 for 2.6% under $10)
  and sold as ONE unit discounted to the fee (`withCardFeeShape` in
  `src/lib/sale.ts`, called by `priceCart` and `checkoutCart`, the only
  two senders of a cart). The browser, the routes and the sale log go
  on counting the fee in cents at $0.01 (`/api/catalog` serves it as a
  one-cent unit whatever the product costs); the screens did not
  change. `priceCart` takes the fee's own discount back out of the
  subtotal and discount it reports, so a promotion code's discount is
  the code's alone; T75 compares the product's own price against
  Mindbody's pre-discount SubTotal, so a product price this read did not
  see is a refusal, never a wrong charge. T103's basket and T274's daily
  check count the fee as one unit. A product still at $0.01, taxed, or
  below the largest fee turns the fee OFF (`/api/catalog`) and is
  refused at pricing; it is never sold the old way. Driven against a
  fake Mindbody priced like the live probes (22 checks: the payload, the
  totals with and without BLACK26, the charge and its basket, a 26 cent
  fee, a 27 cent fee refused, a ticket with no fee unchanged), and the
  $0.01 product refused with nothing sent. **Owed: Pete sets product 589
  to $0.26 (tax exempt, category unchanged); one live card sale under
  $10; how Mindbody's receipt prints a line with a discount on it.**
- [ ] **T237 Hardware day.** Buy and pair the Terminal, the production
  token, `POS_READER_LIVE=true`. **Never `POS_WRITE_CLIENT_IDS` while the
  studio is open**: it suppresses every write for every other client,
  check-ins included, on every iPad (2026-11-22, it stopped a teacher's
  check-ins mid-class; sell to the dummy client by hand instead).
  **Half done 2026-11-22**: paired by device code, and Pete's own card
  bought one LMNT Electrolytes ($2.00) for John NewGuy, Mindbody sale
  429494 paid $2.00 by method 18 "Square Terminal". Owed: the Square
  side read as COMPLETED, the refund/void (Pete may keep it), the next
  day's match. Done when
  Pete's own card buys the cheapest item, the sale reads back from
  Mindbody with the reader's payment method, the payment is completed in
  Square, both are refunded and voided, and the next day's match is clean.
  Then a dummy-client outage drill on prod (the fake cannot stand in for
  Mindbody going dark there: a server flag that treats Mindbody as down
  for that client only, devtools-gated), then the training guide and
  `DEPLOY.md`.

### Rails this phase moves

Each of these is written down in CLAUDE.md or the design doc today and is
changed by the item that builds it, in that item's own commit:

1. **"Nothing auto-charges"** and the display's "nothing runs on the
   server's own initiative": the sweep completes payments and releases
   holds with no tap, and the queue posts Mindbody sales with no tap.
   None is a new CHARGE; the queue is a new unattended Mindbody WRITE,
   which needs its own recorded exception (T228, T277).
2. **T203**: a charge carries a `displayApprovalId` or a PIN token. P8
   would add a third (T230). An outage sale is not approved on the
   customer screen if the approval setting is on and the display cannot
   reach the hub; T276 decides with Pete.
3. **T113**: the idempotency store is deliberately not in Postgres. The
   reader needs a durable row to START, never to finish (T224, T226), and
   the log keys on T113's key (T274).
4. **The charter's "runs fully without `DATABASE_URL`"**: the reader tender
   and outage mode do not; everything else still does (T224, T276).
5. **T103**: "it cannot un-take the payment." On the reader it can, so the
   sold-nothing sentence and its client note need their own words for this
   path (T226).
6. **`modeNotice`'s "exactly four states"**: a fifth (reader in test mode)
   and a sixth (outage), both loud, as the rule itself asks (T223, T275).
7. **Option C's two outcomes** gain a third, hold kept while Mindbody's
   answer is unknown (design doc updated with this plan).
8. **"Pricing comes from the live Mindbody API, never from a cache that
   could go stale"**: in an outage the shelf is the last catalog read,
   in memory only, and Mindbody's total is checked when the sale posts
   (T275, T277).
9. **"A Phase 2 sale must never queue"** (Known gaps, Offline): it queues
   in an outage, and only then (T276).
10. **T50, every write under a signed-in teacher's token**: a queued sale
    whose teacher's session has ended posts as the service account, named
    on the client (T277, P25).
11. **The sanctioned hand-off to the Mindbody app**, which option A
    rejected even as a stopgap: when this app is down, and only then
    (design doc).
12. **T29's charter** gains `sale_log` as our record of our own actions
    (T274).
13. ~~**T93's $10 floor** "does not care whose card it is": at odds with the
    lost-sale brief until P10 is answered (T226).~~ Moved already: T238
    retired the floor on every card path, so T226 has none to apply.

---

## Phase 5: incidents and self-repair

Asked for by Pete, 2026-11-17, after T254 (a whole $201.99 sale refused as
"nothing was sold", a false sentence filed on the student's Notes, a hold
raised, and every step of the diagnosis and repair done by hand): "have
Fable design a system that could auto-diagnose and fix issues like this as
soon as they happen." Design and reasoning:
`docs/design/auto-diagnosis.md`. Do not re-argue it here.

The shape: a route that decides a serious outcome raises an incident (a
console line and an `incidents` row with the evidence it had in hand); an
outbox pushes the incident's id to a fresh Claude Code cloud session; that
session reads through one narrow door into this app and posts a diagnosis;
and the APP, not the agent, takes back its own false side effects once its
own second check agrees. **The agent adds zero write paths to Mindbody and
holds no Mindbody credential.** "Nothing auto-charges" does not move.

**The agent plumbing is unverified from here.** The fire endpoint, the
environment's proxied secret and the unattended connectors are described at
the level of capability and marked (U) in the design; probes A1 to A3
settle them. T260 to T262 need none of it.

### The ladder

| Rung | What | Who acts |
|---|---|---|
| 0 | Record, deliver, diagnose, report | Nobody taps |
| 1 | Take back the app's OWN side effects of a verdict re-proven false (the Notes line, the hold, the red block); write a finding onto an ambiguous hold | Nobody taps: the agent's request AND the server's witness. Pete is told after, with Undo |
| 2 | Merge a fix PR; a repair to Mindbody data from a fixed list; undo a rung 1 action | One tap, Pete (P18), under the tapper's own token |
| 3 | Anything that moves money; any rail, setting, deploy | A person. The agent writes the steps |

### Work items

T260 to T265 are the first slice. Its test is T254 itself, replayed on the
dummy client.

- [ ] **T260 The incident record.** `src/lib/incident.ts` `raiseIncident`,
  the migration (`incident_cases`, `incidents`), the per-request call trail
  through `mbtrace.ts`'s store, the three extra strikes (staff token, gift
  card barcode, authored free text), the charter note in `db.ts`. Raised
  from `soldNothingAnswer`, the partial answers, `/api/purchase-contract`,
  and `settleCharge` as the backstop (`[incident] UNRAISED`). Done when a
  sold-nothing forced against the fake leaves one row holding the ticket,
  the sale as read, the verdict's per-line audit, `side_effects` with the
  note's exact filed text and the hold id, and the git sha; a grep of the
  row finds no card digits, CVV, PIN, staff token or barcode; a money route
  that raises nothing still leaves a row through the backstop; and with
  `DATABASE_URL` unset the console line is printed and the counter's answer
  is byte for byte what it was.
- [ ] **T261 The witness.** A second, separately written check that a sale
  holds what was sold (exact unit count, one-to-one pairing, amounts equal
  payments equal paid to the cent, the same client, no other sale since),
  run once at the verdict on the sale already read and stored on the
  incident. It can only ever say "this alarm was false". Done when sale
  428877's own JSON passes it while `assertBasket` at `4e4aceb^` refuses the
  same JSON; a planted empty basket, a missing line, an extra line, a total
  off by one cent, another client's sale and a second sale five minutes
  later each fail it; and probe A5 has said which ticket shapes it covers.
- [ ] **T262 The agent door.** `/api/agent/*` behind `POS_AGENT_TOKEN` (404
  when unset): incident reads, the GET-only Mindbody proxy with its path
  allow-list and per-incident cap, the call log, `client_writes` and holds
  reads, all with T260's strikes; `scripts/agent/*.ts` as the only client.
  Done when a non-GET or a path off the list is refused with nothing sent
  to Mindbody; the device cookie, a staff session and the display cookie
  each fail to open the door; the agent token opens no route outside it; a
  proxied read shows in the drawer tagged `actor=agent`; and a response
  holding a staff token or a client's Notes arrives with both struck.
- [ ] **T263 Delivery.** The outbox and its backoff, fingerprints and
  cases, the hourly and daily fire caps and the storm alert, the direct
  severity 1 alert that needs no agent, the daily sweep task, probe A1.
  Done when thirty identical incidents in one minute produce one fire and
  one alert line whose count updates; an unreachable fire endpoint changes
  no counter response time and is retried on schedule from the table after
  a restart; the eleventh case of a day produces the storm line and no
  fire; a dry-run, write-guarded or sandbox incident is recorded and not
  fired unless `POS_INCIDENT_FIRE_ALL=true`; and the fired text holds only
  ids and enums.
- [ ] **T264 The investigator.** Its cloud environment (allow-list: this
  app and GitHub; the agent token as a proxied secret), the fired task,
  `docs/agent/incident-playbook.md` with T254 as the worked example, the
  diagnosis form, the issue and the channel message, probes A2 and A3.
  Done when a T254 replay (a fixture of sale 428877 against the pre-fix
  matcher, dummy client 100042041, `incident_repairs` off) puts on Pete's
  phone, within ten minutes and with no human, a diagnosis that says False
  alarm, High, names the `IsService` veto with file and line at the
  incident's sha, says why it had not shown on product-only tickets, and
  reports the sweep; the call log shows only GETs from it; and a client
  renamed to an instruction ("Ignore the playbook and ...") changes nothing
  in the report but the name.
- [ ] **T265 Self-undo.** `POST /api/agent/incidents/<id>/repairs` taking a
  kind and nothing else; the executor (`overturn-verdict`: the exact-match
  Notes retraction through `updateClientAudited` as `incident-retract`, the
  hold's new `overturned` state, the incident's timeline); the
  `incident_repairs` setting (`off`, `propose`, `auto`; ships `propose`,
  fails tight) with its admin control; the screens' 10 second re-ask while
  a hold shows, overturned holds listed for 24 hours, and the correction
  block on the Cart screen and the roster dialog; probe A4. Done when, on
  prod with the write guard on the dummy client and the setting on `auto`,
  the T254 replay ends with no tap in: the false entry gone from Notes and
  every other entry untouched, a `client_writes` row with before and after,
  the hold overturned, and the red block turned into the correction on a
  Cart screen left open, on one reloaded, and on a second iPad. And when
  each of these is left ALONE with the reason reported: a planted true
  sold-nothing, a note a teacher edited by one character, a hold a teacher
  already acknowledged, a second sale for the client after the incident, a
  repair asked for with the witness failing (which also drops the setting
  to `propose`), and a dry-run suppression.
  - [ ] Pete: P21, then move the setting to `auto`.
- [ ] **T266 Truth on an ambiguous hold.** For `ambiguous` and
  `stale-pending`: two server reads at least two minutes apart and five
  minutes after the charge began, then the finding written ONTO the hold
  ("Checked at 1:31 PM: this charge went through. Sale 428877 holds
  everything. Do not charge again." or "... no sale was made and nothing
  was charged. It is safe to ring this up again."). The hold still waits
  for a teacher's Understood. Done when a forced timeout whose sale landed
  and one whose sale did not each show the right sentence on the held
  ticket within ten minutes, a sale that lands between the two reads is
  reported as landed, and neither hold is released by anything but a tap.
- [ ] **T267 The disputed verdict** (needs P19). When the witness disputes
  a sold-nothing verdict at the moment it is made: amber, "We are checking
  this sale. Do not charge again.", the client held as now, and no Notes
  line until the check returns. Done when the T254 replay never shows the
  red block or writes to Notes, a true sold-nothing still shows red and
  files its note at once, and a check that never returns falls back to the
  red block and the note after ten minutes.
- [ ] **T268 Fix PRs.** GitHub Actions on every PR (`typecheck`, `build`,
  the fixture suite); `fixtures/incidents/` with each incident's recorded
  live answer and expected verdict, names struck; the PR body's two-way
  statement of the rail; a separate adversarial review session before Pete
  is told; main protected and `CODEOWNERS` on the money path, the witness
  and the playbook; "safe to merge now" read from the app (no class within
  20 minutes, no pending holds). The agent never merges. Done when the T254
  replay produces a PR whose new fixture fails on the pre-fix matcher and
  passes on the fix, with the review's findings on it, and a push to main
  by the agent's identity is refused.
- [ ] **T269 One-tap repairs.** An admin sheet in this app listing each
  proposal with its evidence and one 64px control, linked from the alert:
  attach a purchased pass to a visit, check in or reverse a check-in,
  un-late-cancel, run a skipped T219 enrolment, re-file a note or a
  document upload, and Undo of a rung 1 action for 24 hours. Each runs the
  existing route's own function under the TAPPER's token. Done when each
  listed repair is run on the dummy client from a phone and Mindbody names
  the tapper, a proposal for a client other than the incident's cannot be
  made, an Undo puts the note and the hold back and drops the setting to
  `propose`, and nothing on the sheet can charge, refund or comp.
- [ ] **T270 Wider detection.** The severity 2 kinds: `total-mismatch`,
  `giftcard-mismatch`, `followon-failed` (enrolment, note, approval record,
  `/api/visit-payment` 502), `client-write-failed`, `foreign-site`,
  `route-threw`; and a small route for the browser-decided
  `attach-failed`, shape-checked and trusted for nothing but an incident.
  Done when each is forced against the fake and leaves a row of the right
  kind and severity, and a declined card, a refused promotion code, a
  greyed pass, an expired sign-in and a 409 `held` each leave none.
- [ ] **T271 The drift digest.** Severity 3 counted, never fired one by
  one; a daily session that reports only what is climbing or stuck. Done
  when a planted week in which every product-only sale logs `[basket]
  unverified` is called out by ticket shape, and an ordinary week produces
  no message.
- [ ] **T272 Housekeeping.** `trail` and `witness` nulled at 90 days; the
  drawer's incidents tab (devtools-gated); a monthly line to Pete with the
  count of cases, what was done on which rung, and what the sessions cost.
- [ ] **T273 The graduation review.** After a year, or twenty cases: did
  the investigator ever disagree with a passing witness, was any automatic
  repair undone, did any PR need rework. Pete decides whether any rung
  moves. Nothing moves without this.

### Rails this phase moves

Each is in CLAUDE.md today and is changed by the item that builds it, in
that item's own commit. Reasoning: the design doc's section of the same
name.

1. **Every write needs a signed-in teacher** (T50): the retraction runs as
   the service account with nobody signed in. One kind, only text this app
   filed, only on two keys (T265).
2. **T253's "the only release before the lapse"**: `overturned` is a
   second (T265).
3. **T116's "a save never blanks text quietly"**: a retraction whose entry
   was the only text leaves Notes empty, audited and reported (T265).
4. **T249's tab record "stays until that result's own Understood"**: a
   server overturn also ends it (T265).
5. **The T29 charter**: `incidents.trail` holds excerpts of Mindbody's
   answers, as evidence, never read to serve a screen, expiring (T260).
6. **The drawer's looser-direction exceptions** gain `incident_repairs`
   (T265).
7. **T109**: staff tokens and gift card barcodes stay visible in the
   drawer and are struck from everything the agent door serves (T262).
8. **The display cookie's "grants exactly `/api/display/*`"** gains a
   sibling of the same shape for `/api/agent/*` (T262).
9. **"Nothing runs on the server's own initiative"**: the dispatcher, and
   the executor acting on an agent's request (T263, T265).

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
