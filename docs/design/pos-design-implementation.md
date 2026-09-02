# Implementing the POS design (POSDesign.pdf)

Status: implementation plan, awaiting Pete's three calls in section 3.
Owner: Pete. Date: 2026-09-02.
Design of record: `docs/design/mockups/POSDesign.pdf` (four frames).
Reasoning of record: `docs/design/sale-screen-layout.md` (the layout plan,
revised 2026-08-31). Where this document and that one disagree, this one
is newer and wins; where either disagrees with TICKETS T35, T35 wins.

## 0. What the PDF is

Four frames, two screens each, in two visual directions. The structure is
the same in all four and it is the structure the layout plan already
decided: rail left, grid middle, cart right, a bottom action bar with one
primary control, and a payment mode that replaces the grid while the cart
stays put. So the plan below is mostly a build order for a screen that is
already designed, plus the handful of places the frames go beyond the plan
or disagree with each other.

| Frame | Screen | Direction |
|---|---|---|
| 1 | Shelf, light | **A "Counter"**: warm paper, one teal accent, monospace only for money |
| 2 | Payment, dark | A |
| 3 | Shelf, dark | **B**: amber accent, price-first cards, pill buttons, mode as a chip |
| 4 | Payment, light | B |

Frame 1 carries the designer's own caption: "warm paper, one teal accent,
mono only for money. Live: tap items, select cart lines, pay, keypad."
That caption is the best one-line brief for the whole build.

### 0.1 What the four frames agree on

Everything here is decided and is built without waiting on section 3.

- **Header**: `Buy`, then the client card (SALE FOR / name / balance pill /
  detach x), Back at the far right. T31's identity placement, styled.
- **Rail** of seven entries, Favorites pinned first and filled when active,
  a muted `more` entry last for the overflow.
- **Grid** of equal cards, name and price, no photos, a small count pill on
  a card already in the cart. Bundle cards marked (a dashed border and the
  word "bundle" in B, no pill in A).
- **Cart** headed `TICKET · 9 items`, one line per item with a right-aligned
  total, the `2 @ 1.81` sub-line only above quantity one, and the selected
  line expanding to minus / quantity / plus / Remove. No studio heading.
  Subtotal / Tax 10.35% / Total at the foot.
- **Bottom bar**: `Empty cart` quiet at the left, the primary control at the
  right: `Pay $277.02` in shelf mode, `Charge $277.02` in payment mode.
- **Payment mode** takes the rail and grid's width; the cart does not move.
  Three figures across the top (Total, Due, Change), the tender lines
  below, `Comp` alone at the foot of the surface and nowhere else, and a
  `Back to items` control.
- **The receipt is identical in both modes**, which is the anchor the
  layout plan argued for.

### 0.2 Where the frames disagree

These are the three calls for Pete (section 3). Nothing below blocks the
build order in section 2 until step 7.

| | A (frames 1, 2) | B (frames 3, 4) |
|---|---|---|
| Mode indicator | A full-width banner line above the header: "Dry run: taps are rehearsed, nothing reaches Mindbody." | A `DRY RUN` chip in the header, plus "Dry run: nothing will be charged." beside the bar's Charge |
| Amount entry | Not shown; the keypad is the T36 modal | A persistent keypad panel in the right half of the payment surface, editing the outlined (selected) tender line, with Exact / $5 / $20 / $100 chips |
| Adding a source | Three tiles (Credit with a balance badge, Card, Cash), each carrying its reason when unavailable ("In the payment", "Two parts is the maximum") | Two small `+ Card` / `+ Cash` buttons under the tender lines; Credit is simply already a line |
| Figures | Total, Due (ok-green when settled), Change (warn-amber) | Due first and largest on an ink-filled tile, then Total, then Change |
| Card layout | Name top, price bottom-left, count pill bottom-right | Price large at top, name and count small at the bottom |
| Title in payment mode | `Buy` stays | `Payment` |
| Bar primary | `Pay $277.02` | `Pay · 9 items · $277.02` |
| Palette | Teal accent, `--ok` green for settled | Amber accent |

## 1. What has to be true regardless of direction

The rails this build runs on. None is new; each is a rule some earlier
ticket paid for and the redesign must carry across intact.

