# The customer-facing iPad

Architecture for a second iPad at the counter that faces the student. The
teacher's iPad stays the master: nothing starts on the customer display
except because a teacher put it there, and nothing the student does on it
reaches Mindbody except through the teacher's own write routes. Four
things it will do, built one at a time in the order at the end:

1. **Sign the waiver** with a finger, and keep the signature.
2. **See the ticket** during a sale, and, when a studio-wide setting says
   so, approve it before the charge goes out.
3. **Register** as a new client by typing their own name, email and phone.
4. **Sign a contract** when a monthly autopay is sold, and keep that too.

This document is the reasoning. The build items land in `docs/PLAN.md`
under "Phase 2.5" and the usual ticket record in `docs/TICKETS.md`.
Read `front-desk-pos.md` "Waiver status" and CLAUDE.md's safety section
first: every rule there still holds, and this design is shaped by them.

---

## What it is not

- **Not a second POS.** The customer iPad has no roster, no search, no
  catalog, no drawer, no teacher session. It renders exactly one thing at
  a time, chosen by the teacher, and otherwise shows an idle screen. If
  someone walks off with it they hold a signed-in nothing.
- **Not the QR-on-their-phone flow.** Phase 3 (the student's own phone,
  Mindbody-hosted card capture, Apple Pay) is unchanged and still the
  better end state for card storage. This is a studio-owned device on
  the counter, which means a bigger screen, no pairing per student, and
  no dependence on the student's phone or on Mindbody hosting anything.
  The two share the "put something in front of the student" idea and
  nothing else; the waiver text, receipt and release write are already
  built (T18, T29) and are reused as-is.
- **Not a payment surface.** No card is ever typed on it (the design
  doc's "we can never build our own add-a-card form" rule), and it never
  calls `/api/checkout`. Approving a ticket is a yes/no; the charge still
  goes out from the teacher's iPad under the teacher's token.

---

## Shape

```
teacher iPad  ──HTTPS──▶  server (Railway, one instance)  ◀──HTTPS──  customer iPad
  /  (the POS)             src/lib/display.ts                          /display
  pos_session cookie       in-memory hub + display_requests table       pos_display cookie
  staff session            SSE fan-out, per display                    SSE subscriber
```

Everything goes through the server. The two iPads never talk to each
other directly: no WebRTC, no LAN discovery, no Bluetooth. That is the
whole reason it can be a web app, and it means the customer display works
wherever the POS works, over the same Railway URL, with the same TLS.

One new concept, the **display request**: a teacher puts a *scene* on a
display, the student acts, and the result comes back keyed by the
request id. Four scene kinds (`waiver`, `ticket`, `register`,
`contract`), one at a time per display. The teacher's iPad can cancel it,
and the display can complete it or refuse it. That is the entire protocol;
each feature is one scene kind plus what the teacher's iPad does with the
result.

### The display's identity: paired, minimal, its own cookie

The customer iPad does NOT hold the device session (`pos_session`) and
never sees the teacher sign-in gate. A student holds this device; a
cookie that opens the POS must not be on it. Instead:

- `/display` opens without any session and shows a **six-digit pairing
  code** with the studio banner. The code lives in server memory for
  five minutes.
- A signed-in teacher types the code into the dev drawer's Settings tab
  ("Customer display"). `POST /api/admin/display/pair` (device session +
  staff session; not admin-gated, a teacher setting up the counter is the
  point) binds that display to a `display_id`, and the display's next
  poll receives its `pos_display` cookie: httpOnly, HMAC-signed like the
  device token (`src/lib/auth.ts` idiom, same `POS_SESSION_SECRET`
  pepper), carrying only the display id. It grants exactly the
  `/api/display/*` routes and nothing else; `requireSession` still 401s
  everything real.
- The binding is a row in `displays` (id, name, paired_at, last_seen_at)
  when a database is configured, and memory otherwise, in which case a
  restart means re-pairing, which the display says on screen. Same
  posture as the T78 staff sessions. Unpair from the same drawer control.
- There is **one counter**, so the POS talks to "the display" rather than
  choosing one. The table allows more so a second counter is a pairing,
  not a redesign; until then the newest paired display is the display.

### Transport: SSE down, POST up, memory hub, table for durability

- **Server to display**: `GET /api/display/stream`, a Server-Sent Events
  response the display holds open. On connect the server replays the
  display's current request (so a reload or a Safari tab resume lands on
  the right scene), then pushes `present`, `cancel` and `idle` events. A
  15s heartbeat comment keeps Railway's proxy and Safari from closing it,
  and `EventSource` reconnects on its own. `last_seen_at` is stamped on
  each heartbeat; the POS header shows a small "display" mark that goes
  amber after 45s of silence, so a teacher knows before sending a waiver
  to a dead screen.
