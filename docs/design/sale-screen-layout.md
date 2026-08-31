# The Buy screen: layout of record

Status: design proposal. Owner: Pete. Date: 2026-08-31.
Mockups: `docs/design/mockups/html/buy-screen-layout.html`.

Pete sent two screenshots of a commercial restaurant POS and asked for the
Buy screen to be "more in the vein of these". This is the answer: what the
reference gets right for a counter, what it gets right only for a
restaurant, and the layout that falls out once the studio's own numbers are
applied to it.

Read alongside `front-desk-pos.md` (the speed argument, the phasing, the
$10 card minimum) and TICKETS T23, T27, T31, T33 and above all **T35**,
whose tender model is the interaction this plan must preserve intact. Where
this document and T35 disagree, T35 wins and this document is wrong.

## 1. The counter is not a restaurant, and the catalog proves it

The reference is built for a menu: dozens of items, photos worth showing,
five categories a server switches between constantly, and an order that is
assembled over minutes. Every one of those assumptions is false here.

Twelve months of in-studio sales, by line count:

| Item | Lines | In-studio price |
|---|---:|---:|
| ClassPass / guest passes (zero-priced) | 2,910 | $0.00 |
| Towel rental | 871 | $2.72 |
| Drop In | 777 | $28.00 |
| Mat rental | 697 | $2.72 |
| Auto Monthly (a contract, T30) | 647 | varies |
| Parking token | 414 | $2.72 |
| Vita Coco 11.1oz | 360 | $2.82 |
| Boxed water | 213 | $3.62 |
| Liquid IV | 192 | $1.81 |
| 10 Class Pack | 122 | $230.00 |
| 5 Class Pack | 118 | $125.00 |
| New Student 2 Week Unlimited | 100 | $49.00 |

Everything below that is fewer than 50 lines a year: t-shirts, a Manduka
mat, Yogi Toes, the odd workshop. **Nine items are 90% of what a teacher
ever taps**, six of them cost under four dollars, and the whole priced
catalog is 57 items of which 16 are passes.

Three consequences, and they decide most of what follows.

- **A dense five-across grid of photo cards is solving a problem we do not
  have.** With nine real items, discovery is not the bottleneck; reach is.
- **Favorites, not categories, is the primary navigation.** The T27
  addendum already shipped a Favorites shelf pinned first. On this catalog
  it is not a convenience, it is the default screen, and it should be able
  to hold every one of those nine items at once.
- **The money is in the passes, the taps are in the rentals.** A $2.72
  towel and a $230 pack are the same gesture, so the screen must not make
  the cheap frequent thing harder to reach than the expensive rare one.

The other constraint the reference does not carry: **selling is the
interruption, not the job.** The resting screen is the roster, Buy is an
overlay over it (T23), and Done returns to the roster (T33). Anything that
makes Buy feel like a place a teacher lives in is wrong.

## 2. Decisions

### 2.1 Keep the horizontal category row. Reject the vertical rail.

The rail is the reference's most visible feature and it is the first thing
to drop.

Arithmetic, at the shell's 1100px max width with 16px padding: 1068px of
usable row. The receipt column is 400px, the gap 20px, so the catalog pane
has 648px, which at the shipped `minmax(190px, 1fr)` is **three columns**. A
150px rail takes that to 498px, which is **two columns**. Trading a third
of the shelf for a permanently visible list of six words is a bad trade
when the shelf holds nine things.

What the rail is genuinely for is a category selector whose position never
moves, so a server's thumb learns it. That is worth taking, and it does not
need a rail:

- **The chip row never wraps.** Six chips (Favorites, Towel and Mat,
  Food/Drink, Passes, Accessories, Clothing, then "more") on one line that
  scrolls horizontally if it must, rather than reflowing to two rows and
  pushing the grid down as the catalog changes. A control that moves
  vertically depending on data is the thing the rail was fixing.
- **Favorites is pinned first and selected by default** (T27 addendum,
  unchanged), so the resting position of the shelf is the same every time.
- **Active chip stays filled with the accent**, matching the class dropdown
  and the sort bar (ui-refactor 2.4). Same idiom in both screens.

### 2.2 The item grid: keep the cards, add a cart badge, no photos

Kept from the reference: a uniform grid of equal cards, name and price,
price never truncated, the card the whole tap target.

Dropped: **photos.** There is no product photography for a towel rental,
Mindbody image fetches would add calls to the shelf path, and a placeholder
tile is worse than type. The name is the identifier a teacher reads anyway.

