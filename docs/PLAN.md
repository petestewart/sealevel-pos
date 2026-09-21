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
