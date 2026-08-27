# Front Desk POS for teachers

Status: design proposal, not built. Owner: Pete. Date: 2026-08-26.

## Problem

Teachers work the front desk. Mindbody's POS screen is slow enough that a line
forms: too many taps to find a client, build a cart, and take payment, and the
check-in flow is buried in a different screen from the sale flow. The goal is
not to replace Mindbody. It is to put a 2-tap surface in front of the 90% of
front-desk moments that are the same five actions, and hand off to Mindbody for
the rest.

The five actions, in rough frequency order:

1. Check in a student who already has a class on a valid pass or membership.
2. Check in a student whose pass just ran out, sell them the next pass, check
   them in.
3. Drop-in sale to a returning student who has a card on file.
4. Drop-in sale to a brand new student, or one with no card on file.
5. Sell a retail item (mat rental, water, towel) alongside any of the above.

Actions 1-3 and 5 are fully doable over the Mindbody Public API v6. Action 4 is
where the hardware question bites, and it gets its own section.

## What the data says (answers open question 2)

Pulled from the analytics mirror, `sales` table. The detailed Mindbody export
covering 2025-07-01 to 2026-07-01 tags each card sale as Keyed or Swiped and
splits in-studio from Online Store, so it answers the hardware question
directly. In-studio sales for those twelve months:

| Payment | Sales | Revenue |
|---|---:|---:|
| Keyed card (stored card on file or manually entered) | 2,411 | $211,762 |
| Comp / trade | 2,530 | $215 |
| Account credit | 969 | $8,757 |
| Cash | 169 | $1,882 |
| Other / misc | 76 | $297 |
| **Swiped card (card present)** | **25** | **$1,377** |
| Gift card | 2 | $184 |
| Check | 1 | $6 |

**25 swiped sales in a year. Four tenths of one percent.** The reader is
effectively already unused; whatever teachers are doing at the counter, they are
not dipping cards. Every dollar of in-studio card revenue except $1,377 came
through a card-not-present charge, which is exactly what the Public API is good at. Apple Pay shows up 5 times in the whole year, all of them Online Store.

So: **Swift would buy Bluetooth to a reader that handles 0.4% of transactions**
and, as it turns out, the studio's reader is not even a Bluetooth device. Build
the web app.

Narrowing further, of the 2,411 in-studio keyed sales, 355 (15%) were that
client's first-ever purchase, so roughly one a day is a genuinely new person who
plausibly has no card on file. The other 2,056 are returning clients who almost
certainly do. That is the real shape of the problem: the "tricky case" is about
one transaction per day, not the main flow.

One caveat the data cannot resolve: "Keyed" covers both *charge the card on
file* and *staff typed a card number in*. Mindbody reports them identically. If
a meaningful share of those 2,056 returning-client sales are staff re-typing a
card every time, that is itself a finding worth fixing (get the card stored),
and the fix is option B below either way. The daily peaks in the data
(60 sales on 2026-03-01, 56 on the 15th) are membership autopay batches, not
counter rushes, so they do not change the picture.

## The card-present problem (the honest answer)

**Confirmed 2026-08-26 from the payments portal at payments.mindbody.io:** the
account is on **Mindbody Payments** (Stripe underneath), status Account Live,
card-not-present enabled. The front desk reader is a **WisePOS E** named "Front
Desk", serial WSC513208040935, status Connected. That closes the processor
question and settles three things at once.

**Card-not-present over the API is available.** The portal states the account
can accept card-not-present payments, which is exactly what
`POST /sale/checkoutshoppingcart` does with a `StoredCard` payment. The whole
payment half of this design is live.