Added, and it is the one thing the reference has that we lack: **a card
already in the cart shows its quantity.** The reference highlights the
order row being edited; ours should mark the shelf card instead, with a
small count badge in the corner opposite the star, so the teacher can see
"two Liquid IV are rung up" without reading down the receipt. Cheap, no new
call, no new colour (the existing `.bal-chip` pairing).

Sizing stays as shipped: `minmax(190px, 1fr)`, 76px minimum card height,
16px name, 16px tabular price, the 44px star as a sibling target in the
corner.

### 2.3 The receipt column: compact rows, controls on the selected row

The reference's order row is two lines: name, then a small "1 Nos @ $8.00"
sub-line, with the line total right-aligned. Ours currently renders a
name/amount line plus a full quantity row of three 64px buttons on **every**
line, which is 100px+ per item and is why a five-line cart already scrolls
internally.

Take the reference's shape:

- **Every line is two lines of type**: name and right-aligned line total on
  top, `2 @ $1.81` in muted type beneath. Tabular figures, right rule
  aligned with the totals below.
- **Tapping a line selects it**, and only the selected line reveals the
  minus / quantity / plus / remove controls at the 64px floor. That is the
  reference's "row being edited is highlighted", and it is what buys the
  vertical space back.
- The common path does not change: **tapping the same shelf card again
  still increments**, so quantity is usually set without touching the
  receipt at all. The controls exist for correcting a mistake, which is the
  rarer act.

Kept exactly: the ticket's monospace treatment, the studio heading, the
subtotal / tax / total block, the server's numbers rather than ours, the
`disagrees` stop block naming the offending line, and the amber suppressed
notice with no figure.

**This pattern does not travel to the roster.** T14 flattened roster rows
into aligned columns and banned the expando specifically because a
26-person list cannot be scanned when rows change height. A receipt is
four lines long and is read top to bottom once; a roster is not. See 5.

### 2.4 A bottom action bar, with one primary control that never moves

This is the best idea in the reference and it should be taken almost
literally.

A bar across the full width of the overlay, below both panes, sticky to the
bottom of the viewport so it cannot scroll away:

- **Left, quiet:** Empty cart, and Back. Outlined, 64px, no fill.
- **Right, primary:** one filled accent control carrying the count and the
  server's total: `Pay · 4 items · $263.80`.

Why it is worth the vertical space it costs:

- **The primary control stops moving.** Today the Charge button sits under
  a receipt whose height depends on the cart, so the thing a teacher aims
  at is in a different place for a one-item sale than a five-item one. A
  fixed bottom-right corner is learnable.
- **It restates the money at the moment of the tap**, which is already the
  rule for Charge (T24) and now holds for the step before it too.
- **It is the same control in both modes** (2.5): `Pay` in shelf mode,
  `Charge $X` in payment mode. One place, two labels, no relearning.

Rules it inherits and must not break: it is disabled on an empty cart; it
shows the pricing spinner rather than a stale figure while a reprice is in
flight; and in payment mode it is enabled **only** when due is exactly zero
and every line is valid (T35). It must sit below every modal scrim in the
stacking order, or the cart-change confirm (T27 round three) could be
tapped past.

Not taken from the reference's bar: **Orders**, **Save** and
**Discount/Charges**. See 4.

### 2.5 One screen, two modes. Not two screens, and not one crowded one.

The question Pete raised is what happens when a teacher is mid-sale and
someone needs checking in. The answer is already built and does not change:
**Back**. The overlay is state, not a route; SaleScreen stays mounted; the
cart survives (T23). That is true whether Buy is one screen or five, so it
does not decide this.

What decides it is that **at tender time the item grid is 60% of the screen
doing nothing**, and the payment figures the reference gives a full half
screen to are, in ours, squeezed above the receipt in a 400px column.

So: one screen, two modes, no route, no navigation, nothing unmounted.

- **Shelf mode** (the default): receipt left, categories and shelf right,
  bar reading `Pay · N items · $total`. There is **no method row and no
  tender block on screen at all** in this mode.
- **Payment mode**: the receipt stays exactly where it is, unmoved and
  unresized, and the right pane becomes the payment surface. The bar's
  primary becomes `Charge $total`.
- **Returning is one tap and loses nothing**: a `Back to items` control at
  the bar's left, and Escape. Tender lines, the armed sources and any
  entered amount survive the round trip, exactly as the cart survives Back.

The receipt not moving between modes is the point. The teacher's eye keeps
its anchor, and a last-second "and a towel" is one tap away rather than a
lost cart.

