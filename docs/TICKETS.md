# Phase 1 tickets

Working tickets derived from `docs/PLAN.md`. The plan says what and why; this
file tracks execution on the `feature/phase-1` branch, which Pete reviews
before anything merges to `main`.

Rules of the board:

- Implementation happens on `feature/phase-1`. One ticket, one commit (or a
  small series), checked off here in the same commit that ships it.
- Agents in a remote container have no `.env`, so "done (code)" means:
  typecheck clean, build clean, request shapes verified against
  `docs/mindbody-openapi/`, conventions honored (colour tokens only, nothing
  under 16px, 64px tap targets, no em dashes in copy). Live verification
  against Mindbody is a separate checkbox and belongs to Pete.
- **Nothing is blocked by auth.** T10 is deliberately last.
- Every ticket gets an adversarial review pass by a separate reviewer before
  it counts as done (code).

## T1. Verify check-in against a real class (PLAN 1.1)

The one call everything else scaffolds around: `POST /client/updateclientvisit`
`{VisitId, SignedIn}`.

- [x] Code audit: confirm the implemented call matches the vendored spec
      exactly (payload shape, response handling, `SignedIn: false` reversal)
- [ ] Pete: flip a `SignedIn` flag on and off against a write-guarded dummy
      client, drawer open, and see it change in Mindbody

Note: the plan says "sandbox", but the studio's credentials only authenticate
against site 471, so the real rehearsal is prod + `POS_DRY_RUN=false` +
`POS_WRITE_CLIENT_IDS` set to a dummy client. Creating that dummy client in
Mindbody is a Pete task.

## T2. Walk-in booking, the money-free half (PLAN 1.2)

`POST /class/addclienttoclass`, permission already held. Depends on T1's code
audit (same visit plumbing).

- [x] Book a searched client into a class from the UI
- [x] `Waitlist: true` offered when `TotalBooked >= MaxCapacity`, never a bare
      failure
- [x] Waitlist promotion via `WaitlistEntryId`
- [ ] Rehearsed with `Test: true` where credentials allow; shapes
      spec-verified regardless (no `.env` in the build container, so the
      rehearsal is still owed; payload shapes verified against
      `docs/mindbody-openapi/class.yml`)
- [ ] Pete: book a write-guarded dummy client for real, then check them in

Watch live: whether `/class/waitlistentries` with `HidePastEntries=true`
counts an in-progress class's entries as "past". If it does, the promote list
goes empty exactly when a teacher needs it, and the flag has to go.

