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

## T10. Auth — deliberately last

- [ ] Shared PIN (stubbed in `.env.example`) or per-teacher identity per the
      P1 answer, whichever exists first. Nothing above waits on this.
