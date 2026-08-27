# sealevel-pos

Front-desk check-in for Sealevel Hot Yoga teachers. An iPad web app over the
Mindbody Public API v6. Read `docs/design/front-desk-pos.md` before any build
work: it carries the reasoning, the studio's real numbers, and a long list of
Mindbody constraints that were expensive to establish and are not obvious from
the API docs.

## Status

**Phase 1: check-in only.** Roster for the classes around now, local
type-ahead search for walk-ins, one-tap optimistic arrival. **No cart, no
payment, no money.** Verified working against live Mindbody on 2026-08-27:
classes, teachers, and pricing options all render from real data.

Phase 2 (stored-card sales and cash) is unblocked but not started. The sale
path was verified with ai-manager's `npm run mindbody:probe-payments`.

## Safety: nothing writes by accident

Two independent guards, both defaulting to safe. Neither is a nuisance to be
removed; this app checks real students into real classes and will later charge
real cards, so reaching production has to be a choice someone made rather than
something they forgot to prevent.

- **`POS_DRY_RUN`** (default `true`) lets reads through to Mindbody and
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

Mindbody's site -99 sandbox works, but **only with credentials issued for
it**: staff accounts belong to a site, so the studio's own API login
(`sealevelapiuser@gmail.com`, site 471) authenticates against 471 and nothing
else. If the sandbox returns "Site is deactivated" or "Staff identity
authentication failed", that is the credentials, not the site being down.

The screen shows which mode it is in at all times, and `GET /api/config`
reports it. Never remove that banner: a teacher must not have to wonder
whether the tap they just made was real.

The cached staff token is keyed by site id, so switching target cannot reuse a
sandbox token against production.

## Locked decisions

- **Web app, not Swift.** Card-present is 0.4% of counter transactions (25
  sales in a year), and the studio's reader is a networked WisePOS E rather
  than a Bluetooth accessory, so native buys nothing. Full argument in the
  design doc.
- **Its own repo, its own Railway service.** Separate from ai-manager, which
  is a back-office worker with a different uptime story and different users.
  The two share an API, not a codebase: `src/lib/mindbody.ts` is adapted from
  ai-manager's client and deliberately not imported from it.
- **No database.** The client index lives in memory and rebuilds on boot.
  Redis or a volume-backed snapshot is a detail if cold starts get annoying,
  not an architecture change.
- **Nothing auto-charges.** Phase 2 will move money only on an explicit tap.
- **Sandbox and dry run are the defaults.** See above.
- **Pricing and schedule come from the live Mindbody API**, never from a cache
  that could go stale.

## Why it is fast

These three are the point of the app, not incidental optimizations. Do not
undo them without reading the design doc's speed argument.

1. **The roster is prefetched** for the classes around now, so tapping a name
   hits memory rather than the API.
2. **Search runs against an in-memory client index**, not Mindbody. A
   per-keystroke API call would be one metered call per letter at 400-900ms
   each.
3. **Check-in is optimistic.** The row goes green on tap and rolls back with
   an error if the call fails. Nobody watches a spinner with a queue waiting.

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
- **`/class/classvisits` puts the CLASS name in the visit's `Name` field.**
  Reading it showed every roster row as "bikram yoga". Names come from
  explicit client fields, and otherwise from the client index by id.
- The permissions this app needs: `LaunchSignInScreen` (arrivals),
  `BookClassesAndEventsWithoutPayment` (booking a walk-in), and for Phase 2
  `MakeSales`, `CreateRetailTickets`, `UseStoredCreditCards`,
  `AddProductsOnRetailScreen`. Plus `Desk staff` ticked on the staff profile.

## Conventions

- Next.js App Router, TypeScript strict with `noUncheckedIndexedAccess`.
- Secrets in `.env`, gitignored. Never commit credentials.
- No em dashes in user-facing copy.
- Sized for a hot room and a queue: nothing under 16px, tap targets at least
  64px tall.

## Known gaps

- **The live charge has never fully settled.** The probe reached payment
  handling and was refused with "Credit card is expired", which proves
  authorization but not that a charge reaches Stripe. Re-run
  `mindbody:probe-payments --live` in ai-manager against a client with a
  current card to close this.
- **No teacher identity.** The app acts as one service account; a shared PIN
  is stubbed in `.env.example` but not implemented. See the design doc's open
  question 3, which needs confirming against payroll reporting.
- **Offline behaviour is unhandled.** Phase 1 arrivals could queue and replay;
  a Phase 2 sale must never queue.
- `GET /sale/alternativepaymentmethods` returns HTTP 400, cause not chased. It
  only matters for a payment option the design ruled out.
