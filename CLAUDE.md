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

**Newest (T220, 2026-11-14): a Mindbody promotion code can be applied at
the counter**, on the Cart screen and in the roster's "Pay and check in",
for the $28-off codes on pass 581 the studio is emailing returning
drop-ins. **Probed live on prod (2026-11-14): Mindbody honours a code on
the `Test: true` rehearsal ($49.00 -> $21.00, T75 agreeing) and pricing does
not spend a one-use code.** **And sold for real** (sale 428528, dummy
client 100042041, $21.00 cash, Mindbody's line: $49.00 less $28.00).
Owed: the code reads as spent afterwards, and whether 581 refuses a
client who already bought it (see Known gaps).

**T221 (2026-11-14): passes a client cannot buy are greyed out before the
tap**, on the Cart screen and in the roster's pay dialog, with Mindbody's
own reason. Driven live against site 471 on 2026-11-14 (Cart screen, dummy
client John NewGuy): 414, 478 and 581 greyed with Mindbody's reasons, a tap
put nothing on the ticket, Drop In still priced.

**T238 (2026-11-15): the $10 card minimum is retired** (Pete: "that is an
old policy! ... change it so any amount can be charged"). A stored card, a
typed card, a split's card leg and each cart of a typed-card ticket are
charged exactly what they pay in ONE `checkoutshoppingcart`; no card sale
buys account credit, and only a card charge of nothing is refused
(`cardChargeable` in `src/lib/sale.ts`). The roster's pay dialog still
defaults to a balance that covers the total, with the card offered beside
it, and since T239 the Cart screen starts the same way: one account-credit
line for the whole total, put there only while the teacher has touched no
tender, removable with its X and replaced by the first other tender tapped.
Since T240 a discounted total gets it too (only a full comp leaves it off),
it is never judged on a balance being re-read (a refetch in flight freezes
it), and a refused charge's reported balance is keyed to its client, cleared
with the tender, and loses to any profile read begun after it.
**T280 (2026-11-22) turned the Cart screen's automatic line OFF** (Pete:
"account should not be selected on its own, teacher should have to select
it"; `AUTO_ACCOUNT_LINE` in `SaleScreen.tsx`); the roster's pay dialog
still defaults to a covering balance. The Cart screen's tiles are now Card
on file ("****7311", only with a client) first when there is one, else the
Card reader ("Cards, Apple Pay, Google Pay", Square's mark), then Cash,
Manual card entry (T93's typed card, always its own tile since T283), Gift
card, and Account last.
`purchaseCredit` is kept, unreached, for Phase 4's gift card (PLAN
T232). The design doc's "$10 card minimum" section is reasoning of record
only. **T297 (2026-11-23): a 2.6% card processing fee on card sales under
$10** (Pete: "we already have a sign at the front desk stating that will
happen"), on the card on file, Manual card entry and the reader alike,
and NOT on a reader card Square reads as DEBIT. Mindbody takes no price
on a cart line, so the fee is a retail product the studio creates at
$0.01, tax exempt, sold at a quantity of cents (`POS_CARD_FEE_PRODUCT_ID`;
unset, there is no fee; `src/lib/cardfee.ts`). The Cart screen adds and
removes the line with the tender; `/api/checkout` refuses it anywhere
else or at the wrong quantity; on reader debit it lowers the Square hold
by the fee before the sale. Not on discounted, override, gift card,
credit or T90 tickets. Driven against the fakes only.

**T298 (2026-11-23): a promotion code on every sale for a run of days**
(Pete: "starting today i want BLACK26 promo code to be entered for all
purchases, thru 11/30"). An admin sets the code and its first and last
day in the drawer's Settings tab (`app_settings.auto_promo`, else
`POS_AUTO_PROMO`; `src/lib/autopromo.ts`); `/api/config` serves today's
as `autoPromoCode`, and the Cart screen and the roster's Pay and check
in fill it in as if typed, so T220's rules judge it unchanged. It yields
quietly to anything a code cannot sit beside, Remove keeps it off for
that ticket, and a ticket Mindbody does not apply it to says so in one
muted line. BLACK26 is 15% off passes, memberships, Clothing and
Accessories (rentals included), and nothing off Food/Drink or Other
(read live with Test pricing; tax is recomputed on the discounted
price). **The card fee's product must sit in a category the code does
not cover**, or the code would discount the fee's cents and the
checkout would refuse the fee's quantity.

**Next (planned 2026-11-15, vendor changed 2026-11-21, not started):
Phase 4, the studio's own card reader, a Square Terminal** driven through
Square's Terminal API (Pete: "let's go with square"), so a student can pay
by chip, tap, Apple Pay or Google Pay at the counter (teachers report lost
sales without it). Work items in `docs/PLAN.md` Phase 4, in this order:
T274 first, a `sale_log` row for every money tap on every route, checked
against Mindbody daily (Pete: "just log every transaction to the DB");
then T222 to T229, a working flow on Square's sandbox before hardware;
then T275 to T278, **outage mode**: while Mindbody is down the counter
sells as normal from the last catalog in memory on the Terminal or in
cash, and each sale is queued and posts itself when Mindbody is back.
When THIS app is down, the teacher uses the Mindbody app and the existing
reader. Blocked on Pete for the Square account (P6) and the Mindbody
custom payment method (P7).

**T274 (2026-11-22): every money tap is logged and read back against
Mindbody** (Pete: "just log every transaction to the DB ... verify MB is
recording what we want it to"). `sale_log` (migration 20) gets one row per
tap on `/api/checkout`, `/api/purchase-contract`'s live purchase and
`/api/guest`, opened before Mindbody is asked and closed with exactly
what the iPad was told (`src/lib/salelog.ts`; in checkout through T113's
`record`/`recordThrow`). The request is a whitelist and the answer is
stripped: no card or gift card number, CVV, expiry, PIN or token, ever.
A dead database never blocks a sale (`NOT STORED` in the `[sale-log]`
line). `src/lib/salecheck.ts` reads each sale that stood back by id
(READS ONLY) and compares lines and money; the first sign-in of each
studio day runs it, and an admin's "Sales log" in the account modal shows
the day, the problems and a "Check now", with a gold count on Profile.
Driven against the fake only.

**T223 to T225 (2026-11-22): the Square card reader, up to a hold,
behind a switch that is OFF by default** (`card_reader`, admin, drawer
Settings; `POS_CARD_READER` without a database). `src/lib/cardreader.ts`
(switch, test or live mode, env by name), `src/lib/square.ts` (the
client), `reader_payments` (migration 21) and `src/lib/readerpayment.ts`
(the compare-and-set state machine and its sweep), and `/api/reader/*`:
pair a Terminal by code, put a rehearsed total on it as a HOLD, poll,
cancel. **T226 to T231 (same day)**: `/api/checkout` `method: "reader"`
claims an approved hold only when the row and a fresh Square read agree
with the sale to the cent, sells under the custom payment method, then
completes the payment; a refusal, suppression or empty basket releases
the hold, no answer looks for the sale for ~25 seconds and otherwise
keeps the hold for an admin to settle on the Sales log (charge only
against a sale Mindbody shows, release only when it shows none). The
Cart screen's "Card reader" tile and the roster's "Use the card reader"
share `useReaderPayment` and `ReaderWait`; "Connect card reader" is in
the account modal; the customer screen says "Paying by Card reader";
the Sales log matches Square's payments against ours. Driven against
the fakes in a browser, and the hold/complete/cancel half against
Square's real sandbox (R6). **Sold live on 2026-11-22** (sale 429494,
$2.00, Pete's own card, method 18 "Square Terminal"). **T286 (same day)
takes a teacher's discount on the reader**: the hold is the discounted
total and the checkout files the discount as for any tender. **T287: a
Cancel waits for Square** and never sells after it: the screen says
"Square confirmed nothing was charged" only once the checkout is
cancelled and any approved payment voided. Still owed: splits, T90
tickets, gift cards and refunds.

**T241 (2026-11-15): the student chooses how to pay on the customer
iPad**, and can type their own card there (Pete: "a student shouldnt have
to hand them their card"). See Customer display below. **Switched OFF by
T291 (2026-11-23, Pete: "let's do away with the customer choosing the
payment method")**: `STUDENT_CHOOSES_TENDER = false` in `SaleScreen.tsx`
and `page.tsx` builds no offer, so the customer screen shows no Change
and no student-typed card; the machinery below is kept for the constant
to bring back.

**T250 (2026-11-17): the roster's "Pay and check in" can charge the
account past its balance** (Pete: "if the client has no account balance,
the teacher needs the ability to override and give them a negative
balance"). T94's overdraft, in that dialog: a "Charge to account" block
with "Balance after: -$X.XX" and a 64px control that opens the shared PIN
pad with the `overdraft` purpose; a match arms it for THAT ticket (client,
pass, code, total) and the charge sends `method: "credit"` with
`overdraftToken`. No server change. A balance read that failed offers no
PIN. **Verified live by Pete, 2026-11-17** ("works"): the account was
charged past its balance with the teacher's PIN and Mindbody accepted it,
which also settles T94's open question. **T252: that dialog now keeps a charge that may have moved money**
(see the T249 section), and **T253 moved the authority for that to the
server**: `/api/checkout` holds each client of a charge AHEAD of running
it and refuses a held client from any iPad until the charge has answered
and anything it may have moved has been acknowledged (see "A charge that
may have moved money holds the client").

**T245 (2026-11-17): the roster's trash offers "Late cancel"** (Pete:
"when they press the trash can it should pop up a 'late cancel/no show'
option", and "all we do is mark them Late Cancel in the Mindbody UI ...
and no we do not take a class away, that is all we do"). The trash on a
row that is not checked in, on a class ahead, running or over, opens a
choice of two 64px buttons: "Cancel booking" (`/api/cancel-visit`,
unchanged) and "Late cancel" ("Marks it in Mindbody as a late cancel.";
Pete removed "No fee, nothing taken off their pass." on 2026-11-18). Late cancel is `POST
/api/late-cancel`, which sends ONLY `{VisitId, Execute: "Latecancel"}` on
`/client/updateclientvisit` under the teacher's token (`requireActor`),
with the client id for dry run and the write guard; Undo on the row sends
`Execute: "Unlatecancel"` the same way. Never `removeclientfromclass` with
`LateCancel` for this: that removes the booking, which the studio does
not do. Pessimistic: the row spins until Mindbody answers, and a 4xx is a
409 `reason: "refused"` whose sentence the dialog (or the row, for Undo)
shows with nothing changed. A late-cancelled visit stays on the roster
(`lateCancelled` on `RosterEntry`, from the visit's `LateCancelled`),
greyed, its chip reading "late cancel", with no check-in, trash, pass
change or guest action, and is left out of the "signed up" counter;
search names it "late cancel". **Mindbody enforces the studio's late
cancel window**: probed on prod (2026-11-17, dummy client 100042041,
visit 1305809, class at 18:00 the same day, run about 6:00 AM), a
Latecancel that far ahead was refused "Cancellation is outside allowed
window." and nothing changed. **After the class it is accepted**
(same visit, 2026-11-17 19:46, class over, never checked in):
`Latecancel` answered `LateCancelled: true`, `AppointmentStatus`
"NoShow" -> "Cancelled", pass 567229 still attached with Remaining
unchanged; `Unlatecancel` put it back to "NoShow", `LateCancelled:
false`, pass unchanged. So marking a no-show afterwards, the studio's
practice, works through the API. The window's size before a class is
still unseen. Late cancel stays offered on rows ahead of the class all
the same: Mindbody decides. Probe: `scripts/probe-latecancel.ts`.

**T242 (2026-11-17): the unpaid row's "Pay and check in" opens on the
student's OWN passes** when they hold any that may pay for this visit
(Pete: "there should be an option to use one of their exisiting passes
when they have one"): only those passes, each with a 64px "Use this pass
and check in", and "Buy a pass instead" for T25's purchase view,
unchanged. **The list is built from READS ONLY** (`GET /api/visit-passes`,
`src/lib/visitpasses.ts`, a signed-in teacher, the visit must be this
client's): current passes with a class left, less guest passes, less a
pass whose `Program` is known and differs from the class's known
`ClassDescription.Program` (either unknown keeps the pass). **Never ask
Mindbody with `Test: true` on `updateclientvisit`**: nobody has seen it
honoured there, and if it is not, every check is a real reassignment of a
real student's visit on the service account (the T242 review removed
exactly that). The real assignment's refusal, in Mindbody's words with
nobody checked in, is the backstop. The tap is `/api/visit-payment` then
`/api/checkin`, the existing routes under the teacher's token,
pessimistic, no money and no approval; a refused or suppressed assignment
checks nobody in, and after a failed check-in (or an assignment with no
answer) nothing else in the dialog writes until the row is checked. Only
a 4xx is a refusal: `/api/visit-payment` now answers 409 `reason:
"refused"` for Mindbody's 4xx and 502 for anything else (a 5xx, the
timeout), which the dialog treats as "may have landed": locked, nothing
offered again, the roster refreshed. It checks in only when Mindbody's
answer names the pass asked for (`appliedClientServiceId`, from
UpdateClientVisitResponse.Visit) or names none. The visit is read on
EVERY unpaid open, whichever view opens: a visit that is someone else's,
gone from the class, or already paid holds Charge, free entry, "Cart and
check in", "Buy a pass instead" and every "Use this pass", with the
reason and a roster refresh, and nothing writes while that read is out. The
student may pick on the customer iPad too ("Your passes", below); the
first tap from either side wins (`payFlight`).

**T255 (2026-11-09, PR #7, merged with main 2026-11-17): item search
on the Cart screen, a split of up to four parts with several cards, and
a whole-sale tender that survives a discount.** A search row above the
grid filters the loaded catalog and gift cards, no Mindbody call. A
split may carry the saved card and any number of typed cards beside the
account, cash and a gift card (`MAX_SPLIT_LEGS` 4 in `/api/checkout`,
every method once except `typedcard`, at most one kept on file), still
ONE `checkoutshoppingcart`, each card leg charged exactly what it pays
(T238); with the total covered, a further part opens at $0.00 and takes
its amount from the part before it. A line one tap took for the whole
sale (`whole` on `TenderLine`) follows the total through a discount. A
card the student typed on the customer iPad still pays the whole sale
alone. Never met live Mindbody: several `CreditCard` entries in one
call, so **a 4xx on a split with two or more card legs is answered
AMBIGUOUS** (T253 hold, "may have gone through", no retry) until probe B8
says whether Mindbody releases card A when card B declines; a split
with one card or none refuses as before. A non-cash part can be typed
only as high as leaves the part it takes from a cent, and change on the
screen is CASH change only. Pete's gift card "missing key account" bug
is NOT fixed (probe B7).

**T256 (2026-11-18): account credit at the counter** (Pete: "we need to
add the ability to add credit to a student's account"). "Add credit"
under Retail puts a keypad amount on the ticket as "Account credit",
untaxed, alone or beside ordinary lines; never beside a gift card, a
line for someone else, a discount or a promotion code, never on the
walk-in client. The API cannot price the studio's ADD CREDIT item in a
cart (nineteen Test shapes, all $0.00), so it is
`/sale/purchaseaccountcredit` with ONE tender (cash, card on file, typed
card; never the account or a gift card), rehearsed with `Test: true` and
checked after on AmountPaid, the sale's ONE "account adjustment" line
(read by `request.saleId`) and a fresh balance. A mixed ticket buys
credit for the WHOLE total on the tender, then sells the lines from the
account (`DebitAccount`); a step 2 that fails after step 1 is a partial
("their $3.99 is on the account"), held by T253. **Never undo credit with
`/sale/returnsale`**: it refunds to the account, so nothing moves.
Verified on the fake; owed live: one real mixed sale (PLAN B9).

**T257 (2026-11-18): the client profile shows "Recent purchases", each
with "Void in Mindbody"** (Pete: see a student's recent sales, "with a way
to void one"). The API cannot void (T256), so the 64px control is a link
that opens Mindbody's own void page,
`clients.mindbodyonline.com/app/clients/<UniqueId>/account-details/void-edit?saleno=<SaleId>`,
in Safari, where the teacher signs in themselves; coming back to the app
reads the list again, so a voided sale drops off. `GET
/api/client-purchases` (device session and a signed-in teacher) reads
`/client/clientpurchases` over a studio-local window (30 days, up to 90),
groups the lines by sale, and passes payments as type and amount only.
READS ONLY, nothing stored. A void link is offered only when one record
holds the client id and its UniqueId is known (T114); a shared id lists
the sales with a sentence and no link. Driven against the fake; the link
opening Safari from the Home Screen app is not yet seen on an iPad.

**T259 (2026-11-19): account credit can be GIVEN at no charge** (Pete,
after Maran's $10 met "Account credit cannot be discounted", T258). The
Add credit keypad has a 64px "Give at no charge": the teacher's own PIN
for the new `credit` purpose and a REQUIRED reason (3 to 200 characters,
T211's pad with its own words, "Why is this credit free?") arm it for THAT
amount and THAT client. The ticket then holds that one line alone,
"Account credit (no charge)", total $0.00, no tender, Finalize reads "Give
$10.00 credit"; a client change or another line takes the line off, and a
new amount on the keypad is ordinary paid credit. `/api/checkout` takes
`accountCredit: { amount, noCharge: { token, reason } }`
(`src/lib/nochargecredit.ts` for the rules, `src/lib/nochargecreditsale.ts`
for the sale): only the credit line, a real client (never the house
client), $0.01 to $200.00 (a slip-of-the-keypad cap, said so), the token
verified and spent before any Mindbody call. It is `purchaseaccountcredit`
paid `{Type: "Custom", Metadata: {Amount, Id}}` with the id of the type
NAMED "Other" on `/site/paymenttypes` (cached an hour; 9 only when that
read fails; a list with no "Other" refuses), rehearsed with `Test: true`
and then checked as T256 credit is: AmountPaid, ONE sale line of the
amount, a fresh balance delta, any miss ambiguous and held (T253); a sale
not yet readable by id leaves the line check unverified, as T256's does,
and AmountPaid and the balance delta still decide. Off prod, a
`/site/paymenttypes` read that fails refuses rather than guess 9. Never
Comp (refused) and never type 7 "Comp/Guest" (passes Test, refused for
real, T258). Dry run and the write guard apply, and a suppressed write
hands the PIN back. No customer approval and nothing on the customer
screen: nothing is charged to them. After it stands, "Credit $10.00 given
at no charge by <teacher> at the counter: <reason>" is filed the T45/T62
way; a filing that fails is said on the done screen ("$10.00 credit given.
Balance now $X") and never undoes the credit. Driven against the fake
only; no real Mindbody call was made for it.

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
  production wants. **On the deployed app it stops the WHOLE STUDIO**: one
  Railway service serves every iPad, so with it set no teacher can check a
  real student in or sell to one. On 2026-11-22 it was suggested for a
  card reader test without saying so, and it stopped a teacher's check-ins
  mid-class (Pete: "NEVER DO THAT AGAIN"). Set it on prod only when the
  studio is closed, and remove it (unset, not empty) straight after.

**Before suggesting ANY change to the live app** -- a Railway variable, a
drawer switch, a pairing, a deploy -- say in the same message what it does
to the iPads at the studio right now, and whether it is safe while a class
is running. Every iPad shares one server and one database, so almost every
setting is studio-wide.
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
other half way through (`targetSettling`). **The drawer is the ONLY
door** (T215, Pete: "The production and sandbox options shouldn't be
there, that should just be in settings"). T212 had put a studio choice
on the sign-in gate, so a counter on a studio nobody could sign in to
was not stuck; it is gone, and `/api/teacher/signin` refuses a `target`
naming the other studio (a stale page) with nothing sent. The trap T212
closed is open again: a counter is moved only by an admin signed in to
the studio it is ON, so an admin of both studios needs BOTH staff ids
(they are per site) in `POS_ADMIN_STAFF_IDS`, and a stored target
otherwise only moves by a database edit, since the row wins over
`MINDBODY_TARGET`. The switch itself is `switchTarget` in
`src/lib/targetswitch.ts`. **Dry run and the write guard did not
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

**A staff token belongs to the site that issued it, and all three places
this app holds one now say which site that is** (T210; Pete's third drive met
Mindbody's answer for getting this wrong, "Delegated staff does not belong to
the subscriber.", in the review sign-up's modal with no way past it). The
SERVICE token's cache is keyed by site id, so switching target cannot reuse a
sandbox token against production. A TEACHER's session records the site its
token was issued for (`staff_sessions.site_id`, migration 17, and `siteId` on
the in-memory `StaffSession`): a row for another site, or one from before the
column existed, is never restored, and a session held in memory for another
site is dropped, which is what a restart with a different `MINDBODY_TARGET`
used to walk straight past (T89's switch ends every session; an environment
change at restart never ran it). The BORROW of a signed-in service account's
own token (T206, `serviceSessionToken`, `adoptServiceToken`) takes the site id
from the env it was called with and refuses a token issued for any other. And
Mindbody's own sentence is treated as a dead token for this site: the session
ends, the write is refused 401 `reason: "staff"` and is NEVER retried as the
service account (which holds the same borrowed token and would fail the same
way), the cached service token for this site is forgotten so the next read
reissues, and the gate says "Your sign-in belongs to a different Mindbody site.
Sign in again." The drawer's Settings tab names both site ids, and says in
words when they differ; `/api/config` and `GET /api/teacher/probe` report both.

### Every write to a client is recorded, and a save never blanks text quietly (T116)

A student's notes and alert were found blank and nobody could say whether
the app did it (the call log is in memory, a restart had wiped it, and a
successful save logged nothing). So every `POST /client/updateclient`
goes through ONE function, `updateClientAudited` in
`src/lib/clientaudit.ts` (notes, alerts, opt-ins, card, waiver release,
waiver receipt, T62's append); anything else sending it logs
`[client-write] UNAUDITED`. Each write prints one `[client-write] {json}`
console line, always and first, and adds one `client_writes` row when
`DATABASE_URL` is set (T29 charter: our audit of our actions, only the
fields we changed). The record is when, the teacher it was for (even
after T49's fallback), whose token, client Id and UniqueId, each field's
before (a fresh read) and after, and the outcome (sent, dry-run,
write-guard, refused, error). A card is only "card replaced, last four
X". A dead or absent database never blocks the write; a row that did not
land logs `NOT STORED` every time. `/api/client-field` refuses an empty
value over text Mindbody holds (409 `reason: "blank"`, decided on its own
read, never the browser's) unless `confirmBlank: true`, which the info
view sends only after asking once. The waiver receipt appends to
Mindbody's notes, read fresh, never to the browser's copy. The drawer's
writes tab and `GET /api/client-writes` (devtools-gated) show recent
entries.

### One tap charges once, even if its request arrives twice (T113)

The single flight (T22) and the partial lock (T95) both live in the BROWSER,
so a checkout that reached the server twice used to charge twice: a dropped
radio and a transport-level retry, a reload mid-charge, a proxy, or two
iPads on one ticket. So the browser now mints ONE idempotency key per TAP
(`src/lib/idemkey.ts`, in the charge gesture and never per render) and sends
it as the `Idempotency-Key` HEADER, which keeps it out of the ticket that
gets fingerprinted. `beginIdempotent` in `src/lib/idemstore.ts` is the gate,
after the device and staff sessions and before every validation and every
Mindbody call: a key never seen runs the checkout unchanged, a key already
answered returns that FIRST answer verbatim with nothing sent to Mindbody
(the suppressed, partial and sold-nothing outcomes included, so the screen
cannot tell a second story), a key still IN FLIGHT waits for the first
rather than refusing (a refusal would say "not charged" about a charge in
progress) and after 30 seconds answers ambiguous, and a key arriving with a
DIFFERENT ticket is refused in words with nothing sent, told apart by a
SHA-256 of the canonical body plus the teacher's staff id. The digest is
kept, never the body, which holds card numbers and CVVs. The record is IN
MEMORY, bounded at 200 keys and 15 minutes (`POS_IDEM_MAX`,
`POS_IDEM_TTL_MS`): a SECOND SERVER INSTANCE DEFEATS IT. And it is never a
way to LOSE a sale, which is why the key is not required: no key, an
over-long key, the store off or full of flights in progress all charge as
before, loudly in the log. Nothing below the gate moved, and nothing about
it is settable from the drawer.

### A charge that may have moved money holds the client, on the SERVER (T253)

**`/api/checkout` refuses any new charge for a client whose charge is
still running, or may have moved money and nobody has acknowledged it**
(reviews of e200b71 and 1bbe146; the main session's decision). T241, T249
and T252 kept that in the browser's sessionStorage, which is ONE TAB's: a
second iPad, a second tab, a closed tab and the Home Screen web app after
it is swiped away (`appleWebApp.capable`; iOS starts a standalone web app
with a fresh sessionStorage per launch, and swiping it away is how the
counter gets reloaded) all saw no hold and could charge the same student
again.

- **Written AHEAD of the charge** (`claimCharge` in
  `src/lib/chargehold.ts`). After T113's gate takes a NEW key, every
  client on the ticket (the payer and each T90 recipient, never the house
  client) is checked and, in the same tick, given a `pending` hold, in
  memory and in the table, before any display card, PIN, approval or
  Mindbody call. A second iPad or a relaunched app charging the same
  client meanwhile is refused "A charge for this client started at 5:33
  PM and has not answered yet." A pending hold cannot be acknowledged;
  the screens offer "Check again".
- **Settled by its answer** (`settleCharge`, `outcomeOf`). A definite one
  (a sale that stood, a suppression, a definite refusal) clears it. One
  that may have moved money (the route's `ambiguous`, a 5xx or 200 it
  could not read, T103's sold-nothing, a T95/T90 partial) turns it into
  that kind of hold, same id, until a teacher acknowledges it. A throw
  ANYWHERE after the claim, even after a definite answer was settled
  (promotion, display card, enrolment, the record), makes it ambiguous,
  because the teacher is about to read "may or may not have gone
  through". A pending hold with no answer after 3 minutes, or found with
  no request in this process that owns it (a restart mid-charge),
  becomes ambiguous, never cleared.
- **The refusal is recorded against its key**: 409 `reason: "held"` goes
  through `gate.record`, so a delayed duplicate of a refused tap arriving
  after Understood replays the refusal rather than charging. A key the
  gate already knows replays its first answer verbatim, hold or no hold.
- **Walk-in tickets** (no client id, or the house client's own, decided
  on the server) never make a blocking hold: a block on the house client
  would stop every walk-in sale. One that ends unknown, sold-nothing or
  partial leaves a STUDIO-WIDE notice (kind `walkin`, kept under the house
  client's id), which refuses nothing; the Cart screen shows it on every
  walk-in ticket ("A walk-in sale at 5:33 PM may have gone through. Check
  Mindbody before ringing up a walk-in again.") with its own Understood.
  T90 recipients on a walk-in ticket are held as usual.
- **Where it lives**: this process's memory is the record; `charge_holds`
  (migration 19: ids, site, kind, the route's sentence with long digit
  runs struck, the sale id when known, the staff id, created and
  acknowledged at and by; NO card data; Mindbody has no home for it, so
  the T29 charter allows it) is its durable copy, written as the whole
  current state by id (`upsertChargeHold`), one write after another per
  hold, so a slow first insert cannot land over a later state. A table
  that does not answer leaves memory in charge; rows memory lacks (a
  restart) are read in. ONE INSTANCE: a second process would share the
  table but not who owns a pending hold, and would turn the other's
  in-flight charges ambiguous; not built for. A settled hold lapses after
  `POS_HOLD_LAPSE_MS` (24 hours), logged.
- **Other money routes**: `/api/purchase-contract`'s live purchase is
  claimed and settled the same way (its Test: true rehearsal is neither
  held nor holds); `/api/guest` sells a $0 comp and moves no money. Every
  other charge path is `/api/checkout` (the Cart screen, the roster's Pay
  and check in and its renewal flavor, the display's picks and approvals).
- **Routes**: the answer that left holds names them (`chargeHolds: [{id,
  clientId}]`, inside T113's record). `GET /api/charge-holds?clientId=`
  (device session; `?walkin=1` for the walk-in notices) lists standing
  ones. `POST /api/charge-holds/acknowledge {id}` (device session and a
  signed-in teacher, logged with the staff id) is the only release before
  the lapse; with a database it must LAND in the table (503 `unrecorded`
  and the hold stands otherwise), and a pending hold answers 409.
- **The screens ask the server** and keep their tab records as the
  instant local copy. The roster's Pay and check in asks on every open and
  shows a server hold like its own record (Close keeps it; Understood
  acknowledges; a pending one offers Check again). The Cart screen asks
  when it opens and when the ticket's clients change, shows every hold
  for the payer or a T90 recipient and the roster's tab record for them
  above the foot, and Finalize waits on them; on a walk-in ticket it shows
  the walk-in notices, which do not hold Finalize. A 409 `held` shows the
  hold. An outcome's Understood acknowledges the holds its answer named
  and ALWAYS reads the server again for the ticket's clients, so a hold
  the answer did not name is offered in the same view. A tab record whose
  server holds are gone (acknowledged on another iPad) lets go; one that
  never reached the server, or is still `charging`, waits for its own
  Understood.

### A charge that may have moved money outlives the Cart screen (T249)

**Corrected by T253**: everything below is ONE TAB's sessionStorage. It
survives a reload and a sign-out in that tab and NOT a second iPad, a
second tab, a closed tab or a Home Screen relaunch, which is why the
server now holds the client (above).

`SaleScreen` renders nothing when closed and `PaymentPanel` unmounts with
it, while the CART survives, so from 2026-09-14 until T249 a T103
sold-nothing answer or a T95/T90 partial (and T95's `partialLock`) was
lost on Sign-in then Cart: the ticket came back intact and unlocked and
Finalize took a second payment (a partial gift card ticket could sell the
same cards again). Two things now stand in the way, either enough alone:

- **The tab's record** (`pos_uncertain_charge` in sessionStorage, the
  T241 record widened, `HeldRecord` in `SaleScreen.tsx`). It is written at
  the charge TAP, synchronously before the request, as `stage:
  "charging"`; a definite answer (paid, suppressed, refused) removes it;
  an ambiguous, sold-nothing or partial answer replaces it with that
  outcome (the route's sentence, the sale id and T103's basket audit),
  which stays until that result's own Understood; and the lock stays in
  it, with a print of the ticket's line keys and quantities, until the
  ticket is emptied. A mount restores each as itself; after a reload it
  says when ("Recorded at 3:41 PM, before this page reloaded."), and a
  record still `charging` comes back as the unknown outcome ("had not
  answered when the page reloaded"), never a clean ticket. The lock comes
  back only onto the ticket it was about, so after a reload (the cart is
  memory) it does not, and an emptied ticket always releases it. **No
  card data**: no number, CVV, gift card number or gift card id (a
  partial's ids are not kept; the restored block says to read them in
  Mindbody if they were still unwritten), and any long digit run in a
  stored sentence is struck.
- **The close is held.** While an unknown, sold-nothing or partial
  result is unacknowledged, or `partialLock` stands, SaleScreen's close
  and Escape refuse and the nav bar's Sign-in is off with the sentence
  (`SaleNavState.closeWhy`); the shelf's foot says it in words, with
  "Show the last charge" when the reason is a result (that opens the pay
  surface WITHOUT Pay's gates, since after a reload there is often
  nothing to pay, and returns to the shelf once the result is
  acknowledged). The nav bar's Cart stays live: it is how a teacher
  reaches Empty cart, which is what releases a part-sold ticket.

Nothing about what the server charges changed.

**The roster's "Pay and check in" holds on the same rule** (T252, a
review of PR #16: Close wiped the dialog's outcome and reopening the row
offered a fresh Charge after an unknown answer, and the Cart screen's
record was read only when that screen mounted). `src/app/heldcharge.ts`
holds both records' readers. The dialog writes its own,
`pos_roster_uncertain_charge`, one per client and no card data: at the
Charge TAP as `charging`, removed on a definite answer (refused,
suppressed, a renewal that charged, a pass that attached), replaced by
`ambiguous`, `sold-nothing` or `attach-failed` until that outcome's own
Understood. The Cart record now names its `clientIds` (payer and T90
recipients; a record without them holds every client). The page reads
both at mount and on every open, and while one stands for the dialog's
client, Charge, free entry, the overdraft PIN, "Use this pass" and the
customer iPad's "Your passes" stand down and the dialog shows the record
with Close and Understood (Close keeps it; Understood on a Cart record
takes its stage the way that screen's does, a part-sold lock stays). The
nav bar's Profile, where Sign out is, waits on `closeWhy` like Sign-in,
and sessionStorage outlives a sign-out in the tab, so a record surfaces
after the next sign-in (in that tab only: T253's server hold is what
another iPad or a relaunch sees). "Use this pass" moves no money and
keeps T242's own lock. The T253 review also made the Cart record keep
the clients it was tapped for even if the client is then detached, and
the roster's view of a Cart record shows its sale id and T103 summary.
`attach-failed` is decided in the browser (the sale stood, the pass did
not attach), so it is a tab record only and makes no server hold.

### A sold pass can come with a place (T219)

A workshop is sold as a pass AND booked, and the counter now does both
(Pete: the Gratitude Yin Sound Bath's two passes and course 743, "think
through how to add this as a feature so next time it is easy"). The
rules are SHELF CONFIGURATION, `enrolments` in `src/lib/shelfconfig.ts`
(pass id, `"enrollment"` or `"class"`, target id; ids only), edited on
the drawer's Shelf tab under "sign up on purchase", where Check asks
`/api/admin/shelf/signup-target` what an id is. A course is
`/enrollment/addclienttoenrollment` by ClassScheduleId (the id in
Mindbody's workshop URL); one class is `addclienttoclass` by ClassId.
`enrolAfterCheckout` (`src/lib/enrolonpurchase.ts`) runs in
`/api/checkout`'s POST after the checkout answered and INSIDE T113's
record, so every charge path gets it and a replay books nobody twice.
Only a sale that stands enrols; the owner is T90's `forClientId`, else
the payer, never the house client; the target is read first and nothing
is written unless it is confirmed upcoming; the write is the teacher's
own, so dry run and the write guard apply; a full one goes on its
waiting list. The answer carries `enrolments`, shown on the Cart
screen's done block, amber when the place did not happen. Nothing in it
can turn a sale into an error. Seen working live on site 471
(2026-11-09) with course 743. **It does nothing until a rule is
saved**, and a workshop pass sold without one says nothing, which is
how the first live test signed nobody up.

### A teacher's PIN now authorizes seven separate things

`CompPurpose` in `src/lib/auth.ts` is `comp` (a discount, T48), `overdraft`
(charging an account past its balance, T94; since T250 also asked by the
roster's "Pay and check in", through the shared `ApprovalDialog` pad), `override` (selling a pass
Mindbody's own rules refused, T112), `approve` (approving a sale the customer
screen could not, T203), `contract` (selling a membership with no customer
signature, T205), since T211 `waiver` (booking or checking a student in
with no released waiver) and, since T259, `credit` (giving account credit at
no charge, paid "Other"). The purpose is SIGNED into the one-shot token and
the reader names the one purpose it will accept, so a PIN typed to discount a
sale cannot authorize an override and none of the seven can stand in for
another. Two request fields are not a separation while one value fits both,
which is the lesson T94's review paid for; do not add an eighth purpose by
reusing an existing one. Each token is verified before any Mindbody call and
spent once -- at `/api/checkout` before the rehearsal, at
`/api/purchase-contract` before the purchase, for T211 in
`claimWaiverOverride` before the write, and for T259 in `giveNoChargeCredit`
before the "Other" lookup -- so a refusal that reached no cart
costs no PIN. **A write that dry run or the write guard SUPPRESSED hands the
token back** (`unspendCompToken`, T211): nothing reached Mindbody, so nothing
was authorized, which is T202's rule for a suppressed release. A refusal or
an error still costs the PIN, because neither is evidence that nothing was
written.

### A promotion code is Mindbody's to judge (T220)

The studio emails returning drop-in students a per-student, single-use
code (`POST /site/addpromocode`, `MaxUses: 1`, `ApplicableItems` = pass
581, "Welcome Back - 2 Weeks Unlimited ($49)") worth their $28 drop-in;
Pete: "that needs to be added immediately" for the ones who come to the
counter. A field under the Cart screen's totals and in the roster's pay
dialog takes the code, and it goes to Mindbody as the cart's
`PromotionCode` (sale.yml:5684) on the `Test: true` pricing, on the
checkout's rehearsal and on EVERY real `checkoutshoppingcart` after it
(`priceCart`, `checkoutCart`, `rehearseCheckout` take it; one shared
`priceCartWithPromotion` in `src/lib/sale.ts` judges it for both routes).
**Nothing here computes what a code is worth**: the discount line is
Mindbody's DiscountTotal for the coded cart and the total charged is the
rehearsal's GrandTotal. A code Mindbody refuses (a 4xx) is priced once
more WITHOUT it, so the screen shows Mindbody's own sentence and a ticket
still chargeable at full price; one it accepts and takes nothing off for
is treated as not applied. Only a code the newest pricing APPLIED is sent
on a charge. At the charge, a code the rehearsal refuses (spent online
since it priced, say) refuses the SALE, 409 `reason: "promotion"`,
nothing charged: the teacher quoted the coded price, so the uncoded one is
never charged on the same tap. Listing codes (`GET /site/promocodes`)
needs the "Set up promotions / Semester discounts" permission and is not
used. **Probe B5 settled the two things this rests on** (Pete, prod,
2026-11-14, dummy client 100042041, a throwaway one-use code for 581):
the code is HONOURED on `Test: true` (SubTotal $49.00, DiscountTotal
$28.00, GrandTotal $21.00, so SubTotal stays pre-discount and T75 agrees),
and a `Test: true` pricing does NOT spend a one-use code (priced twice,
applied twice), so showing a student their price cannot burn their code.

**The rails apply unchanged.** T75 compares Mindbody's SubTotal, which is
before discounts, so a code does not trip it; T79's DiscountTotal check
runs only with a teacher's discount, and **a code is refused beside a
discount or a T112 substitution** (one discount per ticket), **on a T90
ticket with a line for someone else** (a single-use code on two carts is
spent by the first after it charged) and **beside a gift card**
(`purchasegiftcard` takes no code): `promotionRefusal` in
`src/lib/promocode.ts`, before any Mindbody call or spent PIN. T103's
basket assertion, T113's key (its fingerprint is the whole body), T49's
token, dry run and the write guard are untouched. **The code is in T203's
cart sha** (a `promo|` line, appended only when there is one, so every
other ticket hashes exactly as before), and a code arriving or leaving
ends an outstanding customer approval the way a cart edit does. The
answer to a sale that stands carries `promotion: { code, discount }`,
named on the done block; every outcome logs `[promo]`.

### A pass the client cannot buy is greyed out before the tap (T221)

Pete, after 581 was refused for a client who already held it: "is there
any way to make it greyed out with a UNAVAILABLE indicator so i cannot
even put it in the cart to begin with?", and "can items be restricted to
only certain types of members as well?" Mindbody refuses a pass for a
CLIENT on its own rules (T112), so those rules are not rebuilt here:
`GET /api/pass-availability?clientId=` (`src/lib/passavailability.ts`)
prices each pass that CAN be refused per client alone, `Test: true`, for
that client, in parallel, and reports the 4xx ones with Mindbody's own
sentence. Which passes is read off the live catalog: `IsIntroOffer` (any
`IntroOfferType`) or a non-empty `RestrictToMembershipIds` (now carried on
`CatalogItem`), minus the shelf's hide list. On site 471 that is five
(414, 478, 581, 539, 576). Only a 4xx greys anything: a suppressed check
(dry run, the write guard), a 5xx or a dead transport leaves the pass
open, and the cart's own pricing (T100's refused line) stays the
backstop. Answers are cached two minutes per target and client, and the
Cart screen asks fresh after a sale, since a sale is what changes them.
The house client and no client are answered empty with no call.

The **Cart screen** greys the tile (dashed, muted, an UNAVAILABLE tag and
the reason) and a tap puts NOTHING on the ticket: it opens the refused-line
notice with the same three ways forward, buy it for another client,
Override, gift card, because selling that pass to somebody else is still
an ordinary sale. A line already on the ticket is not touched. The
**roster's pay dialog** disables the option with "Unavailable: <reason>",
never defaults to one, and moves a selection that turns out refused to the
next sensible pass. Both run in the background: nothing waits for the
answer, which took **2 to 5 seconds** live (five parallel Test pricings),
so a tap in those first seconds gets T100's added-then-removed behaviour.


- **Web app, not Swift.** The studio's reader is a networked WisePOS E rather
  than a Bluetooth accessory, so native buys nothing. Full argument in the
  design doc. **Card-present is no longer ruled out** (Pete, 2026-11-15):
  the 0.4% figure (25 swiped sales a year) counted sales that happened, and
  teachers report students walking away who could only tap, dip or use a
  phone wallet. The answer is the design doc's option C, the studio's own
  Square Terminal driven server-side from this app (Phase 4 in
  `docs/PLAN.md`; Square over Stripe since 2026-11-21), not a hand-off to
  the Mindbody app and not a flow on the student's phone, both of which
  Pete rejected. The one hand-off he allows is the disaster case: this app
  down, the Mindbody app and the existing reader.
- **Its own repo, its own Railway service.** Separate from ai-manager, which
  is a back-office worker with a different uptime story and different users.
  The two share an API, not a codebase: `src/lib/mindbody.ts` is adapted from
  ai-manager's client and deliberately not imported from it.
  Railway deploys from `main`; both iPads are Home Screen web apps with no
  browser reload, so a new deploy is picked up as described under the
  customer display ("Picking up a new deploy", T246).
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
   hits memory rather than the API. Since T213 it also re-reads the class on
   screen every `rosterRefreshSeconds` (30 by default, a drawer tunable,
   about three metered calls each) while the page is visible, so a student
   checked in from the Mindbody app, the kiosk or another iPad appears
   without a class switch. The re-read never starts during a write on this
   iPad and is dropped if one began while it was out.
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
whether an unpaid booking needs a confirming tap, and how often the roster
re-reads itself (T213). They live in the browser's
localStorage, apply immediately, and need no restart. Testing a number should
not cost a commit. Under them, "signed-in teacher" names who is signed in,
says which Mindbody site issued their token and which site this counter is on
(T210, loudly when the two differ), and runs the T49 permission probe.

Since T89 the tab opens on the Mindbody target: the studio and site in
words, whether that came from the setting or the environment, and, for a
teacher whose staff id is in `POS_ADMIN_STAFF_IDS`, one 64px control that
asks once before switching. Everybody else sees the line and no control.
Under it, the write guard in words (T111: read only, a line and no
control, because with the banner gone in the ordinary production state
this tab is the only place an unrestricted live counter is written down),
and "dry run on this iPad", which turns on a suppression for this browser
only. Under those, since T200, "customer display": whether a second
screen is paired and connected, a six-digit code field with a Pair
button, and Unpair behind one confirm. Anybody who can open the drawer
may use it; pairing decides which SCREEN a waiver appears on, never
whether a write happens. Under those three, the studio-wide rules about
that screen, each a line for everyone and a 64px admin control: T203's
approval, T205's membership signature, and since T207 "customer screen
sign-ups", automatic or review.

Anything that decides whether a write reaches Mindbody in the LOOSER
direction -- the server's dry run, the write guard -- is still
deliberately NOT here. Those stay in the server environment where a
browser cannot reach them; a settings panel that could switch off dry run
would defeat the point of dry run. The two T89 controls are the recorded
exceptions, and both are safe in only one direction: the target switch is
admin-only, audited in the log and refuses an incomplete credential set,
and the local dry run can only make this iPad safer.

T203's "customer approves each sale" is the THIRD recorded exception and
tightens in only one direction too: with it on the server refuses MORE
charges and never fewer, it is admin-only in BOTH directions (turning it
off is the dangerous one), and the log names the staff id who moved it.

T205's "membership needs a signature" is the FOURTH, sits beside it, and
reads the same way: with it on `/api/purchase-contract` refuses MORE
memberships and never fewer, it is admin-only in both directions, and the
log names who moved it. It is the one setting here that DEFAULTS ON, and
turning it off is the dangerous direction.

T207's "customer screen sign-ups" sits beside those two and is NOT a
fifth exception, because it is not a rail: automatic and review make the
same three writes, from the same browser, under the same teacher's
token, dry run and write guard, and no server route reads the setting to
refuse anything. All it decides is whether a human taps before a create
the teacher's iPad would make anyway. It is admin-only and logged for the
reason the other two are, that a studio-wide policy should be somebody's.
It is also the one setting of the three that does NOT fall back to the
environment when the store goes quiet: the process keeps the last value
the store answered with, because for this setting the environment's
answer could be the LOOSER one (a stored `review` flipping to
`automatic` on a database blip is more unattended writes, which nobody
asked for), and it falls to the environment only when this process has
never had an answer.

T241's "students can type a card on the customer screen" sits beside
them and, like T207's, is NOT a rail exception (Pete, 2026-11-17: "i
think we can keep that for now and remove it once we actually have
stripe ... let's hide it behind a flag so i can turn it off if it
becomes annoying"). `display_typed_card` in `app_settings`, DEFAULT ON,
with `POS_DISPLAY_TYPED_CARD` as the no-database fallback (only `false`
or `0` turn it off), read and stored like T205's, except that since T249
a store that goes QUIET keeps the last answer it gave, as T207's does
(the environment's answer is the looser one here, so a blip must not
turn a stored "off" back on), falling to the environment only when this
process has never had an answer or the row is gone
(`displayTypedCardAllowed` in `src/lib/approval.ts`, `PUT
/api/admin/display-typed-card`, a 64px admin control, the log naming
the staff id). Off, the SERVER removes a way to pay: "A different card"
is stripped from every offer `/api/display/present` stores,
`/api/display/card` refuses with nothing held, and switching it off
drops every card already held (each teacher's line then meets "no
longer held" at Finalize, as for any released card). On, a student's
card still reaches Mindbody only through the teacher's own checkout.
The teacher's own typed-card modal is unaffected. It is to be REMOVED,
with the feature, once Phase 4's reader exists (PLAN, Phase 4).

## Customer display (T200 to T205, T207, T208; Phase 2.5)

A second iPad on the counter, facing the student, at `/display`. Design:
`docs/design/customer-display.md`. Built: the plumbing (idle screen,
pairing, the hub in `src/lib/display.ts`, the two SSE routes and
present/cancel/complete/refuse), the ticket scene (T201), the waiver
scene (T202), the ticket approval (T203), the self-serve sign-up (T204)
and the contract signature (T205). Every item of the phase is built; what
is left is live verification. T207 made the sign-up automatic by
default, and T208 is Pete's second drive on real hardware (the tray's
in-progress spinner, a class hours ahead now checked in, a stale row
that clears, the duplicate decision, review mode's own words, and, off
the display, a server-side capacity check and the waiting list at the
bottom of the roster).

**The display adds zero write paths to Mindbody, and must keep adding
none.** Nothing in `src/lib/display.ts` or under `src/app/api/display/`
imports `mindbody()`. A student's answer is a stored result on a
`display_requests` row; the write happens afterwards from the TEACHER's
iPad, under the teacher's token, through a write route that already
exists, which is what keeps dry run, the write guard, T49 attribution
and T50's refusal applying unchanged. **Card data has exactly one path
through it** (T241): a card the student types on the display travels
display -> this server's MEMORY (`src/lib/displaycard.ts`, on that display
request, for one charge) -> the teacher's `/api/checkout`, and nowhere
else: never a table (not `display_requests`, not any payload or result
column), never a log line beyond a last four, never the teacher's
browser, never back to the display.

**A live ticket is the one scene that is REPLACED in place** (T201,
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

**Every ticket scene names the payment method, in words** (T240, Pete:
"we should always list the payment method on the custmer ipad"): the
live mirror once a tender is on the ticket, the approval and the
summary. "Paying by Account balance", "Paying by Card", and on a split
each leg with its amount ("Account balance $15.00, Card $10.00");
"Paid $25.00 by Card" after. The words are a FIXED list, `TENDER_WORDS`
in `src/lib/displayticket.ts` (Account balance, Card, Cash, Gift card,
No charge), and `readTicketPayload` refuses any other, so the payload's
`tenders` cannot carry a card's digits; **a card's last four is no
longer shown there**, the summary included ("Card ending 1234" before
T240). The Cart screen reports its tender up to the mirror
(`onTenderChange`); both charge paths put it on the approval.

**A stuck customer screen clears itself, and can be cleared** (T244,
hotfix, Pete: "when i switched to another app and went back to this one,
it is stuck on a sales screen even tho the cart is empty and no client is
attached"; he had to unpair and re-pair). iPadOS can discard a
backgrounded tab with no `pagehide` and reload it with an empty cart and
no memory of the ticket it left up, so `useDisplayMirror` reconciles on
mount, on `visibilitychange` to visible, on `pageshow` and on the
display (re)connecting: an empty cart sends ONE `POST
/api/display/cancel` with `scope: "live"` and this tab's presenter
(`cancelOnDisplay`), which the SERVER applies only to a live ticket or a
summary (never a waiver, sign-up, contract or approval; a no-op
answering `held`) AND only to one this tab owns, under T241's owner
rule below; the one exception is another tab's LIVE ticket gone two
minutes without a present (T241's own staleness rule, for a tab killed
with its sessionStorage), which is retired and its owner told
(`ticket-retired`). A cart that is not empty is presented again. The
mirror's own cancel on an emptied cart is `scope: "live"` too.
**"Reset customer screen"** is reached on the deployed counter by
tapping the customer display mark under the header (a 64px row;
"Options" opens the menu), and in the drawer beside Pair and Unpair
(`src/app/ResetDisplay.tsx`, `scope: "reset"`): it clears whatever is up
WHOEVER owns it, a live ticket or a summary at once, anything a student
is in only after asking once, naming it (the "Clear it" echoes the scene
it was asked about, and the server asks again if a different one is up
now); a ticket's owning tab is told (`ticket-retired`), and the log
names the staff id. **The student can Close** a live ticket or a summary
(`POST /api/display/close`, display cookie; drawn on the ticket itself,
never inside T241's Change list or card form, and its cancel releases a
card typed on that ticket as any cancel does); the owning tab hears
`closed`, shows "The customer closed the ticket on their screen." and
does not present that SAME cart again until it changes (`closedKey`:
lines and name, never a price). Since T247 a refusal (a student's "Not
now" or Cancel) also sends the display back to idle itself, which is
what unsticks a self-serve sign-up nobody is waiting on. No Mindbody
call anywhere in it.

**Picking up a new deploy** (T246, Pete: "could we add a reload button? i
need it to run the new deployed versions as theyre deployed"). The server
reports the build it runs (`src/lib/version.ts`:
`RAILWAY_GIT_COMMIT_SHA`, else `.next/BUILD_ID`, else a value fixed at
process start) as `version` on `/api/config`, on `GET
/api/display/version` and as a `version` event on every display stream
connect. A page's own version is the FIRST answer it got
(`src/app/appversion.ts`). The **teacher's iPad** re-reads the config
every 30 seconds, on `visibilitychange` to visible and on `pageshow`, and
when the version moves shows "A new version is ready." with a 64px Reload,
fixed above the nav bar with its height added to `--nav-space`, so it
covers nothing. **It never reloads by itself**, and its Reload refuses in
words while a charge is in flight, a gift card id is still to be written,
or any write to `/api/*` is on the wire (counted by the fetch observer the
page already had). **"Reload app"** always reloads, in the account modal
and in the display mark's Options menu. The **customer screen** reloads
ITSELF for a new version, but only from its paired idle screen, 1.5
seconds after it got there: never over a ticket, an approval, a waiver, a
sign-up, a contract, the thank you or the take-over apology, and at most
once per version in two minutes (sessionStorage), so two servers answering
during a cutover cannot loop it. The pairing is a cookie and survives.
**"Reload customer screen"** in the Options menu (`POST
/api/display/reload`, a teacher's session) sends a `reload` to the open
display streams only, never into the replay buffer (a fresh stream replays
the buffer and would reload forever); the display obeys at once if idle or
when the scene ends, and the teacher's line says which, or that the screen
is not connected. Nothing in it calls Mindbody or touches a sale path.

**A screen that goes says so at once** (T206): the display's SSE stream
closing is the signal, so a Safari tab shut on the counter reaches the
teacher's mark as `disconnected` in a second rather than in up to 75
(`markDisplayGone`, counted against `markDisplayStreamOpen` so a
reload's overlapping second stream cannot make the mark flap; the 45
second silence window stays as the fallback for a stream that dies
without an abort).

**The customer can be made to APPROVE each sale** (T203, Phase 2.5 item
4). `app_settings.customer_confirms_sale` (with
`POS_CUSTOMER_CONFIRMS_SALE` as the no-database fallback) is a
studio-wide policy an admin edits from the drawer, and **`/api/checkout`
is the only place it is enforced**: with it on, a charge must carry
either a `displayApprovalId` naming a completed, unconsumed, unexpired
`ticket`/`approve` request for this client, or a PIN token of the new
`approve` purpose, and it is refused with a plain sentence before any
Mindbody call otherwise. What ties the approval to the ticket is one
sha256 both `/api/display/present` and `/api/checkout` compute
themselves with `src/lib/cartsha.ts` over the cart as sent (the client,
each line's type, id, quantity, unit price and T90 recipient, the gift
card lines, the discount; sorted, so order is not a change). Tax and the
total are NOT in it, because the checkout body never carries them, and
T75's rehearsal already refuses a total that moved. The browser never
sends a hash. **Since T240 the TENDER is in it too, whenever the approval
named one**: both charge paths send their `method` or `split.legs`
(method and amount, never a card or gift card number) in the presented
cart, `/api/display/present` rewrites the scene's tender words from that
same tender and hashes it with `{ tender: true }` (a stored and a typed
card fold to one word, as the student reads them), recording
`tenderBound` on the private half, and `/api/checkout` hashes its own
body the same way, so a tender switched after the student approved is
refused, nothing charged. An approval presented with no tender (a page
loaded before T240) hashes exactly as before and binds no tender, because
it showed none. The approval is spent only AFTER the charge resolved
(`recordApproval`, built above every write path and called from each:
`recordDiscount` on the single-cart paths, the gift card and T90
tickets directly, and the sold-nothing answer;
claimed through T202's `beginFinalisation`), so a refused charge can be
retried on the same cart and a spent one is refused twice over. The D1 override is
T48's PIN with its own purpose, spent once, and filed on the client the
way T45/T62 file a comp's reason ("Sale approved by <teacher> at the
counter, customer screen not used"). With the setting off, both fields
are ignored rather than refused: a stale dialog must not stop a sale.

**EVERY charge path asks, through ONE shared piece** (T209). The rule is
enforced on every charge, so every way to `/api/checkout` has to present
the ticket, and there are exactly two: the Cart screen's Charge and the
roster's "Pay and check in" over an unpaid row (T25, with T26's renewal
sibling in the same dialog). T203 wired the first alone, so the second
reached the route with nothing, was refused in words and put NO scene on
the student's iPad (Pete, third sandbox drive, 2026-09-21). The flow now
lives in `src/app/useSaleApproval.ts` -- the present, the 1 second poll
of `/api/display/approval`, the busy retry, the three ways out -- and
the panel in `src/app/ApprovalWait.tsx`, and both screens call them, so
the words, the two 64px controls and the behaviour cannot drift. A
screen that is not paired or not connected still gets the SAME panel,
with the line that names the PIN, and never a PIN pad on its own: the
override is the teacher's own deliberate tap. A refusal that is NOT
about the screen says what it is: a 401 `reason: "staff"` is the
sign-in gone and raises the gate rather than blaming the customer
iPad, and any other refusal shows the SERVER's own sentence, with
Approve sale still offered.

**Nothing outstanding outlives the ticket it was about.** Whatever ends
a wait takes the scene off the student's screen with it (`endWait` in
the hook, which is also what Cancel and the reset are): closing the
roster dialog, a cart edit on the Cart screen, picking a different pass
in the roster dialog, and a present whose answer arrives after the
teacher moved on, which takes its own just-created scene back down. A
cart edit and a pass change each leave one sentence, because a
customer tapping Approve on a ticket nobody can charge is worse than
being asked twice. Cancelling the PIN pad is NOT one of these: it goes
back to the wait it was opened over, so the ticket stays up and the
customer's tap still charges. Take over's three second apology is
cancellable, so Cancel during it puts no ticket up. "Check in free
(comp)" is not a charge and presents nothing. A THIRD charge path added
later belongs in that hook on the day it is written, not after a drive.
**The tender cannot move under an approval** (T240): the hook's `pending`
is true from the primary tap, the present's round trip INCLUDED (T238's
review found the roster dialog's "Use the card instead" live for exactly
that round trip), until the approval is answered, and both screens lock
their tender controls on it: the Cart screen's tiles, keypad square,
line amounts and Xs, and the roster dialog's switch. A tender that moves
by itself under one (a credit line dropped by a refetch, the card lookup
answering) ends it with one sentence, the way a cart edit does, and
`endWait` now also ends a present still in flight.

**"Your passes": the student's own passes for an unpaid visit** (T242).
While the roster's "Pay and check in" dialog shows the student's own
passes and a display is connected, the display shows a `passes` scene
(`src/app/display/PassesScene.tsx`, `src/lib/displaypasses.ts`): names,
classes left and expiry, and a 64px "Use this pass" per pass. **No ids
reach the display**: `/api/display/present` gives each pass a random key
and keeps the key-to-ClientService map on the request's server-only half
(`private.offer`). A tap posts `{requestId, key}` to `POST
/api/display/pass` (display cookie only); `choosePass` checks the key
against that stored offer, moves the scene to "One moment" at once (one
offer, one pick, from either side; it holds a minute at most) and emits
`pass-pick` to the teacher's
stream with the id. The teacher's iPad hears it through `useTenderPick`'s
`applyPass` (the stream the waiver block already holds, plus a 1.5s poll
of `GET /api/display/passes`, acted on once per pick id, for this tab's
scene and a pass its own list shows) and runs the same two writes as the
teacher's tap. **Nobody waits on the student**: the teacher's buttons work
throughout, and the scene then reads "Done" or "Please see the front
desk" for the summary's eight seconds; after an assignment that changed
nothing the list goes back up on the same request, with fresh keys and
the old pick cleared (a replace back to `offer` always clears it).
Closing the dialog or "Buy a pass
instead" cancels it by request id; a busy screen changes nothing on the
teacher's side. The display still adds no write path to Mindbody.

**The student chooses how to pay** (T241, Pete: "would be better to
surface a choice to the customer for the payment method if they want to
switch it", and it must not depend on the approval setting). A live or
approve ticket paid by ONE method carries `choices`, keys from the fixed
`TENDER_CHOICES` (credit, storedcard, cash, giftcard, typedcard), which
the TEACHER's iPad builds from the very rule its tiles are greyed by
(`addReason(source, true)`, a fresh tender for the whole total) less the
method already chosen; the account is offered only when the balance
covers the total and shows it ("Account balance ($100.00 available)"),
the house client gets neither the account nor the card on file, and the
offer is withdrawn from the live mirror the moment a charge begins. The
display's 64px Change opens the list; `POST /api/display/choose` reads a
request id and ONE key and refuses a key not on the offer the SERVER
stored (one offer, one pick: the next present reopens it). The teacher's
iPad hears it through ONE piece, `src/app/useTenderPick.ts`, fed by the
`tender-pick` event on the stream the live mirror already holds and by a
`pick` on the approval poll (no new EventSource: the iPad holds several
and HTTP/1.1 allows six), acted on once per pick id and only for a
ticket that screen is showing. It says one sentence ("Taylor chose
Cash. Enter what they hand you.") and REPLACES the tender, which counts
as touched: Account balance or Card on file, one line for the whole
total; Cash, a cash line with the keypad open; Gift card, the gift card
entry. **A pick never charges**: refused with the reason and nothing
changed during a charge or after the sale resolved. Under an approval, a
tender ready with no hands is asked again IN PLACE (`askAgain`, a present
with `replaces` naming the pending approve ticket, same request id, new
cart sha, never a charge, nothing with the setting off), and Cash or a
gift card ENDS the approval for Finalize to ask again. The roster's pay
dialog offers only the other of Account balance and Card on file, and
only on the approval: it has no live mirror.

**"A different card" is typed by the STUDENT on the display** (T241,
Pete: "i dont want teachers to have to do that. a student shouldnt have
to hand them their card."), while the studio's `display_typed_card`
setting is on (default; see Settings tab: off, it is never offered and
`/api/display/card` refuses). `src/app/display/CardForm.tsx` is T93's
fields and validator (`cc-number` kept for Scan Credit Card; the display
runs `useVisualViewport`), posting to `POST /api/display/card`, which
validates with `parseTypedCard` and holds it in `src/lib/displaycard.ts`:
memory only. **It belongs to the client, the teacher and the TAB whose
ticket it was typed on** (T241 review): every ticket present carries a
per-tab presenter id (`src/app/presenter.ts`, kept in sessionStorage so
a reload of the same tab is still the same owner; a Home Screen relaunch
starts a fresh sessionStorage and is a new owner, T253) on the request's
server-only half beside the staff id. Another tab's present no longer
takes over a live ticket in place (it is "busy"). A ticket that has gone
two minutes without a present is retired, which is kept for an iPad that
died without saying so; the owner is told (`ticket-retired`). A pick
goes only to the tab whose ticket it was. The checkout's claim checks
the client, the staff session, the presenter and the last four the
teacher's line shows ("for a different sale" otherwise). **Every
teacher-side cancel names its tab** (`cancelOnDisplay`), and the hub
refuses, as a no-op, a cancel of a ticket another tab owns, except a
live mirror on an explicit Take over (an approval is never taken) or a
stale live ticket on T244's reconcile; a teacher's deliberate "Reset
customer screen" (T244) is the one cancel that takes anything, after
asking over a student's scene, and tells the owner. A
tab leaving (pagehide) cancels its own live ticket AND its own
outstanding approval with a keepalive request naming it. A PIN-approved
checkout takes down only its own tab's approval (the checkout body
names the presenter). A present that meets ANOTHER iPad's approval is
"busy" with `foreignApproval`, and the teacher reads "The customer
screen is showing another sale's approval." with Wait and Approve sale
and no Take over; an approval its owner has not polled for a minute is
an orphan, and the next present retires it. It is
**released** on the approval's 30 minutes (a timer sweeps, so a closed
tab cannot leave it in memory), on cancel, on the student's own Cancel
of the approval, on expiry, unpair, a present that changes the lines,
name or client, and the teacher's `/api/display/card/release` when the
line leaves the tender, or the teacher's screen refuses the student's
card pick; a claimed card is never replaced, evicted or dropped from
under its checkout, and a drop while claimed marks it withdrawn so it
is never handed back. The teacher hears the last four only;
`/api/checkout` takes `displayCard: {requestId, presenter}` on the single
`typedcard` shape BELOW T113's gate, claims it for one checkout, charges
it as T93's `typedCard` under the teacher's token (dry run, write guard,
T75, T103, T240's binding unchanged; the word is still "Card"), and
**spends it on every answer that asked Mindbody to write anything**
(`src/lib/mbtrace.ts` counts non-GET calls inside the checkout; a
suppressed write counts), keeping it only for a refusal that provably
asked nothing. An answer that spent it says `displayCardSpent`, and a
refused claim is a 409 `reason: "displaycard"` with a `card` code. The
server REMEMBERS a spent card per request (third review), so a later
claim answers `spent`, and the browser treats `spent` and `charging` as
UNKNOWN outcomes, never "nothing was charged". A claim also closes the
ticket's offer: no pick and no new card are taken until the teacher's
iPad offers again, which it does only once the result is settled. **"Ask
them to enter it again" is shown ONLY after a definite outcome that
charged nothing**: a refused claim (other than another checkout holding
it), a 4xx refusal, or a whole-ticket suppression. After an outcome that
may have moved money (no readable answer, a 5xx, ambiguous, sold
nothing, partial, a part-suppressed T90 ticket) the line comes off
without a word and no way to pay is offered on the display until the
teacher has dismissed that result. **While an unknown outcome is
showing (an ambiguous answer, or that hold) the Cart screen's Finalize
and every tender control are locked, for EVERY tender, until that
result's own Understood** (third review: a tile tap, a client change or
a new ticket does not dismiss it), the fetch itself failing is handled
the same way, and the outcome is kept in sessionStorage (no card data:
that the last charge needs checking, when, and the request id) so a
reload OF THAT TAB shows it again with the display's choices held; T249
widened that record and T253 put the authority on the server, since a
Home Screen relaunch starts with an empty sessionStorage (see both
sections near the top). "A different card" stays offered
while a typed card is the tender, and choices are offered on an empty
tender too. For 1.5 seconds after a pick moves the tender, the charge
control ignores taps with the sentence highlighted (`settling` on
`useTenderPick`), so a teacher never charges a method they have not
seen. An approve ticket's Approve names the scene's version, so a tap
on a ticket since replaced in place is refused. "Save this card for next
time", unticked, is T93's keep on file, offered only with a client
attached; the form's name and postal fields have autocomplete off,
and **Safari AutoFill must be switched off on the display iPad
(Settings > Safari > AutoFill)**, which is the only full answer to one
student's details being offered to the next. The teacher's own
typed-card modal is unchanged.

**A student can sign themselves up** (T204, Phase 2.5 item 5). The idle
screen's "New here? Sign up" calls `POST /api/display/start`, the one
route the DISPLAY may put a scene up with: a `register` request with
`initiator: "display"`, no staff id, a payload the SERVER builds (the
required-field list, cached, and the waiver text) and the waiver's
sha256 on the private half. The student types their four fields, ticks
or unticks the two opt-in boxes (both ticked by default, D4) and signs
the same waiver scene T202 built, and the whole of it is ONE result:
form, consent, signature. It has two clocks: the result waits **four
hours** for a teacher, and the SCENE ends after **two minutes with no
touch** (`/api/display/touch`, throttled to 20s by the screen), which
returns the display to idle and discards the partial form so the next
student never sees the last one's email. Only one thing holds the screen
at a time, so a second start is refused and a teacher's `present` answers
409 `busy` with `holdingSignup: true`, which is what makes the sale
screen and the waiver dialog say "Someone is signing up on the customer
screen" and offer Take over.

The teacher meets it in a **tray**, not a wait: a `--gold` count beside
the display mark, fed by a `signups` event and a 30 second poll of
`GET /api/display/signups`, which carries NAMES and a moment and nothing
else. `GET /api/display/signups/<id>` is the one place the student's
typed email and phone reach a browser (a signed-in teacher's, behind the
device session), and it never carries the PNG; everything is deleted on
consume or at four hours. The same person appears above walk-in search's
results as "signed up on the customer screen, not created yet".
**A duplicate is a DECISION, not a dead end** (T208, Pete: "if we think
they already exist, the teacher should have a UI that very obviously
states that instead of going to 'New client'"). Mindbody's refusal
makes `/api/client-create` look the person up with ONE search
(`findExistingClient`, `searchText` on the typed email, else the whole
name) and answer 409 `{duplicate: true, match}`; the tray row reads
"May already have an account: <name>", and tapping it opens the
decision, the two people side by side, with two 64px ways out. "Use
their existing account" posts `useExistingClientId` and **creates
nobody**: the route verifies the id against a match it computes ITSELF
from the form the refused create carried (the teacher's corrections in
review mode, the stored form in automatic, and the signature and
consent always the student's own), runs only the waiver finalisation
for that client and spends the sign-up, and the browser carries on into
the same booking and check-in. The body's form is evidence the server
re-reads, never a client id to trust: a forged one buys nothing a
signed-in teacher cannot already do through `/api/waiver-agree`. "Create a new client anyway" is the same
prefilled form with a line saying an identical name and email will be
refused again. It is no longer true that a duplicate simply leaves the
sign-up in the tray with nothing to do about it.

**The only writes are `/api/client-create` and the waiver finalisation**,
both under the teacher's own token: Create takes the request id as a
handle, takes the FORM from the teacher's corrected body and the consent
and signature from the server's store, creates the client with all six
consent flags on the `addclient` body, and continues into
`src/lib/waiverfinalise.ts` (T18's and T202's release, receipt row,
document upload, Notes line and consume-last, now shared with
`/api/waiver-agree`) for the client id that now exists, under one
`beginFinalisation` claim. A duplicate leaves the sign-up in the tray.
**The text opt-in does not stick** (D-B3, Pete, sandbox, 2026-09-20):
`addclient` answers the three text flags `false` however they were sent,
so the route's read-back finds them dropped every time and files the
T62-signed Notes line asking a human to set it by hand. That line is the
record of the student's "Text me", not a fallback.

**A finished sign-up finishes itself** (T207, Pete: "make automatic the
default with a setting that can be set to review. the new client should
be created and automatically signed in to class (or the waitlist if
class is full)"). With `signup_mode` automatic, the DEFAULT, a completed
`register` request makes the signed-in teacher's iPad run, with no tap,
the sequence that teacher's taps run today: `/api/client-create` with
the request id and the form AS STORED (nobody corrects it in this mode),
then `/api/book` for the class the POS is showing, then `/api/checkin`
with the visit the booking produced, or the roster's own visit for that
client when the booking answer carried none. A full class books onto the
waiting list instead and stops there. **Those are the only three writes,
they are the existing routes, and they run in the TEACHER's browser**,
so requireActor, dry run, the write guard and T49 attribution apply
exactly as they do to the taps; nothing new reaches Mindbody and nothing
runs on the display or on the server's own initiative. Sign-ups are run
ONE at a time in a tab, so two collected while the iPad slept cannot
both book against the same last seat.

**The CLASS's own clock decides what the run may do**, not "is it
today" (`classWhen` in page.tsx, on Mindbody's `EndDateTime`, which
`ClassSummary` now carries). `defaultClassId` leaves the FINISHED 6:30
on screen at 8pm, and attendance at a class that is over must never be
invented: an ended class, a class on another day and no class at all
each create the client and book nothing. **Every other class is booked
AND checked in, however far ahead it starts** (T208, Pete: "it did not
sign them in but did sign them up. is this because the class starts
several hours from now?"): T207's fourth answer, "ahead", which booked
a class past the roster window and deliberately skipped the check-in,
is gone, because the class on screen is the teacher's own choice and
Pete's instruction for this path was "created and automatically signed
in to class".

**While it runs, the tray row says so** (T208): a spinner and "Creating
and checking in..." (or "Creating and booking..." for a full class)
from the moment a sign-up lands until the run resolves, with the gold
count unchanged. A name with nothing under it for two seconds reads
exactly like a name that is stuck. The row OUTLIVES the server's list
on purpose: the create spends the handle half way through, so the tray
draws the in-flight name from the browser's own `signupBusy` until the
booking and the check-in have answered.

The teacher hears one line, for about ten seconds, only when the run
finished the job ("Sam Vega created, checked in to 6:20 Bikram Yoga",
or the waiting list). **Everything else is a row in the tray**, because
a person who now exists in Mindbody and is in no class is exactly what
the tray is for: a duplicate, a field the site demanded, a refused
create, a refused or suppressed booking, a suppressed check-in, an
ended class, no class. A row whose CLIENT already exists taps through
to their profile and never to Create again. **A row the SERVER no
longer has is spent, not stranded** (T208): a create answered "no
longer waiting", or a detail read answered 404, makes the runner call
the tray's own DELETE, because a row a teacher can see and cannot clear
is the bug Pete met on his second drive. That DELETE spends a handle
nothing can account for, and **only a SIGN-UP**: an id that resolves to
a waiver, a ticket approval or a contract is refused with a 404 and
nothing spent, because taking one of those off the screen from under a
student is not what Clear is for.

**In review mode the tap is the only difference** (T208). The tray
heading reads "Waiting for your review", the form is titled "Review
sign-up" with a line under it and a button that names what the tap will
do ("Create and check in", "Create and add to waiting list", or plain
"Create" when there is no class on screen), and after the create the
SAME booking and check-in run, with the same outcome line and the same
tray rows for the exceptions. **Every door into a create that carries a
sign-up handle ends there**, in EITHER mode: the review tap, "Create a
new client anyway", a search hit's own Create. A create that finishes a
sign-up and leaves the person in no class is the bug, not the design. The run is attempted ONCE
per request id per browser, so a refusal is not re-asked of Mindbody
every poll, and two iPads racing are settled on the server by the
create's own `beginFinalisation` claim: the loser gets 409 and drops it
without a word. Those rows are BROWSER state: a reload loses them, and
the sign-up they came from is already spent, so the person is in
Mindbody and findable by search. With the setting on review, T204's tap
is what happens, unchanged.

**A result is spent BY ID, once** (T202). `consumeRequest` finds a
completed, unconsumed request by its id even when the hub has moved on to
another scene or the process restarted, reloading it from
`display_requests`, which is the one reason that table exists. A request
also carries a SERVER-ONLY half (`private`: the client id and the
waiver's sha256) that is stored under a reserved key in the payload
column and never reaches `sceneFor`, so it cannot travel down the
display's stream.

**The waiver signature's copy to Mindbody is best effort** (T202, Phase
2.5 item 3). The `waiver_receipts` row holds the PNG and its hash and is
the ORIGINAL; `POST /client/uploadclientdocument` files a copy from
`/api/waiver-agree` under the teacher's token, with the client id in the
options so dry run and the write guard apply, and a failure reports
`documentFiled: false` with the reason while the agreement stands. A
SUPPRESSED release does not consume the signature, so a real run later
can still spend it. A waiver the studio edited between the student
reading it and the teacher's iPad recording it is refused outright.

**A teacher's PIN is the third way past the waiver gate** (T211, Pete:
"a teacher should be able to override with their PIN and must give a
reason. make sure this is doable if there is an error, that would
probably be the main reason to do so"). One 64px control in the T18/T19
dialog, rendered OUTSIDE its reading/close-only split and last, so it is
there in every shape the dialog can be in -- including the close-only
one a failed waiver-text fetch used to dead-end in, and while the
customer screen is disconnected, busy or refusing. It opens a PIN pad
with a REQUIRED reason (3 to 200 characters, the T43/T48 reason-note
precedent, which is why a text field here is not the typed-amount rule
being broken). `/api/checkin`, `/api/book` and `/api/guest` take an
optional `waiverOverride: {token, reason}`; `claimWaiverOverride` in
`src/lib/waiverguard.ts` is the ONE place it is read, and it checks the
shape, the `waiver` purpose, T94's rule that the token names this
session's own teacher, and spends it, all before any Mindbody call. The
write then runs exactly as it did and the sentence is filed on the
client the way T45/T62 file a comp's reason ("Checked in without a
signed waiver by <teacher> at the counter: <reason>", with the add's,
the promotion's and the guest's own verbs). **It NEVER marks the waiver
signed**: no `LiabilityRelease`, no `waiver_receipts` row, no recorded
agreement, and the same dialog opens on that student's next tap. The
browser holds the armed token for exactly one write
(`takeWaiverOverride`, read once and cleared) and re-enters the same
continuation a recorded agreement takes, so the unpaid confirm, the
full-class waiting list and the guest sheet are all still ahead of it.

**A membership needs the customer's signature** (T205, Phase 2.5 item 6,
D5: "required but with override option"). The rule is
`contract_requires_signature` in `app_settings`, default ON, with
`POS_CONTRACT_REQUIRES_SIGNATURE` as the no-database fallback (only
`false` or `0` turn it off; unset means on) and `PUT
/api/admin/contract-signature` as the admin control beside T203's.
**It is enforced in `/api/purchase-contract`, before any Mindbody call,
and nowhere else**: a LIVE purchase must carry either a
`displayRequestId` naming a completed, unconsumed, unexpired `contract`
request for THIS client, contract and start day whose recorded sha256 of
the RAW terms still matches the terms as Mindbody serves them now, or a
`signatureOverride` token minted from the teacher's own PIN for the new
`contract` purpose (T94's rule: the purpose and the session's own staff
id), spent once and filed on the client as a Notes line naming them. The
`Test: true` rehearsal is exempt and unchanged. With NO display paired
the purchase asks for the PIN every time and says so, deliberately: a
studio that wants signatures should notice when the screen that collects
them is gone.

The signature is sent as `ClientSignature` on the live
`POST /sale/purchasecontract` (sale.yml:6246, base64 PNG, filed by
Mindbody under the client's documents), from the server's own store and
never from the browser, and the rehearsal deliberately carries NONE: the
counter shows the rehearsal's Total, and the field does NOT move it
(probe D-B2, `scripts/probe-contract-signature.ts`, run by Pete in the
sandbox on 2026-09-20: 70.00 with and without the signature). The request is claimed with `beginFinalisation` and spent only
after the purchase answered, so a refusal leaves the signature usable for
a retry of the same contract. `contract_receipts` (migration 15) is ours,
for the one thing Mindbody does not keep: WHICH WORDING was signed, and
by what artifact, or which teacher sold it unsigned.

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
- **A late cancel is an `Execute` code on the visit, not a removal**
  (T245). `updateclientvisit` takes `Execute`: `Cancel`, `Latecancel`,
  `Unlatecancel` (client.yml UpdateClientVisitRequest). Send it with
  `VisitId` and nothing else.

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
  **A retail product comes back `IsService: true`** (T254, live sale
  428877, 2026-11-17: Mat Rental, sent as product "0003", read back as
  `{Id: 3, BarcodeId: "0003", IsService: true}`), so the T103 review's
  veto on that flag refused a $201.99 card sale that had sold
  everything, told the counter "nothing was sold", filed that sentence
  on the client's Notes and held the client. A product line now matches
  on its exact `BarcodeId` string only, a pricing option on `Id` (or
  `BarcodeId`) unless the entry says `IsService: false`.
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
  three. **`ProrateDate` must be BEFORE `StartDate`** (T299, Pete's
  counter, 2026-11-24: "ProrateDate. Cannot be on or after StartDate."):
  it is the day the prorated stretch BEGINS, so it is sent as today and
  `StartDate` as the chosen day. Proration is the DEFAULT for a later
  start, not the only shape (T300, `src/lib/contractbilling.ts`): the
  dialog can turn it off, and then the first payment is on the start day
  (`FirstPaymentOccurs: "StartDate"`, no `ProrateDate`) or today
  (`"Instant"`). Rehearsed live (2026-11-24, `Test: true`): all three
  accepted, the start-day shape prices $0.00 today, the today shape the
  full first payment. Site 471's four contracts all bill `ClientsChargedOn:
  OnSaleDate`; which day of the month an unprorated start then bills on
  is unseen.
- **Mindbody does not enforce class capacity; the caller must.**
  `addclienttoclass`'s own description says so (class.yml:1077: "To
  prevent overbooking a class ... it is necessary to first check the
  capacity level of the class ('MaxCapacity' and 'TotalBooked') and the
  'IsAvailable' parameter by running the GetClasses REQUEST"), and
  Pete's second drive checked three people into a class of two because
  the only count in the way was the browser's, read whenever the roster
  last loaded. So since T208 `/api/book` reads THAT ONE CLASS fresh
  (`classIsFull` in `src/lib/roster.ts`, `GET /class/classes?ClassIds=`,
  one metered read on the service account) before any plain booking, and
  a full count sends the booking to the WAITING LIST instead, answering
  `waitlisted: true` with a sentence the screen shows. A promotion
  (`waitlistEntryId`) and a caller who ASKED for the waiting list are
  exempt, and a read that cannot answer books exactly as asked: the
  count decides, and `IsAvailable: false` beside a count with room is
  Mindbody's refusal to give in words, not ours to guess at.
  **The read must carry a date window**, because `/class/classes` ends
  its own at TODAY: an unbracketed by-id read of tomorrow's class comes
  back empty and checks nothing. The booking body carries the class's
  own `classStartsAt` for that (it picks the DAY and decides nothing
  else), and with none the read brackets today plus ninety days.
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
- **`IsIntroOffer` is not "new clients only"; `IntroOfferType` says which**
  (read live from site 471, 2026-11-14, T220). `GET /sale/services` answers
  414 "New Student 2 Week Unlimited" with `IntroOfferType: "NewClients"`
  and 581 "Welcome Back - 2 Weeks Unlimited ($49)" with
  `"NewAndExistingClients"`, both `IsIntroOffer: true`, sellable at
  location 1. `NewAndExistingClients` still means ONCE per client: after
  one sale of 581, Mindbody refuses the next with "Client has hit the
  purchase count for this intro series." (T220, 2026-11-14). A pass with
  `RestrictToMembershipIds` refuses a non-member "This item may only be
  sold to those with memberships." (576 for client 100041277, T221), and
  478 "ClassPass Convert 2 Weeks (1 time only)" is an intro offer too
  ("Only new clients qualify for this intro series."). Membership 3 is
  "Membership Series", which most of 471's passes grant to whoever holds
  them. The app reads only `IsIntroOffer`, and only to file a pass
  under Specials (`passGroupByRule`); nothing in the code hides a pass
  from a returning client, and the design doc's new-students-only rule
  for the $49 special was never built (PLAN 2.6). So 581 reaches a
  returning client's shelf unless the drawer's hide list names
  `Service:581`, and whether Mindbody sells it to them is the rehearsal's
  answer.
- **A promotion code's discount type is spelled two ways** (T220, Pete's
  prod probe, 2026-11-14). `GET /site/promocodes` lists site 471's codes
  with `Discount.Type: "FlatRate"`, and `POST /site/addpromocode` refuses
  that word: "'FlatRate' is not a valid discount type. Options are: Amount
  or Percent". Write `Amount`; expect to read `FlatRate` back. And
  `addpromocode` answers `PromotionID: 0` for a code it really created
  (it was 4 on the site's list), so the id that `deactivatepromocode`
  needs is read back from `GET /site/promocodes` by code.
- **"Delegated staff does not belong to the subscriber." is a staff token
  used against the wrong SiteId** (Pete's third sandbox drive, 2026-09-21,
  T210). Not a permission, not an expired token, and not about the client or
  the request: the token is alive at the site that issued it and meaningless
  at any other. It arrives as a 4xx with that sentence and nothing else to
  go on, so it is matched on the wording (`isForeignSiteRefusal`), counts as
  a dead token for this site, and is never retried as the service account.
  Anything holding a token -- the session, the cache, the borrow -- has to
  know which site it belongs to; see the safety section above.
- **`/client/uploadclientdocument` wants a MIME type in `MediaType`**,
  not the extension the spec lists (client.yml:7427 says `png`; the
  sandbox answers "Media type png is invalid" for it and for `.png`,
  `PNG` and `Png`, and accepts `image/png`). Probe D-B1, Pete, 2026-09-20.
  And **`addclient` drops the three `Send*Texts` flags** (probe D-B3, same
  day): sent `true`, they come back `false` on the create's answer and on
  the read-back, while the three email flags stick.
- **`GET /sale/contracts` requires `request.locationId` and answers per
  location, and a contract it lists for a location can still refuse to
  sell there** (sandbox, 2026-09-20: 354 and 356 listed at location 1,
  then "Contract 354 cannot be purchased at location 1" on the
  rehearsal). The `Test: true` rehearsal is the only thing that says a
  contract is sellable, which is one more reason the counter shows the
  rehearsal's own answer and never the list's.
- **Void and refund exist only in Mindbody's UI, and its client URLs use
  `UniqueId`** (T257, 2026-11-18). `/sale/returnsale` returns comp sales
  only and refunds a credit sale to the account (T256), so the app never
  voids: it links to `clients.mindbodyonline.com/app/clients/<UniqueId>/
  account-details/void-edit?saleno=<SaleId>`. The number in that path is
  the client's UniqueId, NOT the editable `Id` (`.../clients/100037835/
  account-details` opened the student whose Id is 10814). And
  `/client/clientpurchases` answers ONE element per purchased line, each
  carrying its whole `Sale`, with `SaleDateTime` a "Z" on wall-clock
  digits; a voided sale no longer appears in it.
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
- **The studio's late cancel MARKS the visit and keeps the pass** (T245,
  read live on site 471, 2026-11-17, read-only). Andie's visit 1305761 on
  class 112992 (the 7:30 PM Yin with Sound Bath of 11/16), marked Late
  Cancel in Mindbody's UI the morning after, is STILL on the class's visit
  list with `LateCancelled: true`, `SignedIn: false`, `Missed: true`,
  `AppointmentStatus: "Cancelled"` and her ClassPass `ServiceId` 567467
  still attached. No fee, no booking removed, no pass moved. And
  **Mindbody refuses a late cancel outside the studio's window**: a
  `Latecancel` about twelve hours before the class answered 4xx
  "Cancellation is outside allowed window." with nothing changed, and an
  `Unlatecancel` on a visit that was not late-cancelled answered 200 and
  changed nothing but `LastModifiedDateTime` (prod, dummy client
  100042041, visit 1305809, 2026-11-17). **After the class ended the same
  `Latecancel` was ACCEPTED** (19:46 the same day): `LateCancelled: true`,
  `AppointmentStatus` "NoShow" -> "Cancelled", the pass still attached,
  Remaining unchanged; `Unlatecancel` restored "NoShow". A visit nobody
  checked in reads `AppointmentStatus: "NoShow"` once its class is over.
  The window's size before a class is still unseen.
- **`/class/classvisits` puts the CLASS name in the visit's `Name` field.**
  Reading it showed every roster row as "bikram yoga". Names come from
  explicit client fields, and otherwise from the client index by id.
- **A client's `Id` is NOT unique on a site. `UniqueId` is** (T114). The
  `Id` every endpoint calls `ClientId` is the studio's editable RSSID, and
  Mindbody lets two records hold one: 10814 was both a current member and
  a record inactive since 2010, and the roster, keyed on `Id`, put the
  inactive one's name, waiver and alerts on the member's row. Ids are not
  even numeric ("n23283"). Pete's census found that one pair in 63,948
  records and renumbered the old one to `R10814` in Mindbody's UI
  (`updateclient` + `NewId` cannot do it: it finds the record by the
  ambiguous `Id`). A visit carries `ClientUniqueId` beside `ClientId`, and
  that is the handle: a read that goes from an id to one record goes
  through `pickClientRecord` (`src/lib/clientrecord.ts`), which picks by
  UniqueId when the caller has one, picks NOTHING when two records share
  the id and it has none, and logs `[client-id]`. Never `limit=1` on a
  lookup by id: it lets Mindbody choose and the exact-Id filter cannot
  tell. There is deliberately no UI for a shared id; a write that takes
  only the id lands wherever Mindbody resolves it.
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
  money path. Three fields sit beside the money and are NOT amounts: the
  gift card's barcode (T83; the studio's scanner types it), the discount
  pad's reason note and PIN (T43/T48/T71), and the Mindbody promotion
  code (T220, on the Cart screen and in the roster's pay dialog): a CODE
  read off an email, whose worth Mindbody decides and the screen only
  reports. Card entry keeps the OS
  keyboard on purpose, because that is where Apple's "Scan Credit Card"
  lives; T98 lifts every modal above the keyboard instead (`--vvh`,
  `--vv-top`, `--vv-bot`, `src/app/viewport.ts`). T98 has never been
  seen working on a real iPad, and the sign-in gate is where it failed
  (T215): a centred form put its password field under the keyboard, iOS
  scrolled the page to reveal it and the top went off the screen. So the
  gate's form is pinned HIGH, keyboard up or down, with its fields above
  where the keyboard will be, which leaves iOS nothing to scroll. A modal
  whose fields sit low is still trusting T98.
- **The sign-up forms ask a fifth field only when the site demands it**
  (T206). Both the customer screen's sign-up and the teacher's New client
  modal are D4's four fields ("first name, last name, email, phone.
  Nothing else") plus a birth date, drawn ONLY when
  `/client/requiredclientfields` names `BirthDate` or `Birthday`; one
  validator (`src/lib/birthdate.ts`) covers both screens and both routes,
  and a site that does not ask gets the same `addclient` body it always
  did.
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
  exception. See the phasing section of the design doc. (Since T25 the
  unpaid row's dialog does sell the pass, and since T242 it first offers
  a pass the student already holds; free entry stays in the purchase
  view.)
- **T242 is unverified live, and its list cannot see every rule.** It
  filters by program only, from reads; a pass Mindbody refuses for
  another reason (a membership restriction) is offered and the tap is
  refused in Mindbody's words. Pete's last T242 box is the live run on
  the dummy client.

- **A split of several cards has never met live Mindbody (T255).** A
  split may carry up to four legs, several of them typed cards beside the
  saved card, in ONE checkout; the spec puts no limit on `Payments` and
  two legs have sold, but several `CreditCard` entries in one call have
  not been seen. A refusal is a clean nothing-charged failure.
- **A gift card tender was refused at Finalize, cause unproven (T255).**
  Pete, 2026-11-09: "when finalizing a sale with a Gift card - 'missing
  key account' bug". No call record of it is in the repo. T83's `Metadata`
  is still a JSON STRING; the object `{amount, cardNumber}` is the by-hand
  thing to try (probe B7), never an automatic retry.
- **Card charges are live-proven by use, not by a recorded probe** (Pete,
  2026-11-15: "weve been using the app for months", and typed cards have
  been charged in testing). The note that stood here, that a live charge
  had never settled because the 2026-08-26 probe met an expired card, was
  stale. What is still unseen is only what T238 changed: a card charge
  UNDER $10 as one checkout.
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
  says so. Since T210 a refusal whose message carries "does not belong
  to the subscriber" (a token issued for the OTHER Mindbody site) is
  read the same way, with its own sentence on the gate. Still
  unverified: what Mindbody answers for an expired staff token
  (`isActorTokenDead` reads a 401 and that one sentence), and that the
  sales report actually shows the token's staff member. The probe is
  `GET /api/teacher/probe` (the sign-in modal and the dev drawer run it).
- **The waiver document upload is verified as accepted, not yet as
  visible (T202, probe D-B1, Pete, sandbox, 2026-09-20).** `POST
  /client/uploadclientdocument` answered `{FileSize: 72, FileName}` for
  a PNG sent as `{FileName, MediaType: "image/png", Buffer}`, and
  **`MediaType` is a MIME type**: the spec's own listed `png` is refused
  "Media type png is invalid", as are `.png`, `PNG` and `Png`. Whether
  the file then shows on the client's Documents page has not been looked
  at. The signature itself is kept in `waiver_receipts`, so a refused
  upload loses the copy, not the record.
- **`addclient` DROPS the text opt-in (T204, probe D-B3, Pete, sandbox,
  2026-09-20).** All six `Send*` flags sent `true`: the create's own
  answer and the read-back both carry the three email flags `true` and
  the three text flags `false`, so `AddClientRequest`'s silence about
  the caveat `updateclient` documents means nothing. The sign-up's
  "Text me" box still records the student's intention, and the T62-signed
  Notes line `/api/client-create` files on that evidence is the real
  path, for a human to set in Mindbody by hand, never a silent loss.
- **`ClientSignature` is accepted and does not move the Total (T205,
  probe D-B2, Pete, sandbox, 2026-09-20).** A `Test: true` rehearsal of
  contract 347 for client 100015484 priced 70.00 without the field and
  70.00 with a real PNG in it, and the answer carries no field about the
  signature. So the rehearsal stays signature-free and the live purchase
  carries it, as built. Not yet seen: the `clientContractSignature-...`
  document Mindbody says it files under the client on a REAL purchase;
  our own `contract_receipts` row is the record that does not depend on
  it.
- **The first-class star reads `FirstClassDate`, never seen live (T216).**
  The roster's star beside the M (`src/lib/firstclass.ts`) trusts the
  client record's `FirstClassDate` against the class on screen, and a
  record with NO date counts as a first class. Nobody has looked at what
  Mindbody puts there for a new walk-in, or whether it carries a time.
  If every row on a real roster shows a star, the field is absent and
  the rule needs another source. Since T217 the star also needs NO
  booking before this class (one `/client/clientvisits` read per
  remaining candidate, `fillEarlierBookings` in `src/lib/roster.ts`), so
  only the first class of the first day gets it; whether that read
  returns booked future classes, not just past ones, is also unseen.
- **The promotion code has been probed and sold live, once (T220).** Probe
  B5 on prod (Pete, 2026-11-14, dummy client 100042041 "John NewGuy"): an
  inactive code is refused 4xx "Promotion code is not active." and the cart
  reprices without it; a valid one-use code for 581 is honoured on
  `Test: true` ($49.00 -> $21.00, T75 agreeing); pricing it twice applied it
  twice, so a Test pricing does not spend it. Then a REAL sale on the
  counter build with that code: sale 428528, one 581 line at UnitPrice
  $49.00, DiscountAmount $28.00, TotalAmount $21.00, paid $21.00 cash, the
  pass active 11/14 to 11/27. **581 is ONE per client**: the next pricing
  for that client was refused "Client has hit the purchase count for this
  intro series." (prod, same day), which the Cart screen's refused-line
  notice showed as built. Still owed: a look at the deployed drawer's
  Shelf tab for a hidden `Service:581`. The code's spent state was not
  read (the probe stops at the pass refusal), but it was single-use and a
  real sale used it. The sale's `SalesRepId` came back null, which is T49's
  open attribution question below, not this feature's.
- **T221 is live-verified on the Cart screen, not yet on the roster
  dialog.** Driven against site 471 (2026-11-14) from a cloud session with
  the write guard on dummy client John NewGuy (100042041): the check
  answered 414 and 478 ("Only new clients qualify for this intro series.")
  and 581 ("Client has hit the purchase count for this intro series.") in
  1.6 to 3.3s (0.018s from cache); the three Specials tiles were greyed
  with those reasons by the time Specials opened; a tap on Welcome Back
  left the ticket at 0 items with the notice and its three ways forward;
  Drop In added and priced $28.00. The roster's pay dialog has been seen
  against the fake only.
- **Account credit is live-proven only as a $1.00 cash purchase on its
  own (T256, sale 428953).** A mixed ticket (credit plus items, step 2 on
  `DebitAccount`) and a card as the credit's payment have been run only
  on the fake; PLAN B9 is the first real mixed sale. Two credit purchases
  for one client within seconds once booked ONE sale with both lines
  (428932); T253's hold refuses that from the app, and the sale's line
  count is checked after every purchase.
- **Offline behaviour is unhandled.** Phase 1 arrivals could queue and replay;
  a Phase 2 sale must never queue, EXCEPT in Phase 4's planned outage mode
  (Pete, 2026-11-21: "this is a scenario where we will queue"), where a
  sale paid on the Square Terminal or in cash while Mindbody is down is
  queued in the database and posted once Mindbody answers (PLAN T275 to
  T278). Not built.
- `GET /sale/alternativepaymentmethods` returns HTTP 400, cause not chased. It
  only matters for a payment option the design ruled out.