**The swipe path in the API is dead for us.** The v6 `CheckoutPaymentInfo.Type`
field does list `EncryptedTrackData` and `TrackData` ("indicates that this
payment item is a swiped credit card"), which is worth knowing exists. But
`EncryptedTrackData` means track data encrypted under a key *the processor* can
decrypt, and it dates from the era when Mindbody sold P2PE magstripe swipers.
Stripe will not decrypt a swipe injected for a Bluefin or TSYS key, and this
account is on Stripe. `TrackData` unencrypted would put our iPad in PCI scope,
so it is off the table regardless. And it is magstripe only: no chip, no
contactless, no Apple Pay, worse fraud liability than a dip. Do not pursue it.

**The reader cannot be driven from the Mindbody API.** The WisePOS E belongs to
Mindbody's Stripe platform account, with the studio as a connected account. We
get no Stripe keys for it, and Mindbody exposes no card-present endpoint. Inside
the Mindbody app it works fine ("look for the Card Reader button at checkout");
from our app it is invisible.

**But it kills the last argument for Swift.** The WisePOS E is a networked smart
reader over wifi or ethernet, driven server-side, not a Bluetooth accessory like
the M2 or Chipper. There is no Bluetooth in this studio's payment stack at all.
A web app can drive a reader of this class as well as a native app can, which
matters if option C ever comes up. Nothing about the hardware here favors
native.

Over the API we can reliably take: stored card on file, cash, gift card and
account credit, comp, and custom payment types.

### Choosing a payment method

Everything needed for a payment-method chooser is present:

| Method | Mechanism |
|---|---|
| Stored card | `StoredCard` |
| Account credit | `DebitAccount`, balance from `GET /client/clientaccountbalances` |
| Cash | `Custom` / cash payment info |
| Gift card | balance from `GET /sale/giftcardbalance` |
| Comp | `Comp` |
| Anything the studio defined | `GET /sale/custompaymentmethods` |

Read the balance before offering the method. A chooser that lists "account
credit" and then fails because the balance is $12 against a $140 membership is
worse than one that shows "account credit ($12)" greyed out, and the balance
is one call.

### We can never build our own add-a-card form

The spec settles this. There is no endpoint for attaching a payment method to a
client that does not involve a raw card number: it is either `ClientCreditCard`
on `POST /client/updateclient`, or `saveInfo: true` in `CreditCard` checkout
metadata, and **both take the PAN**. Either one puts our iPad, our server and
our logs in PCI scope.

So storing a card must go through a surface Mindbody hosts, not one we write.
The design already preferred that; the spec now requires it. Do not revisit
this in six months on the theory that a small form would be simpler.

### In-studio price vs online price

Doable, and Mindbody models it directly. Every priced item comes back with
**both** numbers: `Price`, documented as "the cost of the pricing option when
sold at a physical location", and `OnlinePrice`. So the iPad reads `Price` and
the in-studio number is what a teacher sees, with no mapping table of our own.

Displaying it is only half. The cart is priced **by the server**, not by us, so
the checkout has to be addressed to the physical location with `LocationId: 1`
and `InStore: true`. Any mismatch between the total we displayed and the total
the server returns should be treated as a bug and surfaced, never quietly
accepted.

**The two locations** (`GET /site/locations`, 2026-08-27):

| Id | Name | Tax |
|---:|---|---:|
| 1 | Fremont neighborhood, Seattle | 10.35% |
| 98 | Online Store | 0% |

There is exactly one physical location, so there is no location-picking UI to
build: `LocationId: 1` is a constant.

Those tax rates also close a question the probe left open. The probe bought a
$1.81 item and the server returned $2.00, and `1.81 x 1.1035 = 2.00`, so that
cart was priced at the **studio's** tax rate despite sending no `LocationId`.
The spec's "defaults to the online store" note is therefore per-endpoint rather
than universal, and checkout appears to default to the site's real location.
Send `LocationId` explicitly anyway: an undocumented default is not a thing to
build pricing on.

It does hand us a cheap invariant, though. An in-studio total should always be
`Price x 1.1035`, so a total that disagrees means the cart was addressed to the
wrong location, and that check costs nothing to assert.

Note the tension this creates with alternative payments: those endpoints only
support `LocationId = 98`, the online store. **Apple Pay therefore charges the
online price**, which for any item priced differently in studio is the wrong
number. That is a second reason Apple Pay is not a general counter payment
method, and if it is ever offered for an item with split pricing, the
difference has to be deliberate rather than a surprise in the month-end
numbers.

### Apple Pay is real, and it is not a button at the counter

`GET /sale/alternativepaymentmethods` lists it (type code **801**, alongside
iDEAL at 997), and it requires Mindbody Payments on Stripe, which is exactly
what this account is. So it is available to us. But three constraints decide
where it belongs:

- **Online store only.** These endpoints support `LocationId = 98` and default
  to it. The sale lands at the online store, not the studio, which the
  bookkeeping will see.
- **It is a redirect flow.** `POST /sale/initiatecheckoutshoppingcart` returns
  a URL, the customer authenticates on their own device, Mindbody calls back to
  a `PaymentAuthenticationCallbackUrl`, and then
  `POST /sale/completecheckoutshoppingcart` finishes the sale.
- **There is therefore no counter tap.** Nothing lets a teacher press Apple Pay
  on the studio iPad and have a customer's phone respond.

Apple Pay is not a fourth entry in the payment chooser. It is structurally the
same gesture as card capture: **put a link or QR in front of the customer and
let them finish on their phone.** That makes it part of option B rather than a
thing of its own, and it means one QR mechanism yields three outcomes: store a
card, pay now with Apple Pay, sign the waiver.

Note that the probe got HTTP 400 from `/sale/alternativepaymentmethods` and it
was never chased. That endpoint is the gate for all of the above, and the
likely cause is the missing `LocationId=98`. Re-probe it before planning this
work in detail.

### A. Fall back to Mindbody for new-card sales (recommended, v1)

The POS builds the cart, then for a student with no card on file it deep-links
to the Mindbody business app with the client pre-selected, teacher finishes on
the reader, comes back, and our app polls the sale to confirm and completes the
check-in. Zero new hardware, zero reconciliation, no PCI. Cost: the slow path
stays slow, for the minority of transactions.

### B. Capture a card on file at the counter, then charge it (recommended, v1)

Instead of taking the card at our POS, we get it *stored* on the client's
Mindbody profile, then sale becomes case 3 forever after. Two flows:

- **Their phone.** POS texts or shows a QR to a Mindbody-hosted payment-method
  page for that client. They add the card themselves while the next person is
  being served. The card never touches us or the iPad.
- **A second iPad or the same one, handed over.** Same hosted page in a kiosk
  frame.

This is the flow that actually fixes the line, because it moves card entry off
the critical path and it is a one-time cost per student. Trade-off: those
charges settle as card-not-present, which is a slightly worse interchange rate
and puts chargeback liability on the studio rather than the issuer. For a
$25-$200 yoga sale with a known member, that is a fair trade. It also requires
Payments API access on the account, which is the single thing to confirm before
committing to this path.

### C. Our own Stripe Terminal reader (ruled out by the data, not by the tech)

Buy a second WisePOS E on the studio's own Stripe account, drive it from our web
app server-side (`/v1/terminal/readers/:id/process_payment_intent`), then post
the Mindbody sale with a `Custom` payment so the pass and check-in still land in
Mindbody while the money lands in Stripe. Technically clean, and now clearly
buildable as a web app, since the reader we would buy is the same networked
model already sitting on the desk.

It is still not worth it. It would serve about 25 transactions a year and $1,377
of revenue, and the cost is two deposit streams, a nightly Stripe-to-Mindbody
reconciliation job, a second reader on the counter, and a payment type the
bookkeeping has to learn to read. Keep the payment layer behind one interface so
this stays possible. Do not build it.

## Shape of the thing

**Its own app, its own repo, its own Railway service.** This does not belong in
ai-manager. ai-manager is an always-on back-office worker: queues, jobs,
approvals, a console Pete looks at. The POS is a hard-realtime surface a teacher
touches with a line of people waiting, and it needs to be deployable, restartable
and debuggable without any chance of taking the ops system down with it, or vice
versa. Different uptime story, different users, different release cadence, no
shared data model beyond "talks to Mindbody."

Proposal: a new repo `sealevel-pos`, one Railway service in its own project.

**iPad web app (PWA), not Swift.** The data settles the only real argument for
native: direct Bluetooth to a card reader, for 0.4% of transactions. What the
web app buys instead: we ship a fix in two minutes with no App Store review;
teachers get it by opening a bookmark, so there is no MDM, no provisioning
profiles, and no device enrollment for a rotating cast of contractors; and Add
to Home Screen gives a full-screen icon indistinguishable from a native app at
the counter.

**Deliberately lightweight.** One Next.js app, no worker, no queue, no Postgres
if we can avoid it:

```
sealevel-pos/
  app/                    # the counter UI, one route, one screen
  lib/
    mindbody/             # v6 client: Api-Key + SiteId, staff token cache
    roster.ts             # class + roster read model, prefetched
    clients.ts            # in-memory client index for type-ahead search
    cart.ts               # line items, pricing, totals
    payment/
      index.ts            # PaymentMethod interface (the seam option C would use)
      stored-card.ts      # StoredCardInfo
      cash.ts             # CashInfo
      handoff.ts          # option A deep link + sale confirmation poll
      capture-link.ts     # option B hosted card capture
```

No database. The client list is on the order of thousands of rows, so the server
pulls it from Mindbody at boot and on a timer and holds it in memory for
type-ahead search. If we later want it to survive restarts without a cold pull,
Railway gives us Redis or a volume for a JSON snapshot; that is a detail, not an
architecture. Rosters are prefetched per class and held for minutes, not
persisted.

The Mindbody v6 client in ai-manager's `packages/core/src/campaigns/mindbody.ts`
(auth headers, staff user tokens, paging) is worth copying into the new repo as
a starting point. Copy it, do not try to share it: a published package between
two repos for ~200 lines of HTTP is more coupling than it saves. If a third
consumer ever appears, extract it then.

Auth: Clerk if we want teacher-level attribution, or a single studio device
session with a PIN if we do not. See open question 3.

## The speed argument

Mindbody is slow at the counter because every action is a round trip to a
general-purpose UI. Our advantage is that we know, at 6:29pm, exactly who is
about to walk in. So:

- **Prefetch the roster.** When a teacher opens the POS, we load the next two
  classes' rosters plus each student's pass status in one server call, and hold
  them. Tapping a name is instant because the answer was computed before they
  walked in.
- **Search over a local mirror, not the API.** We already sync Mindbody clients
  into Postgres for campaigns. Reuse that table for type-ahead search, so
  finding a walk-in is keystroke-fast instead of an API round trip per letter.
- **Optimistic check-in.** Tap a name, it goes green immediately, the API call
  runs behind it, and a failure surfaces as a rollback banner rather than a
  spinner in the teacher's face. Check-in is idempotent enough for this; a sale
  is not, and sales stay synchronous with a real confirmation.
- **One screen.** Class picker across the top, roster as a single tall list of
  big rows, cart in a right rail that only appears when something is in it.
  Each roster row carries its own status chip and its own primary action, so
  the common case is one tap on the row and nothing else.

Row states and what one tap does:

| Chip | Meaning | Tap does |
|---|---|---|
| green | booked, paid, valid pass | check in |
| amber | booked, unpaid, has card on file | sell the pass + check in, one confirm |
| amber-outline | booked, unpaid, no card on file | opens capture link / handoff |
| grey | not booked (walk-in, found by search) | book + price + check in |
| grey, class full | not booked, no room | add to the waiting list |
| red | waiver missing, or `RedAlert` set | opens the blocking detail |

Two of these carry a nudge rather than a different action: a row whose pass has
`Remaining: 1` says so and offers the renewal, and a row whose history shows a
habitual mat or towel rental says that too.

The target: check-in one tap, pass-renewal check-in two taps, and no path that
requires reading anything smaller than 16px in a hot room.

## The header: counters, and what is behind them

Across the top, three numbers for the selected class: **signed up**, **checked
in**, **waitlist**. A teacher reads these at a glance in the ninety seconds
before a class starts, and they answer the three questions actually being
asked: is everyone here, is anyone missing, is there room.

Two of the three are free. The roster we already fetch gives signed-up (its
length) and checked-in (the count of `SignedIn`), and the class summary
already carries `MaxCapacity` and `TotalBooked`, so capacity costs nothing
either.

**Waitlist costs a call**, and it is not in the roster: it needs
`GET /class/waitlistentries` filtered by `ClassIds`. So it is fetched
conditionally: **if `TotalBooked < MaxCapacity`, there is no waiting list, and
we do not ask.** A class with room cannot have people waiting for it. That
threshold turns the waitlist counter from a per-class call into a call that
only happens for full classes, which at this studio is the minority of slots.
The counter still renders, showing zero, without any request going out.

**Tapping a counter opens the list behind it** in a modal: tap "checked in"
and see who, tap "waitlist" and see the names in queue order. This is where a
teacher answers "is Dennis here yet" without scrolling the roster, and it is
also the only place waitlisted people appear as rows.

One trap: a visit carrying a `WaitlistEntryId` is a **stub**. Mindbody
populates only `ClassId` and `ClientId` on those records, so a waitlisted
person cannot be rendered with the normal row component. Names come from the
same batched client lookup the roster uses.

From the waitlist modal, a name promotes into the class with
`POST /class/addclienttoclass` carrying that `WaitlistEntryId`, which is the
documented way to move someone off a waiting list rather than double-booking
them. And when a walk-in arrives at a class that is already full, the same
endpoint with `Waitlist: true` puts them in the queue instead of failing.

## What the teacher should know about the person in front of them

The counter is a thirty-second conversation, and Mindbody is holding the three
facts that make it a good one. The row expands to show them.

- **"This is your last class."** `GET /client/clientservices` returns `Count`
  and `Remaining` on each pricing option. When `Remaining` is 1, the teacher
  should be told so, and offered the renewal right there, before the student
  walks into the room and the moment is gone. This is the single highest-value
  thing on this list: it converts an expiring pack at the exact moment the
  student is most engaged, and today it is invisible unless someone goes
  looking.
- **"They usually rent a mat."** `GET /client/clientpurchases` is the history.
  If the last several visits carry a towel or mat rental, surface it as a
  prompt so the teacher asks rather than the student having to. This is a
  habit hint, not an upsell: get it wrong and it is noise, so it should need a
  real pattern (say, three of the last five visits) before it shows.
- **"Third visit this week."** `GET /client/clientvisits` gives recent
  attendance. A visit count is a conversation opener and a retention signal
  both, and it costs one call.
- **Notes and alerts.** The client record carries `Notes` and, separately,
  `RedAlert`. `RedAlert` is Mindbody's own "stop and read this" field and
  should be treated as blocking rather than decorative: injury, account
  problem, anything the studio flagged deliberately. Show it on the walk-in
  panel and on the expanded row.

All four are per-client calls, so they are fetched when a row is opened, never
for a whole roster at once. The exception worth considering later is the
last-class prompt, which is valuable enough that prefetching it for the
roster may earn its calls.

## Waiver status

A new student who has not signed the liability waiver is the one case where
the fast path must stop. `Liability.IsReleased` and `Liability.AgreementDate`
on the client record say whether they have.

The API *can* set it: `LiabilityRelease: true` on `POST /client/updateclient`
flips `IsReleased`, stamps the agreement date, and records the staff member as
`ReleasedBy`. That is a one-line implementation and it is the wrong one *if the
teacher taps it*. A liability waiver is a legal artifact, and a staff member
confirming agreement on someone else's behalf produces a record saying the
student agreed when the student may never have read it. That flag is for
recording an agreement that happened, not manufacturing one.

But we can do better than handing off, because **`GET /site/liabilitywaiver`
returns the studio's actual waiver text.** So the whole thing can happen live:
show the real waiver on the student's own phone by QR (or a handed-over
device), they read and agree, and `LiabilityRelease: true` is written on the
strength of a genuine agreement. No Mindbody-hosted page needed, and the
student is signing off the critical path while the teacher serves the next
person. Same QR mechanism as card capture, which is why the two build together.

