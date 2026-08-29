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
- [ ] The design doc's waiver section gets a short dated addendum
      recording Pete's decision and the MB-Resolve reasoning, so the
      reasoning of record stays true.
- [ ] Pete: live-verify against the dummy client that IsReleased flips,
      AgreementDate stamps, the receipt lands in Notes, and nothing else
      on the record changes.

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

## T10. Auth — deliberately last

- [ ] Shared PIN (stubbed in `.env.example`) or per-teacher identity per the
      P1 answer, whichever exists first. Nothing above waits on this.
