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

So: **Swift buys Bluetooth to a reader that handles 0.4% of transactions.** That
settles it. Build the web app.

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

**Correction to an earlier draft of this doc: the API does have a swipe path.**
The v6 `CheckoutPaymentInfo` model's `Type` field accepts, among others:

- `CreditCard` - keyed card (number, exp, cvv, billing address in `Metadata`)
- `StoredCard` - card on the client's account (`amount`, `lastFour`)
- `EncryptedTrackData` - "indicates that this payment item is a swiped credit
  card", with `trackData` in `Metadata`
- `TrackData` - same, unencrypted
- `DebitAccount`, `Custom`, `Comp`, direct debit, gift card

So a magstripe swipe *can* be pushed through the API, if we can get track data
into our app. Three large caveats, in descending order of how likely each is to
kill it:

1. **It probably does not work on Mindbody Payments.** `EncryptedTrackData`
   comes from the era when Mindbody sold P2PE magstripe swipers, and it means
   "track data encrypted under a key the processor can decrypt." Mindbody
   Payments settles through Stripe, and Stripe will not decrypt a swipe injected
   for a Bluefin or TSYS key. The field existing in the model is not evidence
   that this account can use it. This is now the single most important thing the
   processor question decides.
2. **`TrackData` unencrypted is not an option.** Raw track data flowing through
   our iPad and our server puts the whole thing in PCI scope. Off the table
   regardless of whether it works.
3. **Magstripe only.** No EMV chip, no contactless, no Apple Pay, and swiped
   transactions carry worse fraud liability than a dipped chip. We would be
   building 2014 in 2026.

What is definitely still true: the Stripe Terminal readers Mindbody sells today
are paired to the Mindbody business app and cannot be driven from the API, and
there is no Apple Pay token field on checkout. And the data below says the swipe
path is worth 25 transactions a year regardless of whether it is technically
reachable. Noted for completeness, not recommended.

Over the API we can reliably take: stored card on file, cash, gift card and
account credit, comp, and custom payment types.

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

### C. Our own Stripe Terminal reader (ruled out by the data)

The idea: buy a WisePad 3 or S700 on the studio's own Stripe account, take a
real card-present tap in our app, then post the Mindbody sale with
`CustomPaymentInfo` so the pass and check-in still land in Mindbody while the
money lands in Stripe. It would be the fastest new-card path and would bring
Apple Pay to the counter.

It is not worth it. It would serve about 25 transactions a year and $1,377 of
revenue, and the cost is two deposit streams, a nightly Stripe-to-Mindbody
reconciliation job, and a payment type the bookkeeping has to learn to read.
Keep the payment layer behind one interface so this stays possible, and do not
build it.

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
| red | waiver missing or account issue | opens the blocking detail |

The target: check-in one tap, pass-renewal check-in two taps, and no path that
requires reading anything smaller than 16px in a hot room.

## API mechanics worth knowing before building

- **Auth.** Sales and arrivals need a *staff* user token, not just Api-Key +
  SiteId. `POST /class/addarrival` requires the staff account to hold the
  `LaunchSignInScreen` permission, and unpaid reservations require the
  "Make Unpaid Reservation" permission. Provision one dedicated API staff
  account with exactly these permissions rather than reusing a person's login.
- **Endpoints.** `POST /class/addclienttoclass` (book), `POST /class/addarrival`
  (check in), `POST /sale/checkoutshoppingcart` (sell),
  `GET /sale/services` + `/sale/products` (catalog),
  `GET /client/clientcompleteinfo` (pass status, cards on file),
  `GET /class/classes` (roster).
- **Metering.** The API is billed per call, per location, with a modest free
  daily allowance. A naive POS that polls rosters every few seconds will run up
  a bill. Prefetch once per class, refresh on an explicit pull-to-refresh, and
  serve search from our own mirror.
- **Merchant processor.** API credit-card processing only works on
  API-supported processors (TSYS, Bluefin, Elavon, Paysafe, Ezidebit, Adyen).
  Confirm which one Sealevel is on before writing a line of payment code.