One gap to design around: **Mindbody does not snapshot what they agreed to.**
It stores `IsReleased`, `AgreementDate` and `ReleasedBy`, and nothing about the
waiver's content or version. If the waiver text is ever edited, there is no
record of which wording any given student accepted, which is precisely the
question that would matter if a waiver were ever tested. So keep our own
receipt: client id, timestamp, and a hash of the exact text displayed. That is
cheap, and it is the first thing in this app that genuinely needs durable
storage of its own.

## Categories

Hardcoded as config in the app, not fetched. `GET /site/categories` does exist
(filed under Site rather than Sale), so this is a choice, and the live response
is what makes it the right one.

**51 categories come back, and the counter needs about five.** Eighteen are
literal placeholders named `Service Category3` through `Service Category20`.
Others are inactive, or accounting artifacts that are categories in Mindbody's
model but never things a teacher sells: Tip, Fees, Shipping & Handling,
Payments on Account, Gift Certificate. Rendering that list at a counter would be
worse than useless.

The meaningful split is `Service` on each record: `true` for passes, classes
and policy items, `false` for retail.

- **Active retail** (`Service: false`): Food/Drink 36, Accessories 32,
  Clothing 26, Skin/Body 27, Books 29, Jewelry 28, Music 31,
  Videos/Instructional 30, Other Products 49.
