# sealevel-pos

Front-desk check-in for Sealevel Hot Yoga teachers. An iPad web app over the
Mindbody Public API v6. Read `docs/design/front-desk-pos.md` before any build
work: it carries the reasoning, the studio's real numbers, and a long list of
Mindbody constraints that were expensive to establish and are not obvious from
the API docs.

## Status

**Phase 1: check-in, and knowing who you are talking to.** **No cart, no
payment, no money.**

Built: roster for the classes around now, `searchText` walk-in search,
pessimistic check-in, gated check-out. Verified against live Mindbody on
2026-08-27: classes, teachers, and pricing options all render from real data.

**Phase 1 is not finished.** Still to build: verifying check-in against a real
class, walk-in booking (`/class/addclienttoclass`), the header counters,
per-client context on the expanded row, waiver state, and the studio banner.
Then Phase 1.5, which is auth plus deployment and is what makes this usable at
an actual counter.

Phase 2 (sales) is unblocked but not started. The sale path was verified with
ai-manager's `npm run mindbody:probe-payments`.

**`docs/PLAN.md` is the execution plan**: ordered work items, what each one is
done when, the probes still to run, and the questions blocked on Pete. Start
there. `docs/design/front-desk-pos.md` carries the reasoning behind every item
in it; read the relevant section before building, since most items have a
constraint that cost real time to establish.

When the two disagree, the design doc is the reasoning of record and PLAN.md is
stale. Fix PLAN.md, and check items off in the same commit that ships them.

## Safety: nothing writes by accident

Two independent guards, both defaulting to safe. Neither is a nuisance to be
removed; this app checks real students into real classes and will later charge
real cards, so reaching production has to be a choice someone made rather than
something they forgot to prevent.

- **Dry run is forced OFF in the sandbox.** Suppressing writes there hides
  whether the write works, which is the one question a sandbox exists to
  answer. `POS_DRY_RUN` only applies to prod.
- **`POS_DRY_RUN`** (default `true`, prod only) lets reads through to Mindbody and
  suppresses every write, logging it as `[dry-run] suppressed POST ...`. That
  exercises the whole flow -- roster, tap, optimistic row, response handling
  -- against real data without touching an account. **This is the mode to
  develop in.**
- **`POS_WRITE_CLIENT_IDS`** is how a write gets tested for real without
  risking a student: create a dummy client in Mindbody, put its id here, and
  with `POS_DRY_RUN=false` every write for anyone else is still suppressed
  (`[write-guard] suppressed ...`). Empty means no restriction, which is what
  production wants.
- **`MINDBODY_TARGET`** picks the studio: `sandbox` (default) or `prod`,
  reading `MINDBODY_SANDBOX_*` or `MINDBODY_PROD_*`; the unprefixed
  `MINDBODY_*` names remain the production fallback.

**The target, and only the target, can also be switched from the drawer**
(T89, Pete: "we also should make it so that it can flip between sandbox and
prod with a setting rather than a redeploy", and, told this relaxes the rail
below: "go"). One `app_settings` row, `mindbody_target`, wins over
`MINDBODY_TARGET` when present; `src/lib/target.ts` loads it into memory at
the top of every `mindbody()` call, so `target()` stays synchronous, and no
database, no row or a row naming neither studio all mean the environment
decides. A store that does not ANSWER is not a switch: the loaded target
stays and the log says so, because a blip must not move a counter onto the
studio `MINDBODY_TARGET` names. A stored target whose credential set is
missing from the environment is ignored, loudly, and the environment
decides. `PUT /api/admin/target` requires ALL of: the device session, the
devtools gate, a signed-in teacher, that teacher's staff id in
`POS_ADMIN_STAFF_IDS` (admin-only, empty means nobody), and both credential
sets present in the environment, which it refuses by variable NAME.
Switching ends every staff session (a token belongs to the site that issued
it), clears the catalog cache, and refuses every write for two seconds
afterwards, so a route that already read one studio cannot post to the
other half way through (`targetSettling`). **Dry run and the write guard did not
move**: they stay in the server environment, so a switch to prod still
writes nothing until `POS_DRY_RUN=false` is deployed.

**A dry run can also be added for ONE browser** (T89): the drawer's "dry run
on this iPad" control sets the `pos_dry_run` cookie, read per request beside
`POS_DRY_RUN`. It can only ADD suppression, never remove it, which is why
anyone with the drawer may use it: the env flag wins, the sandbox still
forces both off, and the worst it does is stop that iPad writing. Suppressed
writes log `(this browser)`, and `/api/config` reports `dryRunSource`.

