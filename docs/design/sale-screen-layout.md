# The Buy screen: layout of record

Status: design proposal, revised after Pete's review. Owner: Pete.
Date: 2026-08-31.
Superseded for the build by `pos-design-implementation.md` (2026-09-02),
the newer document, whose section 6 records what was built.
Mockups: `docs/design/mockups/html/buy-screen-layout.html`.

Pete sent two screenshots of a commercial restaurant POS and asked for the
Buy screen to be "more in the vein of these". This is the answer: what the
reference gets right for a counter, what it gets right only for a
restaurant, and the layout that falls out once the studio's own numbers are
applied to it.

**Revision, 2026-08-31.** The first draft rejected the reference's vertical
category rail and kept the two-column screen. Pete overruled that: "vertical
categories on left, grid of items in the middle, shopping cart on right",
and separately, "it still wastes a lot of screenspace" and "the Comp button
shouldn't be viz until the checkout screen". Sections 2.1, 2.5, 2.6, 2.8 and
2.9 are rewritten to those three instructions; the sales evidence, the
no-photos decision, the tender model and the regression list are unchanged.
Where the first draft's argument was wrong, it is recorded as wrong rather
than quietly deleted.

Read alongside `front-desk-pos.md` (the speed argument, the phasing, the
$10 card minimum) and TICKETS T23, T27, T31, T33 and above all **T35**,
whose tender model is the interaction this plan must preserve intact. Where
this document and T35 disagree, T35 wins and this document is wrong.

## 1. The counter is not a restaurant, and the catalog proves it

The reference is built for a menu: dozens of items, photos worth showing,
five categories a server switches between constantly, and an order that is
assembled over minutes. Not all of those assumptions hold here.

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

- **A grid of photo cards is solving a problem we do not have.** With nine
  real items, discovery is not the bottleneck; reach is.
- **Favorites, not categories, is the primary shelf.** The T27 addendum
  already shipped a Favorites shelf pinned first. On this catalog it is not
  a convenience, it is the default screen, and it should hold every one of
  those nine items at once without scrolling.
- **The money is in the passes, the taps are in the rentals.** A $2.72
  towel and a $230 pack are the same gesture, so the screen must not make
  the cheap frequent thing harder to reach than the expensive rare one.

The other constraint the reference does not carry: **selling is the
interruption, not the job.** The resting screen is the roster, Buy is an
overlay over it (T23), and Done returns to the roster (T33). Anything that
makes Buy feel like a place a teacher lives in is wrong.

## 2. Decisions

### 2.1 Three columns: rail left, grid middle, cart right

**Decided by Pete, overruling the first draft.** The first draft rejected
the vertical rail and kept the chip row above the grid. The argument was
width: at the sale overlay's 1100px `max-width`, a 150px rail takes the
catalog pane from 648px to 498px, which is three grid columns down to two.

**That argument was measuring the wrong constraint.** 1100px is *our*
number, set in `.sale-shell` and inherited from the roster's `.shell`. The
counter's iPad in landscape is 1180 CSS px on a 10.9", 1366 on a 12.9", and
1080 on the older 10.2". The overlay was leaving 80 to 266 px of the
studio's own screen unused and then rationing the rest. The answer is to
widen the shell, not to drop a column Pete wants.

So: **the Buy overlay's shell widens to 1400px** and the screen is three
columns, all visible at once, in Pete's order.

```
+---------+-------------------------------+------------------+
| rail    | item grid                     | cart / receipt   |
| 132px   | flexible, 3 to 4 columns      | 340px            |
|         |                               |                  |
+---------+-------------------------------+------------------+
| action bar: quiet left ......... one primary control right |
+------------------------------------------------------------+
```

What the rail buys, now that it is not being paid for in grid columns:

- **The category selector stops moving.** The chip row it replaces wraps to
  a second line as the catalog changes and pushes the grid down with it. A
  control whose vertical position depends on data is the thing the rail
  fixes, and it was the half of the rail the first draft already conceded.
- **Favorites is pinned at the top of the rail** and selected by default
  (T27 addendum, unchanged), so the resting position of both the rail and
  the shelf is the same every time.
- **The active entry is filled with the accent**, matching the class
  dropdown and the sort bar (ui-refactor 2.4). Same idiom, both screens.