- **Active service** (`Service: true`): Towel and Mat -14, ClassPass -12,
  Vinyasa -15, Classes 1, Course -11, Teacher Training -5, Posture Clinic -1,
  Virtual Classes -6. Plus policy categories that are never counter items:
  Late Cancel/No Show -7, Auto Monthly Early Cancellation Fee -10, Trade -3,
  and the two "In Studio N Limit" entries.

Proposed counter set, ordered by how often a teacher reaches for it: **Towel and
Mat, Food/Drink, passes, Accessories, Clothing**, with the rest behind a "more".
Five entries of config against 51 fetched, in an order Mindbody's response
cannot express, at no metered cost and with no way to be empty at boot.

Three details from the live response worth keeping:

- **`SubCategories` is empty on every category, and `TotalCount` is 0
  throughout.** The subcategory tree that `/sale/products` can filter on is not
  populated at this studio, so that level does not need building.
- **"sales tax exempt" (100000) is the one `IsSecondary: true` record**, which
  is what `SecondaryCategoryId` on a product refers to. It is the exception to
  the 10.35% tax invariant above, so do not assert that invariant against an
  item carrying it. Note that the obvious candidate is not exempt: parking is
  priced to land on a round $3.00 *including* tax, which is only true if it is
  taxed. That back-solved pricing is itself a useful signal, since an odd price
  like $2.72 or $1.81 is evidence the studio worked backwards from a round
  charged total, and `2.72 x 1.1035 = 3.00` exactly.
