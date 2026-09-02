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

## T4. Counter modals (PLAN 1.4), after T3

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

Second live run (Pete, 2026-08-30) findings, fixed same day:

- **The sandbox taxes at 13%, not Fremont's 10.35%, which exposed the
  hardcoded 1.1035 in expectedTotal**: our math said $16.55 against
  Mindbody's $16.95 on a $15 item, and every taxed cart hit the
  totals-disagree stop. Per-item TaxRate is authoritative: the catalog
  already mapped TaxIncluded/TaxRate onto every CatalogItem (products AND
  services -- the fetches carry locationId, which is what populates them),
  so the rate now rides each cart line and expectedTotal taxes each line
  at ITS rate. Only a line with no rate at all falls back to the studio
  constant 0.1035, named in the code as Fremont's rate. The disagreement
  assertion stays strict; the tolerance route remains forbidden.
- **`usedPaymentStub` came back TRUE**: Test-mode carts on this site DO
  require the Comp payment stub -- the answer to the question the T22
  notes left open. Consequences: the stub retry is the working path, so
  priceCart now sends the stub FIRST (the no-Payments attempt was a
  doomed metered call on every single pricing) and keeps the bare
  no-Payments shape as the one-retry fallback in case other sites differ;
  and the **Comp permission is confirmed a hard requirement** for pricing,
  exactly as predicted. PascalCase `Amount` in the stub's Metadata was
  accepted.

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
- The `usedPaymentStub` question T22 left is CLOSED (second live run,
  2026-08-30): TRUE -- Test-mode carts do require the Comp stub. The
  rehearsal inherits priceCart's machinery by construction, so it already
  sends the stub and nothing else in T24 changes; the Comp permission is
  now a hard requirement, as predicted. priceCart sends the stub first
  now (see the T22 second-run notes). The "Priced via the Comp payment
  stub" receipt line was dropped with the answer in hand: developer-speak
  on a teacher screen, and the dev drawer's call log already shows which
  shape priced every cart.
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

## T27. Sale screen round two (Pete's second live test, 2026-08-30)

Five changes from watching the Buy screen used at the counter, plus the
two findings recorded on T22/T24 above (per-item TaxRate; usedPaymentStub
TRUE and the stub-first pricing order):

- [x] "Buy", not "Sell": the header button, the overlay title and
      aria-label, and every line of copy that named the screen ("For
      cash, use Sell." included) -- the counter conversation is the
      student's ("I want to buy a mat").
- [x] A Buy button on each client row: a quiet 44px bag icon in the
      roster's actions cell next to the Mindbody link, and on
      normal-mode search-result rows next to the "+", opening the Buy
      overlay with THAT client already attached (id, name, balance from
      the row; the search modal closes first). A held cart reprices for
      the new client through the existing client-change path. The
      actions column widened to fit (260px roster, 104px search modal),
      header consistent.
- [x] Cash tender is a modal, not an inline panel: selecting Cash opens
      it (keypad at 64px, quick chips, change-due math, Cancel), and its
      "Record $X cash" confirm fires the SAME charge path as the Charge
      button -- single-flight and every T24 invariant intact, the
      outcome rendering where charge outcomes render. The Charge button
      with cash armed and no tender recorded opens the modal instead of
      charging; the server-side short-tender refusal stays.
- [x] Method buttons compact and above the receipt: the three cards are
      now a row of 64px segmented buttons in the LEFT column, below the
      attach-client control and above the ticket; no subtitle line (the
      unavailable reason lives on the title attr plus one shared quiet
      line under the row). The right column keeps only the shelf; Charge
      and the outcome area sit below the receipt, and the receipt's cart
      lines scroll internally so the left column fits iPad landscape.
- [x] The tax-rate fix and the stub-first pricing order (details on
      T22/T24 above).

Adversarial review (2026-08-30), three fixes:

- **A method armed for client A no longer survives switching to client
  B** (the per-row Buy button made A-to-B a one-tap path): storedcard
  and credit now clear on ANY client change, not just detach. The
  server would have refused the stale method anyway (it re-reads the
  profile), but the Charge button must not offer it.
- **A recorded cash tender no longer survives a cart edit or a client
  change**: it was entered against the OLD total in the modal, and a
  stale tender covering the NEW total would have let the Charge button
  record the cash without reopening the modal. Cleared, the button
  reopens it; the server-side short-tender refusal was never at risk.
- **priceCart's bare no-Payments fallback fires only on a stub-shaped
  refusal** (payment/Comp-the-word/permission in the message), restoring
  the shape gate the stub-first reorder dropped: a genuine cart error
  (bad item, missing client) burned a second metered call and, on this
  site where the bare shape is known-refused, could mask the real error
  with a payments-required one. Note "complete a sale" is Mindbody's
  CLIENT-error wording, hence the word boundary on comp.

TaxRate unit, checked against the spec and the live numbers: the field
is a FRACTION (sandbox: $15 at 13% priced $16.95 = 15 x 1.13, so the
catalog row carried 0.13), the mapping does no unit conversion anywhere
(num() passthrough in catalogFor/pricingOptions, verbatim onto CartLine
and into expectedTotal), and the spec's `example: 1.0` (sale.yml:5225,
5849) is noise, not evidence. If the unit were ever percent-scaled the
strict disagrees assertion fires loudly on the first priced cart and
nothing charges. A client-tampered taxRate can only skew expectedTotal
-- the display estimate and the disagree assertion (a 409, no charge);
the charged amount is always the server rehearsal's grandTotal.

Round three (Pete's third live test, 2026-08-30), two changes:

- [x] **The cart empties on a client change, with an explicit keep.**
      The held cart silently surviving attach/switch/detach was wrong
      (Pete). New rule, in SaleScreen: switching A to B, or detaching,
      with a non-empty cart opens a small confirm ("Start a new cart?",
      "This cart has N items. Keep them for NAME?" / "...Keep them?"),
      quiet "Keep items" against primary "Empty cart" (the default Pete
      asked for). The switch itself has ALREADY happened when the dialog
      opens, so neither button (nor scrim/Escape, which keep: dismissal
      must not destroy a cart) can lose the new client. Attaching from
      NOBODY keeps the cart silently, recorded in the effect's comment:
      an anonymous cart was built for the person now being attached, and
      Pete's words were "when i change clients", which a first attach is
      not. Empty clears cart, tender and method: the existing disarm
      rules (tender + storedcard/credit on any clientId change) are
      untouched, and a cartResetNonce prop lets PaymentPanel drop the
      cash/comp arming those rules deliberately leave. Mid-charge a
      client change is refused outright: the attach and detach controls
      now disable while charging (the bag buttons and header Buy sit
      under the full-screen overlay, so they were already unreachable).
- [x] **The attach modal offers the roster before search.** Attach mode
      only (booking-mode search is untouched): an "In class" quick-pick
      renders immediately on open -- the selected class's roster as
      tappable .row entries (name + balance chip, 64px+), attaching
      through the SAME attachSaleClient handler as a search row (its
      param narrowed to id/name/balance so RosterEntry maps in). Above
      it, a class dropdown in the pass-dropdown idiom listing the WHOLE
      teaching day, because the -2/+4h window cannot see tonight's
      classes from the morning: new `classesForDay(anchor)` in roster.ts
      computes studio-local midnight bounds (STUDIO_TZ constant,
      America/Los_Angeles -- the server runs on UTC where a 6:20am class
      belongs to the wrong day; DST edges noted, harmless for a 6am-9pm
      schedule) and shares the one-call classesBetween helper; served by
      `/api/roster?day=1&anchor=ISO` behind the route's existing
      requireSession. Metered discipline: the day list is fetched
      LAZILY on the modal's open, once per day per session (cached by
      local date, keyed off the selected class's startsAt); picking
      another class fetches its roster through the existing /api/roster
      route, session-cached per classId; the selected class's roster is
      `entries`, zero calls. A failed day fetch degrades quietly to the
      around-now list; roster loading/errors are quiet lines. The search
      bar stays unchanged beneath, led in by "Or search everyone".

Adversarial review of round three (2026-08-30), one real defect plus two
race guards:

- **A morning class's day dropdown fetched YESTERDAY.** Mindbody's
  `startsAt` is a NAIVE studio-local string ("...T06:20:00", no offset;
  the UI has always rendered it by identity), but the route parsed the
  anchor with bare `new Date()`, which on a UTC container reads 6:20am
  wall time as 6:20 UTC = the previous studio EVENING, so classesForDay
  anchored on any class before 7am PT returned the wrong day. New
  `parseRosterAnchor` in roster.ts reads a no-offset anchor as STUDIO_TZ
  wall clock (Intl offset, one DST refinement pass; an explicit Z or
  offset parses directly); verified against PDT, PST and both DST-edge
  days. The client cache key had the mirror bug (`toDateString()` is
  browser-local): now the naive startsAt's own date part, or for the
  no-class fallback the studio-TZ date via Intl.
- Reopening the modal before the day fetch landed fired a second
  metered call (and a slow superseded day could render as the current
  one): a day-key ref now dedupes the flight and drops stale answers.
- Re-picking a class whose roster fetch was still in flight fired a
  second metered call for the same classId: an in-flight set now skips
  it (the first answer still renders through the attachClassIdRef
  guard).

Verified fine, deliberately unchanged: the cart dialog re-arms with
fresh count/name on a second switch and cannot fire from the
charge-success cart clear (effect keys on the client id, not the cart)
or from closing the overlay (closing never detaches); scrim/Escape
keep; Empty's cartResetNonce is consumed by PaymentPanel (cash/comp
disarm) on top of the untouched clientId disarms; Keep reprices the
kept cart for the new client through the [cart, clientId] pricing
effect; attach/detach disable mid-charge and the dialog blocks Charge
behind its scrim. Known cost, accepted: a switch-with-cart starts the
debounced reprice before the dialog is answered, so a slow "Empty"
decision can burn one Test-mode pricing call.

Addendum (2026-08-30): Favorites shelf (Pete). Mindbody's own POS has
"Favorite Products" as the precedent; ours is a "Favorites" chip pinned
FIRST in the category row, selected by default when it has anything to
show (else the usual first category). Its shelf is starred items first,
then bundles, all pure client/config concerns over the already-loaded
catalog: zero new Mindbody calls.

- [x] **Per-device stars.** Every shelf item card grew a corner star, its
      own 44px sibling tap target (nested buttons are invalid HTML),
      aria-pressed, quiet at rest and filled with the warn/gold token
      pair when starred. Stored as type+id pairs in localStorage under
      `pos.favorites.<target>` (target from the /api/config payload the
      page already holds), so sandbox stars never render on prod's shelf:
      item ids are PER SITE. Storage reads/writes are try/catch like
      settings.ts. A starred item missing from today's catalog simply
      does not render; the star stays stored.
- [x] **Bundles as hardcoded config**, the categories.ts precedent: new
      `src/lib/bundles.ts` exports `counterBundles` (empty by default,
      worked commented example, per-site-ids warning in the doc comment),
      served by /api/catalog alongside the categories. The Buy screen
      resolves each bundle against the loaded catalog at render (ids
      compared as strings): fully resolvable renders as ONE card (name,
      computed line total, a small "bundle" marker, dashed border) whose
      tap adds ALL lines to the cart through the same key/clamp logic as
      addItem, so the cart, pricing loop and charge path never know
      bundles exist. Any unresolvable line drops the whole bundle (half a
      bundle rung up silently would be worse than none) and logs one
      console.warn naming it -- the dev drawer is server-side and bundles
      never touch the server, so the console line is the honest cheap
      signal.
- [x] Empty Favorites shelf says, muted: "Star items on any shelf, and
      configure bundles in src/lib/bundles.ts."

## Findings and future tickets (2026-08-30, from Pete's questions)

**The walk-in client already exists on site 471.** Pete's MB POS screenshot
shows "WALK-IN WALK-IN" as the client on an anonymous sale: Mindbody's own
POS uses the house-client pattern this app implements. So nobody creates
anything; find that existing client's id (search "walk-in") and set
POS_HOUSE_CLIENT_ID to it. Verify it carries no memberships/discounts.