- **Server to teacher**: the POS already fetches; it gains
  `GET /api/display/events`, the same SSE shape, delivering `completed`,
  `refused` and `disconnected` for the requests this counter made. SSE
  rather than polling because the waiver case needs "the student signed,
  the release went out" to show up on the teacher's screen with no tap,
  and 350ms polling for an hour is more calls than a queue makes.
- **Display to server**: `POST /api/display/complete` with the request id
  and the result; `POST /api/display/refuse` with a reason. The display
  never sends a client id, a staff id or a price; it echoes the request
  id and the server looks up what the request was.
- **The hub** (`src/lib/display.ts`): an in-process map of display id to
  current request plus subscriber sets, the same idiom as `calllog.ts`.
  Railway runs one instance and the deploy doc says so; if that ever
  changes, Postgres `LISTEN/NOTIFY` slots in behind the same hub API. Not
  built until needed.
- **`display_requests` table** (id, display_id, kind, payload jsonb,
  status, result jsonb, requested_by_staff_id, created_at, completed_at,
  expires_at). It exists for one reason: a signature or a typed
  registration must survive the server restarting between the student
  tapping Done and the teacher's iPad consuming it. With no database the
  hub is memory-only and the display says "re-pair after a restart"; the
  charter's "runs fully without DATABASE_URL" holds because every scene
  degrades to the counter flow that already exists (the T18 dialog on the
  teacher's iPad, the T59b form, the contract purchase without a
  signature). A request that is never consumed expires after 30 minutes
  and its result is deleted; results are handles for one finalisation,
  not a record.

### Who writes to Mindbody, and under whose token