- **"CC purchase under $10" (-13)** is the card-minimum policy, and it is live.
  It gets its own section below.

## The $10 card minimum

The studio does not put a card through for less than $10. Under that, the card
is charged $10 and the difference lands on the student's account as credit,
which is what the "CC purchase under $10" category records. **This must be
automatic in the POS.** It is arithmetic a teacher should never do at a counter
with a line, and getting it wrong is either a policy breach or a student
short-changed.

**The rule, and it is not a default the teacher can talk themselves out of:**

1. **If account credit covers the total, the sale is paid entirely with account
   credit.** No card, no minimum, nothing to decide.
2. **Otherwise it is a card, and the card is charged at least $10** -- that is,
   `max(total, 10)`. Anything above the total lands on the account as credit.

Cash and comp are unaffected: the minimum exists because of card processing
fees, so it binds only cards.

The two halves are one mechanism rather than two rules. Rule 2 creates credit
whenever a card runs for a small sale, and rule 1 spends it on the next small
sale. A student who buys a $3 towel is charged $10 once and then covered for
their next two towels with no card at all. Without rule 1 the POS would
accumulate credit it never spends and charge $10 every single time, which is
the failure mode to design against.

This is why the payment chooser does not get to treat account credit as merely
the recommended option. When the balance covers the sale, credit is *the*
method, not the default; the card is not offered.

Open question: **partial credit.** A $12 sale against a $4 balance satisfies
neither branch cleanly. Two readings, both defensible:

- Ignore the balance, charge $12 to the card. Simple, no split tender, but the
  $4 sits there until a sale small enough to consume it comes along.
- Spend the $4, card covers the remaining $8, which the floor lifts to $10, so
  $2 returns to credit. Consistent with the spirit of the rule, but it is split
  tender and it can leave a balance behind on the very transaction meant to
  clear one.

The literal reading of the rule as stated is the first. Worth confirming with
Pete, since partial balances will be common once rule 2 is running.

**The sub-$10 case cannot be made atomic.** The tempting shape, a single cart
carrying the goods and the account credit together, does not exist:
`CheckoutItem.Type` accepts only `Service`, `Product`, `Package` and `Tip`.
Account credit cannot be a line item, so topping up and spending are always two
separate calls.

So there are three paths, and only the third is awkward:

- **Credit covers it.** One call: `checkoutshoppingcart` paid `DebitAccount`.
- **Card, total already $10 or more.** One call: `checkoutshoppingcart` paid
  `StoredCard`. The floor is satisfied by the total itself, so nothing special
  happens.
- **Card, total under $10.** Two calls: `purchaseaccountcredit` for $10 against
  the card, then `checkoutshoppingcart` for the items paid `DebitAccount`.

It is tempting to collapse the last two by always routing the card through
`purchaseaccountcredit`, giving one card path and one place to enforce the
floor. Do not: it would record a $150 membership as a credit purchase followed
by a credit redemption rather than as a card sale, and quietly wreck the
reporting Pete actually reads. The branch is worth keeping.

**The amount is dynamic, not a preconfigured SKU.** `PurchaseAccountCreditRequest`
carries no `Amount` field at all; the figure travels in `PaymentInfo.Metadata`
under the `amount` key, so any value can be charged. We are not forced to $10 by
the API, only by the studio's policy, and if that floor ever changes it is a
config value rather than a rebuild.

That leaves a genuine failure seam: if step 1 succeeds and step 2 fails, the
student has $10 of credit and no towel. Nothing is lost, since the credit
persists and the sale can be retried, but the POS must say exactly that rather
than reporting a flat failure, or a teacher will run the whole thing again and
charge a second $10.

The mitigation is `Test: true`, which exists on checkout: **validate the real
cart before buying any credit.** If the test checkout is rejected, nothing has
been charged and the failure is free. It does not close the window completely,
since the live call can still fail after a passing test, but it turns the
common failure (a cart Mindbody will not accept) into one that costs nothing.

Order of operations, then: test the cart, buy the credit, run the cart for
real, and on a step 2 failure report the credit balance explicitly.

Worth noting the happy path this creates: after a student's first sub-$10 card
sale they carry a balance, so the next one is a single `DebitAccount` checkout
with no card, no minimum, and no seam at all.

Open detail: **is the $10 measured before or after tax?** A $2.72 item is $3.00
charged. The minimum is a card-processing floor, so it should be the charged
amount, but confirm against how the desk does it today rather than assuming.

The seam only exists on the third path, the sub-$10 card sale. The other two are
single calls and cannot half-complete.

## Everything on account: what shows when a student comes up

Account credit is one of the facts that should be on screen the moment a
student's row expands, not something a teacher goes looking for. It is one call
(`GET /client/clientaccountbalances`), and after the $10 rule above it will
frequently be non-zero.

So the expanded row shows, together: the pass and how many classes remain,
account credit balance, recent visits, habitual add-ons, notes and `RedAlert`.
A teacher should be able to answer "what do I need to know about this person"
without a second tap.

## Studio banner

A single line across the top that an admin sets: upcoming workshops, a teacher
training, a schedule change, a special. It exists because the front desk is the
only moment the studio reliably has a student's attention, and right now
whether anything gets mentioned depends on which teacher is on shift.

Deliberately dumb. It is text, set somewhere an admin can reach, shown until it
is changed. No scheduling, no targeting, no per-student logic.