Found in live testing (2026-08-28): **the API overbooks without complaint.**
Rapid parallel adds pushed a 20-cap class to 21; `/class/addclienttoclass`
refused nothing. So the app's own `TotalBooked >= MaxCapacity` check is the
only thing routing people to the waitlist, and bookings are now serialized
client-side (one in flight at a time) so no two adds can race the same
stale count. The same incident found Mindbody's real batch limit for
`/client/clients`: 20 ids per request (21 returns HTTP 400 "ClientIds
should not be more than 20."), now the chunk size in `briefsForIds`.

## T3. Header counters (PLAN 1.3)

- [x] Signed up, checked in, capacity from data already on hand (roster
      length, `SignedIn` count, `MaxCapacity`/`TotalBooked`)
- [x] Waitlist count via `GET /class/waitlistentries`, fetched **only** when
      `TotalBooked >= MaxCapacity` (one fetch, shared with the T2 waiting
      list panel)
- [x] A class with room renders all counters with zero extra calls

## T4. Counter modals (PLAN 1.4) — after T3

- [x] Tapping a counter lists the people behind it
- [x] Waitlist entries are stubs (`ClassId`/`ClientId` only): names resolve
      through the same batched client lookup the roster uses, not the row
      component
- [x] "Is Dennis here yet" answerable without scrolling the roster

## T5. Client context on the expanded row (PLAN 1.5)

Fetched on row open, never per roster.

- [x] Pass and `Remaining` from `/client/clientservices`; `Remaining: 1`
      surfaced loudly (highest-value prompt in the app)
- [x] Account credit from `/client/clientaccountbalances`
- [x] Recent visits from `/client/clientvisits`
- [x] Habitual add-ons from `/client/clientpurchases`, shown only on a real
      pattern (3 of last 5), otherwise suppressed
- [x] `Notes` shown; `RedAlert` treated as blocking, not decorative

Spec traps found while building (all in `docs/mindbody-openapi/client.yml`
and now compensated for in `src/lib/clientcontext.ts`): `clientservices`
defaults StartDate AND EndDate to today, `clientvisits` defaults StartDate
to the END date, and `clientpurchases` defaults StartDate to **now** -- all
three return an empty window unless StartDate is sent explicitly.
`clientaccountbalances` takes plural `ClientIds` and returns Client records
with `AccountBalance` on each. `Notes`/`RedAlert` are top-level Client
fields, fetched per row open via `/client/clients?clientIds=` (the roster's
batched name lookup runs only for nameless visits and keeps only names, so
there was nothing to reuse).

Still owed live verification (Pete, drawer open): that the four context
calls return real data for a real client, and that a red-alert client
actually shows the blocking dialog. Also check live: the sign convention of
`AccountBalance` (credit vs owed -- the spec does not say), and that a
check-in made after the class start time does not overstate the visit count
by one (the current class's visit can appear in the window).

Follow-up (new ticket when reached): a red-alert walk-in can be booked from
the search panel without the alert ever showing -- context only renders on
roster rows. The design doc wants RedAlert on the walk-in panel too.

Found in live testing (2026-08-28): for a client id Mindbody considers
inactive or unknown, `clientaccountbalances` and `clientpurchases` 400
("Client with Custom ID ... is inactive or does not exist") but
`clientservices` silently IGNORES the filter and returns pricing options
site-wide -- ~90 strangers' passes rendered on one row, and any of them
with `Remaining: 1` fired the last-class banner falsely. Fixed twice over:
the response is scoped client-side on each item's `ClientID`, and a client
whose record says `Active: false` gets a pass-list error regardless of what
came back (sandbox payloads confirm the field is returned). Note the
distinction seen live: `Active` is whether the record is archived,
`Status` is membership standing, and `RedAlert` is free text unrelated to
the structured `SuspensionInfo` (Amanda's says suspended while
`BookingSuspended` is false).

Cheap improvement spotted in the live classvisits payload: each visit
embeds the FULL pass object (`Visit.Service` with `Name`, `Remaining`,
`Count`). For booked students, `Remaining: 1` could light the renewal
prompt on the roster row itself, zero extra calls, without waiting for a
row open. Picked up by T11.

More live confirmations (Colin Dennis payloads, 2026-08-28): every
`clientservices` row carries `ClientID`, so the anti-spill scope guard has
a real field to bite on; each purchase of the same pricing option is its
own ClientService row with a distinct `Id` (three "Personal Training"
rows, one ProductId); `clientpurchases` repeats the whole sale wrapper
once per line item, same `Sale.Id`, which the habit rule's sale grouping
already collapses; and `clientvisits` includes bare gym "Arrival" rows
(`VisitType: -2`) in the visit count, which is acceptable for "how often
are they here" phrasing.

## T6. Waiver state (PLAN 1.6)

- [x] `Liability.IsReleased` / `AgreementDate` surfaced on the row (joins the
      batched client lookup; `/class/classvisits` does not carry it)
- [x] Unmissable blocked state; **no tap path marks a waiver signed**
- [x] A student without a waiver cannot be checked in by reflex

Spec confirmed (`docs/mindbody-openapi/client.yml`): `Liability` on the
Client record is `{IsReleased: boolean, AgreementDate: date-time,
ReleasedBy: int}`; `LiabilityRelease: true` on `POST /client/updateclient`
is the one-line write the design doc forbids, and nothing in this app sends
it. The roster's batched `/client/clients?clientIds=` lookup now runs for
ALL roster ids (it was nameless-visits-only) and carries `waiverSigned`
onto every entry; still one round trip per roster load, chunked at 40 ids
because the old single-URL form would not survive a full room. A row with
`IsReleased` false or absent shows a stop-red "no waiver" chip and its tap
opens an explanation with only a Close button, short-circuiting BEFORE the
red-alert and unpaid gates; check-out of an already-checked-in person is
untouched. A failed lookup fails OPEN (null, no badge, quiet notice):
blocking every row on an outage would stop the counter, and the risk being
managed is reflex check-ins.

Still owed live verification (Pete, drawer open): that a real client with
no waiver comes back with `Liability.IsReleased: false` (not omitted) and
shows the blocked row; that a released client shows a normal row; and that
the batched lookup returns `Liability` at all under our staff credentials
(the spec says it is on the record, nobody has watched it live).

## T7. Studio banner (PLAN 1.7)

- [x] Text from an env var, shown until changed. No scheduling, no targeting.

`POS_BANNER_TEXT` (commented in `.env.example`), exposed through the existing
`GET /api/config` rather than a new endpoint. Empty or unset renders nothing.
Rendered below the mode banner in a deliberately different shape (surface with
an accent rail, not a filled status pill) so an announcement can never crowd
out or be mistaken for the dry-run/live line. Tokens only, both palettes,
17px. Changing it is a Railway variable edit plus redeploy, per the design
doc's option (1).

## T8. Categories config (PLAN 1.8)

- [x] Five hardcoded entries ordered by counter frequency: Towel and Mat
      (-14), Food/Drink (36), passes, Accessories (32), Clothing (26);
      everything else behind "more". Not fetched.

`src/lib/categories.ts`: config plus types, no UI (Phase 2 groundwork; the
sale screen will be its first consumer). "Passes" carries no category id:
per the design doc's live dump, pass-like items span several Service:true
categories (ClassPass -12, Vinyasa -15, Classes 1, Course -11), and passes
sell as pricing options via /sale/services rather than as retail products
filtered by category, so that entry's `categoryIds` is deliberately empty.

## T11. Roster rows carry what the MB sign-in screen shows (Pete, 2026-08-28)

Pete's live comparison against Mindbody's own Class Sign In screen: it shows
balance, payment type, expiration, and remaining per row with no extra taps,
and the app must not feel like more work than the tool it replaces. All of
this is data the app already holds, so the ticket is surfacing, not fetching:

- [x] Parse `Visit.Service` (Name, Remaining, Count, ExpirationDate, Id) out
      of the `/class/classvisits` response into each roster entry. Zero new
      calls; the pass name replaces the bare `ServiceName` string.
- [x] Show remaining classes and expiry on the row, but never print
      Mindbody's absurd unlimited counters (99999, 99988, 1000): when the
      pass's original `Count` is 100 or more, treat it as unlimited and show
      no number. `Remaining: 1` stays loud (the renewal prompt from T5's
      follow-up lands here).
- [x] `AccountBalance` and `MembershipIcon` join the batched
      `/client/clients` roster lookup (both are top-level Client fields, so
      the same one round trip). Balance shows on the row only when nonzero;
      membership shows as a small M chip. No S chip: the balance itself
      replaces it, per Pete.
- [x] Red alert gets a visible icon on the row (the gate already exists;
      the icon makes it visible before the tap).
- [x] The context panel's visit list collapses to ONE line, highest signal
      wins: "3rd class this week", else "2 visits in the last month", else
      "Last here May 28". Never more than one of those.

## T12. Roster sort (Pete, 2026-08-28)

- [x] Sort control above the roster: sign-in order (Mindbody's roster order,
      the default), last name, first name. Choice persists in localStorage.
      Teacher-facing, so 16px+ and 64px targets apply.

## T13. Change which pass pays for a visit (Pete, 2026-08-28)

Mindbody's "Change how the client is paying" dialog. Spec-confirmed:
`UpdateClientVisitRequest` takes `ClientServiceId` ("the ID of the service
to assign to the visit"), so this is the same `POST /client/updateclientvisit`
endpoint check-in already uses, with the same write-guard clientId threading.

- [x] On the expanded row, when the client's fetched pass list has more than
      one current option, offer a change affordance next to the payment line
      (the pass list already loads on row open; no new read).
- [x] Picking one posts `{VisitId, ClientServiceId}` through the existing
      guard plumbing and refreshes the roster so the row shows the new pass.
- [x] Suppressed writes (dry run / write guard) surface as such, same as
      check-in.
- [ ] Pete: verify live against a write-guarded dummy client; the sandbox
      payloads suggest the visit's `Service` swaps, nobody has watched it.
      Include the after-check-in case: change the pass on an already
      signed-in visit and confirm (a) SignedIn stays true (we never send
      it) and (b) the Remaining counts move correctly, one back onto the
      old pass, one off the new. The spec does not document that
      bookkeeping; it is the expected behavior because it is what MB's own
      Change dialog does.

Buy button from the MB screen: deliberately NOT here. That is Phase 2's
sale path (sell the missing pass and check in together), already planned.

## T14. Rows are the whole story: no dropdown, aligned columns (Pete, 2026-08-28)

Pete's screenshot review of T11-T13: the expandable row is the friction he
asked to remove, and detail moved INTO it missed the point. Rework:

- [x] The roster row expando is gone. Everything renders on the row, in
      aligned columns (CSS grid shared across rows, like MB's table): name
      with M / alert / notes icons, payment type, expiration, remaining,
      balance. A one-line history sits with the row too.
- [x] Exactly ONE form of payment shows: the pass paying for this visit, or
      "No pass". "Change" is the only way to see the others,
      and it is an inline dropdown (not a modal): other current passes as
      options, current one marked, pick one to post the existing
      /api/visit-payment write. An unpaid booking with available passes gets
      the same dropdown to assign one.
- [x] Fake-unlimited suppression applies EVERYWHERE a pass renders,
      including the change dropdown options ("99993 of 99999" leaked in the
      old panel pass list).
- [x] Negative account balance renders in the danger colour (token, both
      palettes).
- [x] History one-liner needs `/client/clientvisits` per client, so it is
      fetched in a background sweep AFTER the roster renders and cached per
      client for the session; rows fill in as answers land. The roster
      itself never waits on it.
- [x] Notes ride the existing batched `/client/clients` lookup (`Notes` is
      a top-level Client field); the notes icon tap shows the text. Red
      alert icon tap shows the alert. Open in Mindbody becomes a small
      per-row affordance. The old context panel and its five-call fetch
      retire; the change dropdown fetches `clientservices` on demand.
- [ ] Pete: eyeball the grid on the studio iPad in landscape, both
      palettes, and watch one payment change land in the dev drawer.

How it landed (all done (code): typecheck and build clean, no live run in
this container):

- One grid template (`--roster-cols` in `globals.css`), shared by the
  header row and every roster row, is what aligns the columns; the payment
  cell truncates with an ellipsis rather than wrapping the grid. The whole
  row is still the check-in target, exactly as before; inline controls
  stop the tap from bubbling. Walk-in search rows and the counter/waitlist
  modals keep their old flex layout untouched.
- Pete's refinement, mid-build: the alert/notes icons open INFO-ONLY
  modals (title, text, one Close button) that never ack the alert, while
  the check-in gate keeps the existing blocking dialog with Cancel and
  "I have read it, check in". Reading an alert is not reading PAST it.
- `src/lib/clientcontext.ts` slimmed to the two per-client reads the new
  design still makes: `fetchPasses` (dropdown, on demand at first open,
  cached per client for the session, failed fetches retried on reopen) and
  `fetchVisits` (history sweep). The five-call `clientContext` bundle, the
  balance/habits/profile fetches, the habit rule, and `/api/client-context`
  are deleted; `/api/passes` and `/api/history` replace them. The
  clientservices StartDate trap handling and the per-item ClientID
  anti-spill scope survived the move verbatim. Knowingly dropped with the
  bundle: the inactive-client (`Active: false`) belt-and-braces pass-list
  refusal, which rode the deleted profile fetch; the ClientID scope guard
  (confirmed live to have a field to bite on in every row) still catches
  the observed spill.
- The history sweep runs 4 fetches at a time after the roster renders,
  caches per client id for the session (a failed lookup is also not
  retried until reload; a history line is not worth a retry storm), and
  because the cache is keyed by client a late answer cannot dirty another
  class's rows. A row with no visits shows nothing, deliberately.
- The dropdown's top line is the roster's own `Visit.Service` data, so it
  is always the truth the row shows even before `/client/clientservices`
  answers; suppressed writes render as an amber notice inside the open
  dropdown, never as success. Escape and outside tap close it, except
  while a write is in flight.
- Also gone with the panel: the habitual add-ons prompt ("usually adds"),
  the account-credit line (balance is now a column), and the panel's
  "No active pass." line. The last-class banner's job is done by the loud
  "1" in the LEFT column.

## T15. Counter flow round two (Pete, 2026-08-28)

From live testing after T14 and the five-fix polish pass:

- [x] Sorting control (sign-in order / last name / first name). First
      shipped as a compact pill bar; SUPERSEDED same day by Pete: it is
      now a single quiet 44px sort icon at the right end of the roster
      column-header row, over the actions column, opening an anchored
      menu with the active order checked. Same 44px standing as the undo
      control (occasional deliberate tap, the recorded exception to the
      64px floor); the choice still persists in localStorage.
- [x] Walk-in search results carry context: waiver, red alert, balance and
      membership come free (searchText returns full Client records; this
      also closes the T5 follow-up about red-alert walk-ins booking without
      the alert showing). Forms of payment need one clientservices call per
      shown result: fetched in the background after the debounce settles,
      session-cached per client, displayed as the shortened pass summary.
      Metered-call note: worst case is result-limit calls per novel search.
- [x] A checked-in client with no waiver can still be signed OUT. The
      waiver gate blocks check-IN only; the undo control renders on every
      checked-in row regardless of waiver state.
- [x] Check-out icon becomes an undo symbol (counter-clockwise arrow), not
      an X.
- [x] Rows not checked in get a trash icon where the undo would sit:
      cancel the visit entirely via /class/removeclientfromclass (verify
      against docs/mindbody-openapi/class.yml), behind a confirmation
      dialog that names the person and says they will be removed from the
      class list. Write-guarded like every write; roster refreshes on
      success; suppression surfaces as such.
- [x] Notes icon on every roster row: dimmed when the client has no notes,
      normal when they do. Tapping opens the note box either way, with a
      pencil edit affordance that lets a teacher edit or add notes, saved
      via /client/updateclient with a minimal {Client: {Id, Notes}} payload
      (verify the partial-update shape against client.yml; this is the
      app's first client-record write, so it must be surgical: never send
      fields beyond Id and Notes, and never touch Liability). Pete: verify
      live against the dummy client that only Notes changes.
- [x] (added 2026-08-28) The Expires and Left columns go away: their data
      moves under the payment name as a second line ("3 remaining,
      exp 3/2/27"; a fake-unlimited pass shows only the expiry; no pass,
      no line). The sub-line is 14px muted, a DELIBERATE exception to the
      16px floor, Pete's call: secondary glance data, same standing as the
      compact sort bar. "1 remaining" keeps its warn pill inline. The same
      two-line format applies to the walk-in rows' pass summary; the
      change dropdown keeps facts to the right but aligns them as shared
      right-aligned columns down the list.
- [x] (added 2026-08-28) The horizontal class bar goes away: one header
      row with the current class on the left (date AND time, e.g.
      "Fri Aug 28 · 6:20 AM", name and teacher, plus a labelled 64px
      "Change class" button opening a picker of the classes around now
      with the old bar's facts and the current one marked) and the three
      counters compacted on the right. Layout only: classes data and
      selection state are unchanged.

## T16. Counter flow round three (Pete, 2026-08-28)

- [x] Pass dropdown: names never ellipsize. The name column gets real
      width (wider dropdown, flexible name column, wrap to a second line
      before ever truncating); the left/exp fact columns stay aligned.
      The dropdown now anchors to the ROW's right edge (it was
      left-anchored under the payment cell), so at its new width it can
      never overflow the viewport's right side.
- [x] The selected class id lives in the URL as a query param, so a
      refresh returns to the same class instead of the default. Reading it
      back tolerates a class no longer in the window (falls back quietly
      and corrects the param).
- [x] Tapping the ROW no longer checks anyone in. The check-in chip is the
      only trigger; all gates (waiver, red alert, unpaid confirm) move to
      the chip tap. DECISION REVERSAL, Pete's call: the original design
      made the whole row the target for speed; live use showed accidental
      check-ins. Do not restore row-tap check-in. Walk-in rows got the
      same treatment: the add chip is the only action.
- [x] Search results move into their own modal, formatted with the SAME
      row layout as the roster list (grid columns, icon slots, pass
      sub-line, balance column), with an X close button that closes with
      no action. No more auto-search while typing: the debounced
      live search goes away; Enter (or a Search button) submits, which
      suits the mobile keyboard anyway. Minimum-length check applies at
      submit. The dev-drawer debounce setting retires with it. (The
      modal's rows scope --roster-cols to a sibling template: no notes
      slot, add chip only in the actions column. A successful add closes
      the modal and clears the search; suppressed writes, errors and
      waitlist adds keep it open with the feedback on the row.)
- [x] Balance column: no ellipsis. Widen the column to fit real
      four-figure balances, right-aligned with tabular figures so the
      decimal points line up down the roster. (7em, sized for a
      five-figure negative; the search modal's balance column matches.)

## T17. Search modal polish (Pete, 2026-08-28)

- [x] The name column in the search modal never ellipsizes; it is the one
      column that cannot. Name gets the row's full first line; email goes
      away entirely; the second line holds only the icons (M, alert) and
      the no-waiver chip.
- [x] The add chip becomes a "+" icon button.
- [x] When a result has multiple current passes, which pass will pay is
      selectable IN the modal (same chevron/dropdown idiom as the roster),
      but selecting takes NO action; the booking happens only on the "+"
      tap, using the chosen pass. Check the spec first: if
      AddClientToClassRequest carries ClientServiceId, send it in the one
      booking call; otherwise book then assign via the existing
      updateclientvisit path with the returned visit id.

Spec answer (docs/mindbody-openapi/class.yml): `AddClientToClassRequest`
DOES carry `ClientServiceId` ("the ID of the pricing option on the
client's account that you want to use to pay for this booking"), so the
chosen pass rides the ONE booking call and there is no follow-up
updateclientvisit write. No explicit choice omits the field: the payload
is byte-for-byte what it was, and a waitlist add never sends it (a queue
entry is not a booking). The picker in the modal is position: fixed,
anchored from the row at open time, because the modal's scrolling list
would clip a row-anchored absolute dropdown; scrolling the list closes
it. Selection resets when the modal closes or a new search lands. Live
verification of the chosen pass actually landing on the visit belongs
with Pete's T2 rehearsal.

## T18. Waiver signing at the counter (Pete, 2026-08-28)

Promoted from the note below at Pete's direction. DECISION REVERSAL,
recorded: T6 shipped "no tap path marks a waiver signed", and Pete has
overruled it for the counter flow, on the grounds that Mindbody's own POS
shows the waiver text with a staff-tappable Resolve, so matching it
replicates the studio's existing tool rather than creating a new risk.
The Phase 3 QR-on-their-phone flow stays the better end state; this is
the bridge.

- [x] The no-waiver gate dialog grows a "Read the waiver" path: fetch the
      studio's real waiver text from GET /site/liabilitywaiver (verify
      the response shape in docs/mindbody-openapi/site.yml), shown
      scrollable at 16px+. The old close-only dialog remains the shape
      when the waiver text cannot be fetched.
- [x] The confirm is unmistakably the STUDENT's agreement: enabled only
      after the text has been scrolled to the end, worded "They have
      read it and agree", button "Record agreement and check in". No
      path records agreement without the text having been shown.
- [x] Confirming writes the release via POST /client/updateclient with
      the same surgical discipline as notes (verify against client.yml
      where LiabilityRelease sits in UpdateClientRequest; send nothing
      beyond the id, the release flag, and CrossRegionalUpdate: false),
      write-guarded and dry-run-suppressible like every write, then
      refreshes and checks the row in through the normal path.
- [x] The receipt, from day one, since Mindbody stores no waiver text or
      version: (a) a structured server log line (client id, timestamp,
      sha256 of the exact text served) written whenever an agreement is
      recorded, and (b) the same line appended to the client's Mindbody
      Notes through the existing surgical notes write, so the receipt
      travels with the client where staff already look. A standalone
      receipt store waits for the database (design doc Phase 3).
- [x] The design doc's waiver section gets a short dated addendum
      recording Pete's decision and the MB-Resolve reasoning, so the
      reasoning of record stays true.
- [ ] Pete: live-verify against the dummy client that IsReleased flips,
      AgreementDate stamps, the receipt lands in Notes, and nothing else
      on the record changes.

## T19. The waiver gates the walk-in ADD, not just check-in (Pete, 2026-08-29)

Found live: a no-waiver student can be booked from the search modal with
no waiver dialog, and a booking made after class start can come back from
Mindbody already signed in, so the roster's check-in gate never runs. The
T18 review flagged the gap; Pete confirmed it is a real hole.

- [x] tapWalkIn gates on waiver FIRST, before the red alert, same order
      as the roster's tapCheckIn: a result with waiverSigned false opens
      the T18 waiver dialog (real text, scroll to end, record the
      student's agreement) from inside the search modal.
- [x] On a recorded agreement the flow continues to the BOOKING (not a
      check-in), with the result row's waiver state updated so the pill
      clears without a new search.
- [x] A failed/unfetchable waiver text falls back to close-only, and the
      add stays blocked, matching the roster gate's posture.
- [ ] Pete: verify live whether /class/addclienttoclass after class start
      returns the visit SignedIn true (the suspected mechanism); either
      way the add-side gate closes the hole.

## T20. One info view: red alert, yellow alert, notes (Pete, 2026-08-29)

DECISION REVERSAL, recorded: Pete studied the studio's actual RedAlert
usage separately and determined it is NOT used to block classes (e.g.
"Cleaning on Wednesdays"). So the red alert stops gating check-in and
walk-in adds entirely; the blocking dialogs and the session ack list
retire. The waiver gate is untouched. Auditing/cleaning the alert
contents is deliberately out of scope.

- [x] The separate alert and notes icons become ONE info icon per row
      (roster and search results; the M chip stays separate): greyed out
      when the client has no red alert, no yellow alert, and no notes;
      bright when any exist.
- [x] Tapping it opens one info view showing all three fields (Red
      alert / Yellow alert / Notes), each editable with the same pencil
      -> textarea -> Save flow notes already have. Each save is its own
      surgical /client/updateclient write sending ONLY the id, that one
      field, and CrossRegionalUpdate: false (verify RedAlert and the
      yellow-alert field name and writability in client.yml first; if
      yellow is not writable or not present on the client record, show
      what exists and say so in the report).
      The whitelist (exactly Notes | RedAlert | YellowAlert) is enforced
      server-side in /api/client-field, which generalized and replaced
      /api/client-notes; the red alert keeps its stop treatment inside
      the view, the yellow gets the warn pair.
- [x] YellowAlert (or its real field name) joins the batched roster
      lookup and the search mapping, fail-open like its siblings.
      Spec-confirmed in docs/mindbody-openapi/client.yml: the field IS
      `YellowAlert`, a plain string alongside `RedAlert` on
      `ClientWithSuspensionInfo`, which is exactly the schema
      `UpdateClientRequest.Client` references -- so both alerts are
      writable through the same surgical updateclient envelope notes use.
- [x] The red-alert blocking dialogs (roster and walk-in), the acked
      list, and their gate branches are removed; check-in order becomes
      waiver -> unpaid confirm; walk-in add order becomes waiver ->
      full-class/waitlist. The waiver gate and its T18/T19 discipline
      are untouched, re-traced after the removal: no path books or
      checks in a waiverSigned false client without a recorded
      agreement.
- [x] Promote-from-waitlist gets the waiver gate too (found by the T19
      review): waitlist rows carry no waiver state, so a no-waiver
      student who waitlisted online can be promoted with no dialog, and
      an after-start booking can come back already signed in. Enrich the
      waitlist rows with waiverSigned through the roster's batched
      client lookup and gate promote() with the same waiver dialog (a
      third subject flavor whose continuation is the promotion).
      waitlistFor's ONE briefsForIds call (the same one that already
      filled missing names, widened to every row) now carries
      waiverSigned and notes, fail-open null on a failed lookup --
      unknown never blocks a promotion, matching the roster's posture.
- [ ] Pete: live-verify one alert edit and one yellow edit on the dummy
      client change only their field.

## T9. Deployment, minus auth (PLAN Phase 1.5)

Not blocked by T10. Ships behind the existing safety rails.

- [ ] Railway service deployed
- [ ] `POS_DEVTOOLS=false`; mode banner verified in the deployed build
- [ ] Add to Home Screen on the studio iPad
- [ ] Pete: watch a teacher work a 6pm rush; file what they hit as new tickets

Caution carried from the plan: until T10 lands, the deployed app is an open
endpoint against live student data. Deploy with `POS_DRY_RUN=true` or keep the
URL private until auth exists; Pete's call, recorded here so it is a decision
and not an accident.

# Phase 2 (feature/phase-2)

Phase 1 merged to main 2026-08-29. This section tracks the autonomous
Phase 2 run Pete authorized: no waiting between tickets; assumptions made
in his absence are recorded per ticket and reversible. Everything ships
behind the existing rails (sandbox default, POS_DRY_RUN on prod, write
guard, nothing auto-charges, Test: true rehearsals). Deferred: PLAN 2.6
(the $49 special and $21 upgrade) is blocked on probe B1 and question P3
and is NOT built in this run; probes B1/B3 remain Pete's.

## T21. Auth: shared PIN (PLAN Phase 1.5)

The service-account decision (P1) stands: one shared PIN for the studio,
per the .env.example stub. Per-teacher identity waits on payroll.

- [x] POS_PIN env var (unset = auth disabled, for dev). A lock screen
      (64px keypad, same visual system) gates the app; a correct PIN sets
      an httpOnly signed session cookie (long-lived; the iPad stays
      unlocked through a shift).
- [x] EVERY API route refuses without the session (401), including
      devlog; the page itself renders only the lock screen when locked.
- [x] No PIN or its hash ever reaches the client bundle; rate-limit
      attempts modestly server-side.
- [ ] Pete: set POS_PIN and verify the lock on the iPad.

How it landed (done (code): typecheck and build clean, no live run in
this container):

- `src/lib/auth.ts` is the whole mechanism: a 30-day HMAC-signed token
  (`v1.<issued-at>.<hmac>`) in an httpOnly SameSite=Lax cookie, Secure in
  production only (the LAN dev case is http and a Secure cookie would
  never store). The signing key derives DETERMINISTICALLY from POS_PIN
  via scryptSync with a fixed app salt: a deploy restart keeps the iPad's
  session mid-shift, changing the PIN revokes every session at once. PIN
  check and token verify both go through timingSafeEqual. `requireSession`
  is the ONE guard, called first in every handler; login failures hit an
  in-memory limiter (5 straight failures = 30s lockout, per process).
- New routes: POST /api/login ({pin} -> cookie), POST /api/logout, and
  GET /api/session ({authRequired, authenticated}), which is what the
  page asks before rendering anything.
- /api/config stays reachable without a session because the LOCK SCREEN
  shows the mode banner too, but its unauthenticated answer is trimmed to
  dryRun/target/banner: the full shape also carried siteId, configError
  and writeClientIds, and those now wait for a session.
- The page renders through an AuthGate: /api/session says locked ->
  ONLY the lock screen (studio name, mode banner, masked dots, 0-9 +
  backspace keypad at 64px, explicit Unlock button or Enter; no
  auto-submit since PIN length varies; wrong PIN shakes quietly, the
  lockout counts down). While open, a fetch wrapper watches every /api
  response and a 401 flips back to the lock screen, so an expired or
  revoked session degrades to the lock rather than a page of errors. The
  session probe failing entirely fails OPEN client-side (the server still
  enforces): a lock that cannot check a PIN must not brick the counter.
- Nothing secret is client-side: the bundle holds no PIN, no hash, no
  comparison; the lock screen only POSTs what was typed.

Deploy notes from the T21 review (Pete, before the counter goes live):

- A misspelled POS_PIN silently disables auth by design; after deploying,
  open the app in a fresh browser and confirm the lock screen appears.
- Set POS_SESSION_SECRET in production (openssl rand -hex 32): it kills
  the offline PIN-brute path a captured cookie would otherwise allow.
- The login limiter is global, not per-IP: five wrong PINs from anyone
  lock the counter for 30s, teacher included. Accepted for one shared
  iPad; it is also a 30s nuisance button for anyone on the LAN.
- A production build over plain http can never unlock (the cookie is
  Secure under NODE_ENV=production); LAN testing of a prod build needs
  https or the dev server.

## T22. Catalog and cart pricing (PLAN 2.1)

- [x] src/lib/sale.ts: fetch sellable items per the hardcoded categories
      (/sale/products by CategoryIds; passes via /sale/services), reading
      in-studio Price never OnlinePrice, spec-verified against
      docs/mindbody-openapi/sale.yml.
- [x] Cart totals priced by Mindbody via /sale/checkoutshoppingcart with
      Test: true, LocationId: 1, InStore: true. Assert our expected total
      (Price x 1.1035, exempt category 100000 untaxed) against the
      server's; a disagreement renders as an error, never swallowed.
- [x] No client-side price ever sent; Mindbody's total is the total.

Shipped as src/lib/sale.ts plus two requireSession-guarded routes:
GET /api/catalog (products + passes, cached per process for 10 minutes;
harmless because the CART total always comes live from priceCart) and
POST /api/price-cart. Spec findings worth keeping:

- **Payments under Test: true is formally optional but unproven live, and
  this gates T24.** CheckoutShoppingCartRequest (sale.yml:5632-5735)
  declares NO `required:` list at all -- Items, Payments, ClientId, every
  field is optional by schema. But the one Test call known to have passed
  (the 2026-08-26 probe, design doc rung 5) included a StoredCard payment,
  so "Payments may be omitted" has never been observed. priceCart therefore
  posts without Payments first and, if refused with a payment-shaped error,
  retries once with `Comp { Amount }` (the only documented payment type
  needing nothing but an amount, sale.yml:3934) and reports which shape
  worked via `usedPaymentStub`. Watch that flag on the first sandbox run:
  if the stub is what prices carts, T24's Test-rehearsal step must send a
  stub too, and the Comp permission becomes a hard requirement.
- CheckoutItem.Metadata is typed `string` in the vendored spec
  (sale.yml:4975) with its keys behind the login-walled docs page, as the
  design doc warned. The live API takes an object; we send
  `{ Id: <item id> }`. Which id a Service wants (ProductId, "the unique ID
  of this pricing option", sale.yml:5226, vs the barcode `Id`, 5231) is not
  enumerated either; CatalogItem carries both and priceCart sends
  ProductId for services, barcode Id for products. Confirm with one
  sandbox Test call.
- The payment-Metadata key list (sale.yml:3934) is truncated mid-sentence
  in the vendored file itself (ends "* '"), so at least one payment type
  is missing from our copy of the spec. Refresh from upstream before T24.
  DONE (T22 review, 2026-08-29): cloned api-evangelist/mindbody and
  compared. The upstream per-tag files, the monolithic
  `_original/mindbody-public-api-v6-openapi-original.yml`, and even the
  extracted `json-schema/public-api-v6-checkout-payment-info-schema.json`
  all end the list at exactly the same dangling "* " -- the truncation is
  in Mindbody's published doc string, not in our vendoring, so no refresh
  helps (paths and schemas are otherwise deep-equal to ours; only the
  `openapi:` header, info titles, and YAML key order differ, so nothing
  was re-vendored). What the list DOES establish, for T24: CreditCard
  keys amount, creditCardNumber, expMonth, expYear, cvv, billingName,
  billingAddress, billingCity, billingState, billingPostalCode, saveInfo,
  cardId; StoredCard - amount, lastFour; DirectDebit - amount;
  EncryptedTrackData / TrackData - amount, trackData; DebitAccount -
  amount; Custom - amount, id; Comp - amount. The Type enumeration is cut
  the same way (mid-DebitAccount), so at least one payment type after
  Comp (Cash and/or GiftCard, per /site/paymenttypes) exists with keys
  the spec cannot supply. T24's Cash path must be established with a
  `Test: true` call, not read from this spec. Note also the documented
  key casing is lowercase ("amount"), while our Comp stub sends
  `Amount`; Mindbody's binder has accepted PascalCase elsewhere, but the
  first sandbox Test run should confirm the stub is honored.
- There is no /sale/paymenttypes; the endpoint is /site/paymenttypes
  (site.yml:508), same trap as /site/categories.
- A prod dry run suppresses the Test POST too (every POST outside
  /usertoken is a write to our wrapper). priceCart returns
  `suppressed: true` with no totals; the T23 UI must render that state,
  never a made-up number.

First live sandbox run (2026-08-30) findings, fixed same day:

- **A cart with no client cannot be priced.** /sale/checkoutshoppingcart
  refused Test: true with "At least one of the following parameters must
  be passed: ClientId, UniqueClientId" -- the ClientId requirement the
  spec attached to "complete a sale" (sale.yml:5656) actually bites at
  pricing. Resolution under T24 (POS_HOUSE_CLIENT_ID); /api/price-cart
  now answers a structured `needsClient: true` without calling Mindbody
  when no client is attached and no house client is configured, and the
  UI renders the local expectedTotal as a muted estimate, never a
  chargeable total.
- **The catalog contained duplicate rows** (the same product returned for
  more than one queried category; duplicate pricing-option rows sharing a
  ProductId, the Personal Training triplicates again), which surfaced as
  duplicate React keys on the shelf. catalogFor/pricingOptions now
  de-duplicate at assembly -- products by id, services by ProductId,
  keeping the first row -- so the shelf key is unique by construction.
- **$0 and priceless items rendered as sellable.** Both lists now exclude
  any row without a positive Price: a $0 catalog price is unsellable
  config, not a free item (comps go through the comp path), and a missing
  Price excludes the row rather than coercing to 0.

## T23. The sale screen (PLAN 2.1 UI)

- [x] Two panes per the approved mockups: receipt-style cart left
      (items, qty, subtotal, tax, total), category chips and item grid
      right. Reached from a "Sell" affordance in the header; the roster
      remains the home screen. Mode banner stays visible.
- [x] Optional client attachment: a sale can be anonymous or attached to
      a client (search reused); attaching enables stored-card/credit.

Shipped as src/app/SaleScreen.tsx plus flag-driven changes to page.tsx
(2026-08-29). UI and wiring only; no payment execution. Notes:

- The overlay is state, not a route: the roster stays mounted underneath
  and ?classId= is untouched. SaleScreen stays mounted across open/close
  so a cart survives an accidental Back. Escape closes it unless a modal
  is stacked above or a pricing call is in flight.
- Pricing is pessimistic: every cart or client change debounces 400ms,
  POSTs /api/price-cart, and renders the SERVER totals under a request
  generation counter (the activeIdRef pattern). `disagrees` renders the
  stop-treatment "Our math says X, Mindbody says Y" block; `suppressed`
  renders the amber dry-run notice with no number; `usedPaymentStub`
  surfaces as a quiet line because T24 must know which shape priced.
- Client attachment reuses the search modal behind an `attachMode` flag:
  same submit-triggered search (the input renders inside the modal since
  attach opens it queryless), same row format; the row action becomes a
  person-check that selects and closes, the booking-only furniture
  (waiver gate, full-class offer, pass picker, roster de-duplication)
  steps aside. The clientId rides price-cart calls; a balance chip and a
  detach X render atop the ticket.
- THE T24 SEAM: <PaymentPanel cart priced pricing client onCharge/> at
  the bottom of SaleScreen.tsx owns everything below the totals -- the
  three disabled method cards (Stored card / Account credit / Cash) and
  the disabled Charge button restating the live total. T24 replaces that
  component's internals and the onCharge stub without touching the cart,
  shelf, or pricing loop. Its `chargeable` const already encodes the
  invariants T24 inherits: never charge an empty, in-flight, suppressed,
  or disagreeing cart.
- The mode banner is now the shared <ModeBanner/> component, rendered by
  both the roster page and the sale overlay from the same /api/config
  data.

## T24. Payment execution (PLAN 2.2 + 2.3)

- [x] Methods: stored card (client attached, card on file), account
      credit (balance covers total), cash (records the sale with the
      cash payment type), comp where the API allows. Read balances
      before offering; an unavailable method renders greyed with the
      reason, never hidden.
- [x] The $10 card minimum EXACTLY per PLAN 2.3's table: credit-covers
      via DebitAccount; card >= $10 via StoredCard; card under $10 buys
      $10 account credit then checks out on DebitAccount, with Test:
      true rehearsal BEFORE the credit purchase and an explicit
      credit-balance report on a step-2 failure. Never collapse the card
      paths through credit.
- [x] ASSUMPTIONS (Pete may reverse): P2 partial credit ignored (credit
      is only used when it covers the whole total); P4 the $10 minimum
      is measured against the charged, after-tax total.
- [x] Charge button restates the amount ("Charge $179.87"); pessimistic
      spinner; suppression surfaced; nothing ever auto-charges.

Shipped 2026-08-29 as the T24 half of src/lib/sale.ts (checkoutCart,
purchaseCredit, rehearseCheckout, clientPaymentProfile/storedCardFor),
POST /api/checkout and GET /api/stored-card (both requireSession first),
and the live PaymentPanel in src/app/SaleScreen.tsx. Every write goes
through mindbody(), so dry run and POS_WRITE_CLIENT_IDS intercept them
and suppression comes back as `{ok:false, suppressed}`, rendered amber,
never as a receipt. Comp is hold-to-arm, out of the method row. A
synchronous ref plus the disabled button make a double tap impossible; a
transport-level failure (timeout/reset, flagged `ambiguous: true` by the
route, or the browser's own fetch dying) renders "the charge may or may
not have gone through" and invites no retry. Spec findings:

- **The Cash shape is `Type: "Cash"`, Metadata `{Amount}`, unproven.**
  The CheckoutPaymentInfo Type enum (sale.yml:3928-3931) and Metadata
  key list (3932-3935) are both truncated upstream (T22's finding), each
  BEFORE any cash entry, so the spec literally cannot answer. The
  chooser table in the design doc says "Custom / cash payment info", so
  the recorded fallback if the sandbox refuses `"Cash"` is
  `Type: "Custom"` with `{Amount, Id}` (Custom keys - amount, id;
  sale.yml:3934), the Id being the cash row of /site/paymenttypes
  (site.yml:508; PaymentType carries Id/PaymentTypeName, site.yml:2200).
  Deliberately NOT an automatic fallback: a refused payment type is a
  clean nothing-charged failure, and a money call must never quietly
  retry itself in a different shape. First sandbox run decides.
- **Payment metadata ships PascalCase** (`Amount`, `LastFour`), matching
  the one checkout known to have passed live (the 2026-08-26 probe's
  StoredCard Test call) and T22's Comp stub, against the spec's
  lowercase key list (sale.yml:3934). Open until a sandbox run watches
  a payment bind; lowercasing those keys is the first fix to try.
- **purchaseaccountcredit has NO Amount field** anywhere in
  PurchaseAccountCreditRequest (sale.yml:4774-4810): the figure rides
  `PaymentInfo.Metadata` (PaymentInfo at 4808, a CheckoutPaymentInfo),
  confirming the design doc's "dynamic, not a preconfigured SKU". The
  $10 floor is CARD_MINIMUM_USD, policy not API.
- **A sale requires a client, and it bites at PRICING.** CONFIRMED LIVE
  (first sandbox run, 2026-08-30): checkoutshoppingcart refused a
  client-less cart even under Test: true with "At least one of the
  following parameters must be passed: ClientId, UniqueClientId", so an
  anonymous cash sale could neither be priced nor charged. The house
  walk-in client is now the decided fix, as the optional
  POS_HOUSE_CLIENT_ID env var (.env.example): when set, /api/price-cart
  and /api/checkout substitute it server-side whenever no client is
  attached (the UI still shows "nobody"); when unset, /api/price-cart
  answers `needsClient: true` instantly without calling Mindbody, the UI
  shows the local estimate muted ("Estimated. Attach a client to price
  with Mindbody.") and Charge stays disabled with the reason. The
  server-priced-total-only invariant is untouched. STILL OPEN, for
  Pete: create the house client in Mindbody and set the id. NOTE for
  guarded testing: POS_WRITE_CLIENT_IDS must include the house client id,
  or the write guard suppresses every anonymous sale.
  House-client rules from the review (Pete, when creating it): keep it
  PRICING-NEUTRAL (no memberships or contracts, or anonymous totals
  diverge and every sale hits the totals-disagree stop); NEVER store a
  card on it (the UI cannot reach one, and no card on file makes any
  explicit misuse a clean refusal); and know that anonymous sales land
  on this client in Mindbody's revenue-by-client reporting.
- **Card on file comes on the ordinary client record**: GET
  /client/clients (client.yml:1323) returns ClientWithSuspensionInfo
  (GetClientsResponse, 7106) carrying `ClientCreditCard` (6257; model at
  7365 with LastFour 7397, ExpMonth 7389, ExpYear 7393 -- expiry as
  strings) and `AccountBalance` (6370), so one read serves the method
  gate AND the charge-time re-verify. No separate cards endpoint exists.
- **The under-$10 rehearsal is priceCart itself** (Test: true, Comp stub
  fallback and all): rehearsing with the real DebitAccount payment would
  check a balance the client is not supposed to have yet. /api/checkout
  runs it fresh on every charge, so the authoritative total is also
  re-read at charge time and the browser's number is never charged.
- The `usedPaymentStub` question T22 left is still open (no sandbox run
  yet); if the stub turns out to be what prices carts, the rehearsal
  already sends it by construction, and the Comp permission becomes a
  hard requirement as T22 predicted.
- Tendered cash is change-due arithmetic only. Nothing in the spec's
  visible Cash/Custom keys takes a tendered amount, so it is validated
  server-side (refused when short of the total) and never forwarded.

Money-review pass (2026-08-29), on top of the split-disarm review:

- **The 401 token-refresh retry in mindbody() is argued safe for money
  writes and kept**: 401 is the authentication gate refusing the request
  BEFORE endpoint logic runs, so the first POST provably did not process
  and one re-POST with a fresh token cannot double-charge. What was
  wrong around it is fixed: the retry now lands in the call log as its
  own entry, and a failed retry throws the RETRY's status and message
  instead of the original 401's.
- **A 500-class answer to a money write is now `ambiguous: true`**, not
  "nothing was charged": a server that errored mid-request may have
  processed the charge first. Only 4xx refusals and pre-write failures
  report as definite. Thrown Mindbody errors carry the HTTP status
  (mindbodyHttpStatus) to make the distinction possible.
- **Rule 1 of the $10 minimum is now enforced server-side**: a
  storedcard checkout is refused (409, with the live balance) whenever
  the re-read balance covers the total, and the UI greys the card with
  "Credit covers this". Besides being the design doc's rule ("credit is
  THE method, the card is not offered"), this is what closes the split
  failure's re-buy loop for good: after the $10 credit purchase, the
  balance covers any sub-$10 total, so re-selecting the card cannot buy
  a second $10 even if the browser state was lost.
- Short-tender check no longer exempts an explicit $0; the paid receipt
  is no longer wiped by its own cart-clear; comp's "Tap to unselect"
  actually unselects (the completed hold's click is swallowed); Back is
  disabled mid-charge so the outcome panel cannot be unmounted while
  money moves; the pricing-area suppression notice no longer says "Dry
  run" for a write-guard suppression; keypad/chip/comp tap targets
  raised to the 64px floor.

## T25. The unpaid row sells the pass (PLAN 2.4)

- [x] An unpaid booking's flow becomes: pick the pass to sell (sensible
      default from the class's pricing options), charge on the stored
      card via the T24 machinery, assign it to the visit, check in --
      one gesture, pessimistic end to end, partial failure reported
      honestly at each step.
- [x] Free entry survives as the deliberate exception behind its own
      clearly-labelled choice, no longer the default.

Shipped 2026-08-29: the unpaid chip's tap now opens the "Pay and check
in" dialog in page.tsx (the old arm-then-confirm second tap is gone,
with its `confirming` state). The waiver gate stays FIRST in tapCheckIn,
so an unpaid no-waiver client reads and agrees before any pay dialog;
the dialog captures its row and class at open (the cancel dialog's
discipline) and refuses to close while any stage is in flight. The
`confirmUnpaid` setting keeps its key and now gates the dialog; off
means the pre-Phase-2 direct free check-in.

The dialog: catalog pricing options (Service items from /api/catalog,
session-cached), sorted and defaulted single-visit-first -- lowest real
`Count` (a drop-in is 1; the fake-unlimited >= 100 counters sort last),
price breaks ties; `Service.Count` was added to CatalogItem for this.
The chosen option is priced pessimistically through /api/price-cart
(350ms debounce, generation-guarded), and the one primary button
restates the SERVER total: "Charge $X and check in". The method is
derived, not chosen: account credit when the balance covers the total
(rule 1; /api/checkout enforces it server-side too, and a refusal
naming the live balance refreshes the gate), else the stored card from
/api/stored-card; no cash keypad -- a quiet "For cash, use Sell." line.
Free entry is the dashed quiet "Check in free (comp)" button, today's
behavior exactly (no charge, just the pessimistic setSignedIn).

The stage-failure matrix as built (nothing auto-retries):

- (a) charge, via /api/checkout: suppression renders amber and STOPS
  (no attach, no check-in); a definite 4xx refusal says "Nothing else
  happened; it is safe to try again"; `ambiguous: true` (or an unread
  answer, or the fetch dying) renders T24's wording verbatim -- "The
  charge may or may not have gone through. Check the dev drawer or
  Mindbody before charging again." -- and the dialog offers no second
  charge; a checkout-after-credit split renders the balance and "do
  NOT re-run the credit step", pointing at Sell + the row's chevron.
- (b) attach: re-fetch /api/passes, match `ClientService.ProductId`
  == the chosen option's `productId` (both fields added for this;
  the instance id is the newest matching `Id`), POST
  /api/visit-payment. Any failure -- passes fetch, no instance yet,
  refusal, or a should-be-unreachable suppression -- reports
  "Charged, but the pass was not attached to this visit; attach it
  with the payment chevron, then check in." The fresh pass list is
  written into the chevron's caches first, so the by-hand finish
  works immediately.
- (c) check-in: a failure reports "Paid and attached; the check-in
  tap will finish it." and leaves the row normal (roster refreshed:
  paid, not checked in).

Full success refreshes the roster (activeIdRef-guarded, against the
captured classId) so the row shows paid and checked in, then closes.

Seams for the first sandbox run:

- **Does the purchased ClientService appear immediately after
  checkout?** Stage (b) assumes the /api/passes re-fetch right after a
  200 from /sale/checkoutshoppingcart already lists the new instance.
  If Mindbody materializes it asynchronously, every gesture will end
  at the honest attach-failed message with the charge standing; the
  fix would be a short bounded re-poll in stage (b), added only if the
  sandbox shows the lag.
- **ProductId matching**: instance selection is newest `ClientService.Id`
  among those with the chosen option's ProductId, so a client who
  already owns an older instance of the same option gets the new one
  attached. If /client/clientservices ever omits ProductId, matching
  degrades to the attach-failed path, never to guessing by name.
- **Roster paid-state refresh**: "shows the row paid" assumes
  `Visit.Service` reflects the updateclientvisit assignment on the
  next /class/classvisits read. Watch it flip in the sandbox.
- All T24 open questions (payment metadata casing, Cash shape,
  usedPaymentStub) apply unchanged; this ticket added no new payment
  shapes.

## T26. Last-class renewal (PLAN 2.5)

- [x] The "1 remaining" pill's row offers selling the next pack in the
      same gesture as check-in, via the same T24/T25 machinery. Quiet
      when no card on file.

Shipped 2026-08-29, reusing T25's dialog with a `flavor` rather than new
machinery. A roster row whose pass is real (not a fake-unlimited
counter) and down to `Remaining: 1` checks in EXACTLY as before -- they
still have the session, and the tap must not get slower -- and only a
successful check-in write chains the offer. The offer never blocks and
never undoes: whatever it does, the check-in already stands.

The decision, made after the check-in with one /api/stored-card read
(plus the session-cached catalog when there is no card): an unexpired
card on file, or account credit covering the would-be default pack's
list price, opens the T25 dialog in its "renewal" flavor -- title "Last
session used. Sell the next pack?", the same pricing-option list
defaulting to the pack matching the current pass's ProductId
(`Visit.Service.ProductId`, now on RosterEntry as passProductId) when
the catalog still sells it, else the usual single-visit default, the
same pessimistic pricing loop, the same derived method and single
Charge button (labelled "Charge $X", no "and check in"). Neither, or a
failed profile read, or the teacher having moved on (another pay dialog
open, or a different class active by decision time): no dialog at all,
just a quiet warn-token "Last session used." line under the row's pass
facts so the teacher can use Sell manually. "Not now" (the renewal
flavor's cancel) dismisses in one tap; Escape and the scrim work too,
mid-flight refusals unchanged.

**The renewal purchase intentionally does not touch the visit**: the
gesture is T25's stage (a) alone -- no visit assignment, no
re-check-in -- because the session being paid for is a FUTURE one, and
the current visit is already paid by the pass that just hit zero. On
success the pass caches (chevron dropdown) refresh best-effort, the
roster refreshes so the row's pass facts update, and the dialog closes.
Suppression renders amber with renewal wording ("Dry run: nothing was
charged.") and stops; ambiguity uses T24's wording verbatim and
withdraws the charge; the under-$10 split's renewal wording drops the
attach/check-in instruction since there is nothing to attach. The
free-entry comp button does not render in this flavor (the student is
already checked in) and freeCheckIn refuses it defensively.

Same single-flight (payFlight ref before any await), same
generation-guarded reads, all inherited by construction. The
covering-credit yardstick is the LIST price; tax can push the real
total past it, in which case /api/checkout re-reads the balance and
refuses honestly, and the dialog's gate refreshes with the live number.

## The Phase 2 sandbox run (Pete): one ordered checklist

The run left T21-T26 code-complete, each adversarially reviewed. These are
the questions only a live run answers, in the order that unblocks the most:

1. **AccountBalance sign convention FIRST** (positive = spendable credit is
   assumed by the credit gate and rule 1; if inverted, both flip).
2. One cart priced in the sandbox: watch `usedPaymentStub` (does Test-mode
   checkout demand the Comp stub?), the Metadata id choice (ProductId for
   services, barcode Id for products), and `disagrees` (whole-cart
   rounding vs Mindbody's).
3. One real stored-card sale on the dummy/test client: payment Metadata
   casing (PascalCase Amount sent; lowercase documented), then the
   under-$10 split path end to end.
4. `Type: "Cash"`: does it bind, or does the recorded Custom fallback
   (id from /site/paymenttypes) need to be promoted? Never auto-falls
   back by design.
5. An anonymous cash sale: does Mindbody refuse for want of a ClientId?
   If so, the fix is a house walk-in client (your call).
6. Pay-and-check-in on an unpaid booking: does the purchased
   ClientService appear immediately after checkout (else every gesture
   ends at the honest attach-failed message and a bounded re-poll is the
   recorded fix)?
7. A last-session check-in: the renewal offer fires on a REAL check-in
   only (a write-guard-suppressed one must not offer), and
   Visit.Service.ProductId matches a catalog productId so the same-pack
   default engages.
8. Auth on the deployed build: lock screen appears (a misspelled POS_PIN
   silently disables auth), POS_SESSION_SECRET set, and note a prod
   build over plain http can never unlock (Secure cookie).

Assumptions carried in Pete's absence, reversible: P2 partial credit
ignored (credit only when it covers the whole total); P4 the $10 minimum
measured on the after-tax total; PLAN 2.6 (the $49 special / $21 upgrade)
deferred on B1 and P3.

## T10. Auth — deliberately last

- [ ] Shared PIN (stubbed in `.env.example`) or per-teacher identity per the
      P1 answer, whichever exists first. Nothing above waits on this.
