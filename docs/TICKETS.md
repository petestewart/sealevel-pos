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

- [ ] Code audit: confirm the implemented call matches the vendored spec
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

- [ ] Book a searched client into a class from the UI
- [ ] `Waitlist: true` offered when `TotalBooked >= MaxCapacity`, never a bare
      failure
- [ ] Waitlist promotion via `WaitlistEntryId`
- [ ] Rehearsed with `Test: true` where credentials allow; shapes
      spec-verified regardless
- [ ] Pete: book a write-guarded dummy client for real, then check them in

## T3. Header counters (PLAN 1.3)

- [ ] Signed up, checked in, capacity from data already on hand (roster
      length, `SignedIn` count, `MaxCapacity`/`TotalBooked`)
- [ ] Waitlist count via `GET /class/waitlistentries`, fetched **only** when
      `TotalBooked >= MaxCapacity`
- [ ] A class with room renders all counters with zero extra calls

## T4. Counter modals (PLAN 1.4) — after T3

- [ ] Tapping a counter lists the people behind it
- [ ] Waitlist entries are stubs (`ClassId`/`ClientId` only): names resolve
      through the same batched client lookup the roster uses, not the row
      component
- [ ] "Is Dennis here yet" answerable without scrolling the roster

## T5. Client context on the expanded row (PLAN 1.5)

Fetched on row open, never per roster.

- [ ] Pass and `Remaining` from `/client/clientservices`; `Remaining: 1`
      surfaced loudly (highest-value prompt in the app)
- [ ] Account credit from `/client/clientaccountbalances`
- [ ] Recent visits from `/client/clientvisits`
- [ ] Habitual add-ons from `/client/clientpurchases`, shown only on a real
      pattern (3 of last 5), otherwise suppressed
- [ ] `Notes` shown; `RedAlert` treated as blocking, not decorative

## T6. Waiver state (PLAN 1.6)

- [ ] `Liability.IsReleased` / `AgreementDate` surfaced on the row (joins the
      batched client lookup; `/class/classvisits` does not carry it)
- [ ] Unmissable blocked state; **no tap path marks a waiver signed**
- [ ] A student without a waiver cannot be checked in by reflex

## T7. Studio banner (PLAN 1.7)

- [ ] Text from an env var, shown until changed. No scheduling, no targeting.

## T8. Categories config (PLAN 1.8)

- [ ] Five hardcoded entries ordered by counter frequency: Towel and Mat
      (-14), Food/Drink (36), passes, Accessories (32), Clothing (26);
      everything else behind "more". Not fetched.

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
