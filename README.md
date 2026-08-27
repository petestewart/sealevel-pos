# sealevel-pos

Fast front-desk check-in for Sealevel Hot Yoga teachers. An iPad web app over
the Mindbody Public API v6.

Mindbody's own POS is slow enough at the counter that a line forms. This does
not replace it. It puts a two-tap surface in front of the handful of things
that happen over and over at 6:29pm, and leaves everything else to Mindbody.

The full design, the data behind it, and the Mindbody constraints that shaped
it are in `docs/design/front-desk-pos.md`. Read that before changing
anything structural. In particular it explains why this is a web app rather
than Swift (the studio's card reader is a networked WisePOS E, not a Bluetooth
accessory, and card-present is 0.4% of counter transactions) and why no money
moves in Phase 1.

## Status: Phase 1

Check-in only. Roster, walk-in search, one-tap arrival. **No cart, no payment,
no money.** That is most of the time saved at the door and it cannot break
anything financial while teachers get used to it.

Phase 2 (stored-card sales and cash) is unblocked but not built: the API sale
path was verified end to end with `ai-manager`'s `mindbody:probe-payments`.

## Running it

    cp .env.example .env      # credentials from the ai-manager Railway worker
    npm install
    npm run dev

It starts pointed at Mindbody's sandbox site with writes suppressed, and says
so in a banner across the top. To work against the real studio's data while
still writing nothing, set `MINDBODY_TARGET=prod` and leave `POS_DRY_RUN=true`.
Only setting `POS_DRY_RUN=false` lets a tap actually check someone in.

## How it earns its speed

- **The roster is prefetched.** At 6:29pm we already know who is about to walk
  in, so the classes around now are fetched once and held. Tapping a name hits
  memory.
- **Search is debounced, then goes to Mindbody.** One call per lookup rather
  than one per keystroke, and always current.
- **Check-in is optimistic.** The row goes green on tap, the API call runs
  behind it, and a failure rolls the row back and says why. Nobody watches a
  spinner with a queue waiting.

## Layout

    src/lib/mindbody.ts   v6 client: auth headers, cached staff token, 401 retry
    src/lib/roster.ts     classes, rosters, arrivals
    src/lib/clients.ts    client search
    src/app/api/          roster, search, checkin
    src/app/page.tsx      the counter screen

No database and no client cache: reads go to Mindbody when needed.

## Mindbody permissions

The staff account behind `MINDBODY_STAFF_*` must be in a permission group
granting `LaunchSignInScreen` (arrivals -- Phase 1 needs this),
`BookClassesAndEventsWithoutPayment` (booking a walk-in before they pay), and
for Phase 2 `MakeSales`, `CreateRetailTickets`, `UseStoredCreditCards` and
`AddProductsOnRetailScreen`. It also needs `Desk staff` ticked on its staff
profile.

Getting this wrong produces "You do not have permission to perform sales",
which names sales whatever the actual missing permission is. `GET
/staff/staffpermissions?StaffId=<id>` reads the group back and is far quicker
than guessing; note that the live API returns the fields at the top level, not
wrapped in `UserGroup` as the schema documents.