**Where the section 1 evidence now cuts the other way.** The first draft
used the small catalog to argue against the rail. Read honestly it argues
*for* it: six or seven entries is a rail that never scrolls, never wraps and
never needs a "more" overflow at the top level, and a catalog that never
needs five grid columns is one that can afford 132px off the middle. The
part of the evidence that still stands unchanged is the rest of section 1:
no photos, no five-across, and Favorites as the default shelf.

**Column widths, and what folds first.**

| Viewport | Shell | Rail | Grid | Cart | Grid columns |
|---|---:|---:|---:|---:|---:|
| 1366 (12.9" Pro) | 1366 | 132 | 846 | 340 | 4 |
| 1180 (10.9") | 1180 | 132 | 660 | 340 | 3 |
| 1080 (10.2") | 1080 | 132 | 560 | 340 | 3 |

Arithmetic at the 1080 floor: 12px shell padding each side leaves 1056, two
12px gaps leaves 1032, minus the 132 rail and the 340 cart leaves **560px of
grid**, which at `minmax(168px, 1fr)` with 8px gaps is three columns of
181px. **1080 CSS px is therefore the minimum width for the three-column
screen**, and it is met by every iPad the studio would plausibly put at the
counter.

Below it the layout degrades in a documented order, narrowest thing first:

- **Under 1040px: the rail folds**, back into the horizontal chip row above
  the grid. It is the column carrying the least information (seven words),
  and folding it is the only fold that costs no money control any room. The
  cart stays on the right.
- **Under 860px: the cart folds**, beneath the grid, which is the single
  column behaviour the current `@media (max-width: 900px)` rule already
  implements. At that width the screen is a phone and the counter has other
  problems.

Neither fold is a target. They exist so a teacher on an unexpected device
gets a usable screen instead of a horizontally scrolling one.

### 2.2 The item grid: keep the cards, add a cart count, no photos

Kept from the reference: a uniform grid of equal cards, name and price,
price never truncated, the card the whole tap target.

Dropped: **photos.** There is no product photography for a towel rental,
Mindbody image fetches would add calls to the shelf path, and a placeholder
tile is worse than type. The name is the identifier a teacher reads anyway.
This is the one rejection Pete endorsed outright.

Added: **a card already in the cart says how many.** The reference
highlights the order row being edited; ours marks the shelf card instead, so
"two Liquid IV are rung up" is visible without reading down the receipt. It
sits **inline with the price** (`$1.81   x2`), not as a floating corner
badge, because a corner badge would reserve a padding zone in every card
whether or not it ever has anything to say. No new call, no new colour.

Sizing: `minmax(168px, 1fr)`, 8px gaps, **64px minimum card height** (the
tap-target floor, not 76), 8px/10px padding, 16px name, 16px tabular price.
The 44px favourite star stays a sibling target in the top-right corner, and
is the only thing the card reserves horizontal room for.

### 2.3 The cart column: compact rows, controls on the selected row

The reference's order row is two lines: name, then a small "1 Nos @ $8.00"
sub-line, with the line total right-aligned. Ours currently renders a
name/amount line plus a full quantity row of three 64px buttons on **every**
line, which is over 100px per item and is why a five-line cart already
scrolls internally.

Take the reference's shape, minus its redundancy:

- **A single-quantity line is one line of type**: name, right-aligned total.
  The reference prints "1 Nos @ $8.00" under a line whose total is already
  $8.00; that sub-line says nothing the row does not. Ours renders the
  `2 @ 1.81` sub-line **only when the quantity is more than one**, which is
  three lines out of seven in a realistic cart.
- **Tapping a line selects it**, and only the selected line reveals minus /
  quantity / plus / remove at the 64px floor. That is the reference's "row
  being edited is highlighted", and it is what buys the vertical space back.
- The common path does not change: **tapping the same shelf card again
  still increments**, so quantity is usually set without touching the cart
  at all. The controls exist for correcting a mistake, which is rarer.

Kept exactly: the monospace treatment, the subtotal / tax / total block, the
server's numbers rather than ours, the `disagrees` stop block naming the
offending line, and the amber suppressed notice with no figure.

Dropped, as decoration: **the "Sealevel Hot Yoga / Fremont" heading on the
on-screen ticket.** It is two lines of type plus a rule telling a teacher
standing in the studio which studio they are in. The emailed receipt
Mindbody sends still carries it; the screen does not need to.

**This pattern does not travel to the roster.** T14 flattened roster rows
into aligned columns and banned the expando specifically because a
26-person list cannot be scanned when rows change height. A cart is seven
lines long and is read once, top to bottom; a roster is not. See 5.

### 2.4 A bottom action bar, with one primary control that never moves

This is the best idea in the reference and it should be taken almost
literally.

A bar across the full width of the overlay, below all three columns, sticky
to the bottom of the viewport so it cannot scroll away:

- **Left, quiet:** Empty cart, and Back. Outlined, 64px, no fill.
- **Right, primary:** one filled accent control carrying the count and the
  server's total: `Pay · 9 items · $277.02`.

Why it is worth the vertical space it costs:

- **The primary control stops moving.** Today the Charge button sits under a
  receipt whose height depends on the cart, so the thing a teacher aims at
  is in a different place for a one-item sale than a seven-item one. A fixed
  bottom-right corner is learnable.
- **It restates the money at the moment of the tap**, which is already the
  rule for Charge (T24) and now holds for the step before it too.
- **It is the same control in both modes** (2.5): `Pay` in shelf mode,
  `Charge $X` in payment mode. One place, two labels, no relearning.

Rules it inherits and must not break: disabled on an empty cart; the pricing
spinner rather than a stale figure while a reprice is in flight; and in
payment mode enabled **only** when due is exactly zero and every line is
valid (T35). It sits below every modal scrim in the stacking order, or the
cart-change confirm (T27 round three) could be tapped past.

Not on the bar: **Orders**, **Save**, **Discount/Charges** (see 4), and
**Comp** (see 2.9).

### 2.5 One screen, two modes. The cart never moves; the middle column changes.

The question Pete raised earlier is what happens when a teacher is mid-sale
and someone needs checking in. The answer is already built and does not
change: **Back**. The overlay is state, not a route; SaleScreen stays
mounted; the cart survives (T23). That is true whether Buy is one screen or
five, so it does not decide this.

What decides it is that **at tender time the item grid is half the screen
doing nothing**, while the payment figures are squeezed into a side column.

So: one screen, two modes, no route, no navigation, nothing unmounted.

- **Shelf mode** (the default): rail, grid, cart. The bar reads
  `Pay · N items · $total`. There is **no method row, no tender block and no
  Comp control on screen at all** in this mode.
- **Payment mode**: the **cart stays exactly where it is**, same column,
  same width, unmoved and unresized. The **payment surface takes the middle
  column**, where the grid was.
- **The rail collapses in payment mode**, and the payment surface spans the
  width the rail and the grid shared. Its entries choose what to sell, and
  at tender time there is nothing left to choose; leaving seven inert
  category names on screen beside the figure a teacher is checking would be
  exactly the wasted space Pete objected to. The way back is the bar's
  `Back to items`, which is a bigger target than any rail entry, and Escape.
- **Returning is one tap and loses nothing.** Tender lines, the armed
  sources and any entered amount survive the round trip, exactly as the cart
  survives Back.

The cart not moving is the point, and it is the part of the first draft's
argument that survived Pete's reordering intact: the teacher's eye keeps its
anchor across the mode switch, and a last-second "and a towel" is one tap
away rather than a lost cart.

**Escape gains an owner.** Today Escape closes the overlay unless a modal is
stacked (T23). It must now first leave payment mode, then close. The keypad
modal keeps priority over both, and every path that leaves payment mode must
dismiss an open keypad and report the close upward, on the same rule as
T35's review fix.

### 2.6 The payment surface, and how T35 maps onto "Balance Due / Amount Tendered"

The reference pairs two large figures at the top: Balance Due and Amount
Tendered, the tendered one editable beside a keypad affordance. T35 models
the same thing with more precision, because it has to: a tender is a list of
lines, and cash is the only source allowed to exceed what it owes.

The mapping, and it is close to one-for-one:

| Reference | Ours | Note |
|---|---|---|
| Balance Due | **Due** | The server's total minus what the lines cover. Renders `--ok` at zero, which is the one figure to check before charging. |
| Amount Tendered | **The tender lines** | Their sum is the tendered figure. Two lines maximum (T35), and the second line is the split. |
| (absent) | **Change** | Cash over-tender, the loud `--warn` figure. The reference has no change figure because its tendered field is the customer's cash; ours has to hand money back out of a drawer. |
| (absent) | **Total** | The server's rehearsed grand total, stated once beside Due, because Due alone does not say what the sale was. |

Three figures across the top of the middle column: **Total**, **Due**,
**Change**. Everything below is how Due gets to zero.

**Method tiles.** The reference's grid of tiles is right for us at this
size, and one detail of it is worth taking outright: **the available balance
as a small corner badge on the tile**. Credit's tile reads `Credit` with
`$40.00` in the corner, which is strictly better than today's greyed button
whose reason lives in a `title` attribute nobody on an iPad can see.

What does not change, from T33 and T35:

- **Credit leads when there is a balance, and is absent when there is
  not.** The tile grid is two or three tiles wide, not a fixed four with a
  dead slot. Do not fill the gap.
- Tapping a source **adds a line pre-filled with the whole remaining due**,
  clamped by that source's rule. One tap, no typing, for the ordinary sale.
- A source already in the payment, or a third source when two lines exist,
  is **greyed with the reason on the tile**, never hidden.
- **Comp stays outside the list**, a whole-sale hold with its own confirm,
  and it is now visible only here. See 2.9.

**Tender lines** are unchanged from T35: `[source] [amount] [x]`, one
compact row, tabular right-aligned amount, the amount a button that opens
the keypad, the x removing the line and thereby leaving the split. In the
middle column they get the width to breathe that a 400px side column never
gave them.

### 2.7 The quick-denomination row: it already exists, in the right place

The reference puts four denomination buttons along the bottom of the payment
surface. Pete has separately asked for Exact / $5 / $10 / $20 inside the
amount keypad, and that work is in flight. **Do not build both.**

The keypad is the right home, for a reason that is not just tidiness: a
denomination is meaningless until you know **which line** it applies to. At
surface level, "$20" has no referent when there is no cash line yet, and two
referents once there is a split. Inside the keypad the line is named at the
top, the cap is known, and the change math is on screen underneath as the
chip is tapped.

The surface-level version of "Exact" already exists and costs zero taps:
**tapping the Cash tile pre-fills the whole remaining due** (T35). So the
reference's most-used denomination button is our default behaviour, and the
other three are one tap deeper, where they can be right.

The one change worth making: tapping the Cash tile when a cash line already
exists should open that line's keypad rather than refusing as "already in
the payment", so the denominations stay one tap from the surface.

### 2.8 Density: every band of space earns its place

Pete's second instruction was that the screen still wastes space. It did.
The 16px type floor and the 64px target floor are floors for **text and hit
areas**; they say nothing about padding, margins, decorative headings or
labels that repeat what is already on screen, and the first draft spent all
four freely. This is the audit, element by element. Every number below is a
reduction from the first draft unless marked kept.

**The shell and the chrome**

| Element | Was | Now | Why |
|---|---:|---:|---|
| Shell max-width | 1100 | 1400 | Section 2.1. The counter's screen, not ours. |
| Shell padding | 16 | 12 | 8px of the saving goes to the grid; the frame edge is not a reading surface. |
| Column gaps | 20 | 12 | Three columns with visible borders do not need 20px of air to separate them. |
| Mode banner | 10/16 pad, 12 margin | 8/14 pad, 8 margin | Kept at 16px text and full width. It is never cut: a teacher must never wonder whether the tap was real. |
| Header title | 24px | 20px | Nothing is decided by the word "Buy" being large. |
| Header margin | 12 | 8 | |
| Action bar padding | 12 | 10 | The 64px controls set the bar's height; padding only adds to it. |

**The rail**

Entries are 64px tall (the tap floor, kept) with 4px gaps rather than 8, and
12px horizontal padding rather than 20. Seven entries occupy 476px, which is
less than the grid beside them, so the rail introduces no scroll of its own
and no empty band below it that anything else could have used.

**The grid**

| Element | Was | Now | Why |
|---|---:|---:|---|
| Card min-height | 76 | 64 | 64 is the tap floor; 76 was 12px of habit, times up to sixteen cards. |
| Card padding | 12/14, plus 56 reserved right | 8/10, 40 reserved right | The 56px reserve existed for a corner count badge that most cards never carry. |
| Grid gap | 10 | 8 | |
| Card min width | 190 | 168 | Buys the fourth column at 1366 without truncating a name or a price. |
| Count badge | corner, absolute | inline after the price | Removes the reserved zone above. |

**The cart**

| Element | Was | Now | Why |
|---|---:|---:|---|
| Column width | 400 | 340 | Measured against the longest real item name at 16px monospace; nothing truncates that did not already wrap. |
| Ticket padding | 20/22 | 12/14 | |
| Studio heading | 2 lines + rule | removed | It tells a teacher which studio they are standing in. |
| Line padding | 8 | 4/6 | |
| Line gap | 6 | 2 | The rows are bordered when selected and quiet otherwise; they do not need a gutter each. |
| `1 @ $2.72` sub-line | every line | quantity > 1 only | It repeats the line total when the quantity is one. |
| Rule margins | 12 | 8 | |
| "Dry run: nothing will be charged" | in the ticket | payment surface only | It repeats the banner at the top of the same screen. It belongs at the moment of the tap, which is the Charge button, not the cart. |

Result: a seven-line cart with one line selected fits without scrolling on a
768px-tall landscape viewport, where the first draft's four-line cart
already nearly filled the column.

**The payment surface**

| Element | Was | Now | Why |
|---|---:|---:|---|
| Figure value | 34px | 30px | Still more than twice the floor, and Due is the only figure that must carry across a counter. |
| Figure padding | 12/16 | 10/14 | |
| "Take payment from" label | present | removed | Three tiles reading Credit, Card and Cash do not need a label saying they are payment sources. |
| Tile min-height | 84 | 72 | |
| Tile reason line | always rendered | only when there is a reason | An empty muted line under every tile is a reserved band for an exception. |
| Surface gaps | 16 | 10 | |
| Instruction line | 2 lines | 1 short line | "Tap an amount to change it." teaches a non-obvious affordance once; the cash rule is already visible as the Change figure. |

**Vertical budget**, against the shorter 768px-class landscape viewport:

```
 40  mode banner
 44  header: Buy, For: NAME + balance, Back
~590 columns  (rail 476, grid 4 rows, cart 7 lines + totals: none scroll)
 84  action bar (64px control + 10px padding each side)
```

That is the test this section has to pass: **at the studio's real numbers,
nothing scrolls.** Sixteen catalog items, seven cart lines, seven rail
entries, all on screen at once.

### 2.9 Comp is not a shelf control

**Decided by Pete.** Comp does not appear in shelf mode. It appears only in
the payment step, below the tender lines, as the quiet whole-sale gesture it
already is.

The reasoning is not only space. Comp is the one control on this screen that
gives away a $230 pack in two taps, and it has a confirming hold for exactly
that reason. Having it in the action bar while a teacher is ringing up a
towel puts a destructive-in-effect control permanently in reach of the hand
that is tapping items, which is the same mis-tap argument that keeps
destructive icons off roster rows (ui-refactor 3). It also has nothing to
say until there is a total to comp.

Everything about its behaviour is unchanged from T35: still outside the
tender list, still a whole-sale hold, still clears the lines when armed and
disarms when a line is added, still cleared by a client change.

### 2.10 Colour: two new tokens, both palettes, nothing else

The palette does not need to move for this layout. Everything here paints
from tokens that already exist in both palettes: `--bg`, `--surface`,
`--line`, `--ink`, `--muted`, `--accent`, `--action-bg`, and the three
semantic pairs `--ok/--ok-bg` (Due settled, an available balance),
`--warn/--warn-bg` (change due, dry run, suppressed writes) and
`--stop/--stop-bg` (a disagreeing cart, a refused charge).

Two additions, both defined in `:root` **and** in the
`prefers-color-scheme: dark` block, per the house rule:

- **`--accent-ink`**: the text colour on an accent fill. The code currently
  spends `--surface` for this on `.cat-chip.on` and `.charge-btn`, which
  works today only because both palettes happen to be legible that way. The
  bottom bar's primary and the rail's active entry are the two largest
  accent fills on the screen and should not rest on a coincidence.
- **`--shadow`**: a per-palette shadow, so the sticky action bar can lift
  off the columns without a hairline that disappears in dark mode. A
  light-mode shadow is invisible on a dark ground, which is exactly the
  class of bug the both-palettes rule exists for.

Explicitly **not** required: the `--gold` pair proposed in ui-refactor 2.6.
The cart count and the balance badge reuse the existing `.bal-chip` and
`--ok` pairings.

## 3. What the roster inherits, so the two screens stay one app

Small list on purpose. The roster is a good screen and this is a Buy-screen
plan.

- **The filled-active idiom**, already shared: the Buy rail's active entry,
  the roster's class dropdown and the sort bar all fill with the accent when
  selected, and nothing else on either screen does.
- **The header shape**: title, then identity taking the slack, then a
  labelled Back or Change at the right edge (T31, T34). Both screens already
  read this way; keep them in step when either moves.
- **The corner-badge idiom**: a balance or a count as a small pill in a
  semantic pair rather than the accent. The roster's `.bal-chip` is the
  source of it; the Buy screen's method tiles reuse it verbatim.
- **Tabular figures everywhere money appears**, in both screens.
- **The keypad modal is shared property.** It is the only numeric entry in
  the app, it owns Escape while open, and no OS keyboard appears anywhere.
- **The density audit's method**, if not its numbers: padding, decorative
  headings and labels that repeat the screen are not protected by the 16px
  and 64px floors. The roster has its own version of most of them.

What the roster does **not** inherit:

- **The bottom action bar.** The roster's primary action is per row; a
  screen-level primary would have nothing true to say.
- **The select-to-reveal-controls cart row.** T14 stands: roster rows are
  fixed-height aligned columns, and no expando returns in any form.
- **Two modes.** The roster is one surface with modals over it, which is the
  speed argument, and nothing here changes that.
- **The widened shell, not automatically.** See open question 9.

## 4. What we are NOT taking from the reference

- **Photos on item cards.** No product photography exists, Mindbody image
  fetches would add calls to the shelf path, and a grey placeholder tile is
  worse than a name in 16px type. Endorsed by Pete.
- **Five items across.** At the 16px floor and a 64px card, five columns
  even in the widened middle would truncate names and prices. Three at
  1080px, four at 1366, and names that fit.
- **The `Orders` list and `Save`.** A parked-order queue is a real feature
  with real state, and this counter serves one person at a time; the one
  cart already survives Back and an accidental navigation. If two carts at
  once turns out to be a genuine need, it is a ticket, not a button we add
  speculatively. Open question 6.
- **`Discount / Charges` in the action bar.** There is no line-level
  discount to offer: the request-side `CheckoutItem` carries only `Type` and
  `Metadata`, whose key set is not enumerated in the vendored spec, and a
  price override is unproven pending a Test-mode probe. `PromotionCode` is
  cart-level and needs a permission the account may not hold. Putting a
  Discount button on screen before any of that is settled is promising a
  teacher something the API may refuse.
- **A per-line discount and tax sub-line on every cart row.** Tax is
  per-item (T27's TaxRate fix), but showing it per line is nine figures
  where one is true. One tax line, and the disagreement path already names
  the offending line when the server disagrees with us.
- **The "1 Nos @ $8.00" sub-line on single-quantity rows.** It repeats the
  line total. Ours renders only above quantity one. See 2.3.
- **A fixed tile grid with dead slots.** Gift card and On Account are tiles
  in the reference whether or not they apply. T33 decided the opposite and
  was right: a permanently greyed method is noise on the one row that must
  read at a glance.
- **The currency chip beside the amount.** One currency.
- **The customer's name at the top of the order list.** T31 deliberately
  moved identity to the header and gave the payment column the space back.
  Do not put it back at the top of the cart.
- **A quick-denomination row on the payment surface.** It would duplicate
  the keypad chips. See 2.7.
- **A separate payment screen.** See 2.5.
- **The reference's type scale.** It lives on 12-13px muted metadata. Every
  figure here holds the 16px floor, and the three payment figures are
  deliberately much larger than that.

**No longer on this list, having been overruled:** the vertical category
rail. See 2.1.

## 5. Behaviour this plan would change, ticket by ticket

Nothing below is a silent regression; each is a deliberate revision, and if
Pete rejects any one of them the rest still stands.

- **T27 put the method row above the receipt in the left column.** This plan
  removes it from shelf mode entirely and gives it the middle column in
  payment mode. The reason T27 gave (compact, and the column must fit iPad
  landscape) is served better by not rendering it until it is needed.
  *Reversible: the tiles are the same control in a different container.*
- **T35's sources are "inline with the totals".** They still are, inside the
  payment surface; what changes is which column that block lives in and that
  the tiles gain a balance badge. **No clamp, cap, request shape or
  `chargeable` gate moves.** One line still sends
  `{ method, cashTendered? }`, two still send `{ split: { legs } }`, Charge
  is still enabled only when due is exactly zero and every line's reason is
  computed in the same render.
- **T35 specifies Comp as an always-available whole-sale hold.** Pete has
  narrowed *where it is visible*: payment mode only, never in shelf mode
  (2.9). Its behaviour is untouched. What implementation must not do is
  leave comp *armed* while invisible: arming happens only in payment mode,
  and leaving payment mode with comp armed either keeps it armed and says so
  on the bar's Charge label, or clears it. **Keeping it armed and silent is
  the one option that is not acceptable**, on the same principle as T33's
  "nothing invisible stays armed".
- **T23's Escape rule** (close the overlay unless a modal is stacked) gains
  a step: Escape leaves payment mode first. Any keypad open when payment
  mode is left must be dismissed and the close reported upward, per T35's
  review fix, or the next Escape is swallowed.
- **T23 also set the overlay shell at 1100px**, shared with the roster. The
  Buy overlay now widens to 1400; the roster's is untouched pending open
  question 9.
- **T33's "Done returns to the roster" is unchanged**, and the outcome block
  renders in the payment surface where the charge was made. The receipt is
  still cleared first.
- **T33's Credit visibility rules are unchanged**, including the
  split-failure exception where Credit stays visible while that warning is
  up. The tile grid must not backfill the slot Credit vacates.
- **T31's header identity is unchanged.** The reference tempts the opposite
  and is wrong for us.
- **T27 round three's cart-change confirm is unchanged**, but the sticky bar
  introduces a stacking-order requirement: the bar sits below every modal
  scrim, so nothing behind a confirm is tappable.
- **T23's pricing states must both survive the mode switch**: the
  `disagrees` stop block and the amber suppressed notice render in payment
  mode, next to the figures they contradict. A teacher must never reach a
  payment surface that looks settled while the cart disagrees with Mindbody.
- **T27's Favorites addendum is unchanged**: pinned first, selected by
  default when it has anything to show. In the rail that means the top
  entry, and its position is now constant.
- **T14's no-expando rule is untouched.** The select-to-edit cart row is a
  Buy-screen pattern and does not travel to the roster.
- **The mode banner is visible in both modes.** A payment surface in dry run
  must say so at the moment of the tap.

## 6. Open questions for Pete

**Resolved by the 2026-08-31 review:**

1. ~~Receipt left or right?~~ **Right.** Pete: "shopping cart on right". It
   stays there in both modes and is the layout's anchor.
2. ~~In payment mode, should the shelf disappear or shrink to a strip?~~
   **The grid is replaced by the payment surface and the rail collapses**
   (2.5). Back to items is one tap on the bar.

**Still open:**

3. **Is "Pay" the right word on the bar in shelf mode?** T27 renamed Sell to
   Buy because the counter conversation is the student's. "Pay" may carry
   the same problem. Candidates: `Pay`, `Take payment`, `Checkout`.
4. **Passes is 16 items, and the only shelf that could scroll.** Split the
   rail entry (Drop-ins / Packs / Unlimited), or leave one long shelf and
   rely on Favorites for the four that actually sell?
5. **Should the shelf card of an item already in the cart increment, or
   select its cart line?** The plan keeps increment, which makes the cart
   controls a correction tool.
6. **Do you ever need two carts open at once** (the reference's Orders /
   Save)? If a teacher genuinely gets interrupted mid-sale by a second buyer
   rather than a check-in, that is a real feature and worth a ticket.
7. **Where do contracts (T30) live in this layout?** A grid card in the
   Passes shelf that opens the contract confirm, or their own rail entry?
   They are the largest-value thing sold at the counter and they are not
   ordinary cart lines.
8. **Cart count on grid cards: useful or noise?** It is the one thing added
   here that the current screen does not have in some form.
9. **Should the roster shell widen too?** Buy goes to 1400px because it now
   has three columns to feed. The roster is a single list of aligned rows at
   1100px, and a wider one stretches those rows rather than showing more.
   The two screens sharing a width is worth something on its own, so this is
   a taste call, not an arithmetic one.