- **The money does not move.** Request shapes (one line sends `method` and
  optionally `cashTendered`; two send `split.legs`), the single flight, the
  clamps, the availability rules, the per-line reasons computed in the same
  render as `chargeable`, the server's authority over every number (T24,
  T28, T31, T35). This is a re-skin of the tender, not a re-model.
- **The mode banner is never removed** (CLAUDE.md). If Pete chooses B's
  chip, it replaces the banner's *shape*, not its presence: the chip must
  render in every mode and every state (sandbox, prod dry run, prod live,
  write-guarded), be readable at the 16px floor, and the "nothing will be
  charged" line must sit beside Charge at the moment of the tap.
- **Comp is never armed while invisible** (layout plan 5, T33's rule).
  Comp arms only in payment mode. Leaving payment mode with comp armed
  clears it; the surface says so on return.
- **Escape has an order**: keypad, then cart-change confirm, then payment
  mode, then the overlay (T23, T35 review, layout plan 2.5). Every path
  that leaves payment mode dismisses an open keypad and reports the close
  upward.
- **Nothing local renders as a total.** T38's estimate is muted and
  labelled, and the `disagrees` stop and the amber suppressed notice render
  in payment mode next to the figures they contradict.
- **Tokens, both palettes, no hex in components.** The PDF's frames are
  dark and light versions of one design, which is exactly what the two
  palette blocks are for.
- **16px text, 64px targets.** The PDF's small labels (SALE FOR, TICKET,
  the `2 @ 1.81` sub-line, tile reasons) are the layout plan's recorded
  exceptions: 14px muted metadata is acceptable where it repeats what the
  row already says, and never for a figure or a name.
- **T38 lands first.** It holds the receipt's row cap and scroll cue, the
  pricing estimate, the audit table and the escape hatch, all in the same
  files this plan rewrites. Building the new cart column on top of it is
  one change; building it beside T38's in-flight edits is a merge.

## 2. Build order

Nine steps, each its own ticket (T39.1 through T39.9), each followed by a
separate adversarial review before it is pushed, each leaving the app
shippable. Steps 1 through 6 are direction-independent. Step 7 waits on
section 3. Serial, because every step edits `SaleScreen.tsx` and
`globals.css`.

### T39.1 Shell, tokens, header

- `.sale-shell` max-width 1100 to 1400, padding 16 to 12, gaps 20 to 12
  (layout plan 2.8). The roster's `.shell` is untouched (open question 9).
- Two tokens, in `:root` and the dark block: `--accent-ink` (text on an
  accent fill; `.cat-chip.on` and `.charge-btn` currently borrow
  `--surface` for it) and `--shadow`.
- **The accent becomes the PDF's teal** in both palettes (or amber, if B).
  One token, so the roster's class dropdown and sort bar follow, which is
  the layout plan's "same idiom, both screens". The exact values are read
  off the PDF at build time, then checked for contrast on both grounds at
  16px.
- Header: `.sale-top` becomes the PDF's three-part row. The client card is
  `.sale-for` restyled (label, name, `.bal-chip`, detach x), Back stays the
  labelled outlined control at the right.
- Done when: the overlay is 1400 wide on a 1366 iPad with the columns
  still the old two, both palettes screenshot-checked, typecheck and build
  clean.

### T39.2 The rail

- `.sale-cats` becomes a vertical rail column, 132px, entries 64px tall
  with 4px gaps, Favorites pinned first and filled with the accent when
  active. Packages and Memberships stay where they are in the order today.
- `more`: the entries past the seventh go behind a muted `more` entry that
  expands the rail in place (the PDF shows it as a quiet last entry). With
  the studio's catalog this never triggers, so it needs no scroll of its
  own.
- Folds back to the horizontal chip row under 1040px (layout plan 2.1).
- Done when: the rail never wraps or scrolls at 1080/1180/1366, and the
  fold renders at 1000.

### T39.3 The grid

- `.shelf-grid` at `minmax(168px, 1fr)`, 8px gaps; cards at a 64px
  minimum height with 8/10 padding, name 16px, price 16px tabular
  monospace (A) at the bottom-left, the favourite star still a 44px
  sibling target top-right.