The open question is only **where the text is stored and how an admin edits
it**, and it matters because this app deliberately has no database. Three
options, cheapest first:

1. **An environment variable on Railway.** Zero new machinery. Changing the
   banner means editing a Railway variable and a redeploy, which is a minute of
   work but not something to ask a studio admin to do.
2. **A small admin page in this app**, writing to a file or a single Redis key.
   Needs somewhere to persist, which is the first crack in "no database", but a
   very small one.
3. **A field borrowed from Mindbody**, so it is edited where the studio already
   works and nothing new is stored. Nothing in the API is meant for this, so it
   would mean abusing some other field, which tends to be regretted.

Decided: **start with (1)**, because the banner is worth having before it is
worth an admin UI, and move to (2) when someone other than Pete needs to change
it, or when the database arrives for the waiver receipts, whichever is first.

### On adding a database at all

"No database" was a good default, not a principle, and the cost of breaking it
is smaller than it looks. Railway Postgres is usage-based and a store holding a
banner string, waiver receipts and perhaps shift records runs to a few dollars
a month. The real cost is operational: something to back up, migrate, and keep
from quietly becoming the source of truth for things that belong in Mindbody.

So the rule when it arrives, and it should be enforced rather than assumed:
**the database holds what Mindbody has no home for, and never a copy of what it
does.** Banner text, waiver receipts, shift records, our own settings: yes.
Clients, classes, passes, prices, visits: never, at any point, for any reason
including speed. The client index was already deleted once for exactly this
reason, and a database makes rebuilding it tempting in a way that in-memory
caching did not.

On current planning that lands in Phase 3, alongside the waiver flow.

## API mechanics worth knowing before building

- **Auth.** Sales and arrivals need a *staff* user token, not just Api-Key +
  SiteId. `POST /class/addarrival` requires the staff account to hold the
  `LaunchSignInScreen` permission, and unpaid reservations require the
  "Make Unpaid Reservation" permission. Provision one dedicated API staff
  account with exactly these permissions rather than reusing a person's login.
- **Endpoints.** `POST /class/addclienttoclass` (book, and with `Waitlist: true`
  waitlist, and with `WaitlistEntryId` promote off the waiting list),
  `POST /client/updateclientvisit` `{VisitId, SignedIn}` (check in, and
  reversible), `POST /sale/checkoutshoppingcart` (sell),
  `GET /sale/services` + `/sale/products` (catalog),
  `GET /client/clientcompleteinfo` (pass status, cards on file, waiver,
  notes, `RedAlert`), `GET /client/clientservices` (`Remaining` on each pass),
  `GET /client/clientpurchases` and `/client/clientvisits` (history),
  `GET /client/clientaccountbalances` (account credit),
  `GET /class/classes` (roster), `GET /class/waitlistentries` (waiting list).
  Note that `/class/addarrival` does not exist and arrival is not class
  check-in; see the vendored spec notes in CLAUDE.md.
- **`Test: true` exists on writes too**, not just checkout.
  `addclienttoclass` validates without committing, which is a free rehearsal
  for booking work.
- **Metering.** The API is billed per call, per location, with a modest free
  daily allowance. A naive POS that polls rosters every few seconds will run up
  a bill. Prefetch once per class, refresh on an explicit pull-to-refresh, and
  serve search from our own mirror.
- **Merchant processor.** Answered: Mindbody Payments on Stripe, which is also
  the precondition for the alternative-payment (Apple Pay) endpoints.
- **Never touch a PAN.** No card number, CVV, or expiry may enter our UI, our
  logs, or our database, in any option. This is not a preference: the only two
  API paths that store a card both take the raw number, so honoring this rule
  is exactly what makes a Mindbody-hosted capture surface mandatory rather than
  merely preferable.
- **Metered calls have a shape.** Per-client detail (services, purchases,
  visits, balances) is fetched on row open, never per roster. Waitlist is
  fetched only when a class is at capacity. These are not micro-optimizations,
  they are the difference between one call per counter interaction and thirty.

## Phasing

**Phase 1 — check-in, and knowing who you are talking to.** No money moves, so
there is nothing to reconcile and nothing to break. This alone is most of the
time saved at the door.

- Roster for the classes around now, walk-in search, one-tap check-in and a
  gated check-out. *Built.*
- **Verify check-in against a real class.** `updateclientvisit` is what the
  spec says, but nobody has watched a `SignedIn` flag actually flip. Everything
  else here is scaffolding around this one call, so it is the next thing done,
  in the sandbox, drawer open.
- **Walk-in booking, the money-free half.** `POST /class/addclienttoclass`,
  which needs only `BookClassesAndEventsWithoutPayment`, a permission the
  account already holds. Without it Phase 1 ships a search box that cannot
  complete its own action: it finds a person and then has no visit to sign in.
  Including `Waitlist: true` when the class is full, and promotion off the
  waiting list by `WaitlistEntryId`.
- **Header counters** with the conditional waitlist fetch, and the lists behind
  them.
- **Client context on the expanded row**: last-class-in-the-pack prompt,
  account credit balance, recent visits, habitual add-ons, notes and
  `RedAlert`. All of it visible on one tap, with no second lookup.
- **Waiver state**, shown and blocking. The QR that resolves it is Phase 3;
  Phase 1 shows the problem and hands off to Mindbody.
- **Studio banner.**
- **Categories, hardcoded.** Config in the app, not fetched. See below.