**Escape gains an owner.** Today Escape closes the overlay unless a modal
is stacked (T23). It must now first leave payment mode, then close. The
keypad modal keeps priority over both, and every path that leaves payment
mode must dismiss an open keypad and report the close upward, on the same
rule as T35's review fix.

### 2.6 The payment surface, and how T35 maps onto "Balance Due / Amount Tendered"

The reference pairs two large figures at the top: Balance Due and Amount
Tendered, the tendered one editable beside a keypad affordance. T35 models
the same thing with more precision, because it has to: a tender is a list
of lines, and cash is the only source allowed to exceed what it owes.

The mapping, and it is close to one-for-one:

| Reference | Ours | Note |
|---|---|---|
| Balance Due | **Due** | The server's total minus what the lines cover. Renders `--ok` at zero, which is the one figure to check before charging. |
| Amount Tendered | **The tender lines** | Their sum is the tendered figure. Two lines maximum (T35), and the second line is the split. |
| (absent) | **Change** | Cash over-tender, the loud `--warn` chip beside Due. The reference has no change figure because its tendered field is the customer's cash; ours has to hand money back out of a drawer. |
| (absent) | **Total** | The server's rehearsed grand total, stated once above Due, because Due alone does not say what the sale was. |

Three figures, big, at the top of the surface: **Total**, **Due**,
**Change**. Everything below is how Due gets to zero.

**Method tiles.** The reference's grid of tiles is right for us at this
size, and one detail of it is worth taking outright: **the available
balance as a small corner badge on the tile**. Credit's tile reads `Credit`
with `$40.00` in the corner, which is strictly better than today's greyed
button whose reason lives in a `title` attribute nobody on an iPad can see.

What does not change, from T33 and T35:

- **Credit leads when there is a balance, and is absent when there is
  not.** The tile grid is two or three tiles wide, not a fixed four with a
  dead slot. Do not fill the gap.
- Tapping a source **adds a line pre-filled with the whole remaining due**,
  clamped by that source's rule. One tap, no typing, for the ordinary sale.
- A source already in the payment, or a third source when two lines exist,
  is **greyed with the reason on the tile**, never hidden.
- **Comp stays outside the list**, a whole-sale hold with its own confirm.
  It is not a tile in the tender grid; it belongs with the quiet controls.

**Tender lines** are unchanged from T35: `[source] [amount] [x]`, one
compact row, tabular right-aligned amount, the amount a button that opens
the keypad, the x removing the line and thereby leaving the split. In
payment mode they get the width to breathe that the 400px column never
gave them.

### 2.7 The quick-denomination row: it already exists, in the right place

The reference puts four denomination buttons along the bottom of the
payment surface. Pete has separately asked for Exact / $5 / $10 / $20
inside the amount keypad, and that work is in flight. **Do not build both.**

The keypad is the right home, for a reason that is not just tidiness: a
denomination is meaningless until you know **which line** it applies to. At
surface level, "$20" has no referent when there is no cash line yet, and
two referents once there is a split. Inside the keypad the line is named at
the top, the cap is known, and the change math is on screen underneath as
the chip is tapped.

The surface-level version of "Exact" already exists and costs zero taps:
**tapping the Cash tile pre-fills the whole remaining due** (T35). So the
reference's most-used denomination button is our default behaviour, and the
other three are one tap deeper, where they can be right.

The one change worth making: tapping the Cash tile when a cash line already
exists should open that line's keypad rather than refusing as "already in
the payment", so the denominations stay one tap from the surface.

### 2.8 Density and hit targets at iPad landscape

Horizontal budget, at the 1100px shell (an iPad 10.9" landscape viewport is
1180 CSS px, a 12.9" Pro 1366, so the shell is the binding constraint, not
the device):

```
16  shell padding
400 receipt column        (unchanged; the ticket is legible at this width)
20  gap
648 catalog pane          -> 3 shelf columns at ~205px, 10px gaps
                          -> in payment mode, one payment surface at 648px
16  shell padding
```

Vertical, against the shorter 768px-class landscape viewport:

```
44  mode banner           (never covered, in either mode)
56  header: Buy, For: NAME + balance, Back
~520 panes                (the receipt scrolls internally, as it does today)
88  action bar            (64px control + 12px padding each side, sticky)
```

Targets: **64px minimum on everything that changes the cart or the money**
(shelf cards at 76px, category chips, method tiles, tender amounts, the x,
every keypad key, both bar controls). The 44px quiet-icon exception is
existing precedent and stays limited to what it already covers: the
favourite star, the detach x, the roster's row icons. No money control is
ever 44px. Nothing under 16px anywhere, and every figure that can be
compared to another figure is `font-variant-numeric: tabular-nums`.

