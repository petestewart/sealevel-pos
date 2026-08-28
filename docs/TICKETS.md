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

Buy button from the MB screen: deliberately NOT here. That is Phase 2's
sale path (sell the missing pass and check in together), already planned.

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