**The display never writes to Mindbody, and the server never writes on
the display's behalf.** A completed request is a stored result; the write
happens when the teacher's iPad, which is subscribed and awake, receives
`completed` and calls the existing write route with a `displayRequestId`
instead of the payload. The route pulls the signature or the form from
the stored request (never trusting the teacher's browser to relay it),
verifies it belongs to this counter and is unconsumed, runs the write
under `requireActor` exactly as today, then marks the request consumed.

This keeps every rule in one place. Dry run, the write guard, T49
attribution, the T50 "no sign-in, no write" refusal and the dead-token
handling all apply unchanged because the write route is unchanged in its
auth posture. It also means the audit is honest: the drawer's call log
shows the write with `actor=<staff id>` of the teacher who put the scene
up, which is who Mindbody should name as `ReleasedBy` or the sales rep.

The one cost is that finalisation waits for the teacher's iPad. It is
awake at the counter (it has an SSE stream open) and the write goes out
without a tap, so in practice the student sees "Thank you" and the
teacher's row updates in the same second. If the teacher's iPad IS
asleep, the result waits in the table for up to 30 minutes, and the
teacher's screen finalises it on wake and says so. That is the right
failure: a write that needs a teacher present rather than one that
happens because a student tapped a screen nobody was watching.

### What the display shows when idle

The studio banner (`app_settings` `banner_text`, or `POS_BANNER_TEXT`), a
greeting, and the theme the iPad is set to (T70's `data-theme` boot
script works unchanged). In the sandbox, or under dry run, a small mode
mark in the corner: the "never remove that banner" rule is for the
teacher, but a display that a teacher glances at should not lie either,
and a live studio shows nothing there. The display renders every
Mindbody-sourced text through `plainText` (T99) and none of it through
`dangerouslySetInnerHTML`: it is now in a student's hands, which makes
the rule stricter, not looser.

Kiosk posture: Add to Home Screen, then iPadOS Guided Access to pin the
app and disable the home button. The page itself hides nothing it should
not, because it holds nothing.

**The idle screen is also where a student starts on their own.** Under
the greeting, one 64px button: **"New here? Sign up"**. See "Self-serve"
below: it is what keeps a new student from tying up the teacher during a
rush, and it changes the display from a screen the teacher drives to one
the student can drive for the two things that need no teacher decision,
registering and signing the waiver.

---

## Self-serve: a new student registers without the teacher

**The problem (Pete, 2026-09-19):** "if a teacher has a line of students
to check in and one of them needs to register a new account, ideally that
student can do so without tying up the teacher from signing other students
in." Under the scene model as first written, registration starts from the
teacher's iPad and the teacher then waits on the result, which is the
opposite of that. So registration and the waiver, the two scenes with no
teacher decision in them, become **self-serve**: the student starts them
from the idle screen, finishes them alone, and the teacher meets the result
when there is a gap.

**Two kinds of request, one protocol.** A display request now has an
`initiator`: `teacher` (ticket, approval, contract, and a waiver sent for
an existing client) or `display` (self-serve sign-up). Same table, same
hub, same `complete`/`refuse` routes, same rule that the display never
writes to Mindbody. The one new route is `POST /api/display/start`, which
the display calls with a kind (`signup` for now), and which the server
accepts only from a paired display with no request in progress.

**The sign-up flow on the display**, one scene with steps, the student
holding the iPad the whole way:

1. The four fields and the two opt-in boxes (Scene 3's form, unchanged).
2. The waiver, scroll to the end, signature pad, "I agree" (Scene 1's
   screen, unchanged), for a client who does not exist yet. The signature
   is held in the request's result, not written anywhere.
3. "Thanks, <first name>. Tell the teacher you're signed up." Then idle.

The result is `{form, consent, signaturePng, agreedAt, waiverSha256}`, one
request, so the teacher's finalisation is one tap for both.

**The teacher meets it in a tray, not a wait.** The POS header gains a
**gold count badge** (the `--gold` role: badges and counts) beside the
display mark: "2 signed up". Tapping it lists the pending self-serve
results by name and how long ago. Tapping a name opens T59b's New Client
modal prefilled, exactly as Scene 3 does today, with a line saying the
waiver is signed and waiting. **Create** runs the existing
`/api/client-create` (duplicate detection intact: a student who already
has an account and signs up again is caught here, and the teacher merges
by searching instead), then, on success and without a second tap,
`/api/waiver-agree` with the `displayRequestId`, which records the
release, the receipt row with the signature, the document upload and the
Notes line for the client id that now exists. The row is then a client
like any other and the teacher checks them in. One tap for the teacher,
at a moment of their choosing, and the student was never in the queue.

**The search finds them too.** When a teacher types a name into walk-in
search and a pending sign-up matches it, it appears above the Mindbody
results as "signed up on the customer screen, not created yet", and
tapping it is the same Create. That is the path a teacher actually takes
when the student says "I just signed up": they search the name, as they
would for anyone.

**Priority when the teacher needs the screen.** A self-serve sign-up
holds the display until it finishes, is abandoned (no touch for two
minutes returns to idle and discards the partial form, so the next
student never sees the last one's email), or is cleared from the tray.
While it holds the screen:

- A live ticket mirror is skipped silently and resumes on the next
  priced change, since it is informational.
- An approval or a contract signature, which need the screen, tell the
  teacher "Someone is signing up on the customer screen" with **Wait**
  and **Take over**. Take over ends the sign-up with a "please start
  again in a moment" on the display and discards its partial form. The
  D1/D5 PIN overrides also remain, for a sale that cannot wait.

### Walkthrough: the teacher needs the screen (Pete, 2026-09-19)

The situation: a new student, Sam, tapped "New here? Sign up" and is
halfway through typing their email. The teacher is ringing up Jo, who is
next in line.

**Case 1, the live ticket mirror.** The teacher adds a drop-in to Jo's
cart. Normally the display would show Jo's ticket updating line by line.
Because Sam holds the screen, nothing happens on the display and nothing
happens on the teacher's iPad either: the mirror is informational, so it
is skipped without a word. When Sam finishes and the screen goes idle,
the next change to Jo's cart shows the full ticket as it stands. The
teacher never has to think about it.

**Case 2, sale approval is on and the teacher taps Charge.** The charge
needs the display, and the display is busy. So instead of "Waiting for
the customer to approve", the teacher's screen shows:

    Someone is signing up on the customer screen.
    [ Wait ]   [ Take over ]   [ Approve sale ]

- **Wait** leaves the charge pending on the teacher's screen. The moment
  Sam taps their final "I agree", the display goes straight to Jo's
  ticket with Approve and Not yet, with no further tap from the teacher.
  Sam's sign-up lands in the tray as usual. Right when Sam looks nearly
  done.
- **Take over** interrupts Sam. The display shows a short apology,
  "Please start again in a moment", for a few seconds, then Jo's ticket.
  Sam's partial form is discarded on the server, so nothing they typed
  is shown to Jo. Sam starts over once the screen is free. Right when Sam
  is still on the first field and Jo is in a hurry.
- **Approve sale** is the D1 override. The teacher enters their PIN, the
  charge goes out without the display, and the override is filed on Jo's
  client record with the teacher's name. Sam is not interrupted at all.
  Right when the teacher would rather not bother either student.

The teacher can also tap Cancel to go back to the ticket and do
something else first.

**Case 3, a membership sale needing a contract signature.** Exactly the
same three-way choice. Wait queues the contract behind Sam's sign-up and
presents it the moment the screen frees. Take over bumps Sam. The third
button is D5's "Sell without a signature" with the teacher's PIN, filed
on the client the same way.

**What Sam sees in each case.**

- Wait: nothing changes. Sam finishes, sees "Thanks, Sam. Tell the
  teacher you're signed up", and the screen moves on to Jo's ticket.
- Take over: the form vanishes mid-entry, replaced by "Please start
  again in a moment", then Jo's ticket. When Jo is done and the screen is
  idle again, the sign-up button is back.
- Approve sale / Sell without a signature: nothing changes for Sam.

**Two guards that make this safe.**

- A sign-up can never sit on the screen forever. Two minutes without a
  touch and it returns to idle, discarding the partial form, so a
  student who wandered off cannot block Jo's approval, and Take over is
  rarely needed.
- Only one thing holds the screen at a time. The server refuses a
  second self-serve start while any request is in progress, and a
  teacher's present either waits, takes over, or is overridden. There is
  no state where two flows both believe they own the display.

**Take over is a plain tap, no PIN and no confirm.** It costs Sam thirty
seconds rather than moving money or skipping a signature, and in a rush
one confirm too many is the thing teachers learn to hate. If it proves
easy to hit by accident, an "Interrupt Sam's sign-up?" confirm is a
one-line change.

Nothing here weakens a rule: the write still happens from the teacher's
iPad, under the teacher's token, after a human read the name back. What
changed is only WHEN, and that the student's part no longer waits for the
teacher's.

**Later, and the same mechanism: their own phone.** One display serves
one student at a time, and a 6pm line can hold three new students. The
idle screen (and a printed card at the counter) can carry a QR that opens
the same sign-up as a short-lived signed URL on the student's phone,
producing the same `display`-initiated request into the same tray, so
three people register at once while the display shows the ticket. That is
Phase 3's "customer's own phone" arriving through this door rather than
through Mindbody-hosted pages, and it costs one route and one token
format once the tray exists. Not in this phase's build order; recorded so
the tray is built as the thing it feeds.

---

## Scene 1: the waiver

**Trigger.** The T18 waiver dialog on the teacher's iPad gains one 64px
button beside "They have read it and agree": **"Sign on the customer
screen"**, enabled only when a display is paired and connected. Tapping
it POSTs `/api/display/present` `{kind: "waiver", clientId}`; the server
builds the payload from its own `getWaiver()` (text and sha256; the
display is never sent a hash to echo, the server already holds it on the
request) plus the student's first name for the greeting.

**On the display.** The full waiver text, scroll-to-end required exactly
as T18 requires it, a signature pad, "Clear", and "I have read it and
agree" at 64px, disabled until the scroll reached the end and the pad has
ink. The pad is a `<canvas>` driven by pointer events (finger or Apple
Pencil), exported as a PNG with a transparent background at roughly
800x300 and a typed name line beneath it drawn into the same image, so the
artifact is self-describing. A "Not now" refuses the request.

**Result.** `{signaturePng: base64, agreedAt}` stored on the request.

**Finalisation.** The teacher's iPad receives `completed` and calls
`/api/waiver-agree` with `{clientId, notes, displayRequestId}`. The route
does what it does today (verify the server's hash, release under the
teacher's token, log line, `waiver_receipts` row, Notes append) and adds:

- The receipt row gains `signature_sha256` and `signature_png` (bytea).
  This is OUR artifact, captured on our screen, so the charter permits
  it: the database is the original and Mindbody receives a copy. A
  signature PNG is 10 to 30KB; a year of new students is a few megabytes.
  (D2, Pete: "Do we know if Mindbody actually stores signatures? If so,
  both." It does, in two different ways: a contract signature has its
  own field, `ClientSignature`, which Mindbody files under the client's
  documents itself; a waiver has no signature field anywhere on the
  client, so its image is stored only because we upload it as a client
  document. Both are kept here; probe D-B1 confirms the upload lands
  where staff can see it.)
- The copy: `POST /client/uploadclientdocument` (client.yml:3633, 4MB
  cap) with `FileName` `waiver-<agreedAt>-<sha12>.png`, through
  `mindbody()` with the client id in the options so dry run and the write
  guard apply. Best effort like the Notes append: a failed upload reports
  `documentFiled: false` with the reason and the agreement stands, because
  the release is real and the receipt row already holds the image. The
  `ClientDocument` request shape (client.yml:7417, `FileName`,
  `MediaType`, and a bytes field) needs one sandbox probe to confirm the
  encoding before this ships; it is B-numbered in PLAN.md.
- The Notes line says "signed on the customer screen" rather than "agreed
  at the counter".

**Without a display** (unpaired, disconnected, no database), the button
is absent and T18's flow is exactly as it is now.

---

## Scene 2: the ticket, and the confirming tap

**Trigger.** The sale screen mirrors the ticket to the display as it is
built (D3, Pete: "Live"): every change to the priced cart (`/api/price-cart`'s answer, which
is Mindbody's own pricing, never the screen's arithmetic) is sent as a
`ticket` scene with `mode: "live"`. Lines, quantities, unit and line
prices, discounts as amounts, tax, total, and the client's first name. No
client id, no pricing option ids, no tender details. Re-presenting a live
ticket replaces the previous one; it is the one scene kind that is
updated in place rather than completed.

**The setting.** `app_settings` `customer_confirms_sale`, `"true"` or
`"false"`, default off. Global, because it is a studio policy, not a
per-iPad tunable: the drawer's localStorage settings are for numbers
that are wrong on one iPad, and this one must be the same on every
counter. It is edited from the drawer's Settings tab by a teacher whose
staff id is in `POS_ADMIN_STAFF_IDS`, the T89 idiom, and shown to
everyone. `/api/config` reports it. With no database it falls back to
`POS_CUSTOMER_CONFIRMS_SALE` in the environment.

**Off:** the Charge tap charges, as today, and the display then shows a
`ticket` with `mode: "summary"`: what was bought, what was charged, how,
and "Thank you" for a few seconds before returning to idle. Emailed
receipt state (T53) is shown when Mindbody confirmed one.

**On:** the Charge tap first presents `ticket` with `mode: "approve"`:
the same ticket with **Approve** and **Not yet** at 64px. The teacher's
screen shows "Waiting for the customer to approve" with Cancel. Approve
completes the request; the server records `{approved: true, cartSha256}`
where the hash is over the priced cart it presented. The teacher's iPad
then calls `/api/checkout` with `displayApprovalId`, and **the server
enforces the setting**: when `customer_confirms_sale` is on, a checkout
without a fresh, unconsumed approval whose cart hash matches the cart
being charged is refused with 409 and a plain sentence. "Not yet"
refuses the request with the reason shown to the teacher ("Customer did
not approve"), the ticket stays as built, and the teacher fixes it and
charges again. A disconnected display while the setting is on refuses
the charge the same way and says why.

**The teacher override (D1, Pete: "Teacher override, they must enter
their PIN").** Beside "Waiting for the customer to approve" sits
"Approve sale", which opens T48's PIN dialog: the signed-in
teacher's own PIN, checked against `teacher_pins`, issuing the same
short-lived comp token idiom as a comp does. `/api/checkout` accepts
that token in place of a display approval when the setting is on,
verifies it the way the comp route does, and files the override the way
T45/T62 file a comp's reason: a Notes entry on the client ("Sale
approved by <teacher> at the counter, customer screen not used") and
the staff id in the structured log line. So the setting is still
enforced on the server and cannot be waved through by a tap, but a
customer who walked off or a display that died does not stop a sale; it
costs the teacher their PIN and leaves their name on it. Turning the
setting off stays admin-only.

**Rule preserved.** Nothing here is optimistic and nothing auto-charges:
approval is a precondition the server checks, not an action that charges.

---

## Scene 3: registration

**Trigger.** Two ways in. The student's own, from the idle screen's
"New here? Sign up" (the self-serve flow above, which is the one a rush
uses). And the teacher's: T59b's New Client modal gains "Let them type
it", enabled when a display is connected, for the case where the teacher
is already talking to them; it presents `register` with no payload beyond
what the form needs (which fields are required, from
`requiredClientFields` as the modal already reads them) and continues
into the waiver the same way, so both ways produce the same result shape.

**On the display.** First name, last name, email, phone, and two
consent checkboxes, "Email me" and "Text me", both ticked by default
(D4, Pete: "Four fields. Include opt-in to text & emails (checked by
default)"), with the OS keyboard, at 16px minimum and 64px rows.
Each box sets all three of its channel's flags: email is T53's
`SendAccountEmails`, `SendPromotionalEmails`, `SendScheduleEmails`, and
text is `SendAccountTexts`, `SendPromotionalTexts`, `SendScheduleTexts`.
**Text is the one to watch**: on `updateclient` those three are
documented "cannot be updated by developers, ignored"
(client.yml:5290-5309), which is why T53 never sends them, but
`AddClientRequest` (client.yml:4709, flags at 4945-4956) lists them
without that caveat. So the registration sends them on the CREATE, the
one call that may honour them, and probe D-B3 reads the client back to
see whether they stuck. If they do not, the text opt-in is still shown
and still recorded, as a line in the client's Notes through the T62
signed-entry helper, so a human can set it in Mindbody; the box is never
silently dropped.
Text fields are fine here: the "no amount in a text field" rule is about
money, and this is the one screen where the student, not a teacher, is
typing about themselves. Done validates locally (an email shape, a phone
with enough digits) and completes with the four fields and the flags.

**Finalisation.** The teacher's iPad receives the result and fills the
modal with it. **The teacher taps Create**, and the existing
`/api/client-create` runs as today, with duplicate detection (T59b's
`isDuplicateClientError`) intact. A review tap is deliberate: the
teacher reads the name back, catches "jon" for "john", and it keeps the
create under a human's eye. The consent flags ride the `addclient` body
itself (see above), not a second `updateclient`, because that is the
call that can carry the text flags.

**The waiver is part of sign-up, not chained after it.** Both ways in
collect the signature on the display before the client exists, held in
the request, and Create finalises the release and the receipt right after
the client id comes back. One tap for the teacher, and the student never
hands the iPad back.

---

## Scene 4: the contract

**Trigger.** T30's contract purchase on the sale screen, which today
rehearses with `Test: true` and shows the server's first-payment Total,
gains "Sign on the customer screen". `contract` scene: the contract name,
`AgreementTerms` as plain text (T99's helper; the Description stays
unserved), the start date, the first-payment total and the autopay line
in words, the client's first name, and the server's sha256 of the raw
terms held on the request.

**On the display.** Terms, scroll to the end, the same signature pad as
the waiver, "I agree to these terms" at 64px. Refuse with "Not now".

**Result.** `{signaturePng, agreedAt}`.

**Finalisation.** `/api/purchase-contract` accepts `displayRequestId`.
The server pulls the PNG from the request and sends it as
`ClientSignature` on `POST /sale/purchasecontract` (sale.yml:6246, a
Base64 PNG that Mindbody files itself under the client's documents as
`clientContractSignature-...`). So unlike the waiver, the contract's copy
to Mindbody rides the purchase itself and needs no second call. The
receipt is ours: a `contract_receipts` row (client id, contract id, terms
sha256, signature sha256, signature png, agreed at, sale outcome), for
the same reason as the waiver receipt: Mindbody stores that a contract
was bought, not which wording was signed.

**A signature is required, with the teacher override** (D5, Pete:
"required but with override option"). This supersedes T30's "optional"
posture for the counter. When a display is paired, "Buy" on a contract
presents Scene 4 first, and `/api/purchase-contract` refuses the
live purchase (409, plain sentence) unless the request carries a fresh,
unconsumed contract signature for THIS contract and client, or the same
PIN token Scene 2's override issues. The override sits beside "Waiting
for the customer to sign" as "Sell without a signature", takes the
signed-in teacher's own PIN, and is filed on the client the same way:
a Notes line ("Membership <name> sold by <teacher> without a customer
signature") and the staff id in the log line, so the contract receipt
row records `signature: none, overridden_by: <staff id>`. The rule is
`contract_requires_signature` in `app_settings`, default on, admin-edited
beside `customer_confirms_sale` and reported by `/api/config`, so the
two customer-screen rules read and behave alike. With no display paired
at all the rule cannot be met, so the purchase asks for the PIN every
time and says why, which is deliberate: a studio that wants signatures
should notice when the screen that collects them is gone. One `Test:
true` probe with a real PNG confirms Mindbody accepts the field before
it ships (D-B2).

---

## Data, in one place

New tables, all charter-clean (ours, captured on our screen, nothing
Mindbody holds):

| Table | Holds | Not held |
|---|---|---|
| `displays` | id, name, paired_at, last_seen_at | nothing about who used it |
| `display_requests` | id, display_id, kind, initiator (teacher or display), payload, status, result, requesting staff id when the teacher started it, timestamps | consumed results past 30 minutes (deleted); an unconsumed self-serve sign-up past four hours (the student did not come back) |
| `waiver_receipts` (+2 columns) | signature sha256 and PNG beside the existing text hash | any client detail beyond the id |
| `contract_receipts` | client id, contract id, terms sha256, signature sha256 and PNG (or none plus the overriding staff id), agreed at, outcome | the contract itself (Mindbody's) |
| `app_settings` (+2 keys) | `customer_confirms_sale`, `contract_requires_signature` | |

`display_requests.payload` carries names and ticket lines for up to 30
minutes. That is the same class of data `calllog.ts` already holds in
memory, and it is why `/api/display/*` results are readable only by the
counter that made the request and only once.

---

## Security, plainly

- The customer iPad holds a cookie that opens four routes, none of which
  read Mindbody or name a client by id. Its scene payload is what the
  student may see anyway (their own name, their own ticket, the studio's
  waiver).
- Every write is the teacher's, under the teacher's token, from the
  teacher's iPad, through the write routes that already exist. Adding the
  display added zero write paths.
- The approval setting is enforced on the server, so the POS cannot
  bypass it, and it degrades closed (a missing display refuses the
  charge) rather than open.
- The pairing code is short-lived and typed by a signed-in teacher; an
  unpaired `/display` shows a code and the banner, nothing else.
- Signatures are stored as the images captured, hashed, and copied to
  Mindbody. They are never rendered back into the POS from Mindbody's
  URL; the profile card shows "signed on <date>" from our receipt.

---

## Order of work

Plumbing first, because every scene needs it, then the scenes in the
order Pete listed them. Each is one PLAN.md item with its own done-when.

1. **Plumbing.** `/display` route with the idle screen and pairing code;
   `pos_display` cookie; `displays` and `display_requests` migrations;
   the hub; the two SSE routes; present/cancel/complete/refuse; the
   header connection mark; the drawer's pair/unpair control. Done when a
   teacher can pair an iPad, see it connected, and put the idle screen
   through a restart.
2. **Ticket, summary mode only.** The live mirror and the post-sale
   summary. No approval, no writes: the cheapest scene and the one that
   proves the transport with real sale traffic.
3. **Waiver.** Scene 1 end to end, including the document upload probe.
4. **Ticket approval** and the `customer_confirms_sale` setting with the
   server-side gate.
5. **Sign-up, self-serve.** The idle screen's button, the `display`
   initiator and `/api/display/start`, the form-then-waiver flow, the
   tray with its gold badge, Create finalising both, the search hit, and
   the take-over rule. This is the item that answers the rush.
6. **Contract**, with the `ClientSignature` probe.

## Questions for Pete

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| D1 | Teacher override when approval is on and the customer taps "Not yet" or the display is down? | item 4 | **Answered 2026-09-19: yes, with the teacher's own PIN.** Folded into Scene 2. |
| D2 | Signature in our database as well as Mindbody's documents? | item 3 | **Answered 2026-09-19: both.** Mindbody stores a contract signature natively and a waiver signature only as the document we upload. Folded into Scene 1. |
| D3 | Ticket live as it is built, or only at Charge? | item 2 | **Answered 2026-09-19: live.** |
| D4 | Registration fields? | item 5 | **Answered 2026-09-19: four fields plus email and text opt-in, both ticked by default.** Text flags depend on probe D-B3; folded into Scene 3. |
| D5 | Contract signature on the display: required or offered? | item 6 | **Answered 2026-09-19: required, with the teacher's PIN override.** Folded into Scene 4 as `contract_requires_signature`. |