**Phase 1.5 — put it at the counter.** Not a feature, and it is the step that
turns this from a laptop demo into something teachers use. Auth (see open
question 3), Railway, `POS_DEVTOOLS=false`, `POS_DRY_RUN=false`, the mode
banner verified, Add to Home Screen on the studio iPad. Then watch a teacher
work a 6pm rush and fix what they actually hit, before building any of Phase 2.

Until auth exists this app must not sit at the counter: it is an open endpoint
against live student data and, later, live cards.

**Phase 2 — sales.** Cart, catalog with the hardcoded categories, and a payment
chooser covering stored card, account credit, cash, gift card and comp, with
balances read before each is offered and account credit defaulted whenever it
covers the sale. **The $10 card minimum is part of this phase, not a refinement
of it**: a chooser that can charge a card is incomplete until it handles the
floor automatically, and the rule creates the account credit that the default
above then spends. Priced at the in-studio rate, with
`LocationId` and `InStore` set so the server agrees with the screen. Receipt by
email through Mindbody.

The concrete place this lands in the UI is **the unpaid row**. A booking with
no pricing option attached is action 2 from the list above, and Phase 1 can
only offer to let them in for free behind a confirming tap, which is a
stopgap, not the answer. In Phase 2 that row should offer what the moment
actually calls for: sell them the pass their booking is missing, charge the
card on file, and check them in, in one gesture. Free entry stays available
for the genuine comp, but as the deliberate exception rather than the only
option.

The other thing Phase 2 completes is the **last-class prompt** from Phase 1:
Phase 1 can tell the teacher the pack is empty, and Phase 2 can do something
about it in the same gesture.

**Option A, the Mindbody handoff, is cut.** It was scoped here, and it is a
deep link plus a polling loop to confirm an out-of-band sale, for the roughly
one person a day with no card on file. Phase 3 solves that person better and
permanently. Until then the fallback is that the teacher uses the Mindbody app,
exactly as they do today, which costs no code and is exactly as fast.

**Phase 3 — the customer's own phone (option B, plus Apple Pay, plus the
waiver).** One QR mechanism, three outcomes: store a card, pay now with Apple
Pay, sign the waiver. These were three separate ideas and they turn out to be
one piece of work, because all three are structurally the same gesture: put
something in front of the student on their own device, off the critical path,
while the teacher serves the next person.

Prerequisite: re-probe `/sale/alternativepaymentmethods` with `LocationId=98`,
and establish that a per-client hosted card page actually exists and is
reachable. Both are unproven, and Phase 3 cannot be scoped honestly until they
are.

**Phase 4 — only if needed (option C).** Stripe Terminal behind the existing
payment interface, plus the nightly Stripe-to-Mindbody reconciliation job.
Ruled out by the data. Keep the seam, do not build it.

## Open questions to settle first

**1. Which merchant processor, and is API card processing enabled?** Answered.
Mindbody Payments (Stripe), account live, card-not-present enabled, per
payments.mindbody.io. That portal is also where the reader inventory, disputes
and payout reports live; it is a separate login surface from the main Mindbody
app and worth bookmarking.

**Probe run 2026-08-26.** Rungs 1-4 pass against Sealevel Hot Yoga (site 471;
the key also reaches Mindbody's sandbox, id -99, so anything reading `Sites[0]`
reports on the wrong studio). Staff token issues fine for
`sealevelapiuser@gmail.com`, staff id 100000140. The catalog reads: 57 priced
items, 24 services and 33 products, cheapest LMNT Electrolytes at $1.81. Client
lookup and stored-card detection both work.

Rung 2b reads the account's permission group as **"API Sales"**, not IP
restricted, 103 permissions allowed and 80 denied. Five of the six permissions
this POS needs are allowed. One is **explicitly denied: `CreateRetailTickets`**,
the permission to create a retail ticket, which is exactly what
`POST /sale/checkoutshoppingcart` does. That is the blocker: every payment type
fails identically because the cart itself cannot be created, and an explicit
deny overrides anything ticked on the staff member, which is why editing the
staff profile changed nothing.

`CreateRetailTickets` was explicitly denied at first and moving it to allowed
was necessary but not sufficient. With all six permissions allowed (105 allowed,
78 denied) and `Desk staff` ticked on the staff profile, the call still fails
identically. **Permissions are therefore exhausted as an explanation.**

The probe now tries the remaining request-shape variables automatically before
anyone escalates: `LocationId` (the cart sent none, and Mindbody documents the
default as the online store rather than a physical location) crossed with
`InStore` true and false, all in Test mode. If any shape is accepted, the
permissions were fine all along and the cart was simply addressed to the wrong
place. If none is, the request shape is ruled out too.

**Rung 6 reaches the payment layer.** The live charge was rejected with
`Credit card is expired` -- a card validation error, not an authorization one.
The request passed the permission check, built the cart, and got into payment
handling before being turned away on the state of that particular stored card.
So the account is authorized to perform sales through the API and the design's
payment half is sound. The one thing still not strictly proven is that the
charge reaches Stripe and settles, since Mindbody appears to reject an expired
card before sending anything to the processor. Update the card on file (or use
a client with a current one) and re-run `--live` to close that last gap.

**Rung 5 passes.** `POST /sale/checkoutshoppingcart` with
`Test: true` returns HTTP 200 and the server prices the cart at $2.00 for a
$1.81 item. Getting there took granting the API service account, via its "API
Sales" permission group, the six permissions this POS needs -- `MakeSales`,
`UseStoredCreditCards`, `CreateRetailTickets` (which was explicitly *denied*
initially), `AddProductsOnRetailScreen`, `LaunchSignInScreen` and
`BookClassesAndEventsWithoutPayment` -- plus ticking `Desk staff` on the staff
profile. The exact change that flipped it was not isolated.

