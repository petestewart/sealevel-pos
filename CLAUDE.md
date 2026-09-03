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
`actor=<staff id>`; the token itself is never recorded. Enabled by
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

Anything that decides whether a write reaches Mindbody -- dry run, target,
the write guard -- is deliberately NOT here. Those stay in the server
environment where a browser cannot reach them; a settings panel that could
switch off dry run would defeat the point of dry run.

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
  write guard apply.
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
- **Every colour is a token, in both palettes.** `globals.css` defines the
  palette twice, in `:root` and in the `prefers-color-scheme: dark` block, and
  no hex belongs anywhere else in the CSS or in a component. A hardcoded colour
  sitting next to a themed one is the bug that made the check-in chip
  unreadable twice: the text flipped with the theme and the background did not.
  `color-scheme: light dark` on `:root` covers what variables cannot reach
  (input spinners, checkboxes, carets, scrollbars, focus rings), and the two
  `themeColor` entries in `layout.tsx` must stay equal to `--bg` in the
  matching palette.

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
  after the device lock; the header shows their name and an account
  icon for sign-out), and every write runs under THEIR token so Mindbody
  names them; with nobody signed in, writes are refused (401
  `reason: "staff"`) and the gate comes back. The token lives
  in server memory only (`src/lib/staffsession.ts`; a restart signs
  everyone out, and the gate reappears). Verified live 2026-09-02: the API key issues tokens for
  other staff logins, and a staff token reads its own permission group
  and Test-prices a cart. Still unverified: what Mindbody answers for an
  expired staff token (`isActorTokenDead` reads a 401), and that the
  sales report actually shows the token's staff member. The probe is
  `GET /api/teacher/probe` (the sign-in modal and the dev drawer run it).
- **Offline behaviour is unhandled.** Phase 1 arrivals could queue and replay;
  a Phase 2 sale must never queue.
- `GET /sale/alternativepaymentmethods` returns HTTP 400, cause not chased. It
  only matters for a payment option the design ruled out.