- **Never touch a PAN.** No card number, CVV, or expiry may enter our UI, our
  logs, or our database, in any option. That constraint is what makes A, B, and
  C the only three designs on the table.

## Phasing

**Phase 1 — check-in only.** Roster, search, one-tap arrival, waiver flag. No
money moves, so there is nothing to reconcile and nothing to break. This alone
is most of the time saved at the door, and it is a week of work rather than a
month. Ship it, watch a teacher use it during a 6pm rush, fix what they hit.

**Phase 2 — sales on file + cash.** Cart, catalog, `StoredCardInfo` and
`CashInfo` checkout, receipt by email through Mindbody. Handoff (option A) for
everything else.

**Phase 3 — card capture (option B).** The QR/SMS hosted capture flow, so
"no card on file" becomes a 20-second self-service step off the critical path
instead of a queue.

**Phase 4 — only if needed (option C).** Stripe Terminal behind the existing
payment interface, plus the nightly Stripe-to-Mindbody reconciliation job.

## Open questions to settle first

**1. Which merchant processor is the account on, and is Payments API access
enabled?** Still open, and it gates options A and B. Mindbody has reorganized
its settings more than once and there is no "Merchant Account" menu in the
current UI, so lead with the routes that do not depend on finding a screen:

- **The bank deposits.** The ACH descriptor on the studio's bank statement names
  whoever is actually settling the money. If it reads Mindbody, the account is
  on Mindbody Payments (Stripe underneath) and options A and B are both live. If
  it names TSYS, Elavon, Paysafe, Bluefin, Ezidebit or Adyen, still supported for
  API processing. Anything else means no API card processing at all, and the
  whole payment half of this design collapses to cash plus handoff. This costs
  one look at a statement and answers the question outright.
- **Ask Mindbody support or the account rep**, in one message, two questions:
  which processor is the merchant account on, and is API credit-card processing
  enabled for our Site ID. Those are separate entitlements and support has to
  answer the second one regardless, so ask both at once.
- **Empirically, once we have API credentials.** A $1 sale to a test client with
  a stored card either clears or comes back with a processor-not-supported
  error. Definitive, costs a dollar, and it tests the exact code path we care
  about rather than a claim about it.
- **Is there an API endpoint that just tells us?** No. Nothing in v6 names the
  merchant processor. The closest signals: `GET /site/sites` returns
  `AcceptsVisa`, `AcceptsMasterCard`, `AcceptsDiscover`,
  `AcceptsAmericanExpress` and `AcceptsDirectDebit`, which tell us whether a
  merchant account is wired up at all and for which brands (all false means no
  card processing, full stop), and `GET /sale/alternativepaymentmethods`
  enumerates the custom payment types configured for the site. Neither names the
  processor. Worth calling both on day one anyway, since they are cheap and they
  bound the problem.
- **In the app, if you want to look:** the payments/payouts area of the newer
  Mindbody dashboard is where Mindbody Payments account details live. I could
  not verify the current menu path, so treat this as "poke around Payments"
  rather than a recipe.

The reporting vocabulary in the export (Keyed-vs-Swiped tagging, Apple Pay as
its own payment method) is the newer Mindbody Payments stack rather than a
legacy gateway, which is a hint the account is already on Mindbody Payments. A
hint is not a confirmation. Confirm before writing payment code.

**2. What fraction of transactions involve a card not on file?** Answered above:
0.4% of in-studio sales were swiped, and ~15% of in-studio card sales were a
client's first-ever purchase, about one a day. Option C is dead; options A and B
cover the rest.

**3. Teacher identity.** Do teachers each get a Mindbody staff login, or does
the POS act as one service account? The service account is much simpler, and the
POS can still record who was on shift on its own side. Confirm with Pete that it
does not break commission or payroll reporting first.

**4. Wifi at the counter.** What happens mid-sale when it drops? Phase 1 can
queue arrivals offline and replay them. A sale must never be queued: if the
network is gone, the POS says so and the teacher falls back to the Mindbody app.