Two wrong turns worth recording, because both cost a round and both were
reasoning errors rather than missing information:

1. The probe read the permission group as empty and sent us hunting for group
   membership. That was a parser bug: the documented schema wraps the fields in
   `UserGroup`, the live API returns them at the top level.
2. Seeing a product refused at the physical location on permissions but refused
   at the online store on a business rule, the probe concluded the sales
   permission was location-scoped. It is not. Mindbody validates the **item
   first**: a product against the online store is rejected as unsellable there
   before permissions are consulted, so that path never reached the access
   check. The sound comparison holds the item fixed, and a *service* (sellable
   at every location) was refused on permissions at both. A business-rule error
   is not evidence that the access check passed.

One residual: "card-not-present enabled" on the payments account is not
literally the same entitlement as "API credit-card processing enabled for the
Site ID." There is a probe script for exactly this, which walks from free to
definitive and stops at the first rung that fails:

The credentials (`MINDBODY_API_KEY`, `MINDBODY_SITE_ID`,
`MINDBODY_STAFF_USERNAME`, `MINDBODY_STAFF_PASSWORD`) live on the Railway
**worker** service, not the console. Two ways to get them to the script:

    # A. Railway CLI, no secrets on disk
    railway link                     # pick the ai-manager project, worker service
    railway run npm run mindbody:probe-payments -w @ai-manager/core

    # B. Local .env (it is gitignored), copied from Railway > worker > Variables
    npm ci
    npm run mindbody:probe-payments -w @ai-manager/core

Then the three rungs:

    npm run mindbody:probe-payments -w @ai-manager/core
    npm run mindbody:probe-payments -w @ai-manager/core -- you@example.com
    npm run mindbody:probe-payments -w @ai-manager/core -- you@example.com --live

The email is passed bare, not as `--email`: npm has an `email` config of its
own and swallows the flag before the script sees it. It looks the client up and prints which record it resolved to, and
refuses to guess when two records share the address. Use Pete's own account:
the `--live` rung charges whatever card is on file. `--client <id>` names a
Mindbody client Id directly, for the ambiguous case.

`--live` is not fire-and-forget. It prints the client, card last four, item and
amount, then waits for you to type `charge` before anything moves. Anything
else aborts, and it refuses to run at all outside an interactive terminal. The
amount it shows is the total the server came back with on the Test run, not one
we computed, so what you confirm is what Mindbody will actually charge.

Controlling that amount: it defaults to the cheapest priced thing in the
catalog, reading both `/sale/services` and `/sale/products` so retail counts.
The studio's own cheap items make this easy, no special test SKU needed:
parking token $1.00, Liquid IV $1.81, boxed water $2.00, towel and mat rental
$2.72. The probe prints the cheapest five with their ids so `--service <id>` can
name one. `--discount <amount>` also exists, but v6's request-side
`CheckoutItem` carries only `Type` and `Metadata` with no documented price
override, so it may be ignored; the probe says so when the server's total
disagrees with what the discount implied. Prefer picking a cheap real item over
relying on the discount.

Rung by rung: `GET /site/sites` (is a merchant account wired up at all),
`POST /usertoken/issue` (do the staff credentials work), `GET /sale/services`
(catalog readable), `GET /sale/alternativepaymentmethods`, then a `StoredCard`
cart posted with `Test: true`, which validates cart contents without moving
money. That last one is necessary but not sufficient: Test mode may never reach
the payment gateway, so only `--live` (a real charge on the cheapest service,
refunded afterwards in Mindbody) proves the gateway accepts an API-originated
sale. Run the live rung once against a client who has a card on file, ideally
Pete'"'"'s own account. `GET /site/sites` (returns `AcceptsVisa`,
`AcceptsMasterCard`, `AcceptsDiscover`, `AcceptsAmericanExpress`,
`AcceptsDirectDebit`) and `GET /sale/alternativepaymentmethods` are worth
calling on day one too; neither names a processor, but they confirm the merchant
account is wired up and enumerate any custom payment types.

**2. What fraction of transactions involve a card not on file?** Answered above:
0.4% of in-studio sales were swiped, and ~15% of in-studio card sales were a
client's first-ever purchase, about one a day. Option C is dead; options A and B
cover the rest.

**3. Teacher identity. Decided for now: one service account.** The POS acts as
`sealevelapiuser` and records who was on shift on its own side if we ever want
that. Mindbody will attribute every check-in and sale to the service account.
Pete is checking whether that disturbs commission or payroll reporting; if it
does, the fallback is per-teacher staff logins, which is why auth in Phase 1.5
should not assume a single identity is permanent.

**4. Wifi at the counter. Proposed answer: do not build offline.** The design
already forbids queuing a sale. And a queued check-in is exactly the failure
mode that optimistic check-in was overruled to avoid: a teacher looks away
believing someone is in who is not. If the network is gone, say so loudly and
fall back to the Mindbody app. Revisit only if the counter wifi turns out to be
genuinely unreliable in practice.

**5. Where the studio banner's text lives.** A Mindbody field would keep the
"no database" decision intact; anything richer probably breaks it. Unresolved,
and worth resolving before Phase 1 rather than bolting a database on later.

**6. One unchased probe, a prerequisite for Phase 3.**
`GET /sale/alternativepaymentmethods` returned HTTP 400 and was never
diagnosed; the likely cause is the missing `LocationId=98`. Until it answers,
Apple Pay cannot be scoped honestly.

(The other Phase 3 prerequisite, a Mindbody-hosted card page, matters less than
it did: the waiver half of that flow is fully ours to build now that
`/site/liabilitywaiver` returns the text. Card capture still needs a hosted
surface, since we can never take a PAN.)