- **The count pill**: a card in the cart shows `x2` as a small filled pill
  beside the price, from cart state, no new call. Open question 8 stands;
  it is cheap to remove.
- Bundle cards keep `.shelf-bundle-mark`; contracts keep their own card
  shape and confirm (T30) and sit in the Memberships shelf.
- Done when: sixteen cards fit at 1180 without the grid scrolling
  (four rows of three at 64px), the count pill tracks the cart.

### T39.4 The cart column

Built on T38's receipt, which already has the row cap, the scroll cue, the
estimate and the audit table.

- Column 340px. `TICKET` and the item count on one header line; the studio
  heading goes.
- Rows: name and right-aligned total on one line; `n @ price` sub-line
  only above quantity one (14px muted, the recorded exception).
- **Select to reveal**: tapping a row selects it (outlined with the accent,
  `--surface` fill) and only that row shows minus / quantity / plus /
  Remove at 64px. Tapping again, or another row, or any shelf card,
  deselects. Remove is outlined `--stop`. The per-row 64px stepper on every
  line is deleted, which is what buys back the space.
- Tapping a shelf card still increments the line (open question 5 stands).
- Totals block: Subtotal, `Tax 10.35%` (the rate from `/api/config`, the
  literal string only when the server sent one), Total bold and larger.
- T38's Clear cart control moves out of the ticket and becomes the bar's
  `Empty cart` in T39.5, keeping its confirm.
- Done when: a seven-line cart with one row selected fits on a 768px-tall
  viewport without the column scrolling, T14's roster rule untouched.

### T39.5 The bottom action bar

- Full width of the overlay, sticky to the viewport's bottom edge, lifted
  with `--shadow`, 10px padding, 64px controls.