### 2.9 Colour: two new tokens, both palettes, nothing else

The palette does not need to move for this layout. Everything here paints
from tokens that already exist in both palettes: `--bg`, `--surface`,
`--line`, `--ink`, `--muted`, `--accent`, `--action-bg`, and the three
semantic pairs `--ok/--ok-bg` (Due settled), `--warn/--warn-bg` (change
due, dry run, suppressed writes) and `--stop/--stop-bg` (a disagreeing
cart, a refused charge).

Two additions, both defined in `:root` **and** in the
`prefers-color-scheme: dark` block, per the house rule:

- **`--accent-ink`**: the text colour on an accent fill. The code currently
  spends `--surface` for this on `.cat-chip.on` and `.charge-btn`, which
  works today only because both palettes happen to be legible that way. The
  bottom bar's primary is the largest accent fill on the screen and should
  not rest on a coincidence.
- **`--shadow`**: a per-palette shadow, so the sticky action bar can lift
  off the panes without a hairline that disappears in dark mode. A
  light-mode shadow is invisible on a dark ground, which is exactly the
  class of bug the both-palettes rule exists for.

Explicitly **not** required by this plan: the `--gold` pair proposed in
ui-refactor 2.6. The cart-count badge and the balance badge reuse the
existing `.bal-chip` and `--ok` pairings. If Pete takes the gold pair for
the roster's themed pass, these badges can move with it later; nothing here
depends on it.

## 3. What the roster inherits, so the two screens stay one app

Small list on purpose. The roster is a good screen and this is a Buy-screen
plan.

- **The filled-active idiom**, already shared: the Buy category chip, the
  roster's class dropdown and the sort bar all fill with the accent when
  selected, and nothing else on either screen does.
- **The header shape**: title, then identity taking the slack, then a
  labelled Back or Change at the right edge (T31, T34). Both screens
  already read this way; keep them in step when either moves.
- **The corner-badge idiom**: a balance or a count as a small pill in a
  card's corner, in a semantic pair rather than the accent. The roster's
  `.bal-chip` is the source of it; the Buy screen's method tiles and cart
  badges reuse it verbatim.
- **Tabular figures everywhere money appears**, in both screens.
- **The keypad modal is shared property.** It is the only numeric entry in
  the app, it owns Escape while open, and no OS keyboard appears anywhere in
  either screen.

What the roster does **not** inherit:

- **The bottom action bar.** The roster's primary action is per row; a
  screen-level primary would have nothing true to say.
- **The select-to-reveal-controls receipt row.** T14 stands: roster rows
  are fixed-height aligned columns, and no expando returns in any form.
- **Two modes.** The roster is one surface with modals over it, which is
  the speed argument, and nothing here changes that.

## 4. What we are NOT taking from the reference

- **Photos on item cards.** No product photography exists, Mindbody image
  fetches would add calls to the shelf path, and a grey placeholder tile is
  worse than a name in 16px type. See 2.2.
- **The vertical category rail.** It costs a third of the shelf to make six
  words permanent. See 2.1.
- **Five items across.** At the 16px floor and a 76px card, five columns in
  648px would truncate names and prices. Three columns, and names that fit.
- **The `Orders` list and `Save`.** A parked-order queue is a real feature
  with real state, and this counter serves one person at a time; the one
  cart already survives Back and an accidental navigation. If two carts at
  once turns out to be a genuine need, it is a ticket, not a button we add
  speculatively.
- **`Discount / Charges` in the action bar.** There is no line-level
  discount to offer: the request-side `CheckoutItem` carries only `Type`
  and `Metadata`, whose key set is not enumerated in the vendored spec, and
  a price override is unproven pending a Test-mode probe. `PromotionCode`
  is cart-level and needs a permission the account may not hold. Putting a
  Discount button on screen before any of that is settled is promising a
  teacher something the API may refuse.