Mindbody's site -99 sandbox works, but **only with credentials issued for
it**: staff accounts belong to a site, so the studio's own API login
(`sealevelapiuser@gmail.com`, site 471) authenticates against 471 and nothing
else. If the sandbox returns "Site is deactivated" or "Staff identity
authentication failed", that is the credentials, not the site being down.

**The screen says so whenever a tap would not do what a teacher expects**,
and `GET /api/config` always reports the mode in full. The rail is not "always
say where we are", it is that a teacher must never believe a tap was real when
it was suppressed, and never believe it was suppressed when it was real. So
`modeNotice` in `src/app/SaleScreen.tsx` raises the banner, in the same place
and the same treatment it has always had, for exactly four states: the target
is the SANDBOX, the server's dry run is on, this browser's dry run is on
(T89's cookie), and `POS_WRITE_CLIENT_IDS` is narrowing writes to a list. In
ordinary production, live and writing and unrestricted, there is NO banner
(T111, Pete: "let's also get rid of the LIVE. Taps check real students in.
Production site 471. banner at this point. The settings pop up should show
that info enough without polluting the main screen."), which is the state the
counter is in all day. The lock screen follows the same rule from the same
function, so the two screens cannot disagree. Do not add a fifth quiet state:
anything that changes what a tap does belongs in that function, loudly, not in
the drawer alone. The drawer's Settings tab is where the quiet case is written
down: the studio and site in words, whether the target came from the setting
or the environment, the dry run and whose it is, and the write guard.

The cached staff token is keyed by site id, so switching target cannot reuse a
sandbox token against production.

### A teacher's PIN now authorizes three separate things

`CompPurpose` in `src/lib/auth.ts` is `comp` (a discount, T48), `overdraft`
(charging an account past its balance, T94) and, since T112, `override`
(selling a pass Mindbody's own rules refused). The purpose is SIGNED into the
one-shot token and the reader names the one purpose it will accept, so a PIN
typed to discount a sale cannot authorize an override and none of the three
can stand in for another. Two request fields are not a separation while one
value fits both, which is the lesson T94's review paid for; do not add a
fourth purpose by reusing an existing one. Each token is verified before any
Mindbody call and spent once, at `/api/checkout`, before the rehearsal, so a
refusal that reached no cart costs no PIN.

## Locked decisions

- **Web app, not Swift.** Card-present is 0.4% of counter transactions (25
  sales in a year), and the studio's reader is a networked WisePOS E rather
  than a Bluetooth accessory, so native buys nothing. Full argument in the
  design doc.
- **Its own repo, its own Railway service.** Separate from ai-manager, which
  is a back-office worker with a different uptime story and different users.
  The two share an API, not a codebase: `src/lib/mindbody.ts` is adapted from
  ai-manager's client and deliberately not imported from it.
- **A small Postgres, on a charter (superseded "no database", Pete,
  2026-08-30, T29).** It holds what Mindbody has no home for -- waiver
  receipts, bundle config, banner text, promo entitlements -- and NEVER a
  copy of what Mindbody has: no clients, classes, passes, prices or visits,
  not even for speed. `DATABASE_URL` unset runs the app fully on fallbacks
  (code bundles, Notes + log receipts, env banner); a dead database degrades
  the same way, never an outage. Charter enforced in `src/lib/db.ts`. Still
  no client cache: reads go to Mindbody when needed.
- **Nothing auto-charges.** Phase 2 will move money only on an explicit tap.
- **Sandbox and dry run are the defaults.** See above.
- **Pricing and schedule come from the live Mindbody API**, never from a cache
  that could go stale.

## Why it is fast

These three are the point of the app, not incidental optimizations. Do not
undo them without reading the design doc's speed argument.

1. **The roster is prefetched** for the classes around now, so tapping a name
   hits memory rather than the API.
2. **Search goes straight to Mindbody's `searchText`.** One call, 400-900ms,
   always current. Debounced at 350ms with the in-flight request aborted on
   the next keystroke, and a three-letter minimum: at 120ms and two letters,
   typing "dennis" fired four requests in 220ms, which is more calls than the
   index it replaced would have made, and "de" matched 209 people. There was an in-memory index of every client here and it
   was deleted deliberately: the warm-up cost ~30 metered calls per server
   start to save calls on maybe a hundred searches a day, and a six-hour-old
   index cannot contain a client created ten minutes ago, who is exactly the
   walk-in a teacher is searching for. Do not rebuild it by reflex. If search
   ever needs to be instant, cache RECENT clients, not all of them.
3. **Check-in is NOT optimistic**, and this is the one place the speed
   argument was deliberately overruled. An optimistic row goes green on tap
   and corrects itself when the failure returns, by which time a teacher with
   a queue has looked away believing someone is checked in who is not.
   Attendance is worth 300-900ms, so the row spins until Mindbody answers.
   Everything else here stays optimistic.

## Dev drawer

A pill in the bottom-right opens a drawer listing every Mindbody call the
server made: method, path, status, latency, request body, response body,
newest first. Suppressed calls appear too, labelled `dry-run` or
`write-guard`, so it is visible when a write did not go out and why.

Cmd+D (Ctrl+D elsewhere) toggles it, each call has a `copy` button and the
header has `copy all`, so a payload can be lifted off an iPad where there is
no console. Clipboard falls back to a hidden textarea, since
`navigator.clipboard` needs a secure context and `http://<lan-ip>:3000` is not
one.

It is recorded server-side in `src/lib/calllog.ts`, which matters: it shows
what Mindbody actually received and returned, not what our API routes chose
to forward. A call that ran under a signed-in teacher's token (T49) shows
`actor=<staff id>`, and **since T109 the token itself as well**, in full,
in the expanded record and in what `copy` lifts (Pete, told it is the one
live credential on the list: "log staff session tokens. keep card numbers,
CVVs, teacher PINs redacted."). **The gift card barcode id is no longer
struck either** (Pete, same day: "no redactions at all. these are all
things the teacher can see already and i am not worried about it."), which
is what makes three `giftcardbalance` calls tellable apart; T83's
redaction of it, in the query, in a payment's Metadata and in a quoted
refusal, is gone, and so is its half of `scrubSecrets`, so a suppressed
write's server log line names the barcode too. Still struck, deliberately:
card numbers (by key, by 13-to-19-digit shape, either direction), CVVs,
and teacher PINs with their one-shot tokens. Enabled by
`POS_DEVTOOLS=true` or a dev build; `/api/devlog`
404s otherwise, because the records carry client names and booking details
and must not be reachable from the counter iPad.

### Settings tab

The drawer's second tab holds the tunables that have already been wrong once
each: search debounce, minimum query length, result limit, how many hours of
schedule to show either side of now, whether check-in is optimistic, and
whether an unpaid booking needs a confirming tap. They live in the browser's
localStorage, apply immediately, and need no restart. Testing a number should
not cost a commit. Under them, "signed-in teacher" names who is signed in and
runs the T49 permission probe.

Since T89 the tab opens on the Mindbody target: the studio and site in
words, whether that came from the setting or the environment, and, for a
teacher whose staff id is in `POS_ADMIN_STAFF_IDS`, one 64px control that
asks once before switching. Everybody else sees the line and no control.
Under it, the write guard in words (T111: read only, a line and no
control, because with the banner gone in the ordinary production state
this tab is the only place an unrestricted live counter is written down),
and "dry run on this iPad", which turns on a suppression for this browser
only. Under those, since T113, "customer display": whether a second
screen is paired and connected, a six-digit code field with a Pair
button, and Unpair behind one confirm. Anybody who can open the drawer
may use it; pairing decides which SCREEN a waiver appears on, never
whether a write happens.

Anything that decides whether a write reaches Mindbody in the LOOSER
direction -- the server's dry run, the write guard -- is still
deliberately NOT here. Those stay in the server environment where a
browser cannot reach them; a settings panel that could switch off dry run
would defeat the point of dry run. The two T89 controls are the recorded
exceptions, and both are safe in only one direction: the target switch is
admin-only, audited in the log and refuses an incomplete credential set,
and the local dry run can only make this iPad safer.

## Customer display (T113, T114, T115; Phase 2.5)

A second iPad on the counter, facing the student, at `/display`. Design:
`docs/design/customer-display.md`. Built: the plumbing (idle screen,
pairing, the hub in `src/lib/display.ts`, the two SSE routes and
present/cancel/complete/refuse), the ticket scene (T114) and the waiver
scene (T115). The sign-up and the contract are items 5 and 6.

**The display adds zero write paths to Mindbody, and must keep adding
none.** Nothing in `src/lib/display.ts` or under `src/app/api/display/`
imports `mindbody()`. A student's answer is a stored result on a
`display_requests` row; the write happens afterwards from the TEACHER's
iPad, under the teacher's token, through a write route that already
exists, which is what keeps dry run, the write guard, T49 attribution
and T50's refusal applying unchanged.

**A live ticket is the one scene that is REPLACED in place** (T114,
Phase 2.5 item 2). The sale screen mirrors the priced cart as it is
built, so a second `present` of a live ticket while one is up updates it
under the same request id: the display gets one `present` and no
`cancel`, and the post-sale summary takes over the same way. Anything
else holding the screen (a waiver, a sign-up, a contract, a summary
still thanking the last student) wins, and `present` answers 409
`reason: "busy"`, which the sale screen drops WITHOUT telling the
teacher: the mirror is informational and resumes on the next priced
change. The summary's few seconds are enforced by the hub, not by the
teacher's tab, so a closed tab cannot leave one student's ticket in
front of the next. Every figure on that screen is Mindbody's, from
`/api/price-cart` or the checkout answer, and `readTicketPayload`
rebuilds the payload field by field so no client, product or pricing
option id and no card detail beyond the tender's WORD can reach a screen
a student is holding.

**A result is spent BY ID, once** (T115). `consumeRequest` finds a
completed, unconsumed request by its id even when the hub has moved on to
another scene or the process restarted, reloading it from
`display_requests`, which is the one reason that table exists. A request
also carries a SERVER-ONLY half (`private`: the client id and the
waiver's sha256) that is stored under a reserved key in the payload
column and never reaches `sceneFor`, so it cannot travel down the
display's stream.

**The waiver signature's copy to Mindbody is best effort** (T115, Phase
2.5 item 3). The `waiver_receipts` row holds the PNG and its hash and is
the ORIGINAL; `POST /client/uploadclientdocument` files a copy from
`/api/waiver-agree` under the teacher's token, with the client id in the
options so dry run and the write guard apply, and a failure reports
`documentFiled: false` with the reason while the agreement stands. A
SUPPRESSED release does not consume the signature, so a real run later
can still spend it. A waiver the studio edited between the student
reading it and the teacher's iPad recording it is refused outright.

**The `pos_display` cookie grants exactly `/api/display/*`.** It is
HMAC-signed like the device token (`src/lib/displayauth.ts`), carries
only the display id, and `requireSession` never looks at it, so a
browser holding it is 401 everywhere real. A student holds this device;
a cookie that opens the POS must not be on it. Pairing is six
crypto-random digits on the display's screen PLUS a secret it keeps in
memory and never shows, so reading the code over the counter is not
enough to take the cookie. Pairing and unpairing are behind the device
session and a signed-in teacher and deliberately nothing else: a teacher
setting up the counter is the point. The pairing survives a restart only
with both `DATABASE_URL` and `POS_SESSION_SECRET`; without either the
display says on screen that a restart needs re-pairing.

## The API spec is vendored. Use it.

`docs/mindbody-openapi/` holds the full v6 OpenAPI specification, split by
tag (class, client, sale, site, staff, ...), 148 operations with every
parameter and schema. **Grep it before writing any Mindbody call.** Mindbody's
own docs portal requires a login and is unreachable from a sandboxed agent,
which is how this project spent an afternoon inferring endpoint shapes and got
two of them wrong.

    grep -n "^  /" docs/mindbody-openapi/client.yml     # every client endpoint
    grep -n -A40 "updateclientvisit" docs/mindbody-openapi/client.yml

What that spec immediately corrected, after the guesses had already shipped:

- **There is no `/class/addarrival`.** Arrival is `/client/addarrival`, filed
  under Client rather than Class.
- **Arrival is not class check-in.** It logs that a client turned up at the
  studio and takes no `ClassId`. Signing someone into a class is
  `POST /client/updateclientvisit` with `{VisitId, SignedIn}`.
- **Check-in reverses.** `SignedIn: false` undoes it, which the guessed
  design had assumed impossible.
- `/class/removeclientfromclass` and `/class/removeclientsfromclasses` exist,
  for when a booking rather than a sign-in needs undoing.

Refresh it from `github.com/api-evangelist/mindbody` (`openapi/`) if it drifts.
Note that plain `curl` to raw.githubusercontent is blocked by the agent proxy
while `git clone` works, so clone the repo rather than fetching files.

## Mindbody notes that cost real time to learn

- **Permission errors lie about their cause.** "You do not have permission to
  perform sales" is what you get for a missing *cart* permission too. Read the
  group back with `GET /staff/staffpermissions?StaffId=<id>` rather than
  guessing. The live response returns `PermissionGroupName`,
  `AllowedPermissions`, `DeniedPermissions` and `IpRestricted` **at the top
  level**, not wrapped in `UserGroup` as the schema documents.
- **An explicit deny overrides everything.** `CreateRetailTickets` was denied
  in the "API Sales" group while every sales permission was allowed, and no
  amount of ticking boxes moved it.
- **Mindbody validates the item before permissions.** A product refused at the
  online store short-circuits before the access check runs, so a business-rule
  error is *not* evidence that permissions passed. Compare like with like: a
  service is sellable at every location, so service calls are the sound test.
- **`/site/sites` returns the sandbox too** (id -99, "LastSpot") alongside the
  real studio (471). Never read `Sites[0]`; select by configured site id.
- **The studio's `LocationId` is 1** ("Fremont neighborhood, Seattle", tax
  10.35%). `98` is the virtual "Online Store" location, tax 0%, and it is a
  reserved id meaning the same thing on every Mindbody site. There is only one
  physical location, so `LocationId: 1` is a constant, not a choice. Items
  carry both `Price` (in studio) and `OnlinePrice`; carts must be sent with
  `LocationId: 1` and `InStore: true` so the server prices what the screen
  showed. Alternative payments (Apple Pay) support only location 98, and
  therefore only online pricing.
- **`/client/addclientformulanote` is the dated, staff-only note on a
  client** (the Formula Notes tab on the profile), and the right home for
  an internal record per sale: the checkout request carries no notes
  field, so a comp's reason is filed there afterwards (T45), through
  `mindbody()` with the client id in the options so dry run and the
  write guard apply. **Site 471 has Formula Notes disabled** (Pete's
  live probe, 2026-09-04: "This site does not have formula notes
  enabled"), so the record falls back to a T58-signed entry appended
  to the client's `Notes` (T62, `src/lib/formulanote.ts`); the Formula
  Note is still tried first, once per server start.
- **`/sale/sales` filters by date, sale id and payment method, never by
  client.** The client is matched on `Sale.ClientId` after the read
  (`latestSaleId`, T63's `findGuestPassSale`). And **`/sale/returnsale`
  returns a WHOLE sale by SaleId**, only a comp-paid one per the spec,
  with no per-line return: a sale bundling a $0 Guest Pass with the
  monthly autopay cannot have the pass alone returned. T63 reads the
  sale first and returns it only when it is one $0 comp item (Pete's
  rule: never a refund); otherwise the pass stays and the screen says
  so. `PurchasedItem.Id` is the pricing option's ProductId for a
  service, and there is no ClientServiceId on a sale line.
- **A gift card's value comes from its PRODUCT, unless that product is
  editable.** `POST /sale/purchasegiftcard` has no amount field, so a
  fixed product issues a card worth its own `CardValue`. A product with
  `EditableByConsumer: true` prices itself from the `PaymentInfo` amount
  instead: site 471's product 282, "Gift Card (Custom Amount)", carries
  `CardValue: 0` and answered `Value=$37.00 AmountPaid=$37.00` when paid
  $37.00 (T96, two live `Test: true` probes, 2026-09-16). That one product
  is what lets the counter sell any amount, and it is why a zero-value
  product must not be filtered out of `/sale/giftcards` by reflex. **A
  FIXED product may quietly issue a card worth MORE than was paid**: of
  the nine on that site, six followed the payment and three followed their
  own CardValue, with every documented field identical. So every purchase
  is rehearsed with `Test: true` and both `Value` and `AmountPaid` are
  asserted to the cent before anything is charged; a disagreement, or
  either figure missing, refuses the whole ticket.
- **`GET /sale/giftcardbalance` answers 200 with `RemainingBalance: 0.0`
  for a barcode id Mindbody has NEVER HEARD OF.** Not a 404, not a 4xx
  (Pete's live counter, 2026-09-19, T109: three reads of three ids
  invented seconds earlier, each a 200 under 120ms). T95 recorded this as
  an open question and guessed the cautious way round, which made every
  id the app generated read as taken and refused every gift card sale,
  100% of the time. So **zero is FREE and anything above zero is taken**,
  and an answer that settles nothing (a 5xx, a timeout, a 200 with no
  balance or a balance that is not a number) still refuses the sale.
  The price of the rule: that endpoint cannot tell "no such card" from "a
  card spent down to zero", and `purchasegiftcard` RELOADS an existing
  barcode, so a long-dead card could in principle be reloaded. 32^6 is a
  billion ids against a few thousand a studio will ever issue, which puts
  it near one in a million; the alternative was a feature that could not
  be used at all. The full weighing is in T109.
- **A CART will take a gift card's money and sell nothing** (T103,
  four probes ending in two live comped sales, 2026-09-17). A gift card
  product prices as a cart line: the editable custom-amount product at
  **$0.00** (a cart never carries our price, it prices from the
  product's own SalePrice, and that product has none, so it would hand
  out a free card), and a fixed product at its face value with a
  `DiscountAmount` landing correctly ($28.00 / -$10.00 / $18.00). Then
  the sale itself comes back with **`PurchasedItems: []`**: payment
  taken, discount applied, nothing sold, nothing visible in Mindbody's
  UI, and no barcode anywhere. So `purchasegiftcard` is the only route
  for a gift card, which is also the only one that can SET the barcode
  a teacher writes on blank stock, and **a gift card product id must
  never reach a cart line**. A **Comp** payment is refused by
  `purchasegiftcard` outright ("Invalid payment method"), alone or
  beside another payment, so a discount there can only mean paying
  less, and T102's `Test: true` rehearsal of both `Value` and
  `AmountPaid` is what keeps that safe.
- **A payment with no purchased items is not a sale** (T103). A 200
  with a priced total, a taken payment and an empty basket is
  reachable, so every cart checkout is now asserted against what was
  sent, line for line, by the id that was sent and the quantity
  (`assertBasket` in `src/lib/sale.ts`, beside T75's total assertion,
  with the same per-line audit). An empty basket, a missing line or a
  quantity Mindbody itself reported short refuses the whole answer. It
  deliberately does NOT refuse for a line Mindbody ADDED (a sale
  carries lines of its own), for a line whose items report no
  `Quantity` at all (the documented shape for a pricing option, so a
  short count cannot be inferred), for a cart holding a Package line
  (a package can only come back as its components, T30's carve-out one
  level on), or for a sale that was READ and holds none of this ticket
  (that is a lookup that found the wrong sale, not a sale that sold
  nothing). Each of those is logged and stands: a FALSE refusal tells a
  teacher at the counter that the money is gone and nothing was sold,
  which is worse than the bug this rail catches.
  The basket comes from the answer's own `PurchasedItems` when it
  carries one, else from the sale that `latestSale` already reads for
  the numeric id; when NEITHER says what the sale holds the outcome is
  logged `[basket] unverified` and the sale stands, because a refusal
  has to rest on evidence. It cannot un-take the payment, so the
  refusal is its own outcome: money moved, nothing was sold, the sale
  id is named, the same sentence is filed on the client the way
  T45/T62 file a comp's reason, and there is NO retry anywhere in it
  (a retry is a second charge). Everything catchable before the charge
  is caught before it: a gift card product id in a cart line is
  refused by /api/checkout before any Mindbody call, and a gift card
  list that does not answer refuses the ticket rather than waving it
  through.
- **A contract's text arrives as HTML, and a contract can start on a
  chosen day.** `AgreementTerms` and `Description` on `/sale/contracts`
  are written in Mindbody's rich text editor, so they come back with
  tags and entities in them (Pete: "i am seeing html tags in the
  modal"). Every bit of this text is rendered as PLAIN TEXT through
  `src/lib/richtext.ts` `plainText`, which drops `<script>` and
  `<style>` with their contents, and NEVER through
  `dangerouslySetInnerHTML`: it is staff-editable remote content and
  the counter iPad holds a staff session. The waiver goes through the
  same helper. The contract Description is not served to the browser at
  all any more (T99). On the same endpoint, `POST /sale/purchasecontract`
  defers a start: the operation description (sale.yml:1866, NOT the
  field docs) says `ProrateDate` plus `FirstPaymentOccurs: "StartDate"`
  returns "pro-rate amount + contract amount requiring instant payment"
  in the Totals and leaves the rest due on `StartDate`. So the counter
  sends `StartDate`, `ProrateDate` and `FirstPaymentOccurs` together, as
  studio wall-clock strings, and shows the rehearsal's own Total: no
  proration is ever computed here. Starting today sends none of the
  three.
- **The checkout answer carries no ClientService.** After selling a
  pass, the purchase instance (the id `updateclientvisit` and
  `addclienttoclass` take) comes from re-reading `/client/clientservices`
  and matching by ProductId (T25) or by what was not there before and the
  newest `PaymentDate` (T63).
- **Mindbody refuses a pass for the CLIENT, not for a permission, and
  nobody has established that any token escapes it** (T112). "Only new
  clients qualify for this intro series" is the studio's own business rule
  inside Mindbody; the permissions that sound relevant
  (`OverrideAssignedPricing`, `EditSalePriceCountOnRetailScreen`,
  `ApplyCustomDiscountsOnRetailScreen`) are about PRICE, not eligibility.
  `scripts/probe-restricted.ts` asks both halves side by side, the service
  account and a teacher's own token (`POS_PROBE_STAFF_USER` /
  `POS_PROBE_STAFF_PASS`, the environment and never argv), and says which of
  four worlds this is. **Run live 2026-09-19 (Pete, client 100041277, pass
  414): REFUSED under both, in the same sentence.** So no token escapes this
  rule through the API, and the Override is an attempt that will report
  Mindbody's refusal rather than a way through. The one caveat on the record:
  the login used was the studio's own API user (staff 100000140), so
  "a teacher's token" was that account twice; a rule about which CLIENT
  qualifies is not one a permission group plausibly escapes, but a real
  teacher's login has still never been asked. **The SUBSTITUTE priced in the
  same run: pass 555 at $79.00, tax $0.00, for the client 414 refuses.** That
  is what makes Pete's fallback the real path, 414 -> 555 with the price
  matched down to $49.00. The counter's Override is therefore an ATTEMPT and
  never a promise: `POST /api/override-pass` asks ONE `Test: true`
  question under the teacher's token with T49's service-account fallback
  deliberately off, sells nothing, and reports Mindbody's own sentence when
  the answer is no. The flag it arms may only mean "attempt this line under
  the teacher's token"; it never sets a price and never skips a rehearsal,
  T75's total assertion, T103's basket assertion or any other money rail.
  The refused-line notice carries three ways forward, in this order: buy it
  for another client (T90's path, which the refusal used to hide), Override,
  and T100's gift card. **Pete's fallback when no token gets through is a
  SUBSTITUTION**: a different pass, discounted to the refused one's price,
  on the teacher's same PIN. The mapping is shelf configuration
  (`substitutes` in `src/lib/shelfconfig.ts`, edited in the drawer's shelf
  tab), ids only per the T29 charter, and BOTH prices come from the live
  catalog at the moment of the offer (`src/lib/substitute.ts`); matching
  prices can only bring a price DOWN, and either pass missing from the
  catalog means no offer at all. The screen names the substitute and both
  figures before the tap and on the ticket after it, because the receipt and
  Mindbody will say the substitute's name. The whole story is filed on the
  client the way T45/T62 file a comp's reason.
- **Categories live in `site.yml`, not `sale.yml`.** `GET /site/categories`
  exists; grepping only the Sale tag missed it once. `/site/liabilitywaiver`
  (the waiver's actual text) and `/site/paymenttypes` are next to it.
- **The spec's `Metadata` fields are holes, not answers.** `CheckoutItem` has
  only `Type` and `Metadata`, and the vendored spec does not enumerate that
  metadata's keys; it links to a docs page that needs a login. Absence there is
  absence of *documentation*, not proof the capability is missing, and it has
  already been quoted once as "the API cannot set a price in a cart" when the
  Mindbody web app plainly can. When a question lands on an unenumerated
  `Metadata`, answer it with a `Test: true` call and compare the server's
  returned total, rather than by reading. Test mode prices a cart without
  moving money, which makes this cheap.
- **Datetimes are site-local and the offset is ignored, both ways.** Responses
  carry naive strings ("2026-09-02T09:00:00"), and a request parameter is
  read the same way: `StartDateTime=...08:34Z` is 8:34 studio time, not
  UTC. Send wall-clock strings built for `America/Los_Angeles` (roster.ts
  `studioWall`), never `toISOString()`. Sent as UTC, the class window was
  seven hours ahead.
- **Cancelled classes stay in `/class/classes`** with `IsCanceled: true`,
  staff "TBA ." and zero booked. Filter them; the studio's schedule carries
  whole mornings of cancelled placeholder slots.
- **`/class/classvisits` puts the CLASS name in the visit's `Name` field.**
  Reading it showed every roster row as "bikram yoga". Names come from
  explicit client fields, and otherwise from the client index by id.
- The permissions this app needs: `LaunchSignInScreen` (arrivals),
  `BookClassesAndEventsWithoutPayment` (booking a walk-in), and for Phase 2
  `MakeSales`, `CreateRetailTickets`, `UseStoredCreditCards`,
  `AddProductsOnRetailScreen`. Plus `Desk staff` ticked on the staff profile.
  Since T49 this applies to EACH TEACHER'S permission group too, not just
  the service account's: a signed-in teacher's writes run under their own
  token, and since T50 a sign-in is required, so every write route
  refuses with 401 `reason: "staff"` when nobody is signed in rather
  than running as the service account (`requireActor` in
  `src/lib/actor.ts`; reads stay on the service account). A write their
  group refuses is retried once as the service account and says so in
  amber ("Done as the studio account: ..."), except a comp, which is
  refused outright. `GET /api/teacher/probe` reads a signed-in teacher's
  group and Test-prices a cart under their token.

## Conventions

- Next.js App Router, TypeScript strict with `noUncheckedIndexedAccess`.
- Secrets in `.env`, gitignored. Never commit credentials.
- No em dashes in user-facing copy.
- Sized for a hot room and a queue: nothing under 16px, tap targets at least
  64px tall.
- **An amount is never typed into a text field** (T35, confirmed by Pete at
  the counter in T98: the cash pad raises no keyboard "because there are no
  text fields? this is probably ideal"). Every amount, from every source,
  is entered on a keypad, which is what keeps the OS keyboard out of the
  money path. Two fields sit beside a pad and are NOT amounts: the gift
  card's barcode (T83; the studio's scanner types it) and the discount
  pad's reason note and PIN (T43/T48/T71). Card entry keeps the OS
  keyboard on purpose, because that is where Apple's "Scan Credit Card"
  lives; T98 lifts every modal above the keyboard instead (`--vvh`,
  `--vv-top`, `--vv-bot`, `src/app/viewport.ts`).
- **Every colour is a token, in both palettes.** `globals.css` defines the
  palette twice, in `:root` (light) and in the `:root[data-theme="dark"]`
  block, and no hex belongs anywhere else in the CSS or in a component. A
  hardcoded colour sitting next to a themed one is the bug that made the
  check-in chip unreadable twice: the text flipped with the theme and the
  background did not. Since T70 there is no `prefers-color-scheme` query in
  the CSS: `src/app/theme.ts` puts `data-theme` on `<html>` before first
  paint (an inline boot script in `layout.tsx`) from the iPad's setting or
  the sun toggle's stored choice, and each block sets its own
  `color-scheme`, which covers what variables cannot reach (input spinners,
  checkboxes, carets, scrollbars, focus rings). The two `themeColor`
  entries in `layout.tsx` must stay equal to `--bg` in the matching block.
  Token roles (docs/design/mockups/visual-pass/README.md): `--accent` means
  actionable or selected and nothing else, `--gold` badges and counts,
  `--stop` destructive or blocked only. Text on a `--stop` or `--warn` fill
  is `--bg` (white fails in dark). Radius is 0 everywhere; structure is
  drawn with `--rule` (2px) and `--line` (1px), and only modals and
  dropdowns cast `--shadow-lg`. The font is Archivo through next/font.

## Known gaps

- **Check-in is not verified against a real class yet.** It now calls
  `updateclientvisit`, which the spec says is right, but nobody has watched a
  `SignedIn` flag actually flip. Do that in the sandbox first.
- **Walk-in booking is not implemented.** Search finds people, but adding one
  to a class needs `/class/addclienttoclass` and is Phase 2.
- **The unpaid row only offers free entry.** A booking with no pricing option
  attached currently gets a confirming tap and goes in for nothing. That is a
  Phase 1 stopgap: Phase 2 should sell the missing pass against the card on
  file and check them in together, keeping free entry as the deliberate
  exception. See the phasing section of the design doc.

- **The live charge has never fully settled.** The probe reached payment
  handling and was refused with "Credit card is expired", which proves
  authorization but not that a charge reaches Stripe. Re-run
  `mindbody:probe-payments --live` in ai-manager against a client with a
  current card to close this.
- **Teacher attribution is unverified live (T49).** A comp still takes
  the teacher's own PIN in the dialog, every time (T48: stored hashed and
  unique in `teacher_pins`, enrolled through a one-time Mindbody sign-in
  or the devtools-gated admin route). On top of that every teacher signs
  in with their own Mindbody login (T50: required, the full-screen gate
  after the device lock; since T61 the header shows only the account
  icon, and the modal behind it names them and holds sign-out), and
  every write runs under THEIR token so Mindbody
  names them; with nobody signed in, writes are refused (401
  `reason: "staff"`) and the gate comes back. The session lives in
  server memory and, since T78, in the `staff_sessions` table with the
  token encrypted under a key derived from `POS_SESSION_SECRET`
  (`src/lib/staffsession.ts`, `src/lib/staffcrypto.ts`; two hours from
  sign-in since T64), so a restart keeps every teacher signed in when
  that secret and `DATABASE_URL` are set and signs everyone out when
  either is not. Verified live 2026-09-02: the API key issues tokens for
  other staff logins, and a staff token reads its own permission group
  and Test-prices a cart. A token Mindbody refuses as dead mid-write
  ends the session and REFUSES that write (401 `reason: "staff"`, T50
  review); it is never redone as the service account, and the gate
  says so. Still unverified: what Mindbody answers for an
  expired staff token (`isActorTokenDead` reads a 401), and that the
  sales report actually shows the token's staff member. The probe is
  `GET /api/teacher/probe` (the sign-in modal and the dev drawer run it).
- **The waiver document upload is unverified live (T115).** Probe D-B1
  (`scripts/probe-upload-document.ts`) is written and has not been run:
  nobody has watched `POST /client/uploadclientdocument` accept the
  spec's `{FileName, MediaType, Buffer}` shape or seen the file appear on
  a client's Documents page. The signature itself is kept in
  `waiver_receipts`, so a refused upload loses the copy, not the record.
- **Offline behaviour is unhandled.** Phase 1 arrivals could queue and replay;
  a Phase 2 sale must never queue.
- `GET /sale/alternativepaymentmethods` returns HTTP 400, cause not chased. It
  only matters for a payment option the design ruled out.