- Left: `Empty cart` (T38's confirm behind it). Back stays in the header
  (the PDF keeps it there in both directions).
- Right: one accent-filled primary. Shelf mode: `Pay $277.02`, disabled on
  an empty cart, a spinner in place of the figure while a reprice is in
  flight, and **the server's figure only**: while T38's estimate is
  showing, the bar reads `Pay` with no amount. Payment mode: the existing
  Charge, moved, with its enablement untouched.
- Stacking: below every modal scrim (the keypad, the cart-change confirm,
  the contract confirm, the waiver), above the columns.
- Done when: the primary control is in the same corner for a one-item and
  a seven-item cart, and nothing behind a scrim is tappable.

### T39.6 Two modes

The largest step and the one to review hardest.

- `saleMode: "shelf" | "pay"` in SaleScreen, reset to `shelf` on every
  open and on Done. `Pay` enters; `Back to items` (a quiet control at the
  top-left of the payment surface, where the PDF puts it) and Escape leave.
- The middle column renders the grid or the payment surface; the rail
  collapses in payment mode; the cart column renders the same element in
  both modes and is not remounted.
- **PaymentPanel moves** from `.sale-left` to the middle column. Its state
  (tender lines, comp, the keypad) must survive the mode switch, which
  means the panel stays mounted and is hidden, or its state is lifted. Keep
  it mounted: lifting the tender state out of the panel is a rewrite of
  T35 for no gain. Hidden, not unmounted, and its `onModalChange` still
  reports.
- Comp: rendered only in payment mode; leaving payment mode clears it
  (section 1).
- Escape ordering per section 1, with the T35 review fix's guard still
  covering a keypad whose line has gone.
- The `disagrees` stop and the suppressed notice render in payment mode
  above the figures; the Charge on the bar stays disabled exactly as
  today.
- Done when: a split tender entered in payment mode survives Back to items
  and returns intact, Escape peels one layer per press in the stated
  order, comp cannot be found armed in shelf mode by any sequence.

### T39.7 The payment surface (waits on section 3)

Direction-independent parts, built first:

- Three figures in a row across the top: Total (the server's), Due
  (`--ok` when zero), Change (`--warn`, cash over-tender only). 30px
  figures, tabular.
- Tender lines as T35 has them: source, `covers $X` sub-line when a cash
  line exceeds its due, the amount as the button that opens the keypad,
  the x. "Tap an amount to change it." once, under the lines.
- The foot: the quiet note ("Nothing to pay, on the studio." for a comped
  sale; the first line problem otherwise) and `Comp this sale` at the
  right, hold to arm, unchanged behaviour.
- Tapping the Cash source when a cash line exists opens that line's keypad
  rather than refusing (layout plan 2.7).

Direction-dependent parts, per Pete's call:

- Sources as **tiles with reasons and the balance badge** (A) or as
  **`+ Card` / `+ Cash` buttons** (B, with Credit added as a line
  automatically when there is a balance). A is recommended: T33's rule
  that an unavailable source is greyed with its reason, never hidden, has
  a home on a tile and none on a small button, and the badge is the one
  detail the layout plan singled out as strictly better than today.
- Keypad as **the T36 modal** (A) or **a persistent panel** (B). See 3.2.
- Done when: every T35 scenario in the sandbox checklist (TICKETS, "The
  Phase 2 sandbox run") renders and charges as it did before this plan.

### T39.8 Density and degradation pass

- The layout plan 2.8 audit applied line by line, and the vertical budget
  re-measured at 768 tall: banner, header, columns, bar; nothing scrolls at
  the studio's real numbers.
- The 1040 rail fold and the 860 cart fold verified.
- Both palettes screenshot-checked frame by frame against the PDF.

### T39.9 What the roster inherits

Only the layout plan's short list (section 3 there): the accent (already
shared by the token), the header shape, the badge idiom, tabular figures.
Nothing else travels. Open question 9 (widen the roster shell too) is
answered by Pete or left at 1100.

## 3. Pete's calls

Three, and one reply covers them. Steps 1 through 6 proceed meanwhile.

### 3.1 Direction: A or B?

**Recommend A**, for reasons that are on record rather than taste:

- A keeps the banner line; B's chip is a narrower version of a control
  CLAUDE.md says must never be removed, and it would need to carry four
  states the chip in the frame does not show.
- A's source tiles carry the reason a source is unavailable; B's buttons
  cannot, and T33 decided a greyed reason beats a hidden control.
- A's cards put the name first. Nine items are 90% of taps and six of them
  cost under four dollars; a teacher finds "Towel rental", not "$2.72".
- "Buy" stays the title in A. T27 renamed Sell to Buy on purpose;
  "Payment" reopens that.

What B has that A should take anyway: `Pay · 9 items · $277.02` on the bar
(the count is useful at the moment of the tap), the dashed border and the
word "bundle" on bundle cards, Due as the most prominent of the three
figures.

### 3.2 Keypad: modal (T36, built) or a persistent panel (frame 4)?

T36 shipped the modal three days ago on Pete's words, "having it be a
modal is def better than this", where "this" was the inline keypad pushing
the receipt down the 400px payment column. Frame 4 puts the keypad inline
again, but in the wide payment surface where it pushes nothing, and it edits
whichever tender line is outlined. That is a different proposal from the
one Pete rejected and it is worth deciding on its merits.

**Recommend the modal for T39.7, panel as a follow-up if wanted.** The
modal is built, reviewed and carries the T35 guard; the panel needs a
selected-line notion for tender lines, a rule for what it shows with no
line selected, and a decision on the chips ($100 appears in frame 4).
Neither choice touches the money.

### 3.3 Accent: teal app-wide?

Changing `--accent` moves the roster's class dropdown and sort bar with it.
That is the intended "one idiom" outcome, but it is a visible change on the
screen teachers use most. Yes, or Buy-only (a second token, `--buy-accent`,
which the layout plan argued against).

## 4. Out of scope, deliberately

- Photos, five columns, Orders/Save, Discount, per-line tax: rejected in
  the layout plan section 4, unchanged.
- The PDF's typefaces. It is set in a geometric sans and a coding mono; the
  app stays on the system stack and `ui-monospace`. Type is not what makes
  these frames work.
- Any change to `/api/checkout`, `/api/price-cart` or `src/lib/sale.ts`.

## 5. Verification, per step

No test suite. Each step's review checks: `npm run typecheck`, `npm run
build`, both palettes at 1080, 1180 and 1366 wide and 768 tall, the
Escape order, and for T39.6 and T39.7 the full T35 request mapping in the
dev drawer (one line: `method` alone; two lines: `split.legs` with no
`cashTendered`; cash over-tender: `cashTendered` on a single line).