**Per-item discounts are documented: probe B1 is mostly answered.**
`CheckoutItemWrapper.DiscountAmount` (sale.yml:3624, "The amount the item
is discounted. This parameter is ignored for packages.") sits beside
Quantity on every cart line. Consequences: PLAN 2.6's $21 upgrade needs
no special SKU (a $28 drop-in with a $7 DiscountAmount); in-store promo
discounts need no Mindbody promo-code configuration. One `Test: true`
probe still owed before building on it: per-unit or per-line semantics
under quantity > 1, whether a staff discount permission gates it (MB
validates items before permissions, so only a Test success proves it),
and that a negative line is refused.

**Future ticket: in-store promo codes** (survey reward flow). Split:
entitlement (who earned 10%) is OURS -- Mindbody has no per-client promo
concept and no API to create or list codes -- naturally granted by
ai-manager when a survey completes and stored where the waiver receipts
land (the Phase 3 database, or an ai-manager endpoint; Pete's call).
Execution is `DiscountAmount` per line (above), so the local
expectedTotal models the discount exactly and the disagree assertion
keeps working; `CheckoutShoppingCartRequest.PromotionCode` (5684) stays
available only if a named promotion in MB reporting is ever wanted. POS
surfacing: a reward chip on attach, one tap to apply, consumed in the
entitlement store only on a real successful charge. Blocked on: the
DiscountAmount probe, and the entitlement-store decision.

Granularity (Pete, 2026-08-30): the entitlement schema carries it all,
none of it constrained by Mindbody since WE compute per-line
DiscountAmount: kind + display name; percent-off or fixed amount-off;
grantedAt/expiresAt (expired renders greyed with the date, never
vanishes); item scope (all, categories, specific per-site item ids,
products-only or passes-only); per-redemption quantity scope (1 item,
up to X items, whole cart -- applied to the N qualifying lines, receipt
shows which); maxUses/usesSoFar consumed only on a real successful
charge (suppressed or failed charges never burn a use); optional
minimum spend and no-stacking guards.

**Gift cards (Pete asked 2026-08-30): NOT currently sellable.** The
catalog pulls only /sale/products and /sale/services; gift cards are a
third source, GET /sale/giftcards (sale.yml:398, purchasable cards with
LocationIds and layouts) plus GET /sale/giftcardbalance (333, balance
by barcode). A future ticket has two halves that can ship separately:
SELLING (a Gift cards chip fed by /sale/giftcards; checkout item
Metadata shape needs the usual Test: true probe) and REDEEMING (balance
lookup + a GiftCard payment entry, shape also probe-bound since the
payment Type enum is truncated in Mindbody's own docs). Not scheduled.
Redeeming splits into whole-card and PARTIAL coverage: the checkout
Payments field is an array, so split payments (gift card + card/cash
remainder) look schema-possible; that split, and its honest-failure
handling when one leg lands and the other does not (the under-$10
machinery is the precedent), is the real design work in that ticket.

## T28. Split payments (Pete, 2026-08-30)

Approved: "def need to support this in our app." The checkout Payments
field is an array; the design work is the honest-failure story.

- [x] The Buy screen supports paying one sale with TWO methods: the
      primary case is gift-card-plus-remainder later, but the buildable
      case now is any two of stored card / account credit / cash (e.g.
      credit covers part, card the rest -- which also REVERSES the P2
      "ignore partial credit" assumption for this explicit flow only:
      a teacher deliberately splitting is not the ambiguity P2 guarded
      against; record the reversal).
- [x] UI: a "Split" affordance in the methods row; two amount slots
      that must sum to the server total (one editable, the other
      computed); each slot picks a method under T24's availability
      rules; Charge restates both ("Charge $30.00 card + $13.50
      credit").
- [x] Server: /api/checkout accepts an ordered two-payment array,
      validates sum == rehearsed total, applies the $10 card minimum to
      the CARD LEG (record the interpretation), and sends both entries
      in one checkoutshoppingcart Payments array -- ONE Mindbody call,
      so there is no two-write seam; a refusal refuses the whole sale.
      Verify against sale.yml whether one call with two Payments is
      accepted (schema says array; a Test: true rehearsal with two
      payment stubs is the probe, note it for the sandbox run).
- [x] All T24 invariants inherited: rehearsed total only, single
      flight, suppression never success, ambiguity honest.

How it landed (done (code): typecheck and build clean, no live run in
this container):

- **Schema verdict**: `CheckoutShoppingCartRequest.Payments`
  (sale.yml:5643-5649) is a plain `type: array` of `CheckoutPaymentInfo`
  with no `maxItems` and no other constraint, so nothing in the vendored
  spec forbids two entries. The payment shapes are exactly the ones T24
  already ships (StoredCard {Amount, LastFour}, DebitAccount {Amount},
  Cash {Amount}); a split invents no new shape.
- **NOTE FOR PETE'S SANDBOX RUN: a Test: true rehearsal CANNOT prove
  two-Payments acceptance.** The rehearsal prices with the single Comp
  stub (the T22 machinery, unchanged), so the first REAL split sale in
  the sandbox is the proof that Mindbody accepts two entries in one
  call. If it refuses, the refusal is a clean whole-sale failure
  (nothing partial can exist: it is one call), rendered like any other
  refusal.
- `checkoutCart` in src/lib/sale.ts now takes one payment OR an ordered
  array of one or two; every existing call site still passes a single
  object and is behaviorally untouched.
- /api/checkout: `split: {legs: [{method, amount}, {method, amount}]}`
  replaces `method` (sending both is a 400, as is the same method
  twice, a non-cents amount, or comp in a leg -- comp is a whole-sale
  hold gesture, and half-comping through a split would dodge it). The
  route rehearses FIRST as always; the legs must sum EXACTLY to the
  rehearsed server total after cent rounding (409 naming both numbers)
  -- the client sends amounts only, so the teacher's chosen split is
  honored, but the SUM is the server's total, never the browser's. Both
  methods re-pass their T24 availability checks against a charge-time
  profile read: the credit leg against the re-read balance, the card
  leg against the card on file, and the $10 minimum against the CARD
  LEG's amount (the floor is a card-processing floor, same reading as
  P4). A card leg under $10 is refused with the reason; there is
  deliberately NO auto credit-purchase inside a split -- the under-$10
  credit dance on top of a two-leg split is complexity nobody asked
  for, and it would turn the split's one-call no-seam guarantee into a
  two-write seam. A split always needs a real attached client (every
  valid pair contains a client-bound leg); the house client never rides
  one. Then ONE checkoutshoppingcart call with both Payments entries in
  the teacher's order: a refusal refuses the whole sale, 5xx/transport
  is T24's honest ambiguity, suppression suppresses the whole sale.
- **Rule 1 (credit covers the total -> the card is refused) does NOT
  apply to a split**, and P2 (ignore partial credit) is REVERSED for
  this explicit flow only: both rules guarded against ambiguity -- a
  teacher who never chose between credit and card -- and a deliberate
  two-leg split is the opposite of that ambiguity. Recorded in the
  route comment; single-method sales keep both rules unchanged.
- UI: a quiet dashed "Split" toggle at the end of the methods row. On:
  the three single-method buttons yield to two slots -- slot A's amount
  typed (plain right-aligned input at 20px, the .search size; whole
  cents, filtered at the keystroke), slot B's amount computed as the
  server total minus A and read-only, so the legs can only ever sum to
  the rehearsed total. Each slot picks its method from compact 64px
  Card/Credit/Cash buttons under T24 availability (card greys with the
  T24 reason MINUS rule 1; credit greys with no-client/no-credit; the
  method the other slot holds greys as "Used by the other part"). A
  cash leg opens NO tender modal: its amount IS what is collected, and
  the Charge button says so ("Charge $30.00 card + collect $13.50
  cash"). Charge stays disabled until both methods are chosen, A sits
  strictly inside (0, total), the card leg clears the $10 floor and the
  credit leg fits the balance, all on top of the inherited chargeable
  invariants. Comp's hold disables while split mode is armed. Leaving
  split mode, any client change, any cart edit, and the Empty-cart
  nonce all reset the slots (the existing disarm effects, extended);
  a completed split resets the slots and drops back to single mode.
- Outcomes: the paid summary names both legs with amounts ("Paid $43.50
  by $30.00 on the stored card ...1234 + $13.50 cash for Dennis.");
  every failure shape (refusal, suppression amber, ambiguity with no
  retry invitation) renders through the exact same blocks as a
  single-method charge, because it is the same fetch pipeline.

Adversarial money review (2026-08-30), one fix:

- **A parsed split leg is snapped to its exact cent value.** The
  whole-cent check's 1e-6 epsilon (needed because 10.05 * 100 is
  1005.0000000000001 in a double) admitted a crafted 10.000000001 and
  then forwarded the RAW float into the sum check, the card-minimum and
  balance comparisons, and the Payments entry itself. parseSplitLeg now
  returns Math.round(amount * 100) / 100, so everything downstream --
  Mindbody included -- carries the validated cent amount. Verified
  fine, deliberately unchanged: the sum check compares both sides
  through roundToCents (float-safe); 10.005 is still refused; every
  path that can change the total (client change, cart edit, Empty-cart
  nonce, mode toggle) resets the slots, so a stale slot A cannot
  outlive its total, and a server-side price drift between rehearsals
  lands on the 409 that names both numbers; the split-needs-a-client
  check runs BEFORE the house-client substitution, so the house client
  genuinely cannot ride a leg; the split branch makes exactly one
  checkoutshoppingcart call, and mindbody()'s 401-retry safety argument
  (refused at the auth gate, before endpoint logic) is unchanged by a
  second Payments entry.

## T30. Contracts and packages in Buy (Pete, 2026-08-30: essential)

Mindbody's POS has a Contracts / Packages tab; ours sells only retail
products and pricing options. Two mechanisms under one label:

- [x] PACKAGES are cart items (sale.yml's package model bundles
      services/products; DiscountAmount's "ignored for packages" proves
      they ride the cart): fetch the sellable list (find the endpoint in
      sale.yml), give them a shelf chip, sell through the existing cart
      with the package item Type; Metadata shape probe-noted like the
      others.
- [x] CONTRACTS (autopay memberships) sell through their own endpoint
      (grep sale.yml for /sale/contracts and /sale/purchasecontract):
      list contracts, and a purchase flow with the fields the schema
      demands (client REQUIRED, start date, first payment, stored card
      per the schema's rules; signature image field exists -- note what
      is required vs optional). This is the studio's membership sale at
      the counter, so it gets its own confirm restating the autopay
      terms ("$130 today, then $130 monthly from Oct 1") -- nothing
      recurring is ever started without those words on screen.
- [x] All money rails inherited: rehearse/validate where the API allows
      (check whether purchasecontract has Test), explicit tap, single
      flight, suppression never success, ambiguity honest.
- [ ] Pete sandbox: one package sale and one write-guarded contract
      purchase watched in the drawer before this counts live-verified.

How it landed (done (code): typecheck and build clean, no live run in
this container). All line numbers are docs/mindbody-openapi/sale.yml.

**purchasecontract required vs optional -- the schema verdict.**
PurchaseContractRequest (6210) declares NO `required:` list at all;
every rule below is description-level, which is exactly why it is
recorded here:

- REQUIRED in practice: `ContractId` (6214); `ClientId` (6229) OR
  `UniqueClientId` (6233 -- "you need to provide the 'UniqueClientId'
  OR the 'ClientId'"; UniqueClientId wins if both are sent); and
  exactly ONE payment source out of `CreditCardInfo` (6261),
  `StoredCardInfo` (6264), `UseDirectDebit` (6275), `UseAccountCredit`
  (6279) -- each is "only required if" the others are absent/false.
  The counter sends StoredCardInfo, and its ENTIRE model is
  `{ LastFour }` (5189-5196): there is no CardId anywhere, so yes, it
  charges the card on file, addressed by last four exactly like a
  StoredCard cart payment. No card on file (or an expired one, by our
  own gate) refuses the sale with the reason before any write.
- OPTIONAL and sent: `LocationId` (6224, "used for AutoPays") as 1;
  `FirstPaymentOccurs` (6242) as `Instant` -- the enum is Instant |
  StartDate, and the endpoint description (1866) settles the
  semantics: Instant pays now, StartDate defers payment to the start
  date; `Test` (6219, "validates input information, but does not
  commit it"); `SendNotifications` (6267, default true) sent true
  deliberately, unlike the cart's SendEmail: false -- a recurring
  agreement belongs in the client's inbox.
- OPTIONAL and deliberately omitted: `StartDate` (6238, "Default:
  today's date") -- omitted so Mindbody's own today (site timezone,
  not this server's UTC clock) is the start; the dialog is today-only
  because the StartDate/FirstPaymentOccurs/ProrateDate interplay is
  prose-only and the counter sells memberships that start now.
  `ClientSignature` (6246) -- OPTIONAL (no required list; the
  description only says what happens when it IS sent: a Base64 PNG
  filed to Client Documents), so NO signature pad was built: the
  counter does not collect signatures unless Mindbody demands them.
  If a site setting ever makes the API refuse without one, the refusal
  renders verbatim and the pad becomes its own ticket.
  `PromotionCode`/`PromotionCodes` (6251/6255), `SalesRepId` (6270),
  `UseDirectDebit`/`UseAccountCredit`, `ConsumerPresent` (6283) +
  `PaymentAuthenticationCallbackUrl` (6287, SCA), `ProrateDate`
  (6291): none sent.

**Contracts, the read side**: GET /sale/contracts (142) with the
REQUIRED `request.locationId` (157); `request.promoCode` (206),
`request.soldOnline` (214, default false = ALL contracts, staff-only
included, correct for a counter) and `request.uniqueClientId` (222)
exist and are recorded in sale.ts. The Contract model (5445) carries
Mindbody's own precomputed money -- FirstPaymentAmountTotal (5577),
RecurringPaymentAmountTotal (5592), TotalContractAmountTotal (5607) --
plus AutopaySchedule (4757: FrequencyType/Value/TimeUnit),
NumberOfAutopays (5489), AutopayTriggerType (5494), ClientsChargedOn
(5502, eight values), AgreementTerms (5555, shown verbatim in the
dialog's scroll box), and LocationPurchaseRestrictionIds (5540,
filtered against the studio). No local tax math exists for contracts;
the Test rehearsal re-asks the server before every real purchase, and
the rehearsed total is what the confirm button restates.

**Packages, the read side**: GET /sale/packages (506) with locationId
(546, default is the ONLINE STORE, so passing 1 matters) and sellOnline
left default-false (570, returns all). The Package model (5950) has NO
price, tax rate, or tax-included field: Id, Name, DiscountPercentage,
SellOnline, Services[], Products[] only. The shelf price is therefore a
local component-sum estimate (DiscountPercentage read as 0-100,
clamped) and the cards say "package"; the cart total is Mindbody's, as
everywhere.

**The packagePricing carve-out** (recorded in sale.ts and here): a
package may bundle taxed and untaxed components and its row exposes no
usable tax info, so package-bearing carts are EXCLUDED from the strict
`disagrees` assertion -- priceCart reports `packagePricing: true`, the
receipt renders a quiet "Includes a package; priced by Mindbody." line,
and the server total stands. Package-free carts keep the strict
assertion unchanged; never widen this into a tolerance. Related:
CheckoutItemWrapper.DiscountAmount is "ignored for packages" (3627), so
a future promo applied to cart lines MUST skip package lines (promos
are not built; comment left at sellablePackages so they are not built
wrong).

**NOTES FOR PETE'S SANDBOX RUN (the unchecked box above):**

- Package Metadata probe: a package rides the cart as
  `{ Item: { Type: "Package", Metadata: { Id: <package Id> } } }` --
  the same unenumerated-Metadata caveat as products/services (the key
  list is behind the login-walled docs page). The first Test pricing of
  a package cart proves or refutes `{ Id }`.
- Same probe, second question: the Comp pricing stub's Amount is our
  LOCAL estimate, and for a package cart that estimate is the
  component-sum guess. If Test-mode checkout enforces
  payments-equal-total, a wrong guess fails the pricing call loudly
  (never a wrong charge); if that bites, the fix is priced-then-reprice
  plumbing, its own small ticket.
- Contract purchase: run it write-guarded first (POS_WRITE_CLIENT_IDS
  = the dummy client) and watch the drawer show the Test rehearsal
  land and the real POST suppressed; then allow the dummy and watch
  one real purchase commit. The first REAL purchase is also what
  proves StoredCardInfo-by-LastFour binds the way the schema reads.
- The dialog collects NO signature (decision above); if the sandbox
  refuses a contract for a missing ClientSignature, that refusal
  renders verbatim in the dialog and the signature pad becomes its own
  ticket.

Review pass (2026-08-30), adversarial, on the first recurring-money
write:

- **An unrenderable schedule refuses to sell.** scheduleProblem() in
  SaleScreen.tsx blocks the dialog (and the rehearsal call) whenever
  the commitment cannot be stated from the data: autopay enabled with
  no RecurringPaymentAmountTotal, a set-schedule autopay with a null
  AutopaySchedule, or a FrequencyTimeUnit outside Weekly | Monthly |
  Yearly. Before this, those shapes rendered "then $X on the
  contract's autopay schedule" (or, worse, "No recurring payments"
  for a live autopay whose amount was merely missing) on the confirm
  button. The refusal is honest ("Sell it from Mindbody instead");
  the confirm label becomes "Not sellable here", never a vague
  commitment. Related: frequencyPhrase no longer claims "each time
  the included pass runs out or expires" for a null schedule unless
  AutopayTriggerType actually says PricingOptionRunsOutOrExpires, and
  a SetNumberOfAutopays contract whose count is missing says "for a
  set number of payments (see the agreement)" instead of reading
  open-ended.
- **The house client is refused BY ID server-side**: /api/purchase-
  contract compares against houseClientId(), not just "some client
  present". An autopay on the walk-in account was only UI-prevented
  before.
- **Price drift refuses instead of charging.** The dialog now sends
  the figure its confirm button displayed (expectedFirstTotal); the
  route's purchase-time rehearsal must match it to the cent or the
  purchase refuses with stage "reprice" (409) and the dialog
  re-rehearses so the button restates the current number. Checkout
  already had this property by construction (the payments carry the
  rehearsed amounts); purchasecontract sends no amount at all, so the
  gate had to be explicit. When the rehearsal returns no Totals the
  gate cannot check (probe below) and Mindbody prices the real call
  as it always does.
- **Ambiguity names the CONTRACT.** Both ambiguous wordings (route
  and dialog) now say a contract may have been started and to check
  the client's account in Mindbody for it, not merely that a charge
  may exist -- for a recurring purchase the standing agreement is the
  thing to go look for.
- Package shelf cards say "package, est." -- the number is our
  component-sum guess, and "package" alone did not say so.
- Argued fine, unchanged: the 401 retry in mindbody() holds for
  purchasecontract (401 is the auth gate refusing before endpoint
  logic; no SCA callback is in play since
  PaymentAuthenticationCallbackUrl is never sent); suppression at the
  rehearsal stops the whole purchase; a package whose components all
  price to zero is hidden like any $0 item (no local price basis, and
  comps have their own path); the schedule gate is UI-only (a
  server-side check would cost a /sale/contracts read per purchase;
  the route is not a public API).
- KNOWN CACHE SEAM, recorded: the recurring amount and cadence on the
  commitment come from the /api/catalog response (cached up to 10
  minutes); the rehearsal re-prices only the FIRST payment. A
  contract edited in Mindbody mid-cache could restate a stale
  recurring figure. Tolerated: contracts change rarely, the agreement
  terms render verbatim, and Mindbody's own confirmation email
  (SendNotifications: true) carries the authoritative terms.

Two more probes for Pete's sandbox run: (1) whether purchasecontract
Test: true returns Totals at all -- the price-drift gate and the
dialog's server-priced first payment both depend on it, and the spec
does not say; (2) watch the drawer for the reprice refusal never
firing spuriously (tax rounding between our display and the
rehearsal would show up as a 409 with stage "reprice").

Ordering: T28 (in flight) -> T30 -> T29 (database), since contracts are
counter-essential and the database is admin infrastructure.

## T29. The database, pulled forward (Pete, 2026-08-30)

Approved, with the hard requirement: LOCAL TESTING MUST STILL WORK.
The rule that makes that automatic: the app runs FULLY without
DATABASE_URL -- every DB feature falls back to today's behavior
(bundles from src/lib/bundles.ts, waiver receipts to Notes + server
log, banner from POS_BANNER_TEXT, promos simply absent) and the dev
drawer/config shows which mode storage is in. The charter is the
design doc's: the database holds what Mindbody has no home for, NEVER
a copy of what it does (no clients, classes, passes, prices, visits).

- [x] Railway Postgres; DATABASE_URL optional; schema migrations as
      plain SQL run on boot (idempotent), tables: waiver_receipts,
      promo_entitlements, bundles, settings (banner text first).
      (Code side done: src/lib/db.ts migrates on first use, never at
      build; provisioning the Railway Postgres service and setting
      DATABASE_URL there is Pete's deploy step, documented in
      .env.example.)
- [x] Waiver receipts write to the table AND keep the Notes line (the
      Notes copy is what staff see in Mindbody; the table is the
      durable record with the full hash).
- [x] Bundles read from the table when present (falling back to code
      config), plus a minimal admin surface to create/edit/disable
      bundles (behind the PIN session like everything else).
- [x] docker-compose (or a documented one-liner) for a local Postgres
      when Pete wants to test DB features locally; .env.example notes.
- [x] Promo entitlements TABLE ships (schema per the granularity notes
      above); the promo POS flow itself stays its own future ticket.

Shipped 2026-08-30. How the rules landed:

- The iron rule verified live: with DATABASE_URL unset, /api/config
  says storage "none", /api/admin/* answer honestly (available: false,
  503 on write), and every feature runs on its fallback -- bundles from
  src/lib/bundles.ts, receipts to Notes + the log line, banner from
  POS_BANNER_TEXT. A CONFIGURED-but-dead database degrades identically
  (every db.ts helper catches, logs once per failure kind per process,
  returns a fallback signal); it can never take a counter request down.
- The charter is written in src/lib/db.ts where the next schema change
  will read it, and restated in CLAUDE.md's locked decision.
- Bundle admin lives in the dev drawer's Bundles tab (PIN + devtools
  gated, like /api/devlog: same audience). Listing, create form with a
  catalog item picker, enable/disable toggles, and the banner field.
  No DELETE anywhere: disable is the safe verb. FUTURE WORK: a proper
  admin surface outside the dev drawer, once someone who is not Pete
  needs to edit bundles or the banner.
- /api/catalog serves DB bundles (enabled only) when the table has
  rows, else code config, recording bundleSource: "db" | "config" in
  the payload (visible in the dev drawer, nowhere teacher-facing).
  Bundles read per request, outside the 10-minute Mindbody cache:
  they are local and an admin toggle must show on the next load. A
  non-empty table with every row disabled serves ZERO bundles -- that
  is the admin's deliberate off switch, not a fallback case.
- Lines are validated into storage with the same shape/quantity rules
  SaleScreen's resolver enforces at render (validateBundleLines in
  bundles.ts); whether an id resolves stays the client's render-time
  check, because ids are per site and a sandbox-created bundle must
  fail visibly on prod, not be refused from storage.
- Banner: app_settings.banner_text wins when set; clearing DELETES the
  row so the env var takes back over (design doc option 1 stays the
  base layer, option 2 sits on top). The lock screen shows the DB
  banner too.
- The build never connects: `next build` verified clean with no
  database listening.

## T31. Buy screen round four (Pete's fourth live test, 2026-08-30)

A real split sale went through in the sandbox ($5 account credit + $11.95
cash for Alida Abbott, sale e02301bb...): T28's two-Payments call binds.
Three things wrong with what stayed on screen afterwards.

- [x] **The balance did not update after the sale.** Her $40.00 stayed
      $40.00 on both the Buy header chip and the roster row until the class
      was switched and switched back. Both were pre-sale snapshots that
      nothing invalidated. Fixed in two places, both reads:
      - The `/api/stored-card` lookup now carries `balance` and the client
        id it is FOR, and refetches on a `profileNonce` bump. PaymentPanel
        reads it after a refusal's reported balance and before the attach
        snapshot, so the credit gate uses the freshest number known; a
        completed sale drops the refusal-learned `freshBalance` so the
        refetch is the answer. A refetch for the SAME client keeps its
        numbers on screen while it runs (blanking flickers the method row
        right after a charge); a client CHANGE blanks, because the other
        client's card is not this one's.
      - `onSaleCompleted` (new, alongside T30's `onContractPurchased`, both
        now the one `refreshClientState` in page.tsx) drops the client's
        pass caches and refreshes the roster, so the row behind the overlay
        shows the post-sale balance and any pass the sale just added.
      Fired on a completed sale, on the credit-purchased split failure, and
      on BOTH ambiguous branches -- never on a definite refusal or a
      suppressed write, where nothing moved. Re-reading after an ambiguous
      outcome is the point: that is when the truth matters most. Contract
      purchases bump the profile too (a first payment can spend credit).
- [x] **The client moved to the header.** "For: NAME" plus the balance chip
      (and the attach button when nobody is attached) now sits beside the
      "Buy" title, taking the slack before Back; the payment column starts
      at the method row. Pete's reasoning: it is identity, not a payment
      control, and the column is the scarcer real estate. Same markup, same
      64px target, same mid-charge lock on attach and detach.
- [x] **The account-credit icon is a coin with a dollar sign**, not the old
      rounded note: beside the stored-card button it read as a second
      credit card. Pete asked for "dollar sign, money bag, or something
      like that."

## T32. The attach modal, in reading order (Pete, 2026-08-30)

Pete, from the same live test: "The Attach a client modal should have the
search bar at the top always, class selector and student rows underneath.
And once I search, if the name matches someone in the currently selected
class, that should be at top with the class visible. Below that should be
other matches... Mandy Wang with a divider under her name (and if room, a
checked-in/signed-up pill) with the add icon, which is missing rn, then
underneath that would be Richard Wang."

T27 round three had built the quick-pick as a block ABOVE the search bar,
which put the bar in the middle of the modal and moved it down the screen
as rosters of different sizes rendered. Attach mode only throughout; the
booking-flow search modal is untouched.

- [x] **The search bar is first, always**, directly under the title, then
      the "In class" picker, then the rows. The bar is the one control
      that is always useful, and a bar whose position depends on how many
      people are booked is a bar a teacher has to look for. Same query
      state, same submitSearch, same one-call-on-submit rule: this is a
      move, not a rewrite, so nothing about how search runs changed.
- [x] **The class picker doubles as the first group's heading.** It
      already names the class; a separate "In class X" heading under a
      dropdown that says "In class X" would be the same fact twice. With
      no search run it heads the whole roster; after a search it heads
      the matches who are in that class.
- [x] **Two groups after a search, disjoint by construction.** The
      matches are partitioned (page.tsx:4170) against a Map of the picked
      class's roster by client id: on it, they render first; not on it,
      under "Other matches". Nobody can appear twice because the two
      arrays are built from one predicate and its negation.
- [x] **The in-class group renders from the ROSTER's facts, not the
      search result's** (`rosterAsResult`, page.tsx:99). The question a
      teacher is answering is "is this the person in front of me, the one
      in this class", so the row shows that class's status and the
      roster's balance. It also means the pre-search rows and the
      post-search in-class rows are literally the same rows.
- [x] **One row renderer for both groups** (`attachRowItem`,
      page.tsx:3352): the search-result row's own `.rrow` grid, marker
      line and 52px add button, so the two groups differ only in the
      facts they carry, and the roster rows finally get the add icon Pete
      found missing. Attach mode's row is the simple one: nothing books,
      charges or checks anyone in, so no waiver gate, no pass picker and
      no in-flight dimming ride on it. The tap still only sets the sale's
      client and closes.
- [x] **The status pill** sits on the marker line beside the M chip and
      the no-waiver pill, sized to that line rather than the roster's
      104px chip, and it is text, not a control: attaching a sale moves
      no attendance. New tokens-only classes `.mini-in` (the roster
      chip's ok pairing, so "checked in" reads the same on both screens)
      and `.mini-signed` (quiet: it is the ordinary state), both palettes.

Judgement calls, all reversible:

- **"waitlist" is not a state the pill can show.** A waitlisted person is
  not a roster entry at all (the queue is its own fetch, and only for the
  active class), so the roster knows exactly two states. Saying so in the
  type rather than leaving a third case to rot.
- **"Other matches" renders even when the in-class group is empty.**
  Strictly a heading on the only group is redundant, but without it those
  rows sit directly under the "In class" picker and read as if they were
  that class's, which is the one misreading this layout exists to
  prevent.
- **Both groups scroll in ONE region** (`.attach-rows`, 46vh). The modal
  is centred in a fixed scrim and does not scroll itself, so two lists
  each capped at their own height could stack past the top and bottom of
  the screen. The bar and the picker sit outside it and stay put.
- **The grouping keys on whether a search has RUN** (`searchTitle`), not
  on whether the box has text. Clearing the box with the X leaves the
  results up, exactly as it did before; a cleared box that silently threw
  away the results a teacher was reading would be worse.
- **No column header over the attach rows.** The group headings do that
  job now, and repeating Name/Passes/Balance over each group is noise.
- Zero new Mindbody calls: the picker's day list and the per-class
  rosters are the same session-cached fetches T27 added, the search is
  the same submit-triggered one call, and the pass sweep was not
  touched (a roster person's passes show if a sweep already landed them,
  and the cell stays empty otherwise rather than claiming "no passes").

## T33. The method row reads at a glance (Pete, 2026-08-30)

Pete, same live test: "on the payment methods, change 'Stored card' to
'Card'. 'Credit' should be the first option on the left if there's a
balance. If there's no balance, it shouldn't be a visible option." And,
on the paid receipt: "once a sale completes and I click Done here, it
should go back to the sign-in view."

- [x] **"Card"**, on the button, its title attr and the quiet reason line
      ("Card: No card on file"). The split slots already read that way.
- [x] **Credit leads the row when there is credit, and is absent when
      there is not.** Most sales are to people with no account balance,
      and a permanently greyed button is noise on the one row that has to
      be read at a glance. First-on-the-left is also where the tap
      usually belongs: rule 1 makes credit the method whenever it covers
      the total (the card is refused server-side then, and greys out
      here). Same rule and same order in the split slots, so both read
      alike.
- [x] **The one exception, deliberate: the split-failure seam.** When a
      $10 credit purchase succeeded and the checkout after it failed, the
      credit certainly exists, and the balance read that follows may have
      failed (`creditBalance: null`). Hiding the honest retry -- spend the
      credit that now exists -- on the one screen built to offer it would
      be the worst outcome, so Credit stays visible while that warning is
      up. See T24/T28.
- [x] **Nothing invisible stays armed.** Credit can vanish under the
      teacher (T31's post-sale refetch reporting the balance the sale just
      spent), so losing visibility disarms it in the single method row and
      in both split slots.
- [x] **Done returns to the roster.** The counter's resting screen is the
      sign-in view, not an empty cart. The receipt is cleared first, so
      reopening Buy starts clean.

Review fixes (adversarial pass over T31-T34):

- **"Nothing invisible stays armed" was one paint late.** The disarm
  effect is a `useEffect`, which runs AFTER the browser paints, while
  `chargeable` never consulted a method's own reason: for one frame after
  T31's post-charge refetch reported the credit a charge had just spent,
  the Credit button was gone and the Charge button still read "Charge
  $X", enabled, with credit armed. The reachable case is an ambiguous
  outcome (the method is deliberately left armed there, and the refetch
  fires), which is exactly the moment a second tap must not be invited.
  `chargeable` now requires the armed method to be offered in the SAME
  render, read off the same `creditReason`/`cardReasonFinal` the buttons
  are greyed by, so the button and the charge path can never disagree.
  The effect stays: it is what clears the stored choice. Split legs were
  already gated this way inside `splitReady`.
- Reviewed and left alone: Credit is never hidden while it would be
  tappable (`creditReason` is non-null whenever `balance` is null or <=
  0, which is exactly when `creditVisible` is false), so the hiding rule
  cannot cost a teacher a method. The split-failure exception is
  therefore informational only, and `doCharge`'s own `setResult(null)`
  ends it at the start of the retry it exists for; worth knowing, not
  worth latching, since the button it keeps on screen is greyed either
  way.

## T34. The class selector is a dropdown (Pete, 2026-08-30)

Pete: "make it a drop down like the Buy view. When I drop the list down,
it should show the same 'X booked' view it does on the current selector,
but after I select it, that won't be part of the view since we already
have counters for that."

- [x] **The current class IS the control.** The header's class block is
      now the dropdown button (Buy's attach-picker idiom: the class line,
      a chevron, a `pass-dd` menu with a check on the current one), so the
      separate "Change class" button and the modal it opened are both
      gone. One less tap and one less full-screen layer for the thing a
      teacher changes most.
- [x] **"N booked" lives in the list, not on the collapsed line**, per
      Pete: the header's three counters already say it, in bigger type,
      for the class in front of you.
- [x] Same data and same selection path as the modal it replaces (the
      classes around now, `selectClass`), same Escape-closes handling, no
      new calls. The menu is left-aligned under the button and scrolls at
      60vh; new CSS is `.class-pick`, `.class-pick-btn`, `.class-pick-dd`
      plus the two-column `.pass-opt` override, tokens only.

Open, if it comes up live: the menu lists the classes around now, as the
modal did. The Buy view's picker lists the whole teaching day. Widening
this one to the day is a small change if the -2/+4h window turns out to
be the wrong reach at the counter.

## T35. One tender model for every payment (Pete, 2026-08-30)

Pete, on the split view and the payment seam generally: "these can also be
compacted. Get rid of 'First part' and 'Remainder'. Make the source
buttons smaller and put them inline with the totals. And instead of a
'Split' button once I'm in split view, put an X next to the payment
sources. Also, there is too much divergence: cash sale brings up a keypad
with numbers and options; store credit only applies to the total; split
payments use the keyboard. Need a unified way that works for all these.
The system can automatically tell the teacher if they owe change when
more cash has been given than the sale amount. More credit than the total
sale amount can never be entered. Same with credit/debit card. Come up
with a quality seamless way for these all to work."

He is right that three interactions had grown for one job. This is the
design of record; the divergences below are the thing being removed.

### The model: tender lines against an amount due

There is no split MODE any more. There is a list of tender lines, and a
split is just the case where there are two of them.

- The receipt's server total is the target. **Due** is that total minus
  what the lines already cover.
- Tapping a source (Credit, Card, Cash) ADDS a line for it, pre-filled
  with the whole remaining due, clamped by that source's own rule. So the
  common case is one tap and no typing: tap Cash, the line reads the
  total, Charge.
- Each line is `[source] [amount] [x]`, compact, one row, the amount
  right-aligned and tabular like the receipt. The x removes that line.
  That is Pete's "X next to the payment sources", and it is what leaves a
  split, so the Split toggle is gone.
- Tapping a line's AMOUNT opens the one keypad, inline, for that line.
  One keypad for every source: no OS keyboard anywhere in the payment
  seam (an iPad soft keyboard over a counter screen was the worst of the
  three divergences), and no cash-only modal.
- Adding a second source is the split. Editing line one's amount
  recomputes line two, so the lines can only ever sum to the total.
- **Two lines is the maximum**, because /api/checkout accepts one method
  or exactly two legs. With two lines present the sources that would add
  a third are greyed with that reason. Raising the cap is a server
  change, not a UI one, and nobody has asked for three.

### The per-source rules, enforced in the UI and again on the server

- **Credit** clamps to `min(account balance, due)`. It can never be typed
  above either, per Pete. Absent entirely when there is no balance (T33).
- **Card** clamps to `due`. Never above. The $10 card minimum still
  belongs to the server: a card leg under it takes PLAN 2.3's
  credit-purchase path, unchanged.
- **Cash** is the only source that may be given MORE than it owes. The
  keypad accepts any amount; the line charges `min(entered, due)` and the
  surplus renders as **Change $X.XX**, loud, next to the due line. The
  amount SENT for a cash leg is what it covers; the tendered figure rides
  along as `cashTendered` exactly as it does today, for the drawer.
- **Comp** is untouched and stays outside this list: it is a whole-sale
  gesture with its own hold, not a tender. Arming comp clears the lines;
  adding a line disarms comp.

### What must not change

- **The request shapes stay exactly as they are.** One line maps to
  `{ method, cashTendered? }`; two lines map to `{ split: { legs } }`.
  /api/checkout is NOT touched by this ticket, so every money rule it
  enforces -- the fresh rehearsal, legs summing to the server's own
  total, rule 1, the $10 minimum, the credit-purchase seam -- keeps
  standing behind the new screen.
- Charge stays enabled only when due is exactly zero and every line is
  valid, and it still restates the server's number.
- The single-flight ref, the ambiguity wording, the suppressed-write
  handling and T31's post-charge refetch all stay as they are.
- The keypad is a 64px-target grid; nothing about the money invariants
  moves into it.

### What was built (2026-08-30)

All of it in `PaymentPanel` (src/app/SaleScreen.tsx) plus globals.css;
/api/checkout, src/lib and page.tsx are untouched. Typecheck and build
clean; no live run in this container.

- [x] **Tender lines replace the method row, the cash modal and split
      mode.** State is `lines: TenderLine[]` (id, source, cents) plus a
      separate `comped` flag; there is no `method`, no `splitOn`, no
      `splitA/AMethod/BMethod` and no `tendered` any more. Amounts are
      integer CENTS throughout, so lines can only sum exactly.
- [x] **Tapping a source ADDS a line** pre-filled with the whole
      remaining due, clamped by that source's rule: credit
      `min(balance, due)`, card `due`, cash `due`. One tap, no typing,
      for the ordinary whole-sale case.
- [x] **Each line is `[source] [amount] [x]`**, one compact row, amount
      right-aligned and tabular; the amount is a BUTTON that opens the
      keypad for that line, the x removes it. No labels, no Split
      toggle: the second line IS the split.
- [x] **ONE inline keypad** (`.keypad`, a 3x4 grid of 64px keys: 1-9,
      C, 0, Done) serves every source. Digits accumulate into cents
      exactly as the cash-tender field did. No OS keyboard anywhere in
      the payment seam and no cash-only modal; the number input the
      split slot used is gone.
- [x] **Clamping is enforced on every keystroke**, so the state never
      holds an over-cap figure at all: `capFor` returns null for cash
      (the only source that may exceed the due) and the total (less the
      account balance, for credit) otherwise. Editing one line of a
      two-line tender recomputes the OTHER as the remainder, so the
      lines can only ever sum to the server's total.
- [x] **Change**: `coverage` gives each line what it actually covers (in
      list order, capped by what is still unpaid), and the surplus
      renders as a loud "Change $X.XX" chip beside the due figure.
- [x] **Two lines maximum**, with further sources greyed as "Two parts
      is the maximum" (and an already-used source as "Already in the
      payment"), never hidden.
- [x] **Comp is unchanged**: same hold, same wording, still outside the
      list. Arming it clears the lines; adding a line disarms it.
- [x] **The request shapes did not move.** One line sends
      `{ method, cashTendered? }`, two send `{ split: { legs } }`; a
      cash leg sends what it COVERS and the over-tendered figure rides
      as `cashTendered` on a single-line sale only. Charge is enabled
      only when due is EXACTLY zero and every line is valid, and it
      still restates the server's rehearsed number.
- [x] **Every T24/T28/T31/T33 invariant kept**: the `inFlight` ref and
      the disabled button, the suppressed-write branch, the ambiguous
      branches word for word, the "do NOT re-run the credit step" seam
      (which now clears the whole tender, as it used to clear the armed
      method), `onClientDataStale` on exactly the same branches, the
      disarm-on-client-change and cart-reset effects, and rule 1 plus
      the $10 minimum restated in the UI and enforced on the server.

Judgement calls, all reversible:

- **T33's `methodOffered` became `lineReason`**, per line, read off the
  same `creditReason`/`cardReason` the source buttons grey by and
  computed in the SAME render that enables Charge. So the frame-late
  disarm effect still cannot leave an unoffered source chargeable: an
  ambiguous outcome followed by the balance refetch dropping credit to
  zero fails `lineReason` (and the effect then drops the credit line).
- **Rule 1 is a WHOLE-SALE rule here.** The card greys with "Credit
  covers this" only when it would be the first and therefore only line,
  and a card line that BECOMES the only line (its partner removed) is
  refused by `lineReason` with the same words. A card leg of a genuine
  split is not gated by it, which is T28's recorded reversal, and the
  $10 minimum only bites on a two-line tender (a whole-sale card under
  $10 still takes PLAN 2.3's credit-purchase path).
- **Credit's own gate no longer includes "only $X on account"**: a
  credit line clamps to the balance and a second line pays the rest,
  which makes T28's partial-credit reversal the ordinary case. Credit
  covering the whole total still charges as a single credit method, so
  the server's own rule 1 path is unchanged.
- **The keypad starts empty** (register-style: the first digit replaces
  the figure rather than appending to it), the head shows the line's
  live amount, and dismissing it with nothing entered REMOVES the line
  rather than leaving a $0.00 row for Charge to refuse.
- **A client change now clears comp too**, where before only the
  client-bound methods and the tender went. Stricter, and the hold is
  one gesture to redo.
- **`onModalChange` is still used and still needed**: the keypad is
  inline rather than a modal, but it owns Escape while open, so it
  reports up exactly as the cash modal did (and every reset path
  reports the close, or a keypad dismissed by a reset would leave
  Escape blocked).
- Cases walked in code: whole sale on one source; cash over-tender with
  change; credit covering everything; credit part plus cash; a card leg
  under $10; a cart edit repricing under live lines (the lines clear,
  as the tender and split slots always did); a client change with lines
  armed; and the ambiguous-then-refetch case above. A line whose
  entered amount stops being fully covered (a total that moved under
  it, unreachable in normal use) is refused with "Re-enter the amounts
  against the current total" rather than charging a different figure
  from the one on screen.

Adversarial review (2026-08-30), one fix:

- **A keypad could outlive its line and eat the next Escape.** Every
  deliberate path that drops a tender line (the x, Done on an empty
  entry, the client-change, cart-edit and cart-reset resets, arming
  comp) dismisses the keypad and reports the close up through
  `onModalChange`. The credit-visibility filter -- the effect that
  drops a credit line when the balance stops being offered -- did not:
  after it fired, `keypadFor` pointed at a line that no longer existed,
  so no keypad rendered while SaleScreen still believed one owned
  Escape, and the next Escape press was swallowed instead of closing
  the overlay. Reachable through the exact case T33's review is about:
  a keypad left open on a credit line while a charge comes back
  ambiguous, whose balance refetch then drops the credit to zero. A
  guard effect now dismisses a keypad whose line has gone, whatever
  removed it. No money path is involved.

Checked and deliberately left as they are: the amounts SENT are the
server's (one line sends `method` alone, so /api/checkout charges its
own rehearsed total; two lines send `coverage`, integer cents that sum
to `totalCents` because Charge requires due to be exactly zero, and the
route re-checks the sum against its own fresh rehearsal); a cash leg
sends what it covers and `cashTendered` rides only a single-line
request, which is the only shape the route accepts it on; every
per-line reason is computed in the same render as `chargeable`, so no
effect can leave an unoffered source chargeable for a frame; the credit
clamp is `min(balance, room)` on entry and on the partner recompute,
and the card clamp never exceeds the total; a repriced cart cannot be
charged on stale lines (a cart edit clears them, and a total that moves
under a non-cash line fails `lineReason`); the single-flight ref and
every outcome branch are word for word what T24/T28/T31 left. Rule 1
greying the card only when it would be the whole sale is the recorded
T28 reversal and matches the route, at the cost of one extra tap when a
credit-covered client wants card plus cash: add the cash line first.

## T36. The amount keypad goes back in a modal (Pete, 2026-08-31)

Pete, on the live T35 build: "the keypad looks awful and pushes the
receipt card down. the old keypad design was good. for cash, it was
helpful to have $5, $10, $20 buttons (but not for other forms). and
having it be a modal is def better than this."

T35 had put the one shared keypad INLINE in the payment column, a 3x4
grid with C / 0 / Done, and every time it opened it shoved the receipt
down the screen. The old cash modal's shape was right; what T35 got
right was that ONE editor serves every source. T36 keeps the second
and restores the first.

### What was built

- The keypad is a modal again (`.modal-amount` over `.modal-scrim`),
  opened by tapping a tender line's amount. Opening it moves nothing in
  the payment column.
- The old modal's idiom, generalized: two head rows ("Amount due" for
  THIS line, "Entered"), chips, a 3x4 pad of 1-9 / 00 / 0 / backspace,
  Cancel and Done. Everything on the 64px floor.
- Chips are cash only, per Pete: Exact, $5, $10, $20. A chip SETS the
  amount, as the old modal's did. Card and credit are clamped to their
  cap, so a chip on them could only ever land where Exact does.
- "Amount due" is what this line has to cover given the other line as it
  stands (`dueCents + coverage[padIndex]`), so it is also what Exact
  fills and what a cash surplus is measured against.
- The change line: a cash entry over the due reads "Change due $X"; a
  single-line entry under it reads "Short $X"; on a two-line tender the
  modal instead says what the OTHER part becomes on Done, because a
  deliberate part-payment is not short. Otherwise the cap note.
- Done applies what was typed and closes; with NOTHING typed it leaves
  the line exactly as it was. It does NOT remove the line: the inline
  keypad's "dismiss without an amount removes the row" rule was a trap
  once the editor became a modal with its own Cancel. Cancel, Escape
  and the scrim all leave the line untouched.
- The partner-line recompute, previously per keystroke, now happens once
  on Done. Entry is clamped per keystroke and per chip exactly as before,
  so no over-cap figure is ever held.
- `onModalChange` still reports the surface, and T35's guard effect
  (a modal whose line has gone is dismissed) is carried over unchanged.
- Incidental: T35's inline `.keypad` rule collided by name with the PIN
  lock screen's `.keypad` (globals.css ~1692). The rename to `.pad-*`
  removes the collision.

### What must not change

The money is untouched: request shapes, single flight, availability
rules, per-line reasons in the same render as `chargeable`, the server's
authority over every number. This ticket is the editor's chrome only.

Built by an implementation agent that completed on disk but never
reported; the work was verified (typecheck, build, diff read) and landed
by the orchestrator. Adversarial review is owed and follows with the
next batch.

### Review (separate reviewer)

Read against the money invariants first: `chargeable` still requires
`!pricing`, a non-suppressed, non-disagreeing SERVER price, due exactly
zero and every line valid, all computed in the same render as the source
and line reasons; `addLine` pre-fills from `dueCents`, which is null
until Mindbody answers, so no estimate can become a line's amount. The
request shapes are byte for byte T35's. One fix:

- **The modal promised one change figure and the tender showed another,
  then refused.** Reachable: a $20 total, tap Cash (a $20 line), tap its
  amount, type 15.00, Done ("Short $5.00"), tap Credit (adds $5.00 from
  a balance that has it), tap the cash amount again, type 25.00. The
  modal reads "Change due $10.00", which is right: the credit part keeps
  its $5 and cash covers the other $15. On Done, `coverage` ran in LIST
  order, so cash (first) took the whole $20, credit covered nothing, the
  Due chip read "Change $5.00" and the credit line failed `lineReason`
  with "Re-enter the amounts against the current total". With credit
  first in the list the same entry charged as promised, so the outcome
  depended on which source the teacher happened to tap first. Cash now
  covers last whatever its position: the other line is clamped and
  recomputed as the remainder on Done, so it is exactly what the teacher
  chose to spend from it, and only cash can carry a surplus. Indexes stay
  aligned with `lines`, so the legs the request sends still read
  `coverage[i]` and still sum to the server's total when due is zero. No
  money path is otherwise touched.

Checked and deliberately left: the Escape order (the modal's own listener
dismisses; the overlay's guard reads `payModalOpen`, set in the same
batch as `padFor` on every open and close, so the same press cannot fall
through); `onModalChange` is true exactly while the modal renders (open
sets both, `dismissPad` clears both, T35's guard effect covers a line
removed under it, unmount reports false); Done with nothing typed leaves
the line, Cancel, scrim and Escape leave it, and a modal cannot be open
mid-charge (the amount button is disabled while charging and the scrim
covers Charge); "the other part becomes $X" is the same `min(rest,
balance)` for credit and `rest` otherwise that `applyPad` writes; the
entry is digits only, leading zeros are stripped ("00" on an empty entry
reads "0"), seven digits is the cap, and a clamped source is clamped on
every key and chip. Not verifiable here: nothing in this ticket reaches
Mindbody.

## T39. Implement the POS design (Pete, 2026-09-02)

Pete sent `docs/design/mockups/POSDesign.pdf`: four frames, two visual
directions (A "Counter": warm paper, teal, mono for money; B: amber,
price-first cards, mode as a chip), one structure. The structure is the
layout of record (`docs/design/sale-screen-layout.md`): rail, grid, cart,
bottom bar, a payment mode that replaces the grid while the cart stays.

The plan is `docs/design/pos-design-implementation.md`: nine serial
steps, each its own ticket and review, each leaving the app shippable.

- [x] T39.1 Shell to 1400, `--accent-ink` and `--shadow`, accent retheme,
      the header's client card.
- [x] T39.2 The vertical rail, Favorites pinned, `more`, the 1040 fold.
- [x] T39.3 Grid cards at 64px with the count pill.
- [x] T39.4 Cart column: TICKET header, select-to-reveal row controls,
      sub-line only above quantity one. Built on T38.
- [x] T39.5 Sticky bottom bar: Empty cart left, Pay / Charge right, below
      every scrim.
- [x] T39.6 Two modes: PaymentPanel to the middle column, rail collapses,
      Escape order, comp never armed while invisible.
- [x] T39.7 Payment surface: Total / Due / Change, tiles or buttons per
      Pete's call, keypad per Pete's call.
- [x] T39.8 Density and degradation pass, both palettes, 768 tall.
- [x] T39.9 What the roster inherits.

Decided by Pete, 2026-09-02: Counter (1a light, 1b dark), and every
recommendation in the plan's section 3: the T36 modal keypad, teal
accent app-wide, the system font stack, chips set the entry; plus the
bar's item count, the dashed bundle card and Due as the loudest figure.
The canvas source is `docs/design/mockups/BuyScreen.dc.html`; the plan's
section 0.2 is its spec as our tokens and sizes.

Build runs as four serial cycles, each with its own separate reviewer:
T39.1-3 (shelf mode), T39.4-5 (cart and bar), T39.6-7 (modes and the
payment surface), T39.8-9 (density, degradation, roster).

What must not change: the money (T35's request shapes, clamps, single
flight, `chargeable` in the same render); the mode banner's presence in
every state; comp arms only in payment mode; T38 lands first.

### T39.1-3: what was built

Shelf mode, per the plan's 0.2 and Pete's calls. Nothing in PaymentPanel's
logic, `/api/*` or `src/lib/sale.ts` changed; the cart column is the old
column moved, not rebuilt (that is T39.4-6).

**T39.1, shell, tokens, header.** Both palette blocks re-valued to
Counter's (1a light, 1b dark) with `--accent-ink`, `--line-soft`,
`--bar-bg`, `--shadow` and `--disabled-bg` / `--disabled-ink` added
(`--stop`, `--stop-bg` and the dark `--action-bg` keep their values, the
canvas does not draw them). Every accent fill that painted `--surface` as
its text now paints `--accent-ink`: the M chip, undo, the lock button,
the active chip, Charge, the pay confirm. `themeColor` follows `--bg`.
The retheme is app-wide through the tokens, as decided. The overlay's
shell is 1400 wide at 16/20; the mode banner runs edge to edge inside it
as a 16px line; the header is a 76px row under a hairline: `Buy` at
23px, the client card at 60px (SALE FOR at 14px, the name at 17px, the
balance as a mono pill in the `--ok` pair reading `$40.00 credit`, owed
money keeping the stop pair; a 44px detach), the unattached state the
same card carrying the plus, "Attach a client" and its 16px hint; Back
outlined at the far right, 64px (the house rule over the canvas's 60).

**T39.2, the rail.** `.sale-cats` is a 154px column of 64px entries
(the canvas's 62 brought up to the floor), 6px gaps, 14px side padding,
radius 12, 16px/600, active in the accent fill with `--accent-ink`,
Favorites pinned first and default-selected as before. Past seven
entries the rest fold behind a muted `more` that expands the rail in
place (`RAIL_LIMIT`), and the rail expands on its own when the active
entry would be hidden; the studio's eight (see the review below) show
whole. The panes are a
`154px minmax(0,1fr) 388px` grid placed by column, so the PaymentPanel
(still holding the tender and the receipt, until T39.6) is the right
column without any change to its markup. Under 1040 the same element
folds back to a wrapping chip row above the grid, the cart spanning both
rows (`grid-template-rows: auto 1fr`, or the span's height leaks into row
one); under 900 the one-column stack stays, in DOM order. The folds sit
AFTER the base rules in `globals.css`: same specificity, later wins, and
the first cut had them earlier, where the base `flex-direction: column`
beat the fold silently.

**T39.3, the grid.** `.shelf-grid` at `minmax(184px, 1fr)`, 10px gaps;
cards min-height 96, padding 14, radius 14, name at 17px/600 line-height
1.25 on top, a bottom row with the price bottom-left (16px, the figure
alone in mono, the "no tax" / "package, est." note beside it in the body
face) and, when the item is in the cart, the count pill bottom-right
(accent fill, `--accent-ink`, 14px mono, `×2`), read from cart state by
the same `${type}-${id}` key the cart uses, no call. The star stays a
44px sibling top-right; only the name gives it room now, so the pill
keeps the card's own corner. Bundle cards: dashed `--line-soft` border
and "bundle" after the name (from Slate, decided). Contract cards keep
`.shelf-contract` and T30's dialog; "membership" moves after the name
to match. Under 1190 the cart narrows to 340 and the card minimum to 166.

**Two arithmetic corrections to the plan's T39.3.** (1) At 1366 the grid
gets 756px, and four cards of 184 need 766 (three 10px gaps), so the
grid is THREE columns of about 245, not four. That is what 1a itself
draws: the designer's "try next" line offers "a tighter four-column
grid" as a follow-up, which means the design of record is three. Left at
184 per the spec; a four-column iPad would be `minmax(181px)`, one
number, if Pete wants it. (2) Three columns of 184 with a 388 cart hold
from 1182 up, not 1180, so the narrowing query sits at 1190; at the 1080
floor the grid is 518, three of 166 with two gaps exactly, as planned.

**Also touched.** `.tender-srcs` wraps: at 340 the three sources no
longer fit one line and were clipping. Style only, and T39.6 moves the
row.

**Verified.** `npm run typecheck` and `npm run build` clean. Screenshots
in both palettes at 1366x1024, 1180x820, 1080x768 and 1000x768 with the
API mocked (no Mindbody credentials here; a fixture catalog of the
studio's real names and prices, a fixture client with $40 credit, the
cart priced locally at 10.35%), compared by eye against 1a and 1b: the
header, rail, cards and count pill match; the cart column is still the
pre-T39.4 receipt and tender, as expected at this step.

**Left for the next cycles, on purpose.** The disabled primary pair is
defined but unused until T39.5's bar; `--shadow` likewise. The count
pill is on cards only, never on a bundle card (a bundle is several
lines). The rail's `more` has no collapse, since nothing on the studio's
catalog ever shows it. The tender and receipt in the cart column are
untouched and look like T38 inside a Counter frame until T39.4 and T39.6.

### Review (separate reviewer), T39.1-3

Reviewed against the plan's 0.2 and the 1a/1b frames, with the API
mocked in Playwright at 1366x1024, 1180x820, 1080x768, 1000x768 and
800x1100 in both palettes, and the roster in both palettes with every
chip state (checked in, check in, unpaid, no waiver, the M chip, a
negative balance). One fix:

- **The rail folded the studio's own catalog, hiding one entry behind a
  button that took its slot.** `RAIL_LIMIT` is seven, and the fixture
  the implementer shot with had no packages and no contracts, so the
  rail was six. The studio's rail is eight: Favorites, the five
  categories, Packages and Memberships. At eight the rail showed seven
  plus `more`, with Clothing alone behind it, and `more` is itself a
  64px entry, so the fold saved nothing and cost a tap on every visit
  to Clothing (shot: `real-light-1366x1024-rail.png`, before the fix).
  The fold now happens only when it would hide at least two entries
  (`all.length > RAIL_LIMIT + 1`); eight show whole, nine fold two.
  The comments and the T39.2 note above that said the studio never
  triggers it are corrected. Auto-expansion for a hidden active entry,
  the tap's stickiness, and the fold's survival across a catalog
  reload are unchanged and were exercised with twelve entries.

Checked and clean: no hex outside the two palette blocks (`layout.tsx`'s
two `themeColor` values equal `--bg` exactly); every `background:
var(--accent)` in the CSS pairs with `--accent-ink`; every ok / warn /
stop pairing takes both halves from the same palette; the check-in chip,
the M chip, the balance pill, the class dropdown, the sort bar, the lock
screen, the dev drawer and the settings tab read in both palettes.
Contrast at 16px: accent-ink on accent 7.8 / 9.6 (light / dark), ok on
ok-bg 5.7 / 7.5, warn on warn-bg 5.7 / 7.8, stop on stop-bg 5.3 / 6.8,
muted on surface 4.7 / 5.6, muted on bg 4.3 / 6.1. The two below 4.5 are
the canvas's own numbers: light muted on bg (4.34, the 1a frame's
`#7a7163` on `#f6f3ec`) and the light disabled primary pair (3.10,
unused until T39.5 and drawn that way in 1a); noted for T39.8 rather
than changed here. Light muted on `--line` (3.59) is `.chip.busy`, which
shows a spinner rather than text, and `.mini-signed`; both predate the
retheme. Layout: measured bounding boxes at every size above, no pane or
card overlaps, no horizontal overflow, the banner the overlay's full
width at 16px in dry-run, live and write-guarded states, cards 96px,
rail entries and Back 64px; three columns at 1366 and 1180, three at
1080 with the 340 cart, the chip row and the two-row cart at 1000, one
column at 800. The count pill reads `${type}-${id}`, the key `addItem`
and `addBundle` write, and a bundle tap raised the pills on its
component cards while the bundle card itself carried none. The money
path: the `<PaymentPanel>` element is byte-identical before and after
the column move, no hunk in the three commits touches the PaymentPanel
function, `/api/*` or `src/lib`, and `.sale-left`'s move is one
`grid-column` rule.

Left as it is: the rail is a `nav` with `role="tablist"` whose `more`
entry is not a `tab`, and the tabs have no arrow-key handling (neither
did the chip row); an iPad counter has no keyboard, and the tablist
predates this cycle. Auto-expansion for a hidden active entry collapses
again when a visible entry is tapped, since only the `more` tap is
sticky; with the fix the studio's rail never folds, so this is a
catalog-growth case for the day it comes.

### T39.4-5: what was built

The cart column and the bar, per the plan's 0.2 and 1a/1b. Nothing in
PaymentPanel's logic, `/api/*` or `src/lib/sale.ts` changed; the
`<PaymentPanel>` element and its props are byte-identical, and the bar's
amount is display only.

**T39.4, the ticket.** 1a's: radius 16 on `--surface`, a head line with
TICKET (16px, uppercase, letter-spaced, muted) and the item count (14px
mono, the recorded exception) under a dashed `--line-soft` rule, and no
studio heading. Rows are the name (16px/500) and a right-aligned mono
total on one line, the `2 @ 1.81` sub-line (14px mono muted) only above
quantity one, padded 8/10 with a 2px gap. **Select to reveal**: the row
is the tap target (a div with the button role and an aria-label, since a
`<button>` may not contain the buttons the controls are; Enter and Space
work too), tapping it selects (accent border, `--bar-bg` fill) and only
the selected row shows minus / count (20px mono) / plus at 64px and an
outlined `--stop` Remove pushed right; the controls stop propagation so
a tap on plus does not deselect. Tapping again or another row changes
the selection; `addItem` selects the line it touched and `addBundle`
the last line it rang up; `removeLine` and `emptyCart` clear it; and the
selection is derived against the cart, so a key that leaves by any path
(a recheck dropping the line, a sale clearing the cart) cannot point at
a row that is not there. The always-visible stepper on every line is
gone, which is what buys the height back. `bumpQuantity`, `removeLine`
and `MAX_LINE_QUANTITY` are unchanged. Totals: Subtotal and `Tax 10.35%`
(the rate from `/api/config`'s `studioTaxRate` when the server sent
one, `Tax` otherwise) in 16px mono muted at 1.9, a hairline, Total at
17px/700 beside a 26px mono figure; T38's estimate rows keep the muted
"Estimated" treatment and the "Pricing with Mindbody..." line, and the
disagree block, audit table, suppressed notice and needsClient branch
are as they were, inside the totals block.

**The height model.** The overlay is a flex column the viewport bounds:
`.sale-shell` and `.sale-panes` take `flex: 1; min-height: 0`, each
pane (`.sale-cats`, `.sale-right`, `.sale-left`) is `min-height: 0;
overflow-y: auto` so the grid scrolls inside itself rather than the
overlay scrolling, and the cart column is a flex column whose ticket is
its `flex: 1` child; inside the ticket the lines box is `flex: 1;
min-height: 0; overflow: auto`, replacing T38's `min(44vh, 540px)`. The
fade stays on the wrap; T38's "N more below" cue moved into the head
line beside the count, because the head never moves, so showing the cue
cannot change the box it measures (a pill over the fade landed on the
selected row's Remove when that row was the last visible), and the
measurement now also runs from a ResizeObserver on the lines box, since
the box's height moves with a selection or a totals change. Under 900
the bound is given back (the overlay scrolls as before, the lines take
T38's cap again, the bar sticks). A long totals block (the stop with its
audit) scrolls the ticket as a whole with the lines held at two rows.

**One recorded exception.** Rows are 44px, not 64: the codebase's
secondary standing (the row icons, the old steppers' "occasional
deliberate taps"), because a row is a selection with an immediate
visible answer and no consequence, and at 64 a seven-line cart is 460px
of rows and never fits a 768px screen, which is what the ticket exists
to do. Every control a row reveals is 64.

**T39.5, the bar.** The overlay's last child: 92px on `--bar-bg` across
the full width, a hairline above, `--shadow`, contents aligned to the
shell's 1400 at 20px, `position: sticky; bottom: 0` for the narrow
fold. Left, `Empty cart`: T38's Clear cart moved off the ticket foot,
outlined at 64px on `--surface`, the same dialog ("Clear the cart?",
Keep items / Clear cart) and the same `emptyCart` behind it, disabled
on an empty cart or mid-charge. Right, the primary: 68px, radius 14,
accent fill with `--accent-ink`, `Pay` at 20px/700, `· 9 items` at
16px/600, `· $253.22` at 22px mono; the count from the cart's
quantities and the amount the SERVER's `grandTotal` only. It takes the
disabled pair and drops the figure on an empty cart, while pricing (a
spinner where the amount goes; T38's estimate never reaches the bar),
with no price yet or a failed price, and when suppressed, disagreeing
or needing a client; a real button with `aria-disabled` and a `title`
that says which. Tapping it brings the payment column into view and
focuses the first source that can take it; the `TODO(T39.6)` marks
where the mode switch goes. Charge in PaymentPanel is untouched.
Stacking: the bar is z-index 5 in the overlay's own stacking context
and every scrim there is 30 (the keypad, the cart-change confirm, the
Clear cart confirm, the contract dialog), the attach search modal and
the waiver are 30 at the root above the overlay's 18, so nothing on the
bar is tappable behind any of them.

**Verified.** `npm run typecheck` and `npm run build` clean. Playwright
with the API mocked (the reviewer's fixture: packages and contracts
present, Alida with $40 credit, the cart priced locally at 10.35%) in
both palettes at 1366x1024, 1180x820, 1080x768 and 1000x768, under
`scratchpad/t39-2/`: the empty ticket; the prototype's seven-line cart
(10 Class Pack, Mat, Towel, Liquid IV x2, Parking, Boxed water, Vita
Coco x2) with Liquid IV selected; the estimate state with the bar
reading `Pay · 10 items` and a spinner; the Clear cart confirm with
`elementFromPoint` over Pay returning the scrim; Keep items keeping
eight rows and Clear cart leaving none; the disagree stop. At every
size the bar's box is at the viewport's bottom edge, the overlay,
shell and panes do not scroll, the grid scrolls inside `.sale-right`,
and a second tap on the selected row deselects it. Compared by eye
against 1a and 1b: the head, rows, selected row, totals and bar match.

**Left for the next cycles, with the numbers.** The 768px done-when is
not met in this cycle and cannot be: the tender block (155px) and the
comp / Charge seam (163px) still share the column until T39.6, and at
768 tall the pane is 531, so the ticket gets 189 where its head and
totals alone are 184. It is held at a 260px minimum, so at 768 the
column scrolls 43px (Charge's lower third below the fold, as the
overlay already scrolled there before this cycle) and at 820 the ticket
itself scrolls 25px with two rows showing; at 1024 tall a seven-line
cart shows five rows with one selected and nothing scrolls but the
lines. Once T39.6 moves the tender and the seam out, the column is the
ticket alone and the same geometry gives it 531 at 768: head 44, totals
140, 347 for lines, which is the seven-line cart with one row selected.
Also for T39.8: at 1080x768 the eight-entry rail (8 x 64 + 7 x 6 = 554)
is 23px taller than the bounded pane and scrolls, since the plan's
budget assumed seven entries; and the dev drawer's pill (z-index 19,
above the overlay) sits over the bar's amount in a dev build, which is
absent at the counter.

### Review (separate reviewer), T39.4-5

Traced from the state chain, then run with the implementer's fixture in
Playwright (both palettes, 1366x1024, 1180x820, 1080x768, 1000x768 and
800x1100 for the fold) under `scratchpad/t39-2-review/`. The bar's
figure is `priced.grandTotal` and nothing else: `payWhy` is one chain
in the render (charging, empty, pricing, priceError, no price,
suppressed, disagrees, needsClient, null total) and `payAmount` is null
whenever it is non-null, so the estimate cannot reach the bar. Seen at
every size: `Pay` greyed with "Nothing rung up yet" on the empty cart,
`Pay · 10 items` with the spinner and "Pricing with Mindbody..." while
the mocked price hung, `Pay · 10 items` greyed with "Totals disagree;
do not charge" on the disagree stop, the figure only once the server
answered. The effect-after-paint question: `pricing` is set in the
pricing effect, so a render exists where the cart is new and `priced`
is old, but every path into it is either a discrete event (a card tap,
a client switch, Keep items), whose effects React 18 flushes before
paint, or lands in a state the chain greys anyway (a recheck stands
under the stop, `onSold` empties the cart). Not a bug; recorded so the
next hand knows the guarantee rests on the discrete flush. Empty cart
calls `setClearPrompt` and the confirm calls `confirmClear`, which is
`emptyCart` exactly; disabled on an empty cart and mid-charge; Escape
on the confirm kept seven rows and the overlay. With the Clear cart
confirm, the keypad, the cart-change confirm and the contract dialog
open, `elementFromPoint` over both Pay and Empty cart is the scrim.
The fold at 800x1100: scrolled to the end, the bar's bottom is the
viewport's and its top is 16px under Charge and under the last row.
Nothing but `.t-lines`, the panes and, pre-T39.6, the ticket and the
column scroll, at the numbers the build notes give. Nothing in
PaymentPanel, `/api/*` or `src/lib/sale.ts` has a hunk; T38's estimate,
audit, stop and Recheck are as they were. Tokens in both palettes, no
hex outside the two blocks, no em dashes, 14px only on the count and
the sub-line. Three fixes, all display side, in `SaleScreen.tsx`:

- **The cue went stale on a selection.** In a bounded ticket the lines
  box does not change size when a row reveals its controls, so the
  ResizeObserver never fired and the effect's deps did not include the
  selection: at 1366x1024 with seven lines, selecting the first row
  pushed a third row under the edge and the head still read "2 more
  below". `selectedKey` is now a dependency of the measure effect.
  Cue equals the fresh DOM count at every size afterwards.
- **Enter on the revealed plus deselected the row.** The controls
  stopped propagation for click only; a keydown on the focused plus
  bubbled to the row's Enter/Space handler, which called
  `preventDefault` (eating the button's own activation) and toggled
  the selection off, so a keyboard user got a deselected row and no
  count. `.t-ctl` now stops keydown too. Enter and Space on the plus
  count 2 and 3 with the row still selected; Enter and Space on the
  row itself still toggle.
- **The reveal could be invisible.** Adding from the shelf selects the
  line it touched, and past five lines that row is under the fold: the
  count updated, the cue said "1 more below", and the row with its
  controls was not on screen. A tap on a visible row could also push
  its own Remove under the edge (the 1180x820 screenshot, pre-T39.6).
  On a selection change the lines box now scrolls just far enough to
  show the selected row; only the box, never the column or the
  overlay, so under 900 a card tap cannot pull the shelf away. Its
  scroll event re-measures the cue.

**44px rows: stands.** CLAUDE.md's floor is for tap targets; the
codebase's secondary standing (the sort icon, the undo, the row star,
the detach x, all 44) is for a tap with an immediate visible answer and
no consequence, which a selection is, and every control it reveals is
64. The plan's own T39.4 spec (8/10 padding, a 2px gap, seven lines
with one selected inside 768) cannot be met at 64, and one number in
the build notes is wrong the other way: the prototype's seven-line cart
with one row selected measures 440px of lines (the harness: a 283px box
scrolling 157; five plain rows at 44, two with the sub-line at 64, the
74px reveal, the gaps and padding), not the 347 the notes project for
T39.6, so freeing the column at 768 leaves the box two rows short even
at 44, and 64 would add 140 more. The exception stands as recorded;
the 768 done-when needs T39.6 to re-run the arithmetic with 440 as the
lines figure and take the difference out of the head and totals
(184px together today) or hand it to T39.8's density pass.

Checked and deliberately left: the dev drawer's pill (fixed, bottom
right, z 20) covers the cents of the bar's amount in a dev or
`POS_DEVTOOLS` build, and Next's own dev indicator sits over Empty
cart; there is no corner of the bar's row a fixed pill would not cover
something in (108px up lands on Charge's end now and the Total's later),
so it stays recorded rather than moved, and the ticket's Total carries
the same figure. Pre-T39.6 at 820 and 768 the lines box is its 104px
minimum, and a selected row taller than the box counts itself in the
cue ("7 more below" with the selected row on screen): T38's rule, a row
counts once its bottom is past the edge, applied to a box two rows
tall; it goes when T39.6 gives the ticket the column. The selection
survives a Recheck (the rebuilt lines keep their keys) and a client
switch that keeps the cart, which is right: it is the same line. A
`role="button"` row containing buttons is nested interactive content
under the ARIA rules; the notes record why a `<button>` could not hold
the controls, and the row carries `aria-label` and `aria-pressed`.

### T39.6-7: what was built

Modes and the payment surface, per the plan's 0.2, 0.3 and section 1,
and Pete's calls (Counter, the T36 modal keypad, Due the loudest figure).
`/api/*` and `src/lib/sale.ts` are untouched; in PaymentPanel, `coverage`,
`capFor`, `addReason`, `lineReason`, `chargeable`, `doCharge` and the
request mapping have no hunk beyond one string ("Nothing left to pay"
became the prototype's "Nothing left to cover", plan 0.3) and the done
block's captured figures.

**T39.6, two modes.** `saleMode: "shelf" | "pay"` in SaleScreen, reset
on every open and through one `close` on every way out (Back, Escape,
Done). `Pay` enters when T39.5's chain allows and clears the selection;
in pay mode `.sale-panes.pay` is `minmax(0, 1fr) 388px` (340 under
1190), the rail and grid are `display: none`, the surface pane takes the
middle, and the cart column is the same element in the same place: its
rows lose `role="button"`, `tabIndex` and their handlers, so the
pay-mode ticket has no controls, and the lines box is scrolled to its
first row on entry. The bar's left control is `Back to items` (disabled
mid-charge) and Empty cart is shelf-only.

**The panel stays mounted in both modes.** Its root is `.sale-pay` with
the `hidden` attribute in shelf mode (`.sale-pay[hidden] { display:
none }`, since the pane's own `display: flex` would otherwise beat the
UA rule), so T35's lines, comp and keypad state are the same React state
across Back to items; the ticket moved OUT of the panel (the `receipt`
prop is gone) into `.sale-left` in SaleScreen, since nothing sits
between the tender and a charge button any more. Verified: Credit $40 +
Cash $300 entered in pay mode, Back to items, Pay, the same two lines
with the same amounts; the same for Credit + Card.

**The comp-clearing rule.** Comp arms only in pay mode and is never
armed while invisible. The panel takes `visible`; an effect on it going
false dismisses an open keypad (through `dismissPad`, which reports
`onModalChange(false)`) and, if comp was armed, clears it and sets a
one-shot `compCleared` that the quiet line shows as "Comp was cleared."
until the next tender gesture (a source tap, an x, an amount tap, a
hold) or reset. `armComp` also refuses while hidden, for a hold that
began a moment before Back to items and whose timer lands after. The
button cannot be pressed while hidden (no pointer on `display: none`),
and every mode switch is a discrete event whose effects React flushes
before paint, so no frame shows the shelf with comp armed behind it.
Verified: armed, Back to items, `aria-pressed` false on the hidden
button, "Comp was cleared." on return, gone after a Cash tap. The
button's label is the canvas's "Comp this sale" (no "Hold to" in it),
so a bare tap now writes "Hold Comp this sale for a moment to arm it."
in the quiet line rather than doing nothing.

**The Escape order, as implemented.** One handler in SaleScreen, one
press peels one layer: (1) the keypad, dismissed by the panel's own
listener as Cancel, with `payModalOpen` keeping the overlay handler out
of the same press; (2) the cart-change confirm, the Clear cart confirm
and the contract dialog, each with its own listener and each a return
for the overlay handler; (3) pay mode to shelf; (4) the overlay, not
mid-pricing. Nothing leaves mid-charge: `charging` returns before (3).
Verified press by press: keypad closed and still in pay mode; the
cart-change confirm closed (keeping the items) and still in pay mode;
shelf; closed; reopened in shelf mode with the cart intact.

**One Charge, on the bar, gated in the panel's render.** The panel's
own Charge button is gone. In pay mode the bar's primary is rendered BY
PaymentPanel through `createPortal` into `.sale-bar-slot` (a callback
ref into SaleScreen state, `display: contents`), so the button reads the
`chargeable` of the same render as the tiles' reasons and there is no
effect-after-paint gap and no gate copied upward. It reads `Due $X`
disabled while due is above zero (the prototype's label, plan 0.3),
`Charge $total` at zero, `Comp $total` when comped, a spinner with
"Charging..." in flight, and nothing once the done block is up;
`aria-disabled` like the shelf's Pay so its title can carry the reason,
the click guard and `doCharge`'s own checks refuse the tap, and the
aria-label is T35's full `chargeLabel` (the legs restated). The
suppressed notice and the disagree stop with T38's audit table and
Recheck render above the figures in pay mode from a `notice` prop; the
audit table is one element (`auditTable`) used in both the ticket and
the surface.

**T39.7, the surface.** `.pay-surface`: radius 16 on `--surface`,
padding 18, 12px gaps, the foot pushed down with `margin-top: auto`
under a hairline. Figures: three tiles on `--bg`, 14px uppercase label
over a 34px mono figure; Due has a 1.5px ink border and ink label
(decided: the loudest), takes the `--ok` pair once the lines cover the
total with at least one line present (or comped), Change takes the
`--warn` pair when positive; the tinted borders are the pair's text
colour through `color-mix` at 55%, not new tokens. Source tiles:
`grid-auto-flow: column` so two or three share the row with no dead
slot, min-height 82, a 1.5px accent border when available and
`--line-soft` at half opacity when not, the 18px name with the existing
icon, the reason under it at 14px only when there is one, Credit's
balance badge top-right in the `--ok` pair. Reasons: T35's own where it
has them; "Applies first" on an available Credit and "Nothing left to
cover" once due is zero (plan 0.3). **Tapping Cash with a cash line
present opens that line's keypad** (layout plan 2.7): the tile stays
available with "In the payment. Tap to change it."; a second Card or
Credit tap keeps T35's refusal. Tender rows: `--bg` fill, radius 12,
padding 8/10, the name 16px/600, "covers $X" in 14px mono under a cash
line entered above what it covers, the amount a 64px mono button at
min-width 6.5em, the x a 64px square. The hint under the rows at 16px.
The foot: the quiet line ("Nothing to pay, on the studio." when comped,
"Comp was cleared." once, else the first line problem and T35's chain)
and `Comp this sale` outlined at 64px, the hold unchanged.

**The keypad** is T36's, restyled: 420 wide, radius 20, padding 20, 10px
gaps, the title at 20px, the Amount due row (16px muted, 18px mono), the
Entered box on `--bar-bg` with the 30px mono figure, chips as 64px pills
sharing the row (cash only, and they SET the entry as decided), 66px
keys in 23px mono, the change / short / partner line in 18px mono
`--warn`, Cancel outlined and Done in the accent at 64px, right-aligned.
Nothing in its logic moved.

**The done block** for the one branch that is a completed sale: an 88px
`--ok-bg` circle with the check, "Sale complete" at 30px, the 19px mono
`Charged $253.22 · 9 items` (Comped when comped) with `Change $46.78
from the drawer` under it on a cash over-tender, then the T24 summary
and the sale id, then Done in the accent, still back to the roster
(T33). The paid result now carries `total`, `count`, `changeCents` and
`comped`, captured at the tap because `onSold` empties the cart in the
same commit. Suppression never reaches it: a dry-run suppression keeps
the amber notice and its sentence and gains the title "Sale rehearsed"
(plan 0.3); a write-guard suppression is unchanged; the split, ambiguous
and error branches are word for word.

**Also.** `.shelf-grid { align-content: start }` (cycle 2's stretched
cards). Under 1190 the surface tightens to 14px padding and 10px gaps
and the tiles to 12/14: at 1080x768 the pane is 531 tall and the surface
with two rows and a wrapped tile reason ("Two parts is the maximum")
ran to its last pixel, Comp's lower edge one under the pane's; with the
tweak Comp ends 15px clear of it. The tweak sits AFTER the surface's
base rules in `globals.css`, since the first cut had it before them and
the base padding won at equal specificity (T39.2's lesson, again).

**The request bodies, observed** through the harness's mocked
`/api/checkout` (`scratchpad/review3.js`, the `bodies` and `sizes`
runs):

- One cash line entered at $300.00 against $253.22: `{ ..., "clientId":
  "100000123", "method": "cash", "cashTendered": 300 }`. No `split`.
- Credit + Card (a $40 balance, a card on file): `{ ..., "split": {
  "legs": [{ "method": "credit", "amount": 40 }, { "method":
  "storedcard", "amount": 213.22 }] } }`. No `cashTendered`, no
  `method`.
- Credit + Cash at $300.00: `split.legs` `[{ credit, 40 }, { cash,
  213.22 }]`, the cash leg what it COVERS, no `cashTendered`; the Change
  tile and the done block both read $86.78.
- Back to items then Pay: the same lines, and the same body on Charge.

**Verified.** `npm run typecheck` and `npm run build` clean. Playwright
with the API mocked, both palettes at 1366x1024, 1180x820 and 1080x768
under `scratchpad/t39-3/`: pay mode with no lines, Credit + Cash, the
keypad at $300.00, the over-tender, Back to items, pay again, and the
outcome (paid in light, suppressed dry-run in dark); plus the single
cash over-tender's done block, Credit + Card, the disagree stop in pay
mode (two stops, two audit tables, the figures reading `--` and the bar
`Due` disabled), comp armed and cleared, and the Escape sequence. At
every size the surface and the cart column fit without scrolling with
two tender rows; with an outcome notice up as well the surface scrolls
inside its pane (the dark 820 and 768 shots), the bar never covers it.

**Left, with the reason.**

- After a paid sale the bar shows `Back to items` alone; the prototype
  hides its bar in the done state and offers `New sale`. Ours keeps the
  bar's shape stable and Done is the one control, per T33. Back to
  items from the done block returns to an empty shelf with the paid
  block still held (it clears on the next cart edit, as T35 has it).
- The keypad's scrim covers the bar, so the only way out of pay mode
  with a keypad open is Escape (which closes the keypad first); the
  `visible` effect still covers the hidden-with-keypad case for any
  future path.
- The tile icons (T33's) stay beside the names; the canvas draws none.
  One line to drop if Pete prefers the canvas's plain tiles.
- Under 900 the surface stacks above the cart in DOM order and the
  overlay scrolls, as the other panes do; not screenshot-checked this
  cycle (T39.8).
- The dev indicator and the drawer's pill still sit over the bar's
  left and right ends in a dev build (recorded in T39.4-5).

### Review (separate reviewer), T39.6-7

Read against the money first, in this order: the bar's primary is
rendered by PaymentPanel through `createPortal` into `.sale-bar-slot`,
and both its `aria-disabled` (`primaryOn = dueSettled && chargeable`)
and its click handler (`if (!primaryOn) return; void doCharge()`) are
values of the SAME render as the tiles' reasons and the lines'
`lineReason`; nothing is copied upward through an effect or a ref. The
slot is a callback ref into state, so the first render has no target
and renders no button, which is the shelf's Pay anyway; it is the same
element in both modes (it sits between the bar's two branches and is
never conditional), so switching modes neither loses nor duplicates it.
The portal is guarded by `visible && barSlot`, so in shelf mode the
slot holds nothing (`slotChildren: 0`, one `.sale-bar-pay` on the
screen, the shelf's) and the Charge button is unreachable: there is no
hidden button to focus, not merely a hidden one.

Request bodies, captured through a mocked `/api/checkout` (the
reviewer's `scratchpad/review3r.js`, `bodies`), a $253.22 cart of nine
items, a $40 balance:

- one cash line entered at $300.00: `{ clientId, method: "cash",
  cashTendered: 300 }`, no `split`; the done block reads `Charged
  $253.22 · 9 items` and `Change $46.78 from the drawer`.
- Credit + Card: `{ clientId, split: { legs: [{ method: "credit",
  amount: 40 }, { method: "storedcard", amount: 213.22 }] } }`, no
  `method`, no `cashTendered`.
- Credit + Cash at $300.00: `split.legs` `[{ credit, 40 }, { cash,
  213.22 }]`, the cash leg what it covers, no `cashTendered`; change
  $86.78 on the tile and in the done block.
- comp: `{ clientId, method: "comp" }`.
- one card line (no balance): `{ clientId, method: "storedcard" }`.
- four taps on Charge inside 30ms (two in one task, two a frame later)
  against a 1500ms checkout: ONE request. Mid-flight the bar reads
  `Charging...` disabled, Back to items, the header's Back and detach
  are disabled, Escape leaves neither pay mode nor the overlay, and a
  forced click on Back to items does nothing.

All five match T35's shapes and the route's validation (`cashTendered`
only beside `method: "cash"`, never beside `split`; two legs of
different methods summing to the rehearsed total).

One fix, no money path involved:

- **The hold timer's `visible` guard was dead code.** `armComp` refused
  with `if (!visible) return`, but the callback `compHoldStart` hands
  to `setTimeout` is the closure of the render the hold STARTED in,
  whose `visible` was true by definition, so the guard could never
  refuse the case it was written for. Sequence: pointer down on Comp in
  pay mode, Back to items 300ms later, the timer lands with the panel
  hidden. Observed pre-fix (a MutationObserver on the hidden button):
  `aria-pressed="true"` in shelf mode, then the `visible` effect
  clearing it in the next passive flush, then "Comp was cleared." on
  return for a comp the teacher never saw, and `compHeld` left true so
  the next tap on Comp was swallowed. No frame could charge it: with
  `visible` false the portal renders no Charge button at all, and the
  effect had it disarmed before any tap could land. In Chromium the
  sequence is unreachable with a real pointer (the element going
  `display: none` fires pointercancel, and `compHoldAbort` clears the
  timer); a touch platform that keeps the pointer is the case. Now
  `armComp` reads a `visibleRef` kept current on every render and
  returns whether it armed; the swallow flag is set only for a hold
  that did arm. Same sequence post-fix: no arming, no message, the
  next bare tap shows the hint.

Checked and deliberately left as they are:

- **Escape and exits.** Press by press: keypad (the panel's listener,
  `payModalOpen` keeping the overlay handler out), the cart-change
  confirm, pay mode, the overlay; reopened in shelf mode with no lines,
  no comp and no keypad, because PaymentPanel unmounts with the overlay
  (`if (!open) return null`) and `saleMode` resets on open and in
  `close`. Done after a paid sale closes the overlay. `charging` returns
  before the pay-mode branch in the overlay handler, and the panel's
  own Escape listener is gated on `!charging` too. After an AMBIGUOUS
  outcome Escape leaves pay mode and then the overlay: that is what the
  pre-cycle handler did (it gated on `charging`, `pricing` and the
  modals only), and T24's rule is mid-charge ("Back is disabled
  mid-charge so the outcome panel cannot be unmounted while money
  moves"), so nothing changed here.
- **The cart moving under pay mode** (detach then Keep items, a 1200ms
  reprice): the lines clear, the figures read `--`, the tiles grey with
  "Pricing with Mindbody..." and the bar reads `Due` disabled, for the
  whole reprice. The clearing is the T35 cart-edit effect, post-commit
  as it always was; every path that changes the cart in pay mode is a
  discrete event, whose effects React flushes before paint.
- **The credit-visibility filter** under an ambiguous outcome whose
  refetch reports a zero balance: the credit line goes, the cash line
  stays, Due reads $40.00 and the bar is disabled; the tile is gone
  rather than greyed (T33).
- **The done block's figures** are captured at the tap (`itemCount`,
  `changeAtTap`, `comped`) and `total` is the server's `body.total`;
  `onSold` empties the cart in the same commit, so nothing it shows can
  be recomputed from moved state. "Sale rehearsed" renders for
  `mode === "dry-run"` only; the write-guard branch reads "Write guard:
  nothing was charged." with no title; neither suppression reaches the
  paid branch (the lines and the cart stay, the bar still offers
  Charge). The suppressed, split, ambiguous and error branches diff
  clean against eb834c4 apart from the title and a JSX line wrap that
  renders the same text.
- **Layout**, both palettes at 1366x1024, 1180x820 and 1080x768 under
  `scratchpad/t39-3-review/`: pay mode empty, two lines, the keypad at
  $300.00, the over-tender, paid, suppressed (dry run), the disagree
  stop, plus the write-guard wording at 1366. The bar's bottom edge is
  the viewport's at every size and state; the document and the overlay
  never scroll; only `.sale-pay` (the suppressed notice at 820 and 768,
  the two stops at 768) and `.t-lines` (768) do. With the keypad open
  the point over the Charge button is the scrim. The pay-mode rows
  carry no `role="button"` and no `tabIndex`. `.shelf-grid` has
  `align-content: start`.
- **Conventions.** No hex outside the two palette blocks; the three
  `color-mix` borders mix a token's own text colour with transparent,
  so each is a tint of a colour already right on that ground. 14px is
  on the figure-tile labels, the tile reasons and badge, the cash
  sub-line and the done block's detail, all the plan's 0.2 exceptions;
  the hint and the quiet line are 16px. Every target measured at or
  above 64px: the amount button and x (64), the chips (64), the keys
  (66), Cancel and Done (64), Comp (64), the bar's controls (64 and
  68), Done on the paid block (64). No em dashes in the cycle's diff.

### T39.8-9: what was built

**T39.8, density and degradation.** Measured with Playwright against the
cycle-3 fixture (the API mocked, the studio's eight rail entries, the
prototype's seven-line cart of nine items, Alida with $40 credit), both
palettes, shots under `scratchpad/t39-4/`. CSS, two small render tweaks
and the dev pill; PaymentPanel's logic, `/api/*` and `src/lib/sale.ts`
have no hunk.

1. **The 768 budget.** The layout plan's 2.8 method, applied to the
   frame and the ticket: the banner 36 to 32 (5px padding on the 16px
   line), the header's margin under it 16 to 12, the shell's bottom
   padding 16 to 12, the ticket head 14/16/10 to 10/16/8 (47 to 41),
   the lines box padding 8 to 6, the totals block 12/16/16 to 10/16/10
   with the two muted rows at 1.5 line-height instead of 1.9 (24px a
   row, not 30) and the rule and Total paddings 8 to 6 (140 to 115),
   the selected row's controls 10 to 6 under the line. Rows stay 44,
   every control 64, the bar 92. The budget at 1080x768 is now banner
   32, header 76, 12, panes 543, 12, bar 93; the ticket is head 41,
   lines 384, totals 115. **At 1180x820 (the studio's iPad) the
   seven-line cart with one row selected is 432px of lines in a 436px
   box: nothing scrolls but the grid.** At 1366x1024 the box is 638.
   **At 1080x768 seven lines fit unselected (362 in 384); with a row
   selected the lines are 427 to 432 and the box scrolls 43 to 52px,
   six rows on screen with the selection always among them (the
   T39.4-5 review's scroll-into-view) and the head cue naming the
   hidden one.** That is the recorded number: 44px rows and 64px
   controls want 48px more than 768 has, and both floors stand.
2. **The rail.** Eight entries at 64 on 6px gaps were 554 in a 543
   pane at 768 and scrolled Memberships under the edge. Entries are 60
   tall on 4px gaps (508 for eight, 35 clear at 768) and each entry's
   `::before` reaches 2px into the gap on either side, so the tap
   target is the full 64 pitch: `elementFromPoint` at every pixel of a
   gap returns an entry, never the rail. The first cut used -2px and
   left one pixel of gap, because a button's positioned children sit
   inside its border; -3 is the measured value. The canvas draws 62/6.
3. **The dev pill.** SaleScreen puts `sale-open` on the body while the
   overlay is open and `.dev-handle` under it moves to the bar's centre
   (`left: 50%`), where the bar is empty in every mode (Empty cart or
   Back to items at the left, the primary at the right). The point over
   the amount's last digit is the Pay button in a dev build. Next's own
   indicator still sits over Empty cart's first letter; not ours.
4. **Under 900**, at 800x1100 in both palettes: the stack is banner,
   header, chip row, grid, cart, bar in DOM order; scrolled to the end
   the bar's top is 1007 and the ticket's bottom 995, so the last row
   and the totals are clear of it; in pay mode Comp ends at 631 against
   the bar's 1007 at the top of the scroll and the ticket's bottom is
   995 at the end; a Credit + Cash $300 charge completes with the done
   block and its change line.
5. **Tile icons dropped**, and the three icon components with them;
   the tiles are the name and the reason, as 1a draws them. The
   header's credit pill was already text.
6. **Contrast.** Light `--disabled-ink` is `#5f5749` (the canvas's
   darker muted, the shelf price's colour): 4.59 on `--disabled-bg`,
   from 3.10. Dark stays `#9b9284` on `#2c2b26`, 4.62. Light `--muted`
   on `--bg` stays the canvas's 4.34 (4.73 on `--surface`, where nearly
   all of it sits); recorded, not changed.
7. **The cue** reads `1 more below · 9 items`: the cue, a muted
   separator, the count at the right edge where it always is.
8. **Frame by frame at 1366x1024** against 1a and 1b (the PDF's pages 1
   and 2, rendered; the canvas itself needs a CDN the sandbox has not
   got): shelf with the seven-line cart and Liquid IV selected, pay
   mode with Credit + Cash and a Change figure, the keypad at $300.00,
   the done block. Two drifts fixed: the header's Back had the close X
   where 1a draws a left arrow (now the bar's Back to items glyph), and
   the tile icons above. Left, each deliberate: the favourite star on
   cards (a function the canvas has not got), "no tax" beside pass
   prices, `$` on cart line amounts, the item count on the bar
   (decided), the 16px banner.
9. `npm run typecheck` and `npm run build` clean.

Also recorded: T38's cue counts rows below the visible edge only. With
a lower row selected the box scrolls to keep it in view, and rows past
the top edge have neither cue nor fade (seen at 1080x768 with the last
line selected). Left as T38 has it.

**T39.9, what the roster inherits.** The accent already travels through
the token. The header shape: the Buy header is a 76px row (title, the
client card taking the slack, Back outlined at the right edge) and the
roster's is a 71px row (the class as its own dropdown, Buy, the three
counters at the right edge), both on 64px controls at radius 12 on
`--surface`, both under the mode banner; they read as siblings in both
palettes (`roster-*-header.png`, `roster-*-buy-header.png`) and nothing
was moved. The badge idiom: `.bal-chip` is one rule (the ok pair, mono,
tabular, the stop pair when owed), the Buy header's credit pill; the
roster's balance column stays a plain tabular figure per T14 (a pill on
every row would zigzag the column edge), and the M chip is a membership
marker in the accent pair, not money. Tabular figures where money
appears: `.cell-bal`, `.bal-chip`, `.amt`, the bar's amount, the three
figures, all `tabular-nums`. Not inherited: the bar, the
select-to-reveal rows (T14 stands), the two modes, the 1400 shell. The
roster stays at 1100, which is the answer to layout plan question 9.
Documents: the implementation plan is marked implemented with a section
6 of deviations, the layout plan's Status points at it as the newer
document, and PLAN.md and CLAUDE.md describe neither the Buy screen's
layout nor the Charge button's position, so there was no sentence to
correct.

### Review (separate reviewer), T39.8-9 and the whole

Cycle 4 read against f1b510b and 030097f, then everything since 2abed48
run with the API mocked in Playwright (the reviewer's `scratchpad/
t39-4r.js` over the implementer's fixture, plus a roster fixture with a
checked-in row carrying a balance, a member, an unpaid row, a no-waiver
row owing money, and a last-session row), both palettes, shots under
`scratchpad/t39-4-review/`. One fix, one pre-existing bug recorded, the
rest measured and left.

- **The rail's `::before` was live in the chip-row fold.** The 64 pitch
  is the column's; under 1040 the same element wraps on 8px gaps, and
  the reach only stretched into the header's margin and the row gap
  (measured: 2px of each 8px row gap went to the upper chip, 3 to the
  lower, the rest to the rail; nothing was mis-captured, so not a bug
  in behaviour). It is now `display: none` inside the 1040 query, where
  the notes said it should be. Re-measured: every row-gap pixel hits
  the rail, the horizontal gaps likewise.

The rail, measured in the column at 1080x768, 1180x820 and 1366x1024:
entries 60 tall on a 64 pitch, active fill 60 (the pseudo-element paints
nothing), `scrollHeight` equal to `clientHeight` at every size (508 in
543 at 768). Every pixel of every 4px gap returns an entry from
`elementFromPoint`, never the rail; a click 1px under an entry's edge
activates that entry, a click 1px over the next activates the next. The
split is not the 2/2 the notes describe: with the rail at a fractional
top (120.39) the upper entry keeps about 1px of the gap and the lower
takes about 3, so each entry's target is 63 to 64, and the first entry
reaches 1px above the rail into the header's margin (nothing there) and
the last 2px into the rail's own foot. Keyboard focus (Tab from Back)
draws the UA ring whole on the first and last entries in the column and
on the bottom row of the fold (`rail-*-kbfocus-*.png`); nothing clips
it because the rail has no padding to clip against and the pseudo does
not affect the outline.

The `sale-open` class: on the body while the overlay is open and gone
after Done on a paid sale, Escape and the header's Back (`body.className`
empty each time, the pill back at the right edge), and the effect's
cleanup runs on unmount by React's contract, which covers the lock
screen and an error unmount. With it on, the pill sits centred in the
bar with `.sale-bar-in` on all three sides at 1080, 1180 and 1366 in
shelf, pay and done; at 800x1100 with an empty cart the pill floats
below the bar, since the sticky bar sits at the end of content shorter
than the viewport (bar 926 to 1019 in 1100), which is the narrow fold's
own pre-cycle behaviour and not the pill's.

The 768 cuts: the banner is 32px, 16px, the overlay's full 1080 width
and one line in all six states (dry run on sandbox and prod, live on
both, write-guarded with two ids, a config error), both palettes
(`banner-*.png`). At 1180x820 with a twenty-line cart the head is 41px
and reads `TICKET` at 837 to 906, `11 more below` at 935 to 1054, the
separator, `20 items` ending at 1143 inside the 340 cart, no wrap, no
overlap; with Liquid IV selected the controls are 64 with `margin-top:
6px` and the cue reads `12 more below`. The totals rows are 16px at
24px (1.5). A target audit of every button, `role="button"` and input
in the overlay at 1080x768 in shelf, pay and keypad found nothing under
64 beyond the recorded 44s (the detach x, the card stars, the 44px cart
rows) and the 60px rail entries on their 64 pitch.

The whole redesign, both palettes at 1366x1024 (`app-*.png`): the
roster with checked-in, check-in, unpaid, no-waiver and negative-balance
rows, the M chip and the last-session badge; the class dropdown; the
search modal with results; the attach modal before a search and split
into the class's rows and Other matches; the waiver prompt and the
waiver text with its disabled confirm; the dev drawer's calls and
settings tabs; the studio banner; the contract dialog with its
no-card warning; the cart-change confirm over a selected row; the lock
screen empty and with two dots. Every pair reads on its ground; the
computed colours of `.chip.in`, `.chip.unpaid`, `.chip.stop`,
`.cell-bal.neg`, `.m-chip`, `.banner` and `.studio-banner` are the
palette's tokens; the two `theme-color` metas are `#f6f3ec` and
`#131311`, equal to `--bg` in each block; no hex outside the two palette
blocks in the CSS and none in a component (the `#` hits in
`SaleScreen.tsx` are HTML entities).

**Pre-existing, not the redesign's:** on a checked-in row with a
balance the `checked in` chip (120px at 16px/600) is 16px wider than the
104 the actions column budgets, and its left edge covers the last digit
of the balance (`$40.0` with the `0` under the chip). Measured
identical at 2abed48 and HEAD in both palettes at 1366, 1180 and 1080
(`roster-base-*.png`, `roster-head-*.png`: chip left 924, balance right
928 at 1366), so it predates T39 and is left for its own ticket rather
than fixed in a review commit.

Documents: section 6's deviations spot-checked against the code (the
rail 60/4 with the `::before`; the head 10/16/8; the totals rows
16px/1.5 and the block 10/16/10; the lines padding 6 and the controls
6 under the line; light `--disabled-ink` `#5f5749`; the 1190 query; the
header's arrow; the item count on the bar) and all match, with the
rail's gap split corrected above. The T39 checklist is fully ticked;
the layout plan's Status names the implementation plan as the newer
document; no em dashes and no model identifiers in the diff since
2abed48 beyond the commit trailers. `npm run typecheck` and `npm run
build` clean; `git diff 2abed48..HEAD -- src/app/api src/lib` is empty.

Left as it is: the attach modal shows "No current passes" for roster
rows (T32's `rosterAsResult` carries no pass), which predates the
cycle; the light lock screen's disabled Unlock is the accent at reduced
opacity with `--accent-ink`, the same idiom as before the retheme.

## T38. The cart: more rows, an estimate while pricing, the audit, and a way out (Pete, 2026-08-31)

Four things from the fifth live test, all on the receipt side of the Buy
overlay. Pete:

1. "the cart only shows a max of 4 rows, then i can't see what else is
   put in there."
2. "I think loading items to the cart should optimistically be added.
   currently it's a bit slow due to the network request being awaited."
3. After the $130.20 (ours) against $258.85 (Mindbody) stop, whose cause
   was never found: "there needs to be a way out for the teacher if this
   ever happened. A reset, or a way to match the cart to mindbody and
   inform the teacher of the change. either way we need a clear button
   for the cart."
4. Commit 891190b had already taught `/api/price-cart` to return a
   per-line `lineAudit` when the totals disagree, so the stop could say
   WHICH line; nothing on the screen rendered it.

### What was built

All in `src/app/SaleScreen.tsx` and `globals.css`, plus one read added
to `/api/config`. `/api/price-cart`, `/api/checkout` and `src/lib` are
untouched. Typecheck and build clean; no live run in this container.

**A. More rows, and the scroll is announced.** The `.t-lines` cap was
`min(34vh, 320px)`, which at ~86px a row is the four Pete saw, and
nothing said the box scrolled. Now `min(44vh, 540px)` over rows trimmed
to ~74px (the stepper row's paddings, not the 44px steppers): about six
rows on a 1024px-tall iPad, five on an 820px one, with the ticket and
Charge still fitting the taller screen for any cart length (the overlay
scrolls on the shorter one, as it did before; the row cap was already
past that screen's budget). The clipping is now visible two ways: a
fade in the ticket's own surface over the clipped edge (`.t-lines-wrap
.more::after`, a gradient to `var(--surface)`, so it is the dark
surface in the dark palette), and a foot row under the lines reading
"N more below" while rows are hidden, or "N items" when none are. The
count is measured off the DOM on every cart change, scroll and resize.
The cap was not removed: with it gone a long cart pushes Charge off the
screen, which is the second live test's bug coming back.

**B. An estimate while Mindbody prices.** The 400ms debounce and the
`/api/price-cart` round trip used to show only the spinner. Now the same
Subtotal / Tax / Total rows render from what the browser already holds
(each cart line's shelf price, exemption and own tax rate), muted, with
the total row labelled "Estimated" and the spinner line "Pricing with
Mindbody..." under it; the server's rows replace them when they land.
The one number the browser can lack is a rate for a line the catalog
returned none for, and for that `/api/config` now carries
`studioTaxRate`, mirrored from `STUDIO_TAX_RATE` in `src/lib/sale.ts`
(a read; the constant did not move). With no fallback in hand (config
not loaded yet) the estimate stops at the subtotal and shows tax as
"pending"; no rate is invented in the component. The arithmetic is
`expectedTotal`'s (per-line rate, one round at the end, the same
`roundToCents`), so the estimate and the server's assertion agree to
the cent when the catalog is current. The debounce, the generation
guard and the abort-on-change behaviour are exactly as they were; the
`needsClient` estimate branch is untouched.

*Tender taps mid-estimate, the decision:* the sources stay GREYED while
the estimate is up, with the reason "Pricing with Mindbody...". A tender
line pre-fills from `dueCents`, which is null until the server answers
(`total` in PaymentPanel already required `!pricing`), so `addLine` was
a no-op mid-pricing anyway; the change is only that the reason names
the wait instead of "No total to pay yet". The alternative (add the
line and recompute when the price lands) was rejected because a line
carrying an estimated figure exists for however long Mindbody takes,
and if the server's total came back different the line would be the
stale amount the cart-edit reset exists to prevent. Greyed cannot leave
a stale amount; recompute could.

**C. The audit table.** Inside the disagree stop, after the "Do not
charge" sentence, `totals.lineAudit` renders as a three-column table:
the line (our shelf name; Mindbody's name under it when it differs),
Ours (price x quantity, then the rate or "studio fallback rate", and
the extended figure), Mindbody (price, quantity, rate). Any figure that
differs from ours takes the stop colour, and a line with no Mindbody
side at all reads "no line matched: Mindbody priced something else",
which is the loudest finding the audit can make. 16px, tokens only,
scrolls sideways in its own box. `PricedResult` and a `LineAudit`
mirror were added to SaleScreen for it.

**D. The way out.** Two controls.

- **Clear cart** sits on the foot row under the lines whenever the cart
  holds anything, in every totals state, not only inside the stop. It
  confirms in the cart-prompt dialog's idiom ("Clear the cart?", the
  item count, "<name> stays attached", Keep items / Clear cart with the
  stop pairing on the confirm). Scrim and Escape keep the items; only
  the confirm button empties, and it calls `emptyCart` exactly (cart,
  priced, priceError, cartResetNonce, so the tender resets too).
  Disabled mid-charge like every other cart-changing control.
- **Recheck prices**, in the stop only. `GET /api/catalog?refresh=1`
  (past the ten-minute shelf cache), then every cart line is rebuilt
  from the fresh item with the same type and id, keeping its quantity,
  and `setCart` hands the result to the ORDINARY pricing loop: the
  debounce, the POST, the generation guard. There is no second pricing
  path. The fresh catalog also replaces the shelf, so re-adding a line
  cannot bring the stale card back. A report renders above the totals
  area, keyed to the cart array the recheck produced (any later edit
  retires it without a clearing call): per line "<name>: $X is now $Y";
  a line whose id the catalog no longer has is dropped and named ("<name>
  is no longer in the catalog and was removed", shown on the empty
  ticket too when it was the last line); nothing changed reads
  "Rechecked against the current catalog: no price changed."; a failed
  fetch reads "Recheck failed: ..." and leaves the cart as it was. If
  the fresh price still disagrees the stop stands, table and all.

### What must not change

- **Neither control weakens the stop.** Charge is disabled while
  `disagrees` is true (`total` is null in PaymentPanel for a
  disagreeing, suppressed or in-flight price, and `chargeable` requires
  it), and only a fresh server price that agrees lifts it. Recheck can
  only ever produce a new cart for the same loop to price; Clear can
  only empty.
- **The estimate is never chargeable and never a total.** It renders
  only while `pricing` is true, in muted rows labelled "Estimated", and
  the payment seam cannot read it: `chargeable` still requires
  `!pricing && priced && !suppressed && !disagrees`, the sources grey
  with the reason, and the due reads "--" until Mindbody answers. The
  browser's numbers are never sent anywhere but as the assertion inputs
  they always were.
- `studioTaxRate` on `/api/config` is a mirror of the server constant
  for display. Nothing prices from it; `expectedTotal` on the server
  still reads `STUDIO_TAX_RATE` directly.
- The debounce, the single flight, suppression-is-not-success, and the
  server's authority over every number are exactly as T35 and T36 left
  them.

### Review (separate reviewer)

The estimate was checked by hand against `expectedTotal` for a single
taxable item, two of a $1.81 item at 10.35% ($3.99 both ways), and a mix
with a rateless line at the fallback, an exempt line and a 13% line
($45.84 both ways): same per-line rate source, same single round at the
end. `studioTaxRate` is null on the lock screen's trimmed answer and the
trimmed answer carries nothing new. The estimate is not passed to
PaymentPanel at all; `total` there is null while `pricing` is true, so
the sources grey with the wait and Charge cannot enable. Recheck keeps
each line's `key` and quantity, hands the rebuilt array to the ordinary
loop (new generation, new debounce, the cart-edit reset clears any
tender), retires its report on the next edit by array identity, and
cannot lift the stop itself: the old `priced` still disagrees until the
fresh POST lands, so `total` is null throughout. Clear cart calls
`emptyCart` exactly and only from the confirm button; Escape and the
scrim keep the items, and the overlay's Escape guard includes the
prompt. The hidden-row count re-measures on every cart change (quantity,
Clear, Recheck, the last hidden row removed), on scroll and on resize,
with the listener removed on cleanup; the fade is `var(--surface)` in
both palettes. One fix:

- **The audit did not colour the one rate mismatch it was built for.**
  `rateOff` compared Mindbody's rate to ours only when ours was a real
  catalog rate; for a line the catalog carried no rate for, ours renders
  as "studio fallback rate" and the comparison was skipped, so a 13%
  against the 10.35% fallback (the second live test's exact finding)
  showed Mindbody's rate in plain ink. It now compares against
  `config.studioTaxRate` when the line has no rate of its own, and stays
  uncoloured only when there is no fallback in hand to compare with.
  Display only.

Checked and deliberately left: the recheck report says "no price
changed" when only a line's tax rate or exemption moved (the line is
still rebuilt from the fresh item and repriced, and the stop's own lift
or the audit table is what says so); a recheck that drops every line
leaves an armed comp standing on an empty cart, as removing the last
line with its x always has, and comp cannot charge without a total; a
double tap on Recheck before the disabled state paints could fire the
refetch twice, which costs four reads and changes nothing on Mindbody's
side. Not verifiable here: whether `/api/catalog?refresh=1` returns a
changed price in practice, and the audit table against a live disagree.

## T40. Cancelled classes listed, and the class window seven hours ahead (Pete, 2026-09-02)

Pete's live dev log at 10:34Z (3:34am Seattle): the header and the class
dropdown listed thirteen "Hot 26 & 2 ... TBA ." classes at 9:00 and 9:30.
Two defects in one screenshot.

- **Cancelled classes were listed as real.** Every one of the thirteen
  carried `IsCanceled: true` with staff "TBA ." (id 100000086, last name
  ".") and `TotalBooked: 0`, and `/class/classvisits` for one answered
  with staff "Class Cancelled" (id -1). `classesBetween` never read the
  flag. It now drops cancelled classes; when the whole window is
  cancelled the screen shows its existing "No classes" line.
- **The window went out as UTC.** `toISOString()` sent `08:34Z` to
  `14:34Z`, which is 1:34am to 7:34am Seattle, and Mindbody answered with
  9:00 classes: it reads a datetime's digits as site-local and ignores the
  offset, the same convention its responses use (the T27 review's
  `parseRosterAnchor`). Both windows (around-now and the whole day) now
  send naive studio wall-clock strings via `studioWall`.
- Teacher names drop parts with no letter or digit, so a placeholder
  staff record renders as "TBA", not "TBA .".

- Pete's next screenshot, with the real classes showing, had them in
  Mindbody's order (12:00, 7:00pm, 8:00am, 5:00pm). `classesBetween` now
  sorts by `startsAt`.

Not verifiable here (no credentials in the container). Pete: reload at a
studio hour and confirm the dropdown shows the classes actually around
now, and that a genuinely cancelled class is absent.

## T41. Buy screen tweaks from the first live pass (Pete, 2026-09-02)

Pete ran the redesigned Buy screen against production Mindbody under dry
run and listed five things. Each below in his words, then what changed.

- [x] **Cart row controls only on tap.** "the 1/+/Remove buttons should
  not be visible unless I tap on that item. Currently there is always a
  row that has those buttons visible at all times." T39.4 had `addItem`
  and `addBundle` select the line they touched, so the cart never had a
  quiet state after the first tap. Neither selects anything now: only a
  row tap does, a shelf tap leaves the selection where it is, and
  remove/empty still clear it. The T39.4 review's scroll-into-view
  stays for the tapped row (a visible row can still push its own
  controls under the edge). Harness: after seven shelf taps `.t-row.sel`
  is 0; after a row tap 1; after another shelf tap still 1 on the same
  row.
- [x] **Trash icon for Remove.** "instead of 'Remove' use a trash can
  icon". A 64px square, the stop outline the word had, holding the
  roster's trash glyph (the same path as page.tsx's `TrashIcon`, copied
  since page.tsx was out of scope), `aria-label="Remove <item> from the
  sale"` and `title="Remove <item>"`. Tokens only; nothing under 16px
  was touched.
- [x] **Empty categories.** "not sure why there are no items in 'Towel
  and Mat' ... when a category has no items it should not even display
  in the UI as a button at all." Two changes and a finding, below.
- [x] **Anonymous sale.** "even though the search modal says 'Search for
  the client the sale is for, or close to sell anonymously.', i am
  unable to enter the Pay screen if no one is selected". See below.
- [x] **Client profile data layer.** "there should be a profile icon and
  when i click it, a modal with the same basic info as the mindbody
  client-info page should show". The read and the card are built; the
  icon and the modal in page.tsx are the next agent's.

### Towel and Mat: why it was empty

Towel and Mat is Mindbody category **-14**, and the design doc's
category dump marks it `Service: true`. `/api/catalog` fills a category
button by filtering `GET /sale/products` on category ids, and a service
category never matches a retail product: `/sale/products?categoryIds=-14`
is empty by construction. The rentals ($2.72 towel, $2.72 mat, the
design doc's top sellers) are pricing options, which the route fetched
from `GET /sale/services` and lumped wholesale under Passes.

Checked against the vendored spec (`sale.yml`, the `Service` model at
5197): a pricing option carries **no category id**. Its
category-shaped fields are `ProgramId` (5216, "the program that this
pricing option applies to"), `RevenueCategory` (5270, a string: "the
revenue category of the pricing option") and `MembershipId` (5290).
There is no `CategoryId`, `ServiceCategoryId` or `SubCategoryId` on a
Service, and `/sale/services` filters only by `classId`,
`classScheduleId`, `programIds`, `sellOnline` and the usual paging.
`/site/categories` returns revenue categories (`Category.CategoryName`,
site.yml:2248), so the name is the one handle both sides share.

Built on that: `pricingOptions` keeps `RevenueCategory` on each
`CatalogItem` (`revenueCategory`, null for products and packages);
`categories.ts` gives Towel and Mat `revenueCategories: ["Towel and
Mat"]`; `/api/catalog` stamps a pass whose revenue category matches a
counter category's name (case-insensitive) with that category's id.
Every pass still rides the `passes` array in the same shape; the screen
reads `categoryId: null` as Passes and anything else as that category's
shelf, alongside its products (`categoryShelf` in SaleScreen). **Not
verified live**: whether the studio's rental options carry the revenue
category "Towel and Mat" exactly is a question for the dev drawer's
`/sale/services` body on Pete's next run. If they carry something else,
add that name to `revenueCategories`; until then the button simply does
not render, because of the second change:

**The rail renders only categories whose shelf has something to sell.**
`shownCategories` filters the config list against the loaded catalog;
Favorites keeps its own rule (always rendered), and Packages and
Memberships already hid when empty (T30). Nothing hides while the
catalog is loading, since the rail does not render until it lands. The
default chip is the first category WITH a shelf, and an active category
that loses its last item on a recheck falls back the same way rather
than leaving a selected button the rail no longer shows. Harness: with
Accessories emptied and two rental services routed to Towel and Mat,
the rail reads Favorites, Towel and Mat, Food/Drink, Passes, Packages,
Memberships, Clothing; the Towel and Mat shelf lists the rentals with
the studio mat and towel, and Passes no longer lists them.

### Anonymous sale: what was actually wrong

Mindbody prices and charges nothing without a client (confirmed live
2026-08-30, T24), so an unattached cart rides `POS_HOUSE_CLIENT_ID`:
`/api/price-cart` substitutes it, and answers `needsClient` without a
Mindbody call when it is unset; `/api/checkout` refuses with a 409
naming the variable. Pete's server has it unset, so the estimate
rendered, Pay stayed disabled, and the attach modal's footer promised
"close to sell anonymously" all the same.

- `GET /api/config` now reports `houseClient: boolean` (never the id),
  on the authenticated answer only.
- With it set, nothing changed and nothing needed to: the unattached
  cart prices and Pay enables like an attached one; in pay mode Cash is
  live, Card is greyed "Attach a client", Credit is not offered (no
  balance to offer), Comp is available. Screenshots
  `unattached-house-set-*`.
- With it unset, the totals area says in one line: "Anonymous sales
  need POS_HOUSE_CLIENT_ID set on the server; attach a client instead."
  (`NEEDS_HOUSE_CLIENT_LINE`, exported). The bar's reason reads "No
  house client for an anonymous sale; attach a client". Pay stays
  disabled exactly as before.
- `attachSearchHint(config)` is exported from SaleScreen for page.tsx's
  attach modal: the anonymous promise only when `houseClient` is true, a
  sentence naming the variable when false, and no promise before config
  loads. **page.tsx still renders the old sentence** (line ~4342) until
  the next agent wires it; the harness confirms the mismatch persists in
  the unset state for now.
- Money path untouched: `/api/checkout`'s refusal, `priceCart`, the
  tender model and every request shape are as T35 left them.

### Client profile: the data layer

Pete's Mindbody client-info page shows phone, email, visits with the
join date, the client id, the waiver with its date, the last visit
(class, date, time), membership status, and each pass with sessions
remaining and expiry. `GET /api/client-profile?clientId=`
(`requireSession`, read-only, 502 on a whole-read failure like
`/api/stored-card`) returns a `ClientProfile` (`src/lib/clientprofile.ts`)
from three parallel reads, each optional via `Promise.allSettled`: a
failed sub-read leaves its section null and names the reason in
`errors.{client,visits,passes}`.

- `/client/clients?clientIds=` (the spelling the roster verified live):
  name, Email, MobilePhone else HomePhone else WorkPhone, UniqueId as
  `mindbodyId`, CreationDate as `joined`, FirstClassDate, Status,
  MembershipIcon as `member`, Liability {IsReleased, AgreementDate},
  RedAlert, YellowAlert, Notes.
- `/client/clientvisits?ClientId=`: `StartDate` ten years back and
  `EndDate` now, both as studio wall-clock strings (`studioWall`, now
  exported from roster.ts; the spec defaults StartDate to the END date,
  and T40 showed Mindbody ignores an offset). `Order=desc` per the spec
  (1879) and the page sorted again locally in case it is ignored; the
  count is `PaginationResponse.TotalResults` (6734), falling back to the
  page length; the last visit is the newest non-missed, non-late-
  cancelled row.
- Passes reuse `fetchPasses` from clientcontext.ts, spill guard
  included; not duplicated.

`ClientProfileCard` (`src/app/ClientProfileCard.tsx`, props `profile`,
`loading`, `error`) renders it in the Buy header's card idiom (`.sale-for`
shape: bordered surface, muted uppercase label over 17px values), with
the red alert in the stop pair and the yellow in warn, an unsigned
waiver in the warn pair, passes as "4 of 10 left, expires Sep 2, 2026"
or "Unlimited". Dates are rendered digit for digit from Mindbody's
site-local strings (`wallDate`, `wallDateTime`, exported), never through
`Date`, so the iPad's zone cannot shift a 9:00 class. Every colour a
token in both palettes; 14px only on the label, the recorded exception.
Not screenshotted: nothing mounts it until page.tsx does.

### For page.tsx (next agent)

Imports: `attachSearchHint`, `NEEDS_HOUSE_CLIENT_LINE` and `ModeConfig`
(with `houseClient`) from `./SaleScreen`; `ClientProfileCard`, `wallDate`,
`wallDateTime` from `./ClientProfileCard`; `type ClientProfile` from
`@/lib/clientprofile`. The profile icon belongs beside the attached
name in the Buy header (SaleScreen's `.sale-for.attached`), left for the
same commit as the modal so the icon never opens nothing; fetch
`/api/client-profile?clientId=` on open, not on attach, since it is
three metered reads.

Verified: `npm run typecheck`, `npm run build`; the Playwright harness
(`scratchpad/t41.js`, mocked API) at 1366x1024 in both palettes: the
cart with no row selected and one selected, the rail with Accessories
hidden, the unattached cart with and without a house client, and pay
mode with one. Not verified live (no credentials here): the revenue
category name on the studio's rental options, and the visits
endpoint's `Order` parameter.

### Follow-up from the live pass (2026-09-02)

Pete: "there is no Towel and Mat visible at all". The guessed revenue
category name did not match, so the shelf was empty and the rail hid it.
The studio's items are "Mat Rental", "Towel Rental" and "Mat & Towel
COMBO" (ai-manager's sales table; the $2.72 on the shelf is the $3.00
rental before tax). `nameMatches` on the category (`rental`, `towel`) now
routes a pricing option by its name as well, so the shelf fills whatever
the revenue category says. Still worth reading the real
`RevenueCategory` off the dev drawer's `/sale/services` body once, so the
name match becomes the fallback rather than the rule.

### Review (separate reviewer), T41

Read the five commits against 60cc7db, ran the harness (mocked API) at
1366x1024 in both palettes (`scratchpad/t41-review/`), rendered the
card with react-dom/server, and drove `clientProfile` with a stubbed
`mindbody()`. Two real bugs, both in the profile read, both fixed here;
everything else NOT A BUG.

- **REAL: the route's 502 could never fire.** `/api/client-profile`
  promises a 502 "when the whole read fails", but `clientProfile` ran
  the three reads under `allSettled` and never threw, so a dead token
  or a wrong site came back 200 with every field null and three
  `errors`, which the card renders as a client with nothing on file
  ("Not on file" six times). Sequence: dev server with no Mindbody
  credentials, `GET /api/client-profile?clientId=100000123` answered
  200 before, 502 with the reason after. Three refusals now throw;
  one or two still answer 200 with the section null and named.
- **REAL: the last visit trusted `Order=desc`, which the ticket itself
  marks unverified.** The window is ten years at 200 rows a page, and a
  regular has more than 200 visits; had Mindbody ignored the parameter
  and sent the oldest page, sorting it locally would have reported the
  newest of the OLDEST 200, a "last visit" years stale, with nothing to
  say so. Fixed off the page itself: when the first row is older than
  the last (ascending) AND `TotalResults` exceeds the page, the tail
  page (`offset = total - 200`) is read and merged before the sort. A
  page that arrives newest-first costs no extra call. Stubbed: an
  ascending page of 2017/2018 rows with TotalResults 350 now reads
  offset 150 and answers Aug 30 2026 (skipping a Missed row); a
  descending page makes one call.

NOT A BUG, checked:

- Money path: `git diff 60cc7db..HEAD -- src/app/api/checkout
  src/app/api/price-cart` is empty; `sale.ts` adds only
  `revenueCategory` to `CatalogItem` (three constructors, null for
  products and packages). `houseClient` is `houseClientId() !== null`
  on the authenticated answer only; a PIN-locked server on 3001
  answered `/api/config` without the key. The Charge body still sends
  `...(clientId ? { clientId } : {})`; the server substitutes.
- Routing: `routeServices` trims and lowercases both sides, stamps
  `categoryIds[0]`, leaves an unmatched or null `RevenueCategory` at
  null (Passes), runs before the cache is filled so `?refresh=1` and
  the TTL are as before. `categoryShelf` puts a routed pass on exactly
  one shelf (harness: Towel and Mat lists the rentals, Passes does
  not); starred items and the bundle resolver read `allItems`, never
  `categoryId`, so a starred rental still shows on Favorites. The
  harness's Towel shelf listing each rental twice is the fixture, whose
  products already carry a "Mat rental" and "Towel rental" in category
  1, not a double count.
- Hidden categories: the rail renders only under `catalog &&
  !catalogLoading && !catalogError`, and `shownCategories` is a
  `useMemo` on `catalog`, so the fallback effect runs per catalog load,
  not per render; a null `activeCat` still takes Favorites first
  (T27), and Favorites, Packages and Memberships keep their own rules.
  `passesIdx` of -1 appends the extras. `more` counts `all`, built
  from the shown list.
- Selection: `addItem` and `addBundle` no longer call `setSelectedKey`;
  `removeLine`, `emptyCart` and the Pay tap clear it; the scroll-into-
  view effect's deps are `[selectedKey]` alone. Harness: 0 selected
  after seven shelf taps, 1 after a row tap, still that row after
  another shelf tap. Trash button 64x64, `--stop` outline, aria-label
  "Remove Liquid IV from the sale", title, SVG 22px.
- Anonymous: unset gives Pay(off), the totals line naming the
  variable; set gives Pay on, Cash live, Card "Attach a client", Comp
  as the hold in the footer (it is not a tile). `chargeable` is
  computed where T35 left it; the flag only feeds copy.
- Profile card: renders sanely with every field null (six "Not on
  file", no passes, no crash), with a full profile, loading and error.
  `wallDateTime` gives 12:05am and 12:30pm at the day's edges. No PAN
  anywhere in `PassInfo` or `ClientProfile`. Tokens only, both
  palettes; 14px on the label only; no em dashes.
- `/client/clientvisits`: the spec names `request.startDate`,
  `request.endDate`, `request.order`, `request.limit`; the bare names
  are the idiom `fetchPasses` verified live on `/client/clientservices`.

Verified: `npm run typecheck`, `npm run build`, the harness in both
palettes, and the two stubbed sequences above.

## T42. Attach modal redesign, walk-in search rows, client profile (Pete, 2026-09-02)

Pete reviewed the app live and listed changes to the Buy screen's
"Attach a client" modal, the check-in screen's walk-in search, and asked
for the profile modal T41 built the data layer for. His words, then the
design he approved ("go with that filter design"), then what landed.

### Pete's items

Attach modal:

- "when i search for a client to sell to, it looks like there's only one
  page of responses we should lazy load as the user scrolls"
- "if the user searches and then clicks X to clear the search bar, the
  search results should disappear. currently they stay visible"
- "the list of clients in a class should be in alphabetical order"
- "the M/i/signed-up pills should all be lined up vertically in the list"
- "when i type a name in and click search, the modal temporarily shrinks
  vertically while the request is made. should stay the same size always"
- "there should be a row of filters. In class should be one of them. when
  In class is selected, there should be more filters: all, signed-in,
  not-signed-in ... the class drop down can be more narrow and these can
  be to the right"
- "when in class is not selected, the class selector dropdown and its
  filter buttons should be greyed out"
- "since we can have duplicate names, we should optionally display email
  and phone in small text (mindbody does this already). we can do this by
  getting rid of the M/i/waiver text and placing it there"
- "tapping on the row at all should select the client. remove the
  checkmark-person icon"
- "if i type a name with in class filter selected, the results should be
  search results that only match students in the class (and all other
  filters that are on)"
- "in class with the current class should be the default when i first
  click on Attach a client and I land on this. I should see a list of all
  clients for the current class"
- "don't need all the info here. waiver is irrelevant."

Walk-in search (check-in screen):

- "when i search for a client, the buy icon should not be in the results
  list"
- "remove the + icon and make the whole row clickable"

Profile:

- "there should be a profile icon and when i click it, a modal with the
  same basic info as the mindbody client-info page should show"

### The decided design

- Search box on top as before (Enter or Search; the X clears the query
  AND the results). Under it a filter row: an `In class` toggle (64px,
  accent-filled when on), ON by default with the roster's current class;
  the class dropdown narrowed to about half the row with a three-segment
  control to its right (`All`, `Signed in`, `Not yet`, icon plus label,
  64px, one active). With `In class` off, the dropdown and the segments
  render greyed and disabled together.
- `In class` on, no query: the class roster, alphabetical by last name
  then first, cut by the segment (signed in = `checkedIn`; not yet =
  booked and not checked in). With a query: the same list filtered
  locally, case-insensitive on the name, no Mindbody call, no
  three-letter minimum.
- `In class` off: a query searches everyone through `/api/search`; no
  query shows only the hint.
- Rows: name (20px/600 as the modal's rows already were), a small muted
  email and phone line (14px, the recorded metadata exception) on SEARCH
  rows only; class rows show only what the class says, a `signed up` /
  `checked in` chip, in a fixed grid column so the chips line up. No M,
  no info icon, no waiver, no pass cell. The whole row is the tap target
  (64px+, `role="button"`, aria-label "Attach NAME"); the person-check
  icon is gone.
- Lazy loading: `/api/search` accepts `offset`; the modal loads a page
  of 20 and fetches the next when the list scrolls near its end, stopping
  on a short page or at `TotalResults`. One metered call per page, no
  prefetching beyond the page the scroll asked for.
- Stable height: the rows region is a fixed height (about five rows,
  scrolling), so the modal keeps its size while a request is in flight;
  the previous rows stay, dimmed, under a quiet "Searching..." line.
- Footer sentence: `attachSearchHint(config)` from SaleScreen.
- Walk-in search rows get the same treatment: name plus the contact
  line, a chip only for someone signed up, checked in or on the waitlist
  for the ACTIVE class, no M/info/waiver, no Buy bag; the whole row is
  the add, with the T19 waiver gate, the unpaid confirm and the full-
  class waitlist confirm exactly as the "+" had them; the per-row outcome
  text stays. The roster list itself is unchanged (T14's columns stand).
- A 44px profile icon on roster rows (actions cell) and at the right
  edge of search rows opens a modal that fetches `/api/client-profile`
  and renders `ClientProfileCard`; Escape and the scrim close it; it
  stacks above the search modal.

### What was built

- [x] **Paging** (`src/lib/clients.ts`, `src/app/api/search/route.ts`):
      `search(query, limit, offset)` sends `/client/clients`' own
      `offset` (client.yml:1392) and answers `total` from
      `PaginationResponse.TotalResults` (client.yml:6753), null when
      omitted. Each result carries `phone` (Mobile, else Home, else
      Work, the order clientprofile.ts reads them). Every page is one
      metered call.
- [x] **The scroll-loaded list** (page.tsx `fetchSearchPage`,
      `loadMoreResults`, `searchPage`): a sentinel at the end of the
      list (`.attach-more`) under an IntersectionObserver; the next page
      appends, de-duplicated by id in case a client created between two
      pages shifts Mindbody's offsets; a short page or the total reached
      ends it and the sentinel unmounts. One `AbortController` covers
      the query and the pages: a new query, the X, the close and the
      toggle coming back on all abort whatever is in flight, so a late
      answer can never land under the wrong query. Harness: "wan" with
      45 matches loaded 20, 20 and 5 across three calls as the region
      scrolled, then nothing more. The walk-in search pages the same
      way at its own `searchLimit` (12): 12 then 12 more on scroll.
- [x] **The X clears results with the query** (`clearSearch`), in both
      search bars. T32's "clearing the box leaves the results up" is
      reversed here on Pete's instruction.
- [x] **The filter row** (`attachInClass`, `attachSeg`,
      `toggleAttachInClass`): the toggle, the narrowed dropdown, the
      segment. Off greys both (opacity on the group, `disabled` on the
      controls). Toggling ON drops the search and shows the roster
      again; toggling OFF with a query of three letters or more already
      typed searches everyone at once (one call), with fewer letters it
      says so under the bar rather than making a call that would be
      refused anyway.
- [x] **In-class rows**: `byLastThenFirst` sorts; the segment and the
      typed query filter in memory as the teacher types (Enter does
      nothing with the toggle on, deliberately, since there is nothing
      to fetch). Harness: 30 booked, `Signed in` shows the 10 checked
      in, `Not yet` the 20 others, "wan" typed shows the class's five
      Wangs with zero search calls. The pass sweep no longer runs for
      attach-mode results, since the rows have no pass cell to fill.
- [x] **Stable height**: `.attach-rows` is `height: min(46vh, 420px)`
      (420 at 1366x1024), the modal measured 679px tall before, during
      and after a search. The last rows dim (`.attach-rows.searching
      .roster`) under "Searching Mindbody...".
- [x] **Rows**: `attachRowItem` is the whole-row tap (`.rrow.rrow-tap`,
      keyboard Enter/Space too); name, `.contact-line` on search rows
      (whether or not that person also happens to be on the picked
      roster), `.cell-chip` as its own grid column (`.modal-search.
      attach-mode { --roster-cols: minmax(0, 1fr) 118px }`). Chips
      measured at one x down the list in both modals. Dropped from the
      attach rows: M, info icon, no-waiver pill, passes, balance (the
      balance still rides `attachSaleClient` for SaleScreen).
- [x] **Footer**: `attachSearchHint(config)`, so with no house client
      the line names `POS_HOUSE_CLIENT_ID` instead of promising an
      anonymous sale (closes T41's open note).
- [x] **Walk-in search rows**: five columns (`.modal-search
      --roster-cols`: name | passes | balance | chip 118px | profile
      44px). Every match shows now, roster people included: booking
      mode used to hide them, which read as "nobody found" for the
      person standing there. `rosterStatus` maps the active class's
      entries and the loaded waitlist (never fetched for this) to
      `checked in` / `signed up` / `waitlist`; a row with a standing is
      not a tap target and carries no add label. The Buy bag, the "+",
      M, info and the waiver pill are gone from these rows. The tap
      calls `tapWalkIn` unchanged; the pass chevron's stopPropagation
      keeps the picker off the row tap; the working row shows its
      spinner in the chip column and the outcome text stays under the
      name.
- [x] **Profile modal** (`openProfile`, `closeProfile`, `profileView`,
      `profileState`): `PersonIcon` in the roster's actions cell (after
      the Buy bag, before the Mindbody link) and at the right edge of
      search rows; fetched at open, generation-guarded against a stale
      answer; `.modal-scrim.profile-scrim` at z-index 31 so it paints
      over the search modal's scrim; the card scrolls inside
      `.profile-scroll`. Escape closes it first: the search and counter
      modals' Escape handlers stand down while it is open, and
      SaleScreen's `modalAbove` counts it.
- [x] **Roster actions column**: 328px (`--roster-cols`), the sum of
      what the cell actually holds: the "checked in" chip renders at
      120px, not its 104px min-width, which is the overlap the T39
      review saw in the 260px column. Measured: cell 328, children
      120 + 44 x 4 + gaps, no horizontal overflow at 1366.
- [x] CSS: `.add-btn`, `.marker-line`, `.mini-stop`, `.attach-group` and
      `.attach-quick-label` retired with the rows that used them; new
      rules all tokens, both palettes; 14px only on `.contact-line`.

Verified: `npm run typecheck`, `npm run build`, and the Playwright
harness (`scratchpad/t42.js`, mocked API: a 30-person class with a third
checked in, 45 search matches paged at the requested limit, a profile
fixture) at 1366x1024 in both palettes, screenshots under
`scratchpad/t42/`: `attach-default`, `attach-signed-in`,
`attach-inclass-query`, `attach-searching`, `attach-everyone-page1`,
`attach-everyone-page2`, `attach-cleared`, `walkin-search`, `roster`,
`profile-loading`, `profile`, `profile-over-search`.

### Judgement calls and what is left

- **Search stays submit-triggered.** The brief describes the everyone-
  search as "existing debounce/abort/minimum"; the debounce went in T16
  (Enter or Search fires the one call, which is also how Pete described
  it: "type a name in and click search"). Kept as is; the abort and the
  minimum are there.
- **T32's groups are gone.** With the filter row, "in class" and
  "everyone" are two states of one list rather than two groups of one
  search; a search row who is on the picked roster still shows the
  chip, so the fact T32 surfaced is still on screen.
- **Rows already in the class are not tappable in the walk-in search.**
  Adding them would be refused by Mindbody anyway; the chip says where
  they stand, and the roster row is where check-in happens.
- [ ] Pete: the everyone-search's page size in attach mode is 20 (the
      walk-in search keeps the drawer's 12). Say if it should be one
      number.
- [ ] Not verified live: `/client/clients?searchText=&offset=` paging
      order is assumed stable between calls, and `TotalResults` present;
      a missing total falls back to the short-page rule.

### Follow-up (2026-09-02)

The review's first open item is closed: a walk-in search row now prints
its red alert under the name in the stop colour (and a yellow alert as a
plain note), so the cue T20 relied on survives the info icon's removal.
The attach rows stay without a profile icon on purpose: Pete's design
for that modal is a bare tappable row, and the profile is one tap away on
the roster once the client is in the class.

### Review (separate reviewer), T42

Adversarial pass on `b150cd3`, `e54dfec`, `eb375c0` with its own
Playwright harness (`scratchpad/t42-review.js`, mocked API, screenshots
under `scratchpad/t42-review/`). Four real bugs, all in `page.tsx`, each
fixed in place; the rest of the hunt list came back clean.

**Real, fixed:**

- **Enter on a control inside a walk-in row booked the client.** The
  row's `onKeyDown` took every keydown that bubbled up through it, so
  Enter on the focused profile icon (and on the pass chevron) went to
  `tapWalkIn`, while the row's `preventDefault` swallowed the button's
  own click: one `/api/book` POST, no profile. Sequence: search "wang",
  focus a tappable row's profile icon, Enter: `book calls 1, profile
  open false`. Now the row handler ignores keys whose target is not the
  row itself; same guard on `attachRowItem`. After: `book calls 0,
  profile open true`, and the chevron opens its picker.
- **A requery mid-page pinned `searchMore` on.** `fetchSearchPage`
  aborts the page in flight, whose `finally` returns early on the abort
  and never clears the next-page flag; a first page did not clear it
  either. Sequence: "wang", scroll (page two in flight), Enter on "wan":
  the new list showed "Loading more..." for good and scrolling never
  fetched page two (`loadMoreResults` refused on `searchMore`). Seen in
  both modals. A first page now clears the flag. After: "wan" pages
  normally (`offset=12` fetched on scroll).
- **A failing page retried itself in a loop.** On a next-page error the
  sentinel stayed mounted and in view, the observer effect re-armed on
  the flag change, and the new observer fired at once: 14 metered calls
  in three seconds against a page answering 429. A failed page now ends
  the paging (`done: true`, sentinel unmounts); the error line shows and
  a new submit starts over. After: 1 call in the same three seconds.
- **The walk-in list carried its scroll into the next query.** The
  `<ul>` persisted across queries at its old `scrollTop`; a list opening
  already scrolled to its sentinel asked for page two unbidden
  (measured: scrollTop 480, `wan&offset=12` fetched with no scroll). The
  list is keyed by the query, so a new search remounts it at the top.
  After: scrollTop 0, one call. The attach modal's `.attach-rows`
  already reset (its rows remount through the searching state).

**Checked, not a bug:**

- Walk-in gates through the row: the waiver dialog opens for
  `waiverSigned === false` with no book call; a full class opens the
  waiting-list confirm with no book call; the booked row spins in the
  chip column with "Talking to Mindbody..." under the name, every other
  row dims and loses its `role`, and the modal stays until the answer
  (3s mock). Roster and waitlist people render the chip with no role,
  label, or handler. Two Playwright taps on one row: one POST.
- Three `el.click()`s in ONE task made three POSTs. That is React
  flushing the discrete update in a microtask, so same-tick clicks share
  the stale `bookingIds`; real taps are separate tasks and the second
  saw the lock. The "+" had the identical guard. Not changed; a ref lock
  (T24's `payFlight`) would close it if it ever matters.
- Attach transitions: off with "wa" says the three-letter line and makes
  no call; Enter while off with "wa" the same; back on restores the
  roster filtered by the kept query ("wa" gives the four Wangs, message
  cleared); off with "wang" is one call; toggling on mid-page aborts it
  and shows the roster; off again is one new call; scroll, scroll: 45
  rows over 3 calls for the query, a third scroll makes none; the X
  leaves zero rows, empty box, no call. Empty class: "Loading the
  roster..." then "Nobody is booked yet."; a failed roster: "Roster
  unavailable: ..." whichever segment. Reopening resets to on / current
  class / All deliberately (`openAttachSearch`), which is Pete's "I land
  on this" and right. Waitlist people are not roster entries and
  appear in neither segment, which is correct: they are not booked.
- Sort: "Mary Ann de la Cruz" under the Cs, "Émile Ortega" after
  "Dennis Ortega", one-word "zoe" by that word, last. (The comment said
  "de la Cruz" sits with the Ds; corrected to the Cs.)
- Profile: open A (slow), close, open B: B renders and A's late answer
  does not replace it; a 502 renders "Profile unavailable: ..."; Escape
  closes only the profile and the search modal stays. The fetch is not
  aborted on close, only dropped, which is fine: the metered reads are
  already spent by then.
- Roster actions column at 1080, 1180 and 1366: cell 328, children 120
  + 44 x 4, no horizontal overflow, and the "checked in" chip starts 12px
  right of where "-$1,234.50" ends (T39's overlap is gone).
- Font sizes under 16px in the search rows: `contact-line` and
  `pass-facts` only, both recorded. Rows 64px or more. No hex outside
  `globals.css`, no em dashes in the diff.
- Money and check-in paths: `git diff 8660287..HEAD` touches only
  `page.tsx`, `globals.css`, `clients.ts`, `api/search/route.ts` and
  this file; `api/book`, `api/checkin`, `api/checkout`, `api/cancel-visit`,
  `api/visit-payment`, `api/waiver-agree`, `lib/sale.ts`, `lib/roster.ts`
  are untouched.

**Open, for Pete:**

- A red alert on a walk-in search row has no visible cue now. T20 took
  the alert off the gate on the grounds that it sat behind the row's
  info icon; that icon left the search rows in T42, so the alert is
  only inside the profile modal. The row for a client with `RedAlert`
  set renders exactly like any other. Either the red alert should mark
  the row, or that trade is accepted.
- The attach modal's search rows carry no profile icon (only the
  walk-in rows and the roster do). The ticket's design said "at the
  right edge of search rows"; in attach mode the contact line is the
  only disambiguator. Say if the icon belongs there too.
- `/api/search` accepts any non-negative `offset` and `limit` uncapped;
  only our modals call it and Mindbody answers an empty page past the
  end, so it is not a fault, but a cap would be one line.
- [ ] The profile icon in the Buy header beside the attached name (T41's
      suggestion) is not added: SaleScreen is out of this ticket's
      scope. The roster and search rows cover the counter.

## T43. A comp needs a reason (Pete, 2026-09-02)

Pete: "is there a way to force the teacher to write a reason for
comping?" Yes, and the reason has to live on our side: Mindbody's
checkout request has no notes field (the request schema in
`docs/mindbody-openapi/sale.yml` carries none; the response's `Notes` is
customer-written), so the comp payment stub goes out exactly as it did
and the reason is ours to keep.

### The design (approved)

1. **A reason dialog on arm.** Holding `Comp this sale` no longer arms
   comp directly; the completed hold opens a modal: title `Comp this
   sale`, the total, four preset chips (`Teacher`, `Trade`, `Goodwill`,
   `Damaged item`), a free-text field (max 200 characters), `Cancel`
   and `Comp`. A chip fills the field with its label and the teacher may
   edit; `Comp` is enabled only when the trimmed text has at least three
   characters. Cancel, Escape and the scrim leave comp unarmed and drop
   the draft. Tapping the armed Comp control unselects and clears the
   reason. Leaving pay mode clears both.
2. **The gate.** `chargeable` requires the reason whenever comp is
   armed, in the same render; the state makes an armed comp without a
   reason unrepresentable.
3. **The request.** The comp body carries `compReason`, only beside
   `method: "comp"`; the route validates it (string, trimmed, 3 to 200)
   and refuses it on any other method or a split. Nothing goes to
   Mindbody.
4. **Storage.** `comp_receipts` in Postgres, our line list and the
   reason, on the T29 charter; and ALWAYS a `[comp]` server log line so
   a comp is on record with no database.
5. **The done screen** says `Comped: <reason>`.
6. **Teacher identity** stays open question 3: the receipt has no
   teacher name until it is answered.

### What was built

**SaleScreen.tsx, PaymentPanel.** `comped: boolean` became `comp: {
reason: string } | null` (`comped` is derived from it), so the reason
cannot be absent from an armed comp; `chargeable` re-checks
`compReasonValid(comp.reason)` in the same render regardless. `armComp`
(the hold timer's callback, still reading `visibleRef` so a hold that
lands after Back to items is refused) now opens the dialog and reports
`onModalChange(true)`; `confirmComp` is what arms: it clears the lines,
dismisses the keypad, sets `comp` and closes the dialog. `closeReason`
(Cancel, Escape, the scrim, every reset path, the `visible` effect)
drops the draft and reports the close upward like `dismissPad`, so a
dialog dismissed by a reset never leaves Escape blocked. The dialog is
a `.modal-reason` inside the keypad's `.modal-amount` shape over the
same `.modal-scrim`, with its own Escape listener; the input is a 64px
target at 18px with `autoComplete="off"`, Enter confirms only when the
text is long enough. The quiet line reads "Nothing to pay, on the
studio. Comped: <reason>" while armed, so the reason is on the surface
before Charge. The paid result carries `compReason` and the done block
renders `Comped: <reason>` under the charged line. Every other comp rule
is as T35/T39 left it: arming clears the lines, a tender disarms, a
client change and a cart reset clear it, leaving pay mode clears it with
"Comp was cleared." on return.

**CSS.** `.modal-reason .reason-chips` wraps the four chips at 64px,
`.pad-chip.on` takes the accent pairing, `.reason-input` and
`.pay-done-reason` in tokens only; both palettes come from the variable
swap.

**/api/checkout.** `compReason` parsed before the house-client
substitution and the rehearsal, so a reasonless comp costs no metered
call: 400 when missing, short, long or not a string on a comp; 400 when
present on any other method or on a split. Each item may carry a `name`
on a comp, read into the receipt's line list and never forwarded (the
Mindbody payload is built from the validated `items` alone, verified
against a mock: the request keys are `Items, Payments, ClientId, Test,
LocationId, InStore, CalculateTax, SendEmail`, as before). After the
Mindbody call resolves, `recordComp` writes ONE log line and then the
table row; a refused or ambiguous call logs the attempt with its
outcome and records no row. The single flight, the payload and every
outcome's wording are untouched.

**db.ts.** `comp_receipts (id serial, recorded_at, sale_id text null,
client_id text null, total_cents integer, items jsonb, reason text,
target text, suppressed boolean)` as migration version 2, since version
1 has already run on the deployed database and is skipped there; the
runner's own comment asks for a numbered block. `insertCompReceipt`
follows `insertWaiverReceipt` exactly: never throws, `logDbError` once
per kind, returns whether it stored.

### Observed (harness `scratchpad/t43.js`, shots under `scratchpad/t43/`)

The request body for a comp charge, the mocked route capturing it:

    { "items": [ { "type": "Service", "metadataId": 1002, "quantity": 1,
        "price": 230, "taxExempt": true, "taxRate": null,
        "name": "10 Class Pack" }, ... ],
      "clientId": "100000123", "method": "comp",
      "compReason": "Teacher, covering for Pete" }

`method: "comp"` unchanged; `compReason` beside it; `name` on the items
of a comp only (a cash or split body is byte for byte what T39 recorded).

Against the real route with `DATABASE_URL` unset, a mock Mindbody on
`MINDBODY_API_BASE_URL`, `POS_DRY_RUN=false` and the write guard
allowing one client:

    [comp] prod sale=777001 client=100000123 total=31.00 reason="Teacher, covering for Pete"
    [comp] prod sale=none outcome=refused client=100000123 total=3.00 reason="Goodwill" error="Refused by the mock"

No `[db]` line: with no database the insert returns false silently and
the log line is the record. The validation answers: no reason, two
characters, 201 characters each `400 "a comp needs a compReason of 3 to
200 characters"`; `compReason` beside `method: "cash"` or a split `400
"compReason applies only to method comp"`. The reason is trimmed on the
way in.

The gate: with two characters typed `Comp` is disabled and Enter does
nothing; spaces only likewise; Cancel leaves the bar at `Due $253.22`
disabled and a forced click on it sends no request; the next hold opens
an empty field. Escape and the scrim close the dialog and stay in pay
mode; two Escapes with the dialog open peel the dialog, then pay mode.
Armed with `Trade`, a tap on the control unselects and the quiet line
returns to the card reason; Back to items with comp armed clears it and
the return says "Comp was cleared."; a Cash tap disarms. Every target in
the dialog measured 64px. Both palettes shot at 1366x1024: the dialog
open, `Teacher` chosen, comp armed with the reason on the surface, the
done screen.

### Left, with the reason

- **Teacher identity.** The receipt carries the reason and no name;
  open question 3 in the design doc, and the sentence added there.
- **A suppressed comp never reaches the receipt path** as the route is
  built: dry run and the write guard suppress the Test: true rehearsal
  first, and the route answers `suppressed` before the comp branch. The
  `suppressed: true` row is written for the case where a rehearsal
  passes and the write is eaten, which today cannot happen; it stays
  because the guard's order could change and a comp must not go
  unrecorded when it does.
- **`review3r-lib.js`'s `attach()` predates T42's attach modal** (the
  "In class" scope is on by default, so an everyone search needs the
  toggle off); `t43.js` carries its own. The lib is unchanged.

### Review (separate reviewer), T43

Three real bugs, all in the UI; the route and the storage came through
clean. Fixed in place, `scratchpad/t43-review.js` (CDP touch, long
reasons, the keyboard and two-finger paths) beside the implementer's
harness, shots under `scratchpad/t43-review/`.

REAL, fixed:

- **On a touch pointer the dialog closed the moment the hold's finger
  lifted.** The dialog opens at 700ms with the finger still on Comp, so
  the scrim is what is under the finger when it lifts, and the click the
  browser fires for a touch is hit-tested at the lift: Chromium (CDP
  `Input.dispatchTouchEvent`, touchStart, 900ms, touchEnd) fired
  `pointerdown`, `pointerup`, `pointerleave` on Comp and then a click on
  `.modal-scrim`, whose handler was `closeReason`. Observed: `dialog: 0`
  after every touch hold; on the iPad the feature could not have been
  used. A mouse never showed it because the pointer's leave aborted the
  hold and the click went to the common ancestor of the down and the
  up. Now the scrim closes only for a click whose pointer went DOWN on
  it (`reasonScrimDown`, set on the scrim's own pointerdown, consumed
  on click). Post-fix: the touch hold opens and the dialog stays; a
  touch tap on the scrim still closes it; after Cancel one touch tap on
  Comp shows the hint (the swallow flag is not stuck: `pointerleave`
  had already cleared it); a chip and Comp by touch arm it and one tap
  unselects.
- **A long reason ran off the surface.** 200 characters with no space
  in them (`W` x 200): the quiet line's scrollWidth was 3164 in a 606
  box, `.pay-surface` 3182 in 922, the text under the Comp button and
  past the pane (`light-long-armed.png`, pre-fix in the harness log);
  the done screen's `.pay-done-reason` 2288 in 646. `overflow-wrap:
  anywhere` on both, as the rest of the file does for free text; both
  now measure at their box and wrap (the quiet line to 157px tall at
  the worst case, the done line to 133).
- **Charging with the dialog open was reachable two ways**, and the
  ticket's "an armed comp without a reason is unrepresentable" held but
  "the dialog owns the screen" did not. (a) Tab: focus lands in the
  field, three Tabs reach the bar's Charge under the scrim, Enter with a
  cash line covering the total sent the request and the done screen
  rendered while the dialog was still up (observed: `requests: 1`,
  `done: "Sale complete"`). (b) Two fingers: one holding Comp, the other
  tapping Charge at 200ms; the timer landed at 700ms with money moving,
  the dialog opened over "Charging...", and Comp in it cleared the lines
  and armed comp mid-flight (observed: `compPressed: "true"`, `lines:
  []` beside the disabled Charging bar). Now `chargeable` is false while
  `reasonOpen` (the bar reads `Charge $X` disabled under the scrim, and
  Enter on it sends nothing: `requests: 0`), `armComp` refuses through a
  `chargingRef` like `visibleRef` (the two-finger timer opens nothing),
  and `confirmComp` refuses while charging as a belt. The money moved in
  (a) was the tendered cash for the rehearsed total from an explicit
  Enter on Charge, so no wrong charge, but a charge from behind a modal
  is not a state the seam should have.

NOT A BUG, checked:

- **The Mindbody payload.** The mock at `MINDBODY_API_BASE_URL` logged
  the keys of every call: the rehearsal `Items, ClientId, Test,
  LocationId, InStore, CalculateTax, Payments` and the write `Items,
  Payments, ClientId, Test, LocationId, InStore, CalculateTax,
  SendEmail`, `Payments: [{Type: "Comp", Metadata: {Amount}}]`, the
  cash control identical but for `Cash`. `parseCartLines` builds each
  line from named fields, so `name` cannot ride into `cartItemsPayload`;
  `compReason` is read from the payload and never passed on. `git diff`
  of the route: the split branch, the credit and card branches, the
  outer catch and every response body are untouched; the comp/cash
  branch gained an inner try that logs and rethrows, and `recordComp`
  between the resolved call and the response.
- **Validation order and cost.** Nine 400s (no reason, two characters,
  201, `null`, a number, spaces only, `compReason` beside cash, credit
  and a split) and the mock's line count did not move: zero metered
  calls. 200 exactly passes; 150 spaces + `abc` + 150 spaces passes as
  `abc` (trimmed, then measured). The reason is stored as sent after
  trimming, HTML and quotes included; the done screen renders it as a
  React text node (`innerHTML` shows `Comped: WWW...`, no markup).
- **The log line.** Paid: `[comp] prod sale=777001 client=100000123
  total=31.00 reason="abc"`; house client: `client=house`; refused
  (mock 400 on the write): `sale=none outcome=refused ...
  error="Refused by the mock"`; ambiguous (a mock that answers the
  rehearsal and destroys the socket on the write): `sale=none
  outcome=ambiguous ... error="fetch failed"`, with the route's answer
  still "The charge did not answer. It MAY have gone through" and
  `ambiguous: true`. The rehearsal-suppressed path answers before the
  comp branch and writes no `[comp]` line, as the ticket says; nothing
  was given away, so there is nothing to receipt.
- **`recordComp` cannot turn a paid sale into a refusal.** It runs
  inside the outer try, so a throw from it would be answered as a
  checkout error after the sale completed; but `insertCompReceipt`
  catches everything from `ready()` on, `console.log` does not throw,
  and the string it builds is `total.toFixed` and `JSON.stringify` of a
  string. Not reachable; noted because the invariant matters more than
  the line. It does await the insert before answering, so a configured
  but dead database costs the first comp its 5s connection timeout and
  then the 30s cooldown, exactly as the waiver receipt does.
- **Storage.** The runner applies `MIGRATIONS` in array order and skips
  `version <= current`: a fresh database records 1 then 2, the deployed
  one at 1 runs only 2. `insertCompReceipt` mirrors the waiver insert
  (try around `ready()` and the query, `logDbError` once per kind,
  false on failure). The row is the reason, our line list (`{type, id,
  name, quantity, price}` per line, documented in `db.ts`), cents,
  the two ids, target and the flag; no client name, no catalog copy.
  `serial` where the T29 tables use `bigserial` is a nit, not a bug.
- **State.** Every former `setComped(false)` is a `setComp(null)`
  (`addLine`, the unselect tap, `resetTender`, the `visible` effect);
  `confirmComp` is the one `setComp({reason})` and it clears the lines
  and the keypad first. The hold under an open keypad lands on the
  scrim (keypad closes, nothing opens). The hold landing after Back to
  items: refused, no dialog, one Escape then closes the overlay. Back
  to items by keyboard with the dialog open (focus + Enter): the dialog
  closes with the mode, nothing arms, one Escape closes the overlay,
  the reopened pay mode is clean. The overlay's Back with the dialog
  open unmounts the panel and the unmount effect reports the close;
  reopened, one Escape closes it again. Escape with the dialog open
  peels the dialog only (`payModalOpen` keeps the overlay handler out
  of the same press). `maxLength` holds 200 for typing, `fill` and
  `insertText` of 201.
- **Focus** lands in the field on open and on the body after Cancel
  or Comp, which is what the keypad does too; the target that had it
  is behind a scrim that is now gone. Left as it is.
- **Conventions.** Every colour in the three commits is a token
  present in both palettes; every dialog target measured 64px in both;
  no em dash in the diffs; the done, suppressed, split, ambiguous and
  error branches diff clean against T42 apart from the reason line.

## T44. Teacher identity: the last four of your phone (Pete, 2026-09-02; SUPERSEDED by T48)

Pete: "let's do teacher identity with a PIN per teacher ... last 4
digits of their phone # would be ideal." That closes the design doc's
open question 3: the POS keeps acting as the service account against
Mindbody, and WHO is at the counter is a second layer of ours, named
in our receipts and logs.

### The design (decided)

Two layers. The device session (`POS_PIN`, 30 days, T21) is untouched.
On top of it a TEACHER session, for a shift:

1. **Staff read** (`src/lib/staff.ts`): `GET /staff/staff` with
   `Filters=ClassInstructor`, and the same rule applied to the answer
   (`ClassTeacher !== false`, `Active !== false`), mapped to `{id, name,
   pinDigits}` where `pinDigits` is the last four digits of MobilePhone,
   else HomePhone, else WorkPhone, digits only, or null. Cached ten
   minutes in memory per target, never persisted (the T29 charter); a
   failed read serves the stale cache when there is one, else throws.
   No phone number leaves the server: the `/api/*` answers carry names
   and ids only.
2. **Teacher session** (`src/lib/auth.ts`): a second cookie
   `pos_teacher` holding `t1.<staff id>.<name, base64url>.<issued-at
   ms>.<hmac>`, signed with the same derived key (pepper included, so a
   PIN or pepper change revokes both cookies), twelve hours, httpOnly,
   SameSite=Strict, Secure when the request came over https
   (`x-forwarded-proto` or the URL). `teacherFrom`, `teacherSetCookie`,
   `teacherClearCookie`, and `requireTeacher`, which lets a write
   through with auth disabled and answers 401 `{error, reason:
   "teacher"}` without a teacher when auth is required. The login
   limiter became a factory: two counters, same rules, so a teacher
   fumbling digits cannot lock the device door.
3. **Routes.** `POST /api/teacher/login` `{pin}` (four digits) behind
   the device session, rate-limited on its own counter: a unique match
   answers `{ok, teacher: {id, name}}` and sets the cookie; several
   answer 200 `{ok: false, choices: [{id, name}]}` and the browser posts
   again with `{pin, staffId}`, which must be one of THAT pin's matches
   (a staff id alone names nobody); none is 401; a staff read that
   fails with nothing cached is 502 with the reason. Every teacher is
   compared constant-time with no early exit. `GET /api/teacher` answers
   the current teacher or null plus `required`, `pinsAvailable`,
   `noPhone` (names of teachers with no usable phone) and `staffError`.
   `POST /api/teacher/logout` clears the cookie.
4. **The prompt** (`src/app/TeacherPrompt.tsx`): after the device
   unlock, or straight away with auth disabled and nobody named, a
   full-screen overlay in the lock screen's idiom: "Who is at the
   counter?", "Enter the last four digits of your phone", the same 3x4
   keypad, four fixed dots, the fourth digit submits. A collision lists
   the names as 64px buttons with "Not me, start over". Under the
   keypad a quiet 16px line "No phone on file in Mindbody for: A, B",
   the staff-read error when there is one, and the 429 lockout line as
   the device lock shows it. No Skip with `POS_PIN` set; with auth
   disabled a "Continue without a name" control exists for dev. The
   header shows the teacher's first name as a 64px control beside Buy;
   tapping it clears the cookie and asks again. A write answering 401
   `reason: "teacher"` (the twelve hours ran out mid-shift) brings the
   prompt back and retries nothing; any other 401 is still the lock.
5. **Writes carry the teacher.** `requireTeacher` after `requireSession`
   in checkin, book, cancel-visit, visit-payment, waiver-agree,
   purchase-contract, checkout and (from the review) client-field. `comp_receipts` gains `teacher_id`
   and `teacher_name` (migration 3, additive); the `[comp]` lines and
   the `waiver-agreed` line carry `teacher=<id|none>`. The Mindbody
   payloads, the single flight and the outcome wording are unchanged;
   `src/lib/sale.ts` has no diff.

### What was built and checked

Against the dev server with `POS_PIN` set and Mindbody mocked (a staff
fixture with a unique match, a collision pair whose phones are written
"+1 206-555-7788" and "425.555.7788", a teacher with no phone, a
non-teacher and an inactive teacher, both filtered), at 1180x820 in both
palettes: the device lock, the prompt with the no-phone line, the
collision picker, the header with a name on one row with the counters,
the switch tap bringing the prompt back, the lockout line on the sixth
wrong entry with the keys disabled. Every target in the prompt measured
64px. Node-level: a check-in and a comp with a device session and no
teacher cookie answer 401 `reason: "teacher"` (as do book, cancel-visit,
visit-payment, waiver-agree and purchase-contract); a four-digit shape
check is 400; a wrong pin with a staff id attached is 401; the collision
answers the pair; the pair's pin with an id outside it is 401; after a
unique login the check-in reaches the mock and the comp logs
`[comp] sandbox sale=777001 client=100000123 total=3.00
reason="Teacher" teacher=100`; after logout the check-in is 401 again.
`typecheck` and `build` clean.

### Left

- **The staff-phone permission is unverified live.** The spec says
  `/staff/staff` returns only names, ids, bio and image without a token
  whose group may view staff; whether the API account's "API Sales"
  group returns `MobilePhone` is the first thing to check on the
  studio. If it does not, `GET /api/teacher` reports `pinsAvailable: 0`
  and the prompt says nobody can sign in.
- The `Filters=ClassInstructor` query parameter is spelled from the
  spec's `request.filters`; the local filter covers it being ignored.
- Mindbody still attributes every sale and check-in to the service
  account (the payroll caveat in the design doc's question 3).
- The check-in, booking and pass-change routes have no outcome log line
  of their own, so their teacher is recorded only by the comp and
  waiver lines; if per-check-in attribution is ever wanted, the dev
  call log is where a `teacher` field would go.
- With auth disabled the prompt can be skipped; the four-digit match
  then still works, it is just optional.

### Review (separate reviewer), T44

Read as a security change first. Node-level against the dev server with
`POS_PIN=2468` and the mock on :4545 (the staff read refusing first, then
the fixture), then the browser at 1180 and 1080 in both palettes, then a
second server with `POS_PIN` unset. Scripts `t44-review-node.js`,
`t44-review-ui.js`, `t44-review-noauth.js`; shots in `t44-review/`.

**Three real bugs, fixed in place.**

1. **`/api/client-field` was a Mindbody write with no teacher gate.**
   `POST /client/updateclient` (notes, red and yellow alerts) sat behind
   the device session only: with a device session and no teacher cookie
   the request reached the mock. Everything the ticket calls "every write
   route" was gated; this one was not in its list. Fixed: `requireTeacher`
   after `requireSession`, same 401 `reason: "teacher"`; verified 401 with
   no teacher, the page's wrapper shows the prompt as for any write.
2. **A device session gone at the prompt read as "wrong digits" and
   stuck the counter.** The fetch wrapper excluded `/api/teacher/login`
   from its 401 handling entirely, so when the device cookie had expired
   (or `POS_PIN` had been rotated) while the prompt was up, every entry
   answered `{error: "unauthorized"}` and the prompt said "No teacher has
   a phone ending in those digits." until someone reloaded. Sequence:
   unlock, clear `pos_session`, type 1234: prompt still up with that
   message (`A-device-gone-at-prompt.png` is the after). Fixed: the login
   route's three 401s carry `reason: "teacher"`, and the wrapper no
   longer excludes the path: a 401 on it WITH the reason is the prompt's
   own business (nothing happens), one WITHOUT is the lock. Same
   sequence now lands on the lock screen.
3. **A unique match ignored a wrong `staffId`.** `{pin: 1234, staffId:
   101}` answered 200 as staff 100: the id was only checked when the pin
   collided. No privilege gained (the pin alone names 100), but the
   contract "a staff id must be one of THAT pin's matches" was not what
   the code did. Fixed: when given, the id must be in the match set,
   unique or not; `{1234, 101}` is 401, `{1234, 100}` and `{7788, 102}`
   are 200, `{7788, 100}` and `{7788, 105}` (the inactive one) are 401.

**Checked and NOT a bug** (the sequence or reasoning in each):

- Token: all four fields are under the HMAC with the `.` separators
  (`t1.<id>.<name b64url>.<issuedAt>`); id and issuedAt are digit-only
  and the name is base64url, so no field can carry a `.` and the
  five-part split is unambiguous. Tampering the id, the name, issuedAt
  by 1 ms, the prefix, a sixth part, the signature's case, a `.` in the
  name, the device token as a teacher token and an empty value all
  verify to null. The regexes run before the HMAC but branch on public
  format, not on the secret; the signature check is `safeEqual` and
  expiry is read from the signed issuedAt after it. The key is the
  device key, so a `POS_PIN` or `POS_SESSION_SECRET` change invalidates
  both cookies. `Secure` follows `x-forwarded-proto` (first value: "http,
  https" is not Secure, "https" is), absent that the URL; over plain
  http the cookie has no Secure and stores. `HttpOnly; SameSite=Strict;
  Path=/; Max-Age=43200`.
- `teacherFrom` reads the cookie without checking the device session,
  but every caller runs `requireSession` first: a teacher cookie with no
  device cookie is 401 `unauthorized` on `/api/teacher`, the login and
  every write.
- **Replay after logout: possible, accepted.** There is no server-side
  list, so a cookie value captured before the header's switch tap names
  that teacher until its twelve hours run out (verified: the pre-logout
  value still answers `/api/teacher` and a check-in). Capturing it needs
  the device or a LAN proxy over http, and it names a teacher on OUR
  receipts and logs; it opens no Mindbody write the device session did
  not already open. Twelve hours is a shift; acceptable for attribution.
- Login: `requireSession` first, then the claim before the first await;
  a parallel burst of 12 wrong pins answered five 401s and seven 429s
  (`retryAfterSeconds: 30`); a device login, right or wrong, during the
  teacher lockout was unaffected and vice versa. `^\d{4}$` refuses a
  leading space, fullwidth digits, a number and five digits (400);
  `staffId` as a string, null or 1.5 is 400; a non-JSON body 400. Every
  400 and the 502 burn a claim, which is conservative rather than wrong:
  the prompt cannot produce a malformed post. The staff read refusing
  answers 502 with Mindbody's message and no stack, and re-reads on the
  next call when nothing is cached. No answer carries a phone or
  `pinDigits`: the choices and the teacher are `{id, name}`.
- **Enumeration, stated.** Five tries then 30 s: ten guesses a minute
  behind the device session. Walking all 10,000 pins is about 17 hours;
  with ~15 teachers the expected first hit is ~625 guesses, about an
  hour of continuous typing at the counter, and the prize is a
  colleague's name on a comp receipt. Acceptable for attribution-only;
  the device PIN, not this layer, is what keeps a stranger off the
  writes.
- Staff read: the mock logged `?Filters=ClassInstructor&Limit=100&
  Offset=0`, and a 400 from Mindbody on that parameter would take the
  error path (502 / `staffError`), not an unfiltered read; the local
  `ClassTeacher`/`Active` filter is the fallback for it being ignored,
  not for it being refused. Paging stops on a short page or
  `TotalResults`, `MAX_PAGES` caps a runaway, the `seen` set dedups.
  "+1 206-555-7788" and "425.555.7788" both yield 7788 and both names
  come back as choices; a two-digit work phone is null and names the
  teacher on the no-phone line; the non-teacher and the inactive teacher
  are absent from choices and from `noPhone`. The cache is a module
  variable keyed by target; the only place a phone is written is the
  mindbody call log's response body, which `/api/devlog` gates.
- Gates: the seven routes plus client-field call `requireTeacher` right
  after `requireSession` and before any Mindbody call; checkout's diff
  is the gate, two log tags and two receipt columns, and `sale.ts` has
  no diff. With `POS_PIN` unset the prompt offers "Continue without a
  name", the header reads "Who is here?", a check-in with no cookies at
  all is 200, and 1234 still names Pete. Migration 3 is two
  `ADD COLUMN IF NOT EXISTS`; the runner applies every version above
  `max(schema_version)` in array order, so a fresh database runs 1, 2,
  3 and one at 2 runs only 3.
- Prompt: `required` true has no skip control, Escape is not handled,
  the shell has no click handler and is `z-index: 40` over everything;
  two synchronous clicks and a keydown on the fourth digit posted once
  (`submittingRef`, then the keys disable); a write 401 with the reason
  brought the prompt back after exactly one `/api/checkin` POST and the
  mock saw no `updateclientvisit` from it; the first Tab on the
  collision list lands on "Alex Rivera" and Enter names them. Header at
  1080: badge 64 px high, 16 px, on the counters' row, no horizontal
  overflow. Colours in the new CSS are all tokens present in both
  palettes; nothing under 16 px; no em dashes.
- Docs: question 3, `.env.example`, the CLAUDE.md gap and PLAN.md agree
  with the code; item 5 above now lists client-field.

Left as before, plus: the login limiter counts a 502 as a failed guess,
so a Mindbody outage during a shift change locks the door for 30 s after
five tries, which is a nuisance rather than a risk.

## T45. The comp reason is data, and the teacher is picked from a list (Pete, 2026-09-02)

Pete, after T43 and T44: "if teacher is chosen, the teacher should be
selected from a list (can default to the teacher of the current class).
also, looks like the buttons merely paste strings in? so we aren't
saving an enum with the row is that right? we should. and see if there's
a field in mindbody to write to for our own internal eyes."

Yes, T43's chips pasted their label into the text field, so the row
held "Teacher" or "teacher, covering" or anything else, and nothing
could be counted. And yes, Mindbody has a home for an internal note:
`POST /client/addclientformulanote` (client.yml), the dated staff-only
Formula Notes tab on a client's profile, which the checkout request
itself cannot carry (no notes field, T43).

### The design (decided)

1. **Reason kinds.** `compReason` becomes `{ kind: "teacher" | "trade" |
   "goodwill" | "damaged" | "other", detail, forStaffId?, forStaffName? }`
   (`src/lib/comp.ts`, shared by the dialog and the route). The chips
   choose the kind; the field is `detail`, required (3 to 200) only
   for `other`, optional otherwise ("Add a note (optional)").
   `compValid` replaces `compReasonValid`: a kind, the detail when the
   kind needs it, a teacher for a teacher comp.
2. **Teacher picker.** The Teacher chip shows, inside the dialog, the
   active teachers from a new read-only `GET /api/staff` (device and
   teacher session, `[{id, name}]` from the T44 staff cache, never a
   phone), 64px rows with the first name bold, the roster's current
   class's teacher preselected (SaleScreen's new `classTeacher` prop
   from page.tsx's active class summary, matched to a staff name
   case-insensitively: the full name, else a unique first name). A
   failed read shows "Could not load teachers. Tap Teacher to try
   again." and leaves Comp disabled for that kind. Loaded once per
   panel life, on the first Teacher tap.
3. **The route** validates before any Mindbody call: the kind in the
   enum; `detail` a string, trimmed, at most 200, at least 3 for
   `other`; `forStaffId` a positive integer required for `teacher` and
   refused for every other kind; `forStaffName` from the browser is
   ignored and resolved from `listTeachers()` by id (a miss, an
   inactive teacher or a non-teacher is 400; a staff read that fails
   with nothing cached is 502 "Nothing was charged"). Nothing in the
   checkout payload changes.
4. **Storage.** Migration 4, additive on `comp_receipts`: `kind`,
   `detail`, `for_staff_id`, `for_staff_name`, `formula_note_id`. The
   `reason` column keeps a rendered line (`Teacher: Kim Farrell,
   covering for Pete`, `Goodwill: spilled tea`, `Goodwill`) so T43 rows
   and T45 rows read alike. The `[comp]` line gains `kind=<kind>
   for=<id|none>` and, when filed, `note=<id>`.
5. **The Formula Note.** After a REAL comp (not suppressed, refused or
   ambiguous) for a NAMED client (a `clientId` that is not the house
   client), the route posts `/client/addclientformulanote` with
   `ClientId` and `Note` = `Comped $233.00 at the counter: Teacher (Kim
   Farrell). Note: covering for Pete. By Pete Stewart. Sale 777001.`,
   empty parts omitted. Through `mindbody()` with the client id in the
   options, so dry run and the write guard apply as to any write. It
   runs after the outcome is decided, never throws, and never changes
   the answer or its wording: a failure is `[comp] formula-note failed:
   <reason>` and a null on the receipt; the house client is `[comp]
   formula-note skipped: house client`.
6. **Done screen**: `Comped: Teacher (Kim Farrell)` (or `Comped:
   Goodwill`) with the detail on a muted second line when present.

### What was built and observed

Harness `scratchpad/t45.js` (the review3r fixture with `/api/staff` and
`/api/teacher` routed in the browser), mock `t45-mock.js` (the T44
staff fixture plus Kim Farrell, the checkout mock refusing client
100000999, `/client/addclientformulanote` refusing 100000555 and
answering an id otherwise), `t45-node.js` against the real route with
`POS_PIN=2468`, `POS_DRY_RUN=false`, `POS_HOUSE_CLIENT_ID=100000777`
and the write guard allowing the four ids. Shots under `scratchpad/t45/`
in both palettes at 1366x1024: Teacher chosen with Pete Stewart
preselected from the roster's "Pete", Other with two characters typed
and Comp disabled, comp armed, the done screen; light only, the staff
read failing.

The comp body the browser sends:

    { "items": [ { "type": "Service", "metadataId": 1002, "quantity": 1,
        "price": 230, "taxExempt": true, "taxRate": null,
        "name": "10 Class Pack" }, ... ],
      "clientId": "100000123", "method": "comp",
      "compReason": { "kind": "teacher", "detail": "covering for Pete",
                      "forStaffId": 106, "forStaffName": "Kim Farrell" } }

A goodwill comp with nothing written: `"compReason": { "kind":
"goodwill", "detail": "" }`. The Mindbody checkout keys and Payments
were exactly T43's (`Items, Payments, ClientId, Test, LocationId,
InStore, CalculateTax, SendEmail`, `[{Type: "Comp", Metadata:
{Amount}}]`); `git diff -- src/lib/sale.ts` is empty.

What the mock received after the teacher comp, with a forged
`forStaffName: "Nobody Real"` in the request:

    POST /client/addclientformulanote
    {"ClientId":"100000123","Note":"Comped $233.00 at the counter: Teacher (Kim Farrell). Note: covering for Pete. By Pete Stewart. Sale 777001."}

and the log:

    [comp] formula-note filed: id=555001 client=100000123
    [comp] prod sale=777001 client=100000123 total=233.00 reason="Teacher: Kim Farrell, covering for Pete" kind=teacher for=106 teacher=100 note=555001
    [comp] prod sale=777001 client=100000123 total=233.00 reason="Goodwill" kind=goodwill for=none teacher=100 note=555002
    [comp] formula-note skipped: house client
    [comp] prod sale=777001 client=house total=233.00 reason="Other: spilled tea on the mat" kind=other for=none teacher=100
    [comp] prod sale=none outcome=refused client=100000999 total=233.00 reason="Trade: for a class" kind=trade for=none teacher=100 error="Refused by the mock"
    [comp] formula-note failed: Note refused by the mock
    [comp] prod sale=777001 client=100000555 total=233.00 reason="Trade" kind=trade for=none teacher=100

The house client's comp, whether the id was omitted or sent
explicitly, posted no note; the refused checkout posted no note and
answered 502 as before; the note Mindbody refused left the checkout's
answer `{ok: true, saleId: "777001"}` untouched. The 400s, each before
the mock saw a call: a T43-shaped string, no kind, "Teacher" as a kind,
a numeric detail, 201 characters, `other` with nothing, two characters
or spaces, `teacher` with no id, a string id, 0, 1.5, an unknown id
(999), the inactive teacher (105), the non-teacher (104), `goodwill`
with a `forStaffId`, and `compReason` beside cash or a split.
`/api/staff` is 401 with no device session, 401 `reason: "teacher"`
with no teacher, and `[{id, name}]` x 5 after the login (no phones).

In the browser: the Teacher chip loaded the list once (`staffCalls: 1`
across a switch to Other and back), preselected Pete Stewart, and a
tap on Kim Farrell moved the selection; Other cleared the picker and
disabled Comp until three characters (Enter on two did nothing);
Goodwill with the same two characters was chargeable; every target in
the dialog measured 64px and the dialog with five teachers fit at
1024 without the list scrolling. With the staff read failing the chip
showed the line, a typed note left Comp disabled, and the next Teacher
tap read again and preselected. The quiet line reads "Nothing to pay,
on the studio. Comped: Teacher: Kim Farrell, covering for Pete"; the
done screen "Comped: Teacher (Kim Farrell)" with "covering for Pete"
under it, and "Comped: Goodwill" with no second line.

### Left

- **The Formula Note permission is unverified live.** The spec wants
  a staff token whose group may view client profiles (or both
  ViewAppointmentDetails and ModifyAppointment). If the API account
  lacks it, every comp logs `[comp] formula-note failed:` with
  Mindbody's message and the sale stands; check the first live comp's
  log line.
- **The note waits.** The route awaits the note before answering, so
  a real comp for a named client costs one more Mindbody call (and up
  to the 20s transport timeout if Mindbody hangs on it) before the
  done screen. Filing it in the background would lose
  `formula_note_id` on the receipt; kept simple until it is felt.
- **Preselection is by name.** The class summary carries a display
  name, not a staff id; a class whose teacher shares a first name with
  another teacher and is listed by first name only preselects nobody.
- `comp_receipts.kind` is text rather than an enum type, so the closed
  list lives in `comp.ts` and the route, not in Postgres.

### Review (separate reviewer), T45

Read as a money change first: the second Mindbody write after a real
comp, then the trust boundary, then the dialog. Node-level against the
real route under three server postures (`POS_DRY_RUN=false` with the
write guard allowing the fixture's ids; `POS_DRY_RUN=true`; the guard
allowing only the house client), a mock on :4545 with hang, socket-kill
and no-id modes on the note endpoint and a counter of every call it
received; then the browser at 1366x1024 in both palettes, 1180x820 for
the studio-sized list, and CDP touch. Scripts `t45-review-node.js`,
`t45-review-ui.js`, `t45-review-many.js`, `t45-review-2f.js`,
`t45-review-hang.js`, mock `t45-review-mock.js`; shots and logs under
`scratchpad/t45-review/`.

**Two real findings, fixed in place.**

1. **A hung Formula Note held the done screen for 20 seconds after the
   money had moved.** The route awaits the note and the only bound was
   the transport's 20s `AbortSignal.timeout` in `mindbody()`. Observed
   with the mock never answering the note: `/api/checkout` answered in
   20024ms, `[comp] formula-note failed: The operation was aborted due
   to timeout`. The ticket's Left noted it; a teacher with a queue
   should not stare at "Charging..." for twenty seconds over a
   side-record. Now the note is raced against `FORMULA_NOTE_WAIT_MS`
   (8s): observed 8622ms with the body untouched (`{ok: true, method:
   "comp", total: 230, saleId: "777001"}`) and `[comp] formula-note
   failed: no answer in 8s; the note may still file`; the underlying
   call runs on to its own timeout and still lands in the call log, and
   the next comp filed normally (`note=555008`). The timer is cleared
   in a `finally`; `Promise.race` subscribes to both, so the late
   rejection is handled. Nothing about any answer changed.
2. **At the studio's staff size the preselected teacher was out of
   view.** Fifteen teachers with the roster's "Pete" matching Pete
   Stewart, alphabetically last: the list is 328px at 820 and 410px at
   1024 (about five rows), the selected row sat 744px and 662px below
   the fold, and Comp was enabled for a name nobody on the screen could
   see (`onVisible: false` at both sizes). Now an effect scrolls
   `.reason-teacher.on` into view (`block: "nearest"`, so a row already
   visible is left alone) when the list lands or the selection changes:
   `scrollTop` equals the maximum at both sizes and the row is inside
   the box (`many-1180x820.png`); the dialog fits at 820 (5 to 815).

**Checked and NOT a bug** (the sequence or reasoning in each):

- **The note goes through the guard.** `mindbody("/client/
  addclientformulanote", {method: "POST", body: {ClientId, Note},
  clientId})`: the body names the client, so `bodyClientId` finds it
  for `POS_WRITE_CLIENT_IDS`, and `isWrite` (POST, not `/usertoken/`)
  puts dry run in front of both. Under `POS_DRY_RUN=true` the
  rehearsal is suppressed first: `{ok: false, suppressed: "dry-run"}`,
  the mock saw no checkout and no note, no `[comp]` line, for a named
  client and for the house. Under the guard allowing only 100000777:
  the named client's comp is `suppressed: "write-guard"` with
  `[write-guard] suppressed POST /sale/checkoutshoppingcart for client
  100000123; POS_WRITE_CLIENT_IDS allows only 100000777` and no note;
  the house client's comp is real and logs `formula-note skipped: house
  client`. So the note's own suppression branch (`res.DryRun ||
  res.WriteSuppressed`) is unreachable today, as T43 said of the
  suppressed receipt row, and right to keep for the same reason.
- **Only after a REAL comp.** Refused (mock 400 on the write): 502
  `Refused by the mock`, `ambiguous: false`, the mock saw two checkouts
  and no note, `[comp] prod sale=none outcome=refused ... kind=trade
  for=none teacher=100 error="Refused by the mock"`. Ambiguous (socket
  destroyed on the real write): 502 "It MAY have gone through",
  `ambiguous: true`, no note, `outcome=ambiguous ... error="fetch
  failed"`. The comp branch reaches `fileFormulaNote` only after
  `checkoutCart` resolved, and only when `outcome.suppressed` is null.
- **Never for the house client.** `clientId` omitted, sent as
  `100000777`, and sent as ` 100000777 ` (trimmed before the compare):
  each a real comp, no note, `[comp] formula-note skipped: house
  client`, `client=house` or `client=100000777` on the receipt line.
- **A failed note never changes the answer.** Note refused (400), an
  answer with no `Id`, the socket destroyed mid-request, and the hang:
  each `200 {ok: true, method: "comp", total: 233, saleId: "777001"}`,
  the log `[comp] formula-note failed: Note refused by the mock` / `no
  note id in the answer {...}` / `fetch failed` / the 8s line, and the
  receipt line without `note=`. The catch is inside `fileFormulaNote`
  and `recordComp` cannot throw (T43 review).
- **The note text.** A detail with newlines, `\r\n`, quotes,
  backslashes and `{"json":1}` arrived JSON-encoded in the body
  (`"Note":"Comped $233.00 at the counter: Goodwill. Note: line
  one\nline two\r\n\"quoted\" \\ back {\"json\":1}. By Pete Stewart.
  Sale 777001."`); 200 quote characters likewise. It is one string
  field in a JSON body, never a path or a query; Mindbody stores free
  text. The teacher's name is from the signed cookie, the staff name is
  resolved by id, the sale id is Mindbody's. `forStaffName: "Nobody
  Real"` and `forStaffName: 42` both filed `Teacher (Kim Farrell)`.
- **Validation before any Mindbody call.** 32 requests answered 400
  with the mock's call count unmoved across the whole batch (the staff
  cache warm from the login): the implementer's list plus `null`, an
  array, `"OTHER"`, `detail: null`, `other` with no `detail` key, 100
  spaces + 201, `forStaffId: null` on teacher and on goodwill, a
  negative id, `1e400` (Infinity), `damaged` with an id, and `comp`
  with no `compReason`. Trim then measure: 3 spaces + 200 y + 3 spaces
  passed as 200 and 100 spaces + 201 x is 400. The teacher-id check is
  the cached staff read: cold, one metered GET `/staff/staff`, a read
  and never money; with nothing cached and Mindbody refusing, the same
  `listTeachers` answered the login 502 `Could not read the staff list
  from Mindbody: Staff read refused by the mock` and nothing followed.
- **The rendered line and the done screen.** `Teacher: Kim Farrell,
  covering for Pete`, `Teacher: Kim Farrell`, `Goodwill`, `Other:
  spilled tea on the mat`, `Trade: for a class`, `Damaged item`; the
  done screen `Comped: Teacher (Kim Farrell)` at 19px with `covering
  for Pete` under it at 17px in `--muted`, and `Comped: Goodwill` with
  no second line. The log line carries `kind=<kind> for=<id|none>
  teacher=<id> note=<id>` as the ticket shows.
- **Migration 4** is five `ADD COLUMN IF NOT EXISTS`; the runner skips
  `version <= current` in array order, so a database at 3 runs only 4
  and a fresh one 1 to 4. The insert has fourteen placeholders and
  fourteen values in the same order.
- **`GET /api/staff`.** 401 `unauthorized` with no device session; 401
  `reason: "teacher"` with the device session alone; after the login
  `[{id, name}]` x 5 and the union of keys across rows is exactly `id,
  name`; three opens after the login cost zero mock calls; with
  Mindbody refusing and the cache warm still 200 (the stale list, as
  the login serves it); cold and refused, 502 `{error}` with the
  message only. With auth disabled `requireTeacher` lets it through,
  the posture of every write it feeds; `/api/teacher` stays
  device-only because it is what says whether a teacher exists.
  Dev-mode note, not a bug: `next dev` compiles a route on demand with
  a fresh module instance, so in the dry-run run the first
  `/api/checkout` after the login re-issued a token and re-read staff;
  in the main run, where checkout had been compiled before the login,
  the 400s and the staff opens cost nothing, which is what the
  production build does throughout.
- **The dialog.** Namesake (Pete Stewart and Pete Jones, roster
  "Pete"): nobody preselected, Comp disabled "Choose the teacher".
  "KIM FARRELL" preselects Kim Farrell; "kim" preselects Kim Farrell
  (Jordan Kim is a last name); "  Sam  " Sam Lee; "Nobody", "" and
  null nobody. Kim picked then Goodwill: the list is gone and Comp is
  on; Teacher again preselects Pete, which is only possible because the
  switch cleared `forStaffId` (the preset applies to an empty
  selection). `staffCalls: 1` across Goodwill/Teacher switches, Back to
  items, the return and a new hold. Tab order: chips, every row, the
  note field, Cancel, Comp; Shift+Tab from the field lands on the last
  row and Space selects it. With the dialog open, the bar's button
  focused by script and Enter sent nothing (`requests: 0`, the bar
  `Due $253.22` disabled). Two fingers (a cash line, a mouse hold on
  Comp, a scripted Charge at 200ms, the hold landing over
  "Charging..."): `dialog: 0`, Comp disabled, one request with `method:
  "cash"` and no `compReason`, "Sale complete". CDP touch: the hold's
  lift leaves the dialog up, a touch on the Teacher chip and a row
  selects Kim Farrell, a touch tap on the scrim closes. Back to items
  with goodwill armed: "Comp was cleared."; the next hold has no chip
  on, no list and an empty field. `compValid` in `chargeable` re-checks
  the armed reason in the same render as before.
- **Conventions.** Every colour in the new CSS resolves to a token in
  both palettes (chip and chosen row `--accent`/`--accent-ink`: light
  rgb(15,92,85) on white, dark rgb(95,210,164) on rgb(11,26,20); rows
  on `--bg` with `--line`; the detail line `--muted`); nothing in the
  dialog under 16px; no target under 64px; no em dash in the three
  commits or this one. The mock logged the checkout keys as
  `Items,ClientId,Test,LocationId,InStore,CalculateTax,Payments` for
  every rehearsal and `Items,Payments,ClientId,Test,LocationId,InStore,
  CalculateTax,SendEmail` for every write, twenty of each, exactly
  T43's; `git diff 8da2d6c..HEAD -- src/lib/sale.ts` is empty, and the
  route's diff since T44 adds the compReason 400s, the staff 502 and
  the note without removing or rewording any existing response.
  `typecheck` and `build` clean.

Left as the ticket says, plus: a note that files after the 8s bound
has no id on the receipt; the dev call log has it.

## T46. The check-in screen on any day (Pete, 2026-09-02)

Pete: "there's no reason we can't allow for the checkin screen to
support days other than the current one. We should have a calendar icon
next to the drop down with a date selector. we can support past dates as
well, but probably no edits would be allowed for those, or we could gate
them behind a teacher PIN."

### The design (decided)

Past days are allowed, attributed and bannered; no second PIN. T44
already puts the teacher on every write, so a past-day edit is exactly
as accountable as a live one, and a second gate would be a slower way
of saying the same thing. Future days are booking only.

1. **A calendar control** beside the class dropdown: a 64px outlined
   button (`.cal-btn`, the `.class-change` shell) with a calendar glyph,
   and the chosen date as text on any day but today. It opens a modal
   month grid in the app's own idiom, never the OS picker: month title
   with 64px previous/next, a weekday header, 64px day cells (44px
   floor on a narrow screen), today ringed with the accent, the chosen
   day filled with it, `Today` and `Cancel` at the foot. Escape and the
   scrim close it; it stacks like the other modals.
2. **Picking a day** fetches that studio-local day's classes through the
   existing `GET /api/roster?day=1&anchor=` (T27 round three), one
   metered call, and puts them in the class dropdown, selecting the
   class nearest to this time of day (at 6:15pm, "last Monday" most
   likely means last Monday's evening class). `Today` returns to the
   around-now window exactly as the app starts. State is
   `viewDate: string | null`, a studio-local `YYYY-MM-DD`, null for
   around now; the dropdown, the header and the roster read the same
   `classes` array in both modes.
3. **The header says so.** A quiet `Viewing Thu Aug 27` line under the
   header row, and a 16px banner row above the roster in the warn pair:
   `Editing a past class. Every change is recorded with your name.` for
   a past day, `A future class. Booking only; check-in opens on the
   day.` for a future one. The mode banner at the top is untouched.
4. **Past days: allowed.** Check-in, undo, cancel and walk-in booking
   work as they do today; every write already carries the teacher
   (T44), and the outcome log lines gain nothing new.
5. **Future days: booking yes, check-in no.** On a class whose date is
   after the studio's current day the chip renders as `chip future`
   (muted pair, disabled, `title="Check-in opens on the day"`) and
   `tapCheckIn` refuses before the waiver gate, so no path reaches the
   API. Walk-in booking, waitlist moves and cancellations stay enabled.
   A class earlier or later TODAY is not future and behaves as before.
6. **Fetching only for today.** There is no roster polling loop to
   pause (a roster loads on class select and after each write's
   `refreshRoster`, never on a timer); what is gated is the
   settings-driven around-now classes fetch, which stands down while
   another day is showing and runs again on the return to today.
7. **Buy stays anchored on now.** The attach picker keeps using
   `activeId`, so a past-day class can be the "current class" a client
   is attached from; nothing about pricing or the sale changes.

### What was built

- [x] **One per-day cache for both readers.** The attach picker's
      single-slot `{key, list}` cache became `dayClassesCache`, a Map
      keyed by studio date, plus `dayClassesInFlight`, a Map of the
      flights themselves, both behind `loadDayClasses(key)`: a cached
      day resolves at once, a day already on the wire hands back that
      promise, and only a new day fires the call. The attach modal's
      open and the calendar's pick both go through it, so a day the
      teacher viewed costs the attach dropdown nothing and vice versa.
      The anchor is the day's studio-local NOON as a naive string
      (`parseRosterAnchor` reads it in STUDIO_TZ), as far from both
      midnights and any DST edge as an anchor can sit. Class lists
      only, for the page's life; no rosters, passes or clients.
- [x] `pickViewDate(key | null)`: bumps `viewGen` (a late answer for a
      superseded pick is dropped, and so is an around-now answer that
      a pick overtook), sets `viewDate`, loads the day, selects
      `nearestClassId`, syncs `?classId=`. A day with no classes clears
      the roster so the previous class's rows cannot linger under the
      new banner; the header row still renders, with the calendar
      button in it, or there would be no way back but a reload. The
      same is now true of an empty around-now window at 3am.
- [x] Date helpers are pure `YYYY-MM-DD` arithmetic (`studioToday` via
      Intl en-CA in STUDIO_TZ, `keyToDate`, `dateKey`, `dayKeyLabel`,
      `isFutureDay` as a string compare on the naive startsAt's date
      part, `studioMinutesNow` for the nearest-class pick). No instant
      is ever built from a wall-clock string, the T27 round three
      lesson.
- [x] The header row: `.class-pick` is capped at `min(340px, 28vw)` so
      the date text on the day control cannot push the counters onto
      a second line at 1080 wide (a wrapping flex row packs by content
      width, so a merely shrinkable item still wraps); the class title
      ellipsizes past the cap, the dropdown carries the full line.
- [x] CSS: `.cal-btn`, `.cal-btn.viewing` (accent outline),
      `.class-viewing`, `.class-none`, `.day-banner`, `.modal.modal-cal`
      (520px so seven 64px cells and their gaps fit), `.cal-head`,
      `.cal-nav`, `.cal-grid` (`repeat(7, minmax(44px, 64px))`),
      `.cal-wd`, `.cal-day` with `.today` and `.sel`, `.chip.future`.
      Tokens only, both palettes; 16px floor; 64px targets.

### Verified (mocked Mindbody, real dev server, both palettes, 1180x820 and 1080x768)

`scratchpad/t46-mock.js` answers `/class/classes` BY THE REQUESTED
WINDOW (five slots on every day, one cancelled, ids derived from the
date) with a mutable per-class roster; `t46.js` drives the page.
Screenshots under `scratchpad/t46/`: the calendar open (64px cells, 68px
pitch, both nav buttons 64px, today ringed and selected), a past day
with its banner and the `Viewing Thu Aug 27` line, a check-in on it
(the row goes green through the real `/api/checkin`, the mock logs the
`updateclientvisit`), a future day with every chip `chip future`,
disabled, titled, and a forced click on one reaching no API; Today
restored with no banner and no line. Escape closes the calendar.

Mindbody calls by the mock's count:

- pick a day: `/class/classes` whole-day window 1, around-now window 1
  (that one is `classRoster`'s own summary lookup inside
  `?classId=`, pre-existing on every roster load), `classvisits` 1,
  `clients` 1;
- pick it again: nothing;
- switch class within it: the roster only (`classvisits` 1, `clients`
  1, plus the same pre-existing around-now summary call);
- back to Today: the around-now list 1, exactly the app-start fetch,
  plus that class's roster.

So the new cost is one whole-day call per day for the page's life, and
today's budget is unchanged. `typecheck` and `build` clean.

### Open

- **A past-day `updateclientvisit` is unverified live.** The Mindbody
  web app allows signing someone into a past class, and the vendored
  spec (`docs/mindbody-openapi/client.yml`, `/client/updateclientvisit`)
  documents no date restriction, but nobody has watched the API accept
  one. If it refuses, the row's existing failed state and the reason
  line are the honest answer, and the fix is a banner-level note.
- The `?classId=` in the URL names a class on the viewed day; a reload
  lands on the around-now window (the class is not in it) and quietly
  corrects the param. Carrying `?day=` in the URL is a small follow-up
  if a reload mid-audit turns out to matter.
- ~~`classRoster` still spends an around-now `/class/classes` call for
  the class summary on every roster load; on a past-day class that
  lookup can never hit.~~ Closed by the review below: `summary=0`.

### Review (separate reviewer), T46

Hunted in the order set: writes on the wrong day, the roster route's
wasted call, date arithmetic, cache and budget, UI, and the money and
check-in paths. Mocked Mindbody with delays, a failing day, an empty
day and a long class name (`scratchpad/t46-review-mock.js`,
`t46-review.js`; logs and screenshots under `scratchpad/t46-review/`).
Two real defects and one misleading state fixed; the rest held.

- **REAL: `Today` while the app-start fetch was still on the wire left
  the screen on "No classes in the next few hours" for good.**
  `pickViewDate(null)` bumped `viewGen` unconditionally, so the
  around-now answer already in flight was dropped as superseded, and
  since `viewDate` was null already the effect did not re-run to fetch
  again. A teacher who opens the calendar in the first second and taps
  Today (plausible: the calendar is the new thing on the screen) got a
  header with no class until a settings change. Sequence R1 (a 2.5s
  around-now delay, Today tapped at once): before, `none: "No classes
  in the next few hours"`, `classes:now` 2 and nothing rendered; after,
  the 12:00 class and its roster land. Fix: Today with today already
  showing is a no-op (a `viewDateRef` readable at call time), so the
  fetch on the wire keeps its generation.
- **REAL: a failed day fetch captioned today's roster with the other
  day.** `viewDate` was set before the load, and on failure only
  `viewError` was written, so the header line read "Viewing Thu Aug
  27", the day control showed Thu Aug 27 in the accent, the banner said
  "Editing a past class", and the class button and every row were
  today's 9:00 (R5 before, `when: "Wed Sep 2 · 9:00 AM"` under
  `viewing: ["Viewing Thu Aug 27"]`). The rows were the right class for
  their own writes, so no write went to the wrong day, but a teacher
  reading the header would have believed otherwise. Now the failure
  clears the class (header keeps the calendar button and the error
  note, the line reads "Could not load Thu Aug 27."), the day is not
  cached, and the next pick fetches again (R5 after: `classes:day` 2,
  the retry renders Thu Aug 27 · 12:00 PM).
- **The same banner showed while a day was loading** (R6 before:
  "Loading Thu Aug 27..." with "Editing a past class" over today's
  rows). The banner now reads the CLASS's date, like `futureClass`
  already did: `pastClass` is `startsAt` date part `< todayKey`. That
  also covers the overnight case, where a day picked as tomorrow
  becomes today at midnight and would have been captioned past.
- **The wasted call, closed.** `GET /api/roster?classId=` spent an
  around-now `/class/classes` per roster load to fill name, teacher,
  capacity and booked; for a class on another day it could never hit
  (`curl` on a past id: `"name":"Class","startsAt":"","capacity":null`)
  and the page never read those fields from it, since the header takes
  them from the day's list. The page now sends `&summary=0` whenever
  another day is showing and `classRoster(id, {summary: false})` skips
  the lookup. Switching class within a viewed day went from
  `classes:now 1, classvisits 1, clients 1` to `classvisits 1, clients
  1` (R8). Today's path is untouched: its list call still refreshes
  `booked` after a booking. Known trade: on a viewed day `booked` is
  the cached list's until Today, so `classFull` can lag by the
  teacher's own bookings there; Mindbody refuses an overbooking anyway
  and the "signed up" counter is `entries.length`, which is live.
- **The class button's cap replaced by slack-filling.** `max-width:
  min(340px, 28vw)` truncated "Bikram Yoga - Pete Stewart" on TODAY at
  1080 with 100px of row to spare (the T46 screenshot shows "Bikram
  Yoga - Pete..."). `.class-pick` is now `flex: 1 1 0` with a 240px
  floor: a zero basis never asks the wrapping row for room, so the
  counters stay on the line, and the title grows into what the other
  controls leave (440px on today at 1080, 330px on a viewed day; at
  820 portrait the counters wrap as they did). A long name still
  ellipsizes ("New Student 2 Week Unlimited..." at 1080) and the
  dropdown carries the full line unclipped at 520px. No horizontal
  overflow at 820, 1080 or 1180.

Held, with the sequence that proved it:

- Writes go to the class on screen. Past day, check-in: `VisitId
  2026082720` (the Aug 27 12:00 class's row). Past day, walk-in book:
  `addclienttoclass {ClassId: 202608270}`. Past day picked, Today
  tapped before it landed, then a check-in (R2): the day's answer was
  dropped by `viewGen`, the roster stayed today's and the write was
  today's visit. Day A then B before A landed (R3): B rendered, A
  cached quietly. A check-in whose answer came back 2.5s after Today
  was tapped (R4): the write went to the past visit, `refreshRoster`'s
  `activeIdRef` guard dropped its roster, and the screen stayed on
  today with no banner and no line.
- Future day: every chip `chip future`, disabled, titled; a forced
  click reaches no API (T46's own run); a disabled button is not in
  the tab order, and `tapCheckIn` refuses before the waiver gate on
  `activeStartsAtRef` regardless. Booking, waitlist and cancel stay
  open by design.
- Dates are studio-local end to end. With the browser clock at 06:30Z
  Sep 3 in `America/Chicago` (1:30am Nashville, 11:30pm Seattle) the
  calendar rings the 2nd (R9b). The past/future split compares the
  naive `startsAt` date part to the Intl en-CA studio date. The
  weekday and month names come from a Date built from y/m/d parts, so
  the browser's zone cannot shift them. `classesForDay` at the noon
  anchor: Nov 1 2026 asks `01:00 -> Nov 2 00:00`, Mar 8 2026 `Mar 7
  23:00 -> Mar 9 00:00`, month ends `Aug 31 00:00 -> Sep 1 00:00`:
  the DST-day edges are the documented hour (T27 round three) and
  cannot touch a 6am-9pm schedule. NOT A BUG.
- Cache and budget: a day picked twice costs nothing the second time;
  the attach picker on a past-day class lists that day (R8, zero
  calls); a failed day is not cached (above); the settings-driven
  around-now effect returns early while another day shows and the
  return to Today costs one list call plus the class's roster (R7:
  `classes:now` 1 net of dev-mode double effects).
- UI: the calendar is the only layer open when it can be opened (the
  button sits in the header, under every modal), so Escape closes it
  alone; 64px cells and nav at 1080 (T46's run); tokens only, both
  palettes (`--warn`/`--warn-bg`, `--accent`/`--accent-ink`, `--line`,
  `--muted` all defined in the dark block); no em dashes; 16px floor;
  an empty day renders the header with the calendar button (R7).
- `git diff 5aeaf59..HEAD -- src/app/api/checkin src/app/api/checkout
  src/lib/sale.ts src/app/SaleScreen.tsx` is empty.

`typecheck` and `build` clean.

## T47. Guest passes: how the member's pass reaches the guest (open, Pete, 2026-09-02)

What the data says (ai-manager's sales and visits tables, twelve months):
the auto-renew membership adds a $0 "Guest Pass (for auto-debit members
only)" to the MEMBER's account each month (100 of 106 recent guest-pass
sales are on member accounts); the visits paid with one are mostly
non-members, booked in Business Mode; and all 56 guest-pass visits since
2025-10 had a member attending the same class. The counter moment is
"Bella brought a friend", never a guest alone.

What only staff can say: which Mindbody screen makes the guest's visit
pull from the member's pass. Either (1) "pay with another client's
pricing option" on the sign-in screen, which rides Client Relationships
(member pays for guest), or (2) selling the guest a $0 Guest Pass at the
desk and booking against it (the six non-member sales look like this).

Why it decides the build: the API's booking and visit-payment calls take
a `ClientServiceId` the spec describes as "on the client's account"
(class.yml:3370), so handing the guest's visit the member's service id
may be refused. Mechanism 2 is entirely within what the app already does.

Next step once Pete has the answer: a write-guarded probe against two
dummy production clients (`POS_WRITE_CLIENT_IDS`), trying the member's
service id on the guest's visit. Accepted: a "guest of NAME" action on
the member's roster row. Refused: search the guest, sell the $0 pass with
the member as payer (`PayerClientId` exists on the checkout request),
book.

## T48. Teacher identity, take two: a PIN of your own, asked for by a comp (Pete, 2026-09-02)

Pete's live test of T44, his five points verbatim:

1. "we dont have phone #s for everyone"
2. "probably don't need to require a pin for everything. comp is
   something where we do"
3. "is it possible to use a mindbody sign in for identification of the
   teacher?"
4. "if we are going to do PINs we likely need to store them in our own
   db. even with phone #'s it's not impossible that 2 people could have
   the same last 4 digits"
5. "comp just let me right through without entering a PIN even though I
   selected Continue without a name at the front. that's exactly what we
   don't want"

Point 5 is the one that matters: his server had no `POS_PIN`, so T44's
teacher layer was optional there, and a real $2 comp went to Mindbody
with `teacher=none`. T48 replaces T44's design; T44's heading says so.

### The design (decided)

**A. No shift-level sign-in.** The "Who is at the counter?" prompt,
the `AuthGate` teacher step, the header badge and `requireTeacher` are
gone from app start and from every routine write (checkin, book,
cancel-visit, visit-payment, waiver-agree, purchase-contract,
client-field, and `/api/staff`). Routine writes carry no teacher; the
`waiver-agreed` log line dropped its `teacher=` field, since there is
no source for one. The T44 cookie, `/api/teacher`, `/api/teacher/login`,
`/api/teacher/logout` and `TeacherPrompt.tsx` are deleted, not kept.

**B. PINs are ours, stored hashed, unique.** Migration 5,
`teacher_pins (staff_id text primary key, name text not null, pin_hash
text not null, pin_lookup text not null unique, set_at timestamptz not
null default now(), set_via text not null)`. `pin_hash` is scrypt of the
PIN with a random per-row salt (`s1$<salt>$<hash>`); `pin_lookup` is
HMAC-SHA256 of the PIN under `POS_PIN_PEPPER` (review; falling back to
`POS_SESSION_SECRET`, then an app constant), so a check is one indexed
read and UNIQUE on it refuses a PIN another teacher holds ("That PIN is
taken, choose another."). 4 to 6
digits (`comp.ts` `PIN_MIN`/`PIN_MAX`/`isPinShape`, shared by the dialog
and the routes). The key is deliberately not the device PIN: rotating
`POS_PIN` must not orphan every teacher's PIN; rotating the key in use
does, and `.env.example` says so. No phone numbers anywhere: `staff.ts` reads
names and ids only, `pinDigits` and `noPhone` are gone. With no
`DATABASE_URL`, a dev-only `POS_TEACHER_PINS="100:1234,106:5678"` stands
in, refused with a warning on `MINDBODY_TARGET=prod`, a PIN listed twice
naming nobody. `src/lib/teacherpins.ts` holds all of it; a miss costs the
same scrypt as a hit, and the env list is compared constant-time with no
early exit.

**C. The comp gate ALWAYS asks, regardless of `POS_PIN`.** The comp
dialog is three steps: the reason (T45, its button now reads Next), then
"Who is comping this? Enter your PIN" with six dots, the amount pad's
keys (the keyboard stands in), Done from four digits, then "Comping as
Kim Farrell" with the reason line and the Comp button, which is the only
thing that arms. `POST /api/teacher/verify {pin}` (device session,
rate-limited on its own counter: five misses, 30s) answers `{ok,
teacher: {id, name}, token}`. The token is `c1.<staff id>.<name
b64url>.<issued-at>.<hmac>`, ten minutes, signed with the session key
when `POS_SESSION_SECRET` exists and with a random per-process key
otherwise (review: the build also used the session key with `POS_PIN`
alone, but that key is scrypt of the device PIN, which every teacher
knows; see the review below). The charge body carries `teacherToken`;
`/api/checkout` for `method: "comp"` verifies it right after the method
check, before the client, the reason and the staff read, and refuses
401 `{error, reason: "teacher"}` without one in every configuration; it
then SPENDS the token after every validation and before the rehearsal,
so a second charge on the same token, however it got there, is the same
401 with no Mindbody call. `teacherToken` beside any other method is
400. The receipt, the `[comp]` line and the Formula Note carry the
teacher the token names, never a name from the browser. `chargeable`
in the same render requires `comp.teacher` and `comp.token`; a refused
token sends the dialog back to the PIN step with the reason kept, arms
nothing and retries nothing. The page's fetch wrapper treats a 401 with
`reason: "teacher"` as the dialog's business, not the lock.

**D. Enrollment through a Mindbody sign-in** (point 3: yes). From the
PIN step, "Set up or change your PIN" opens a form: Mindbody username
(email), password, new PIN, 18px inputs at 64px. `POST
/api/teacher/enroll {username, password, pin}` calls `/usertoken/issue`
with THOSE credentials through `signInAsStaff()` in `mindbody.ts`, which
never caches the token, never logs the body and is never recorded in
the call log (like the service account's issue); reads `User.Id` and
the name; refuses `Id` 0 (the spec: "always 0 for Admin and Owner type
users") and any id not in `listTeachers()`; stores the PIN (B); revokes
the token with `DELETE /usertoken/revoke` (user-token.yml has it) in
the background; answers `{ok, teacher}` with the name as the staff list
spells it. Rate-limited on its own counter. Every Mindbody refusal is
the same 401 "Mindbody did not accept that sign-in.", so an unknown
username and a wrong password read alike. The password never touches a
log, a row or an answer. For a staff member with no Mindbody login:
`POS_TEACHER_PINS` in dev, or `PUT /api/admin/teacher-pins {staffId,
pin}` guarded exactly as `admin/banner` (device session, then
`devtoolsEnabled()`, else 404), with `GET` listing who has a PIN (id,
name, when, how; never a hash).

**E. The teacher picker filters placeholders.** `listTeachers()` drops
`Id <= 0` and names matching `/\b(tba|no class|front ?desk|account|
teacher|staff)\b/i` (`isPlaceholderTeacher` in `staff.ts`); the live
list carried "TBA .", "TBA TBA", "TBA Teacher", "No Class No Class", "No
Class Today" and "FrontDesk Account". The rule applies to the comp
picker, the enroll check and the admin route alike.

### What was built and checked

Node-level against `next start` on the T48 build, Mindbody mocked on
:4545 (`t48-mock.js`: `/usertoken/issue` answering BY CREDENTIALS,
`DELETE /usertoken/revoke`, six placeholder staff rows, a call counter),
in three postures (`t48-node.js`, logs under `scratchpad/t48/`):

- **db** (`POS_PIN=2468`, a local Postgres 16, `POS_DEVTOOLS=true`):
  migration 5 applied on first use (`schema_version` 1 to 5). A check-in
  with the device session alone reached the route (no teacher gate);
  `GET /api/teacher` is 404. `/api/staff` listed five teachers and none
  of the six placeholders. A comp with no token, a garbage token and a
  token forged under the wrong key were each 401 `reason: "teacher"`
  with the mock's checkout count unmoved; cash with a `teacherToken` was
  400. Enrollment: a two-digit PIN 400; Kim (`kim@example.com`) 200; Pete
  taking Kim's PIN 409 "That PIN is taken, choose another."; Pete on
  another PIN 200; Kim changing hers 200, after which her old PIN was
  401 and Pete's verified to a token; an unknown user and a wrong
  password the same 401 with the same words; the owner login 403; the
  front-desk login 403. The mock saw 9 issues and 6 revokes and no
  password anywhere in our logs. Admin: GET listed Kim and Pete as
  `mindbody-signin`; PUT for Sam with Pete's PIN 409, with another 200
  (`admin`), for placeholder 205 400. Kim's PIN verified to `{ok,
  teacher: {106, "Kim Farrell"}, token: c1.106.<name>.<ms>.<hmac>}`; the
  comp with it was 200 (rehearsal + write + note at the mock) and logged

      [comp] prod sale=777001 client=100000123 total=233.00 reason="Teacher: Pete Stewart, covering for Pete" kind=teacher for=100 teacher=106 note=555003

  with the note `Comped $233.00 at the counter: Teacher (Pete Stewart).
  Note: covering for Pete. By Kim Farrell. Sale 777001.`; the same token
  again was 401 with the checkout count unmoved. A token forged under
  the REAL key (scrypt of `2468`, the T21 derivation) dated 11 minutes
  back was 401; a fresh one was 200, which proves the derivation and the
  expiry both. A burst of eight wrong PINs answered five 401s and three
  429s; Kim during the lockout 429; the device login during it 200
  (separate counters); the enroll burst likewise.
- **env** (no `POS_PIN`, no database, `POS_TEACHER_PINS` with two
  teachers sharing 7777): the same gate results with no device session
  at all (the comp with no token still 401 before any call), Kim's PIN
  verified through the env list with her name from the staff read, the
  comp logged `teacher=106`, the shared 7777 named nobody.
- **none** (no `POS_PIN`, no database, prod target with
  `POS_TEACHER_PINS` set): the server logged `POS_TEACHER_PINS is set
  but MINDBODY_TARGET=prod; ignored`, verify was 503 "No teacher PINs are
  set up on this server", enroll 503 "No database to keep a PIN in", and
  the comp with no token 401 as everywhere.

`git diff -- src/lib/sale.ts` is empty; the mock logged the checkout
keys as `Items,ClientId,Test,LocationId,InStore,CalculateTax,Payments`
for the rehearsal and `Items,Payments,ClientId,Test,LocationId,InStore,
CalculateTax,SendEmail` for the write, T43's exactly, with `Payments:
[{Type: "Comp", Metadata: {Amount}}]`.

In the browser (`t48.js`, then `t48b.js`/`t48c.js` with a two-item cart
after the nine-item ring proved slow, `t48d.js` for the lockout DOM;
mocked `/api` in the page, shots under `scratchpad/t48/` at 1366x1024,
both palettes): the app start renders the desk with NO prompt, no
badge and no `/api/teacher` probe (`prompt: 0, badge: 0, teacherCalls:
0`, `*-1-start-no-prompt.png`). The hold opens the reason step with its
five chips and Next disabled; Goodwill with a note enables Next; Next
lands on "Who is comping this? Enter your PIN." with six ring slots,
eleven 66px keys, the 64px "Set up or change your PIN", Back and Done
(64px), nothing under 16px (`*-2-pin-step.png`). Three digits leave
Done off, the fourth turns it on; a wrong PIN clears the dots and says
"That PIN does not match any teacher." (`*-3-pin-wrong.png`); `5678`
typed on the keyboard with Enter lands on "Comping as Kim Farrell" over
"Goodwill: spilled tea" with the Comp button (`*-4-comping-as.png`);
Comp arms with the quiet line "Nothing to pay, on the studio. Comped:
Goodwill: spilled tea. By Kim Farrell." (`*-5-armed.png`); the charge
body was `{method: "comp", compReason: {kind: "goodwill", detail:
"spilled tea"}, teacherToken: "c1.106..."}` and the done screen read
"Comped: Goodwill" (`*-6-done.png`). The enrollment form: email,
password and PIN inputs, each 64px at 18px, Save PIN off until all
three are filled, the PIN field keeping digits only (`12ab34` became
`1234`); a wrong password showed "Mindbody did not accept that
sign-in." and cleared the password field, the post carrying it exactly
once; a taken PIN showed "That PIN is taken, choose another." and kept
the password (a review of the first run: the dialog had cleared it on
a 409 too, and Save went dark for a sign-in that had just succeeded);
`5678` then answered "PIN set for Kim Farrell. Enter it to comp." back
on the PIN step (`light-7-enroll-form.png`, `light-8-enroll-refused.png`,
`light-9-enroll-done.png`). With `/api/checkout` answering 401 `reason:
"teacher"` once: comp disarmed, no result rendered, and the dialog came
back on the PIN step with "Your PIN check ran out. Enter it again."
(`light-10-token-refused-back-to-pin.png`); Back from there kept Kim
Farrell selected and "covering for Pete" in the note. A 503 from verify
showed its message on the PIN step (`light-11-no-pin-store.png`); a 429
showed "Too many attempts. Try again in 30s." with all eleven keys and
Done disabled and typing adding no dot (`light-12-lockout.png`);
Escape closed the dialog with nothing armed and no charge sent.

### Left

- **A teacher's Mindbody login issuing a token through the studio's API
  key is unverified live.** `/usertoken/issue` has only ever been called
  with the API user; if Mindbody refuses other staff through this key,
  enrollment falls back to the admin route and `POS_TEACHER_PINS` is
  dev only. First thing to try on the studio, with Pete's own login.
- **`/usertoken/revoke` is best effort** and its answer is not read; a
  token nobody holds expires on its own.
- **The one-shot set is in memory**, per process, pruned by the ten
  minutes; a restart forgets it and (with no `POS_PIN` and no secret)
  the key too, so a token from before a restart is refused, which the
  dialog handles.
- **Changing the PIN lookup key orphans every stored PIN** (`POS_PIN_PEPPER`,
  else `POS_SESSION_SECRET`, else the constant); teachers enroll again.
  Documented in `.env.example`.
- Every enroll attempt, including a 400 shape error and a 403, claims a
  slot on the enroll counter, as T44's login did; conservative rather
  than wrong.
- Mindbody still attributes every sale and check-in to the service
  account (the payroll caveat in the design doc's question 3).
- What T44 leaves behind: migration 3's `teacher_id`/`teacher_name`
  columns on `comp_receipts`, now filled from the comp token; the
  limiter factory; the `safeEqual`/`sign` helpers the comp token reuses.
  Its cookie, prompt, routes and phone reading are gone.

### Review (separate reviewer), T48

Read as a security review first, against `ef78200`, `3b84155`, `48d7290`
and `ddcface`; the T48 build rebuilt and run under `next start` in five
postures against the T48 mock (`scratchpad/t48-review/`: `review-node.js`,
`node-*.log`, the browser harnesses re-run as `t48b/c/d-review.js`, shots
`dark-1..6`, `light-7..12`), plus one `next dev` run.

**REAL, fixed: a comp token could be minted by anyone who knows the device
PIN.** With `POS_PIN` set and no `POS_SESSION_SECRET` (the posture the
build's own db run used), the comp token was signed with the session key,
which is scrypt of the device PIN and a public salt. The device PIN is the
one secret every teacher at the counter knows, so anyone who can unlock
the iPad could sign `c1.<any staff id>.<any name>.<now>.<hmac>` and comp
as a colleague with no PIN typed; the build's harness even proved it
("a fresh one was 200, which proves the derivation"). That is the T48 bug
through a different door. Sequence: `POS_PIN=2468`, no secret, device
login, `POST /api/checkout {method: "comp", teacherToken: forge(106, "Kim
Farrell", now, scrypt("2468", KEY_SALT, 32))}` was 200 with a sale at the
mock. Fix in `auth.ts` `compTokenKey()`: the session key signs comp tokens
only when `POS_SESSION_SECRET` is set; otherwise the random per-process key
(the no-PIN path already had it). Cost: without the secret a restart
mid-dialog asks for the PIN again, which the dialog handles and
`.env.example` now says. Verified: the same forge is 401 with the mock
unmoved, a token from before a real restart is 401 (`node-restart.log`;
the first attempt at that test had left the old server running behind
`EADDRINUSE`, so kill by port, not the npx pid), and under a secret the
device-PIN forge is 401 too.

**Made, small: `POS_PIN_PEPPER`.** The lookup HMAC was keyed on
`POS_SESSION_SECRET`, whose rotation has another job (revoking every
session and, now, every comp token); tying every teacher's PIN to it made
that rotation cost a re-enrollment for the whole staff. `teacherpins.ts`
`lookupKey()` now reads `POS_PIN_PEPPER` first, then the session secret,
then the constant, so an existing deploy changes nothing until the pepper
is set. `.env.example` documents it. Seen in passing: two servers on one
database with different keys orphan each other's rows, which is the
documented behaviour and the reason to set the pepper once.

**Hunted and NOT A BUG**, with the request:

- The gate: no token, `null`, a number, a six-part token, an expired token
  under the real key, a garbage signature, a token under a previous
  process key, `teacherToken` beside cash or a split (400): every one 401
  `reason: "teacher"` (or the 400) with the mock's checkout and total
  counters unmoved, in all of db, pin, env, prod-with-env-pins and
  no-store postures. The signature is compared constant-time
  (`safeEqual`, sha256 both sides) before the issued-at is parsed; the
  shape checks before it are on public structure only. The token carries
  id, name (base64url, `[A-Za-z0-9_-]*`), issued-at and the HMAC, nothing
  else; the verify answer is `{ok, teacher, token}` and nothing else.
- Spend order: spent after every 400-class check and before the
  rehearsal. A refused write (mock client 100000999: 502, two checkout
  calls) then a replay of the same token: 401, checkout unmoved. A 400
  (bad reason) leaves the token usable. Two concurrent charges on one
  token: one 200, one 401, two checkout calls (rehearsal and write of the
  winner), because `spendCompToken` is synchronous. Spending before the
  rehearsal is right: a refused or ambiguous charge is a second decision
  and should cost the PIN again; the dialog says why.
- Token for Kim with `forStaffId` Pete: 200, the receipt and note name Kim
  (the token), Pete is the "for". That is the design: the comper and the
  beneficiary are different people.
- PIN storage: `pin_hash` is `s1$<16-byte salt>$<scrypt 32>`, checked
  with `timingSafeEqual`; a miss runs the same scrypt against a real hash
  of a seven-digit PIN. UNIQUE `teacher_pins_pin_lookup_key` is read back
  by constraint name and reported as "taken" with no id; a teacher
  re-setting their own PIN is 200, not "taken" (the upsert is by
  staff_id). `1234567` and `5678` (a number) are 400 at both routes.
  `POS_TEACHER_PINS` on `MINDBODY_TARGET=prod`: the warning line logged,
  verify 503, the comp still 401. The admin route's `gate()` is
  character-for-character the banner route's (session, then
  `devtoolsEnabled()`, else 404): 401 with no session, 404 with devtools
  off; `listTeacherPins` selects `staff_id, name, set_at, set_via` only.
- Enrollment: `signInAsStaff` and `revokeStaffToken` are plain `fetch`
  with no `record()` (the four `record` calls in `mindbody.ts` are all
  inside `mindbody()`), and an enroll on a `POS_DEVTOOLS=true` server put
  nothing in `/api/devlog`. No `console` line in the route or the client
  carries the body; the transport catch answers a fixed string and the
  server logs no stack (`node-outage.log`, mock stopped: 502 "Could not
  reach Mindbody to check that sign-in."). Wrong password and unknown
  user answer the identical body. `Id` 0 is 403, an id outside
  `listTeachers()` 403, both after the revoke was started; revoke has a
  10s `AbortSignal.timeout` and swallows everything. Own limiter: the
  enroll burst never touched the device door. `grep -n "secret\|nope\|
  password" server-*.log` is empty.
- Removal: no `requireTeacher`, `teacherFrom`, `TeacherPrompt`,
  `pinDigits`, `noPhone` or `api/teacher/login` anywhere under `src/`,
  the docs or `.env.example`; every route still calls `requireSession`
  (grep count per file). The page wrapper locks on any `/api/` 401 whose
  body lacks `reason: "teacher"` and leaves that one to the dialog; the
  dialog's 401 branch disarms comp, keeps the reason and lands on the
  PIN step (`light-10`). Every `.teacher-*` rule is gone from the CSS and
  each new class (`reason-sub`, `pin-dots`, `reason-link`, `reason-who`)
  is used; no hex in the component, no em dash in either commit.
- The dialog, from the harness DOM: eleven 66px keys, three 64px buttons,
  no font under 16px on the PIN step; three 64px inputs at 18px on the
  enroll form; Done off at three digits and on at four; wrong PIN clears
  the dots; the keyboard's digits, Backspace and Enter drive the pad on
  the PIN step only; the lockout disables all eleven keys and Done and
  typing adds no dot; a 409 keeps the password and a 401 clears it;
  Escape closes with nothing armed and no charge; `chargeable` reads
  `comp.teacher.id > 0 && comp.token.length > 0` in the same render as
  `!reasonOpen`, and `armComp` still refuses on `chargingRef`; the scrim
  closes only on a click whose pointerdown was on it. `resetCompSteps`
  runs on open, close and disarm, so a token never outlives its dialog.
- Money path: `git diff a762fa3..HEAD -- src/lib/sale.ts` is empty; the
  checkout route's diff is the two gate blocks and `gate.teacher` becoming
  `teacher`, nothing in the payload, the outcome wording or `inFlight`.
- `ddcface`: `state` is `globalThis.__posCallLog ??= {...}`, `record`,
  `recent` and `clear` all go through that one object (`clear` empties
  `state.entries` rather than rebinding a module variable), and nothing
  else imports the buffer. Under `next start`: DELETE took the log from
  one entry to zero and the next uncached call appeared. Under `next dev`
  with no PIN and no secret, a token from `/api/teacher/verify` verified
  at `/api/checkout` after a third route had compiled, so the per-process
  key and the spent set are one instance across routes in dev too; an
  edit to `auth.ts` mid-dialog would reset them, which is a PIN re-entry.

**Left, recorded:** the database path of `verifyTeacherPin` does not
re-check the row's staff id against `listTeachers()`, so a teacher who has
left the studio keeps a working comp PIN until someone changes it (the
admin route can overwrite it; there is no delete). And the review's fix
means a deploy with `POS_PIN` and no `POS_SESSION_SECRET` now forgets comp
tokens on restart, which the `.env.example` note and the dialog cover.

## T49. Mindbody sign-in: writes run as the teacher (Pete, 2026-09-02)

Pete, on T48: "Mindbody sign-in might be the right move then. today
that's what they already do, and this probably makes observability
better, assuming MB tracks who made sales, etc." Decided: the app acts AS
the signed-in teacher for every write, so Mindbody attributes check-ins,
bookings, pass changes, the waiver release and sales to them; T48's comp
PIN gate stays on top as deliberate friction. Nothing requires a sign-in
and nothing prompts at start: with nobody signed in every write runs as
the service account exactly as before.

### The design (decided)

**1. A staff session** (`src/lib/staffsession.ts`). `POST
/api/teacher/signin {username, password}` calls `signInAsStaff` (T48's
one call to `/usertoken/issue` with the teacher's own credentials),
refuses `User.Id` 0 (owner/admin) and any id not in `listTeachers()`,
revoking the token at once in both cases, and otherwise keeps the
Mindbody `AccessToken` SERVER-SIDE in memory only: a Map on `globalThis`
(like the call log, so a dev recompile does not sign everyone out) from
an opaque random id to `{staffId, name, token, issuedAt}`. Never in the
database, never in the call log, never in an answer. The browser gets
`pos_staff=s1.<24 random bytes, base64url>.<hmac>`: HttpOnly,
SameSite=Strict (the device cookie is Lax; nothing arrives from another
site carrying a teacher's identity), Secure in production, twelve hours
from sign-in, not sliding. The HMAC key is random per process, on
purpose: the sessions are per process, so a key that survived a restart
would sign cookies for entries that did not. Verification is
constant-time (`safeEqual`) before the Map lookup. A restart forgets
every session; the cost is one sign-in from the header. A sign-in over
an existing session replaces it and revokes the old token (a shift
change is signing in as the next teacher). `POST /api/teacher/signout`
drops the entry, revokes (best effort, bounded by `revokeStaffToken`'s
10s) and clears the cookie. `GET /api/teacher` answers `{teacher: {id,
name} | null}`. The sign-in route mirrors enroll's discipline: its own
limiter (`claimSigninAttempt`, five then 30s; every attempt, a 400
included, claims a slot, as enroll's does), one 401 wording for an
unknown user and a wrong password, the password in no log, row or
answer.

**2. Writes run as the teacher.** `mindbody()` takes `actor?: {token,
staffId, name}`; when present the `Authorization` header is the
teacher's token on that call only, and the call log entry carries
`actor: <staffId>` (never the token; suppressed calls carry null). Dry
run and the write guard run first and apply exactly as before. The
service account's own 401 retry (forget the token, reissue) is skipped
for an actor call: a refusal under a teacher's token is the ROUTE's
decision. Every write route resolves `actorFor(request)` once and runs
its write through `runAsActor` (`src/lib/actor.ts`): checkin, book,
cancel-visit, visit-payment, waiver-agree (both the release and the
notes append, the append under whatever the release landed under),
client-field, purchase-contract (the real purchase; the Test rehearsal
stays on the service account) and checkout (every `checkoutCart`,
`purchaseCredit` and the Formula Note; the rehearsal stays on the
service account). Reads (roster, search, catalog, the checkout
rehearsal, the sale-id lookup) stay on the service account.

**3. Permission failures are loud, and the counter keeps working.**
`isActorRefusal`: a 401 or 403, or Mindbody's "permission" wording, on a
4xx only (a 5xx or a dead transport says nothing about permissions and
for a money write must stay ambiguous). On it, `runAsActor` logs
`[actor] fallback staff=<id> route=<path> reason="<message>"`, retries
ONCE as the service account, and the answer carries `actorFallback:
{name, reason}`; the UI renders `actorFallbackLine` in amber: "Done as
the studio account: Kim Farrell's Mindbody login lacks permission to
launch the sign-in screen." on the roster row (check-in, pass change,
the pay dialog's writes), on the done block (a sale, a contract), or as
a 20-second banner under the mode banner for writes with no row (a
booking, a promotion, a cancel, the waiver). Safe on a money write: the
refusal is a 4xx, refused at the gate, nothing charged, the same reading
`/api/checkout` has always applied. A 401 under the teacher's token is
`isActorTokenDead`: the staff session ends (`[actor] token refused
...`), the fallback still runs, the answer adds `staffSessionEnded:
true` and the header control goes back to "Sign in" with the row line
"...'s Mindbody sign-in ended (<message>). Sign in again." The comp is
the exception: `runAsActor(..., {fallback: false})`, so a comp Mindbody
refuses under the teacher is REFUSED with the message (502, the `[comp]
... outcome=refused` line), never done as somebody else; the session
still ends on a dead token.

**4. The probe.** `GET /api/teacher/probe` for the signed-in teacher
reads `GET /staff/staffpermissions?StaffId=<id>` UNDER THE TEACHER'S
TOKEN, reading the live top-level shape and the schema's `UserGroup`
wrapper both, and answers `{teacher, tokenOk, group, ipRestricted,
allowed: [{name, allowed}] (the six), denied: [...all], sale}`, where
`sale` is a `Test: true` price of a one-line cart holding the cheapest
priced pricing option (a service, sellable at every location, so the
sound test) attached to the house client, under the teacher's token:
`{ok, total, item}`, `{ok: false, error}`, `{suppressed}` under dry run,
or `{skipped}` with no house client or an empty catalog. A 401 on
either read ends the session and answers 401 `reason: "teacher"` with
`staffSessionEnded`. The signed-in modal shows it as one line ("Kim's
Mindbody account can check in, book, and sell." or "Pete's Mindbody
account cannot: check in (LaunchSignInScreen); sell (MakeSales); price
a sale (You do not have permission to perform sales).") over the six
with ticks and crosses and the Test-price line, with "Run probe again";
the dev drawer's Settings tab has the same view under "signed-in
teacher" with "Run probe", and its calls tab shows `actor=<id>` on
every call that ran as a teacher.

**5. The header.** Beside Buy, where T44's badge was: a 64px
`class-change` control reading "Sign in" or the teacher's first name.
It opens `StaffModal.tsx`: signed out, email and password (18px inputs
at 64px, `autoComplete="username"` / `"current-password"`), Cancel and
Sign in (off until both are filled; the password leaves state the
moment it is sent, a refusal shows the route's message); signed in, the
name, "Signed in to Mindbody. Check-ins, bookings and sales from this
iPad are recorded under this login until sign-out or twelve hours.",
the probe, Close and Sign out. Escape and the scrim close it. Nothing
prompts at app start; `GET /api/teacher` is read once so the control
reads the right thing.

**6. The numeric sale id.** `checkoutshoppingcart` answers
`ShoppingCart.Id`, a GUID, which is not the number on Mindbody's own
receipts. After a REAL (not suppressed) checkout, `latestSaleId`
(sale.ts) reads `GET /sale/sales` over today's studio-local window
(`studioWall`; the endpoint takes `StartSaleDateTime`,
`EndSaleDateTime`, `Limit`, `Offset`, `SaleId`, `PaymentMethodId` and
NO client parameter, sale.yml:992, so the client is filtered here on
`Sale.ClientId`) under the service account, bounded at 8s, and picks the
highest `Sale.Id` for the client (the house client when unattached)
that this process has not already handed out. The answer's `saleId` is
that number, else the GUID as before; `cartId` is always the GUID. The
done screen reads "Sale 425874."; the comp receipt's `sale_id` holds
the number when found and the GUID otherwise, `cart_id` (migration 6,
additive, nullable) the GUID always; the Formula Note reads "Sale
425874." A failed, hung or ambiguous lookup is one `[sale-id]` line and
the GUID; nothing about the outcome changes. Cost: one read after each
real checkout, and on a comp the Formula Note waits for it (worst case
8s + 8s).

**7. Docs.** This section; CLAUDE.md's known gap and permissions
bullet; the design doc's question 3, answered a third time.

### `src/lib/sale.ts`, every hunk

`git diff -- src/lib/sale.ts` is eleven hunks and nothing else:

1. `@@ -30,7 +30,8` the import: `type Actor` from mindbody, `studioWall`
   from roster (for the sale-id window).
2. `@@ -579,6 +580,10` `priceCart` gains `actor?: Actor | null` (only the
   probe passes one; the checkout rehearsal never does).
3. `@@ -626,6 +631,7` the stub pricing call: `...(actor ? { actor } : {})`.
4. `@@ -649,6 +655,7` the bare retry: the same spread.
5. `@@ -824,6 +831,9` `checkoutCart` gains `actor?: Actor | null`.
6. `@@ -850,6 +860,7` its `mindbody()` call: the same spread, after
   `clientId`; the body object is untouched.
7. `@@ -912,6 +923,8` `purchaseCredit` gains `actor?`.
8. `@@ -927,6 +940,7` its call: the spread.
9. `@@ -1304,6 +1318,8` `purchaseContract` gains `actor?` in its opts.
10. `@@ -1327,6 +1343,7` its call: the spread.
11. `@@ -1354,3 +1371,90` `latestSaleId`, appended.

The payload of every money write (`Items, Payments, ClientId, Test,
LocationId, InStore, CalculateTax, SendEmail`, the mock logs the keys),
the single flight, the rehearsal order, the suppression and the outcome
wording are T24/T28/T43's; the checkout route's diff is the `session`
resolution, each `checkoutCart`/`purchaseCredit` call wrapped in
`runAsActor`, `saleIds()` after each real checkout, `cartId` and
`actorFields` on the answers, and `staffSessionEnded` on the final
catch.

### What was built and checked

Node-level (`t49-node.js`, `scratchpad/t49/node.log`) against `next
start` on the T49 build at :3049, prod target with `POS_DRY_RUN=false`,
`POS_WRITE_CLIENT_IDS` including the house client, `POS_DEVTOOLS=true`,
`POS_SESSION_SECRET` set, no `POS_PIN`, a local Postgres 16, Mindbody
mocked on :4549 (`t49-mock.js`: `/usertoken/issue` answering a DISTINCT
token per login, `tok-<staff>-<seq>`; `/staff/staffpermissions` per
staff in the live top-level shape, Kim 106 all six allowed, Pete 100
with `LaunchSignInScreen` and `MakeSales` denied; a permission-checked
`/client/updateclientvisit` and `/sale/checkoutshoppingcart` answering
403 "You do not have permission ..." under Pete; `/sale/sales` listing
every real checkout with a numeric `Id`; `/__kill?token=` making a token
answer 401 from then on; and every call's Authorization header recorded
so the actor is provable):

- Nobody signed in: `GET /api/teacher` `{teacher: null}`; a check-in
  reached the mock under the service token (`staff=0`), the dev log
  entry `actor: null`.
- Sign-in: a bad shape 400; an unknown user and a wrong password the
  identical 401 "Mindbody did not accept that sign-in."; Kim 200
  `{ok, teacher: {106, "Kim Farrell"}}` with `Set-Cookie:
  pos_staff=s1.<32 chars>.<64 hex>; Path=/; Max-Age=43200; HttpOnly;
  SameSite=Strict; Secure`; `GET /api/teacher` names her; her token
  (`tok-106-4`) appears in no answer and nowhere in `/api/devlog`
  (`includes(kimToken)`: false), while the dev log entry for her
  check-in carries `actor: 106`. The owner login 403 and the
  non-teacher login 403, each followed by a `DELETE /usertoken/revoke`
  under the token just issued.
- The probe under Kim: `/staff/staffpermissions` and the Test price
  both under `staff=106` (the catalog read under the service account),
  group "Teachers", all six true, `sale: {ok: true, total: 1.81, item:
  "LMNT Electrolytes"}`.
- Check-in and booking as Kim: `updateclientvisit` and
  `addclienttoclass` under `staff=106`.
- Comp as Kim with her PIN (enrolled through T48's route, verified to a
  token): rehearsal under `staff=0`, the write under `staff=106`,
  `GET /sale/sales` under `staff=0`, the Formula Note under `staff=106`;
  the answer `{ok, method: "comp", total: 233, saleId: "425874",
  cartId: "cart-1-aaaa-bbbb"}`; the note "Comped $233.00 at the
  counter: Goodwill. Note: spilled tea. By Kim Farrell. Sale 425874.";
  `comp_receipts` row `425874|cart-1-aaaa-bbbb|106|555001` with
  `schema_version` 6; the line

      [comp] prod sale=425874 client=100000123 total=233.00 reason="Goodwill: spilled tea" kind=goodwill for=none teacher=106 note=555001

- Cash as Kim: 425875, then the house client: 425876. Never the same id
  twice.
- Sign-out: `{ok}` with the clearing cookie, the mock shows her token
  dead (revoked), `GET /api/teacher` null, the next check-in under
  `staff=0` again.
- Pete: the probe reads group "Instructors", `LaunchSignInScreen` and
  `MakeSales` false, `denied: ["LaunchSignInScreen", "MakeSales"]`,
  `sale: {ok: false, error: "You do not have permission to perform
  sales"}`. His check-in: the mock saw `updateclientvisit` under
  `staff=100` (403) then under `staff=0`; the answer `{ok, suppressed:
  null, actorFallback: {name: "Pete Stewart", reason: "You do not have
  permission to launch the sign-in screen."}}`; the server line
  `[actor] fallback staff=100 route=/api/checkin reason="..."`. His cash
  sale: rehearsal `staff=0`, write `staff=100` (403), write `staff=0`,
  sales list; `saleId: "425877"` with the `actorFallback`. His comp with
  his PIN: rehearsal `staff=0`, write `staff=100` refused, NO third
  call; 502 "You do not have permission to perform sales", real
  checkouts unmoved (4 before, 4 after), no note, the `[comp] ...
  outcome=refused ... teacher=100` line; he stays signed in.
- His token killed at the mock: the next check-in saw `staff=100`
  (401), `DELETE /usertoken/revoke`, then `staff=0`; the answer carries
  `actorFallback` and `staffSessionEnded: true`; `[actor] token refused
  staff=100 route=/api/checkin; ending the staff session`; `GET
  /api/teacher` null; the probe with no session 401 `reason:
  "teacher"`.
- A cookie with its last signature character changed: `{teacher:
  null}`; the real cookie again: Kim. Pete signing in over Kim's
  session: her token dead at the mock, `GET /api/teacher` Pete.
- Six wrong sign-ins: `[401, 401, 401, 401, 401, 429]`; an enroll
  during the lockout 200 (its own counter). `grep -c "secret\|tok-"
  server.log`: 0.

In the browser (`t49.js`, `scratchpad/t49/ui.log`, shots
`{light,dark}-{1..7}-*.png` at 1180x820): the app starts with no
prompt and a 64px, 16px "Sign in" control beside Buy
(`*-1-header-signed-out.png`); the modal has two 64px inputs at 18px
with `autocomplete` username/current-password, Cancel and Sign in at
64px, Sign in off until both fields are filled (`*-2-signin-modal.png`);
a wrong password shows "Mindbody did not accept that sign-in." and
clears the password field (the post carried it exactly once); Enter on
the right one lands on "Kim Farrell", "Signed in as Kim Farrell.", the
summary "Kim's Mindbody account can check in, book, and sell.", the six
ticks and "Test price of LMNT Electrolytes came to $1.81", one probe
call (`*-3-signed-in-modal.png`); the control then reads "Kim" with the
aria label naming her (`*-4-header-signed-in.png`); a check-in answered
with `actorFallback` goes green with the amber 16px row line "Done as
the studio account: Kim Farrell's Mindbody login lacks permission to
launch the sign-in screen." (`*-5-fallback-row.png`); a cash sale's done
screen reads "Sale 425874." and, on the light run, the same amber line
under it for a checkout that fell back (`*-6-done-sale-id.png`); Sign
out puts "Sign in" back; Pete's summary reads "cannot: check in
(LaunchSignInScreen); sell (MakeSales); price a sale (...)" with three
crosses (`dark-7-pete-cannot.png`); and a check-in answering
`staffSessionEnded` flips the control to "Sign in" with the "sign-in
ended" line on the row. Both palettes from the tokens; no hex outside
the blocks.

### The probe procedure (Pete, live)

1. On the studio build, tap "Sign in" beside Buy and sign in with your
   own Mindbody login (the one you use for the web app). The modal runs
   the probe on its own; read the one line and the six ticks. If the
   sign-in itself is refused, T48's open question is answered the other
   way: the API key does not issue tokens for staff other than the API
   user, and the whole ticket falls back to the service account with no
   change in behaviour.
2. Open the dev drawer (Cmd+D), Settings, "signed-in teacher": the
   same result with "Run probe"; the calls tab shows
   `/staff/staffpermissions` and the Test `checkoutshoppingcart` with
   `actor=<your staff id>`.
3. Check someone in. The calls tab entry carries `actor=`; in the
   Mindbody web app the visit's sign-in should now name you rather than
   `sealevelapiuser`. Sell a mat for cash: the sales report's staff
   column is the question this ticket exists for, and the done screen's
   "Sale <number>" is the row to look for. If a write shows the amber
   "Done as the studio account" line, the permission it names is what
   your group lacks; fix it in the group or leave it, the counter works
   either way.
4. What a dead token looks like live is the one thing the mock guessed:
   `isActorTokenDead` reads a 401. If Mindbody answers an expired staff
   token with a 403 or with token wording on another status, widen
   `isActorTokenDead` in `mindbody.ts`, not `isActorRefusal`.

### Left

- **Unverified live:** that the studio's API key issues tokens for
  teachers other than the API user (T48's open question, now
  load-bearing); what Mindbody answers for an expired staff token; that
  Mindbody's sales report and visit records actually show the token's
  staff member (Pete's "assuming MB tracks who made sales"); the
  `/sale/sales` window filter and whether `Sale.ClientId` matches the
  RSSID this app holds.
- **Sessions are per process.** A deploy signs every teacher out; the
  header says "Sign in" and nothing else changes. Two instances would
  not share sessions.
- **The sale-id lookup is a heuristic:** the newest unseen sale for
  the client today. Two counters selling to the same client in the same
  minute could cross; the GUID stays on `cart_id` for exactly that case.
- **The Formula Note waits for the lookup** (8s + 8s worst case on a
  comp).
- `.env.example` is unchanged: nothing new is configured.
- Every sign-in attempt, a 400 included, claims a limiter slot, as
  enroll's does.
- The comp PIN (T48) and the staff session are two separate proofs of
  the same person; a comp under Kim's session with Pete's PIN files the
  receipt under Pete (the token) and the Mindbody sale under Kim (the
  session). Deliberate for now: the PIN is the friction, the session is
  the attribution.

## The Phase 2 sandbox run (Pete): one ordered checklist

The run left T21-T26 code-complete, each adversarially reviewed. These are
the questions only a live run answers, in the order that unblocks the most:

1. **AccountBalance sign convention FIRST** (positive = spendable credit is
   assumed by the credit gate and rule 1; if inverted, both flip).
2. One cart priced in the sandbox: watch the Metadata id choice
   (ProductId for services, barcode Id for products) and `disagrees`
   (whole-cart rounding vs Mindbody's). ANSWERED by the second live run:
   `usedPaymentStub` is TRUE (Test-mode checkout demands the Comp stub;
   it now goes first), and the 13% sandbox tax exposed the hardcoded
   10.35% in expectedTotal, fixed to per-item TaxRate. See T22/T27.
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

## T10. Auth, deliberately last

- [ ] Shared PIN (stubbed in `.env.example`) or per-teacher identity per the
      P1 answer, whichever exists first. Nothing above waits on this.
