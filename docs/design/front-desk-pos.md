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

## The card-present problem (the honest answer)

**The physical reader cannot be driven from the API.** Mindbody Payments runs on
Stripe Terminal underneath, and the supported readers (Stripe Reader M2,
WisePad 3, BBPOS Chipper 2x) are paired to the Mindbody business app. Mindbody's
own support docs say the mobile reader "can only be used to process payments
using the Mindbody business app; it can't be used as a card reader from the
Point of Sale screen." There is no card-present endpoint in the Public API, no
way to hand a Stripe Terminal `PaymentIntent` to Mindbody's merchant account,
and no Apple Pay token field on checkout. Anyone who tells you otherwise is
describing card-not-present entry with a keyed PAN, which we will not do
(it drags the iPad into PCI scope).

So a POS we build can take, over the API:

- stored card on file (`StoredCardInfo` on `POST /sale/checkoutshoppingcart`)
- cash / check
- gift card and account credit
- comp
- custom payment types, if enabled for the site

and it cannot take a tap/dip/swipe of a card that is not already on file.

Three ways to close that gap. Recommendation is A + B for v1.

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

### C. Our own Stripe Terminal reader, recorded in Mindbody as a custom payment

Buy a WisePad 3 or S700 against the studio's own Stripe account, take a real
card-present tap in our app, then post the Mindbody sale with
`CustomPaymentInfo` ("Stripe Terminal") so revenue, pass, and check-in all land
correctly in Mindbody while the money lands in Stripe. Fastest possible new-card
path, real card-present rates, Apple Pay works.

Cost is real: two deposit streams to reconcile, a nightly job to match Stripe
payouts against Mindbody custom-payment lines, and Mindbody's own reporting shows
those sales under a payment type the studio has to learn to read. Do not build
this in v1. Build it only if, after a month of A + B, new-card sales are still
the bottleneck. The design below keeps the payment layer behind one interface so
C is an addition, not a rewrite.

## Shape of the thing

**iPad web app (PWA), not Swift.** Reasons, in order: we ship from the same
Next.js console we already run on Railway, so there is no App Store review
between a bug and its fix; teachers get it by opening a bookmark, no MDM, no
provisioning profiles, no device enrollment for a rotating cast of contractors;
and everything the POS needs (Mindbody v6, our Postgres, Clerk) is already
server-side in this monorepo. Add to Home Screen gives it a full-screen icon
that is indistinguishable from a native app at the counter. The one thing a
PWA costs us is direct Bluetooth to a Stripe reader — which only matters in
option C, and Stripe's S700 is a networked smart reader that a web app can drive
over the internet, so even that is covered.

If option C ever becomes the main path and we want the M2 over Bluetooth, that
is the moment to consider a thin Swift shell around the same web UI, not before.

```
apps/console/src/app/pos/          # the counter UI, its own layout, no console chrome
packages/features/src/pos/
  roster.ts                        # class + roster read model, cached
  clients.ts                       # local fuzzy search over the synced client mirror
  checkin.ts                       # arrival + booking
  cart.ts                          # line items, pricing, totals
  payment/
    index.ts                       # PaymentMethod interface -- the seam for option C
    stored-card.ts                 # StoredCardInfo
    cash.ts                        # CashInfo
    handoff.ts                     # option A deep link + sale confirmation poll
    capture-link.ts                # option B hosted card capture
packages/core/src/mindbody/        # promote the existing campaigns/mindbody.ts client here
```

The Mindbody client in `packages/core/src/campaigns/mindbody.ts` already handles
Api-Key + SiteId headers and staff user tokens. Promote it to
`packages/core/src/mindbody/` and grow it; do not write a second one.

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

1. Which merchant processor is the account on, and is Payments API access
   enabled for the Site ID? This decides whether B is available at all.
2. What fraction of front-desk transactions actually involve a card not on
   file? Pull it from the analytics mirror before deciding how hard to fight
   for option C.
3. Do teachers each get their own Mindbody staff login, or does the POS act as
   one service account and attribute the sale to the signed-in Clerk user? The
   second is simpler; confirm it does not break commission or payroll reporting.
4. Studio wifi at the counter: what happens mid-sale when it drops? Phase 1
   can queue arrivals offline; a sale must not be queued.