- **A per-line discount and tax sub-line on every receipt row.** Tax is
  per-item (T27's TaxRate fix), but showing it per line is nine figures
  where one is true. One tax line, and the disagreement path already names
  the offending line when the server disagrees with us.
- **A fixed tile grid with dead slots.** Gift card and On Account are tiles
  in the reference whether or not they apply. T33 decided the opposite and
  was right: a permanently greyed method is noise on the one row that must
  read at a glance.
- **The currency chip beside the amount.** One currency.
- **The customer's name at the top of the order list.** T31 deliberately
  moved identity to the header and gave the payment column the space back.
  Do not put it back at the top of the receipt.
- **A quick-denomination row on the payment surface.** It would duplicate
  the keypad chips. See 2.7.
- **A separate payment screen.** See 2.5.
- **The reference's type scale.** It lives on 12-13px muted metadata. Every
  figure here holds the 16px floor, and the three payment figures are
  deliberately much larger than that.

## 5. Behaviour this plan would change, ticket by ticket

Nothing below is a silent regression; each is a deliberate revision, and if
Pete rejects any one of them the rest still stands.

- **T27 put the method row above the receipt in the left column.** This
  plan removes it from shelf mode entirely and gives it the right pane in
  payment mode. The reason T27 gave (compact, and the left column must fit
  iPad landscape) is served better by not rendering it until it is needed.
  *Reversible: the tiles are the same control in a different container.*
- **T35's sources are "inline with the totals".** They still are, inside
  the payment surface; what changes is which column that block lives in and
  that the tiles gain a balance badge. **No clamp, cap, request shape or
  `chargeable` gate moves.** One line still sends `{ method, cashTendered? }`,
  two still send `{ split: { legs } }`, Charge is still enabled only when
  due is exactly zero and every line's reason is computed in the same
  render.
- **T23's Escape rule** (close the overlay unless a modal is stacked) gains
  a step: Escape leaves payment mode first. Any keypad open when payment
  mode is left must be dismissed and the close reported upward, per T35's
  review fix, or the next Escape is swallowed.
- **T33's "Done returns to the roster" is unchanged**, and the outcome
  block renders in the payment surface where the charge was made. The
  receipt is still cleared first.
- **T33's Credit visibility rules are unchanged**, including the
  split-failure exception where Credit stays visible while that warning is
  up. The tile grid must not backfill the slot Credit vacates.
- **T31's header identity is unchanged.** The reference tempts the opposite
  and is wrong for us.
- **T27 round three's cart-change confirm is unchanged**, but the sticky
  bar introduces a stacking-order requirement: the bar sits below every
  modal scrim, so nothing behind a confirm is tappable.
- **T23's pricing states must both survive the mode switch**: the
  `disagrees` stop block and the amber suppressed notice render in payment
  mode, next to the figures they contradict. A teacher must never reach a
  payment surface that looks settled while the cart disagrees with
  Mindbody.
- **T27's Favorites addendum is unchanged**: pinned first, selected by
  default when it has anything to show. The non-wrapping chip row makes its
  position constant, which is the whole point of it.
- **T14's no-expando rule is untouched.** The select-to-edit receipt row is
  a Buy-screen pattern and does not travel to the roster.
- **The mode banner is visible in both modes.** A payment surface in dry
  run must say so at the moment of the tap.

## 6. Open questions for Pete

1. **Receipt left or right?** The reference puts the order list on the
   right and the primary Pay under it. Ours is on the left, and this plan
   keeps it there (the header identity sits above it, and the shelf gets
   the flexible column). It is close to a one-line flip if you want to try
   the other way at the counter.
2. **In payment mode, should the shelf disappear entirely, or shrink to a
   narrow strip of Favorites** so a last-second towel is one tap rather
   than two? The plan says disappear, on the grounds that the payment
   figures deserve the room and Back to items is one tap.
3. **Is "Pay" the right word on the bar in shelf mode?** T27 renamed Sell
   to Buy because the counter conversation is the student's. "Pay" may
   carry the same problem. Candidates: `Pay`, `Take payment`, `Checkout`.
4. **Passes is 16 items, and the only shelf that scrolls.** Split it
   (Drop-ins / Packs / Unlimited), or leave one long shelf and rely on
   Favorites for the four that actually sell?
5. **Should the shelf card of an item already in the cart increment, or
   select its receipt line?** The plan keeps increment, which makes the
   receipt controls a correction tool. Say if you want the other.
6. **Do you ever need two carts open at once** (the reference's Orders /
   Save)? If a teacher genuinely gets interrupted mid-sale by a second
   buyer rather than a check-in, that is a real feature and worth a ticket.
   If not, one cart stays and the button never appears.
7. **Where do contracts (T30) live in this layout?** A shelf card in the
   Passes category that opens the contract confirm, or their own category?
   They are the largest-value thing sold at the counter and they are not
   ordinary cart lines.
8. **Cart count badge on shelf cards: useful or noise?** It is the one
   thing added here that the current screen does not have in some form.
