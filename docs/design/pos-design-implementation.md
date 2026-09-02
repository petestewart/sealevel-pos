# Implementing the POS design (Buy Screen canvas)

Status: implementation plan, revised against the canvas source. Awaiting
Pete's calls in section 3. Owner: Pete. Date: 2026-09-02.

Design of record: `docs/design/mockups/BuyScreen.dc.html` (four
directions; 1a is an interactive prototype), with `support.js` beside it
so it opens locally, and `BuyScreen.sync.md` (the design tool's sync
note). `docs/design/mockups/POSDesign.pdf` is the same four screens
exported as frames.
Reasoning of record: `docs/design/sale-screen-layout.md` (the layout plan,
revised 2026-08-31). Where this document and that one disagree, this one
is newer and wins; where either disagrees with TICKETS T35, T35 wins.

## 0. What the canvas is

Four directions over one arrangement. The arrangement is the layout of
record: rail left, grid middle, cart right, a bottom action bar with one
primary control, and a payment mode that replaces the grid while the cart
stays put. So this plan is mostly a build order for a screen that is
already designed, plus the places the canvas goes beyond the plan, the
places the prototype's behaviour differs from T35, and the calls that are
Pete's.

| Option | PDF frame | Direction |
|---|---|---|
| 1a | 1 | **Counter**: warm paper, one teal accent, mono only for money. Interactive: tap items, select cart lines, pay, keypad. |
| 1b | 2 | **Counter, dark**: "same tokens flipped; teal lifts, paper goes to ink." |
| 1c | 3 | **Slate**: cool graphite, borderless cards, amber accent, price-first tiles, statement-style cart. |
| 1d | 4 | **Chalk**: light, no hairlines, oversized numerals, keypad always on the payment surface instead of a modal. |

1a and 1b are one direction in two palettes, which is exactly what
`globals.css`'s two palette blocks are for. 1c and 1d are each a single
palette. The designer's own "try next" line at the foot of the canvas
offers three follow-ups, none of them decisions: build 1c as the live
one; put 1d's inline keypad into 1a; one direction with a tighter
four-column grid.

### 0.1 What all four agree on

Decided, and built without waiting on section 3.

- **Header**: `Buy`, then the client card (SALE FOR / name / balance pill /
  detach x), Back at the far right. T31's identity placement, styled.
- **Rail** of seven entries, Favorites pinned first and filled when active,
  a muted `more` entry last.
- **Grid** of equal cards, name and price, no photos, a small count pill on
  a card already in the cart.
- **Cart** headed `Ticket · 9 items`, one line per item with a right-aligned
  total, the `2 @ 1.81` sub-line only above quantity one, the selected line
  expanding to minus / quantity / plus / Remove. No studio heading.
  Subtotal / Tax 10.35% / Total at the foot.
- **Bottom bar**: the secondary control quiet at the left, the primary at
  the right carrying the figure.
- **Payment mode** takes the rail and grid's width; the cart does not move.
  Three figures across the top (Total, Due, Change), tender lines below,
  Comp alone at the foot of the surface and nowhere else.

### 0.2 The Counter spec, read off the source

Every number below is from 1a/1b's markup, at a 1366 x 1024 frame. Where
it collides with a house rule the rule wins and the collision is marked.

**Frame.** Banner 30px. Header 76px, bottom hairline. Columns padded
16/20 with 14px gaps. Bar 92px on its own ground.

**Palette, as our tokens.** Light / dark.

| Token | Light | Dark | Role in the canvas |
|---|---|---|---|
| `--bg` | `#f6f3ec` | `#131311` | frame ground, figure tiles, tender rows |
| `--surface` | `#fffdf8` | `#1c1b18` | cards, ticket, surfaces, modal |
| `--line` | `#e4ded2` | `#2c2b26` | hairlines, card borders |
| `--line-soft` (new) | `#ded7ca` | `#33322b` | dashed ticket rules, key borders |
| `--ink` | `#1a1815` | `#f2efe7` | |
| `--muted` | `#7a7163` | `#9b9284` | labels, notes, sub-lines |
| `--accent` | `#0f5c55` | `#5fd2a4` | active rail entry, count pill, primary fill, selected outlines |
| `--accent-ink` (new) | `#ffffff` | `#0b1a14` | text on the accent fill; the dark accent is light, so this cannot be `--surface` |
| `--ok` / `--ok-bg` | `#0d6b47` / `#e7f1ea` | `#68c79b` / `#0f2a20` | banner, balance pill, Due settled, tile badge, done check |
| `--warn` / `--warn-bg` | `#7a5a10` / `#faf1de` | `#e0b264` / `#2e2410` | Change tile, keypad change line (`#8a5a00` in 1a) |
| `--stop` | `#b0332c` | (not drawn; keep ours) | Remove |
| `--action-bg` | `#f1ede4` pressed, `#e8e3d8` key pressed | (not drawn; keep ours) | |
| `--bar-bg` (new, or `--bg`) | `#f2efe7` | `#191816` | action bar, selected cart row, Entered box |
| disabled primary | `#d5cfc2` on `#7a7163` | (not drawn) | `Pay` on an empty cart, `Due` while unpaid |

The dark Due and Change tiles also carry their own border colours
(`#2b6b4c`, `#6b5321`); use the `--ok` / `--warn` text colour at reduced
opacity rather than two more tokens.

**Type.** Instrument Sans for everything, IBM Plex Mono for money only,
tabular. Sizes the canvas uses and what we do with them:

| Canvas | Where | Ours |
|---|---|---|
| 12px | SALE FOR label | 14px, the metadata exception |
| 13px | banner, figure-tile labels, count pill, tile badge | **16px for the banner** (a mode line is read, not glanced), 14px for the rest |
| 14px | ticket count, sub-lines, tile reasons, hints, notes | 14px, the recorded exception; 16px for any hint that carries a rule |
| 15px | rail entries, Ticket heading, totals rows, chips, Remove, Comp | 16px |
| 16px | card price, cart lines, Back, bar secondary | 16px |
| 17px | card name, client name, Total label | 17px |
| 18px | tile names, keypad Amount due, change line | 18px |
| 20px | tender amount button, keypad title, bar primary label | 20px |
| 22px, 23px | bar primary amount, keypad keys, `Buy` | as drawn |
| 26px | ticket Total | as drawn |
| 30px | keypad Entered, done title | as drawn |
| 34px | the three figures | as drawn |

Fonts are a call (3.4). Everything else is a straight token mapping.

**Shelf mode.** Grid `154px minmax(0,1fr) 388px`.
- Rail: entries 62px tall, 6px gaps, 14px side padding, radius 12, 600
  weight; active is the accent fill with `--accent-ink`; `more` is muted.
  We hold 64px.
- Cards: `minmax(184px, 1fr)`, 10px gaps, min-height 96, padding 14,
  radius 14, name top (17px/600), price bottom-left (16px mono, muted-
  strong `#5f5749`), count pill bottom-right (accent fill, 13px mono,
  `x2`). Hover lifts 1px with an accent border; pressed goes `--action-bg`.
- Ticket: radius 16; head `Ticket` (uppercase, letter-spaced, muted) with
  the count right; dashed `--line-soft` rules; lines padded 8/10 with a 2px
  gap; the selected line gets an accent border and `--bar-bg` fill and
  reveals 64px minus / plus, a 20px mono quantity, and an outlined
  `--stop` Remove pushed right; totals 15px mono muted at 1.9 line-height,
  Total 17px/700 beside a 26px mono figure.
- Bar: `Empty cart` outlined 64px left; `Pay $277.02` right, 68px tall,
  radius 14, accent fill, 20px label plus 22px mono amount; disabled on an
  empty cart.

**Payment mode.** Grid `minmax(0,1fr) 388px`; the rail is gone.
- Surface: radius 16, padding 18, 12px gaps.
- Figures: three equal tiles, 13px uppercase label over a 34px mono figure
  on `--bg`; Due goes `--ok` pair when settled with at least one line;
  Change goes `--warn` pair when positive.
- Tiles: three across, min-height 82, 1.5px border in the accent when
  available and `--line-soft` at 0.5 opacity when not; 18px name, 14px
  reason under it only when there is one; the balance badge top-right in
  the `--ok` pair, 13px mono.
- Tender rows: `--bg` fill, radius 12, padding 8/10; name 16px/600 with an
  optional 14px sub-line (`covers $237.02`); the amount is a 60px button,
  min-width 6.5em, 20px mono right-aligned; the x is a 60px square.
- Hint 14px under the rows: "Tap an amount to change it." when lines
  exist, "Choose how they are paying." when none.
- Foot, pushed to the bottom with a hairline above: "Nothing to pay, on the
  studio." and an outlined 60px `Comp this sale`.
- Bar: `Back to items` left; the primary reads `Due $X` disabled while due
  is above zero and `Charge $total` once it is zero.

**The keypad modal** (1a, over a 42% ink scrim): 420px wide, radius 20,
padding 20, 10px gaps. Title (the source, 20px/700); `Amount due` row
(16px muted label, 18px mono figure); `Entered` box on `--bar-bg` with a
30px mono figure; four 60px pill chips; a 3x4 grid of 66px keys (23px
mono: 1-9, 00, 0, backspace); the change line 18px mono in `--warn`;
Cancel (outlined) and Done (accent) at 60px, right-aligned.

This is T36's modal, almost to the pixel. Two differences, section 0.3.

**The done state** (1a): the columns are replaced by a centred block: an
88px `--ok-bg` circle with a check, `Sale rehearsed` at 30px, a 19px mono
line `Charged $277.02 · 9 items` over `Change $12.98 from the drawer`,
and a `New sale` accent button. Section 0.3 on whether we take it.

### 0.3 Where the prototype's behaviour differs from what is built

1a is interactive, and its logic (the `Component` class at the foot of the
canvas) makes choices T35 already made differently. Each is listed with
the side that wins and why. None of them is a visual matter.

| Prototype | Built (T33/T35/T36) | Wins |
|---|---|---|
| Tapping **Cash** opens the keypad pre-filled with the due; Credit and Card add a line directly | Every source adds a line for the whole remaining due in one tap; the amount is a button that opens the keypad | **Built.** One tap for the ordinary cash sale is the point of T35; and the layout plan (2.7) already says a Cash tap with a cash line present should open that line's keypad, which is the prototype's instinct in the right place. |
| Chips **add** to the entry (`$5` on `$10.00` makes `$15.00`); Exact sets | Chips **set** the entry, as the old cash modal's did | **Built**, and it is worth a second look: adding is how a drawer is counted ("a twenty and a five"). Ask Pete (3.5). |
| **Back to items** clears the tender lines | Tender state survives the round trip | **Built.** The layout plan's argument stands: a last-second towel must not cost a re-entered split. |
| **Empty cart** clears without confirming | T38 confirms | **Built.** A seven-line cart is a minute of taps. |
| Bar primary reads **`Due $X`** while unpaid, `Charge $total` at zero | Charge, disabled until due is zero, with the tender note saying what is short | **Prototype**, for the label: it turns the disabled state into information. Enablement is unchanged. |
| Tile reason **"Applies first"** on Credit, **"Nothing left to cover"** on tiles once due is zero | T35's reasons | **Prototype's words** where T35 has no reason of its own; T35's reasons (a source already in the payment, two parts maximum, the $10 card minimum) stay verbatim. |
| A **done screen** inside the overlay: "Sale rehearsed", the charged line, change from the drawer, `New sale` | T33: Done returns to the roster; the outcome block renders in the payment surface | **Built**, with one thing taken: the outcome block gains the prototype's shape (the check, the charged line, the change-from-the-drawer line, which is the figure a teacher most needs after a cash sale). Its button stays `Done` and still returns to the roster, per T33; `New sale` is a second sale for the same client, and the roster is where the next student is. |
| `Sale rehearsed` as the wording | "Suppressed" wording per mode | **Built.** "Rehearsed" is a nicer word for a dry run and may be adopted for that mode only; a write-guard suppression is not a rehearsal. |
| Keypad `Amount due` = due plus this line's own amount | T36's `padDueCents` | Same. |
| No change figure below the due; "No change due" | T36's change / short / partner line | **Built.** The prototype has no two-line recompute. |
| A `$100` chip (1d only) | Exact / $5 / $10 / $20 | **Built.** Pete named the three. |

The prototype's totals arithmetic (subtotal rounded, tax rounded on the
subtotal, total rounded) is not ours and must not be copied: our estimate
mirrors `expectedTotal` per line (T38), and the server's number is the
only total.

## 1. What has to be true regardless of direction

The rails this build runs on. None is new; each is a rule some earlier
ticket paid for and the redesign must carry across intact.

- **The money does not move.** Request shapes (one line sends `method` and
  optionally `cashTendered`; two send `split.legs`), the single flight, the
  clamps, the availability rules, the per-line reasons computed in the same
  render as `chargeable`, the server's authority over every number (T24,
  T28, T31, T35). This is a re-skin of the tender, not a re-model.
- **The mode banner is never removed** (CLAUDE.md) and holds the 16px
  floor. Counter keeps it as a line; Slate and Chalk shrink it to a `DRY
  RUN` chip, which would have to render in every state (sandbox, prod dry
  run, prod live, write-guarded) and carry the "nothing will be charged"
  line beside Charge at the moment of the tap.
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
- **Tokens, both palettes, no hex in components.** 1a and 1b are the two
  palette blocks; the table in 0.2 is the mapping.
- **16px text, 64px targets.** The 0.2 type table says where the canvas's
  12-15px sizes land: 14px only for the recorded metadata exceptions, 16px
  for anything read, and the canvas's 60-62px controls come up to 64.
- **T38 lands first.** It holds the receipt's row cap and scroll cue, the
  pricing estimate, the audit table and the escape hatch, all in the same
  files this plan rewrites.

## 2. Build order

Nine steps, each its own ticket (T39.1 through T39.9), each followed by a
separate adversarial review before it is pushed, each leaving the app
shippable. Steps 1 through 6 are direction-independent in structure and
take Counter's numbers unless Pete picks otherwise (the numbers are a
token swap either way). Step 7 waits on section 3. Serial, because every
step edits `SaleScreen.tsx` and `globals.css`.

### T39.1 Shell, tokens, header

- `.sale-shell` max-width 1100 to 1400, padding 16/20, gaps 14 (0.2). The
  roster's `.shell` is untouched (layout plan open question 9).
- Tokens in `:root` and the dark block, per the 0.2 table: the existing
  ones re-valued to Counter's, plus `--accent-ink`, `--line-soft`,
  `--bar-bg` and `--shadow`. `.cat-chip.on` and `.charge-btn` move off
  `--surface` onto `--accent-ink` for their text.
- Header: 76px row; `Buy` at 23px; the client card at 60px (label, name,
  `.bal-chip` in the `--ok` pair, a 44px detach x); Back outlined at the
  right.
- Done when: the overlay is 1400 wide on a 1366 iPad with the columns
  still the old two, both palettes screenshot-checked against 1a and 1b,
  typecheck and build clean.

### T39.2 The rail

- `.sale-cats` becomes a 154px vertical column, entries 64px with 6px
  gaps, Favorites pinned first and filled with the accent when active,
  `more` muted and last. Packages and Memberships keep today's order.
- `more` expands the rail in place; with the studio's catalog it never
  triggers.
- Folds back to the horizontal chip row under 1040px (layout plan 2.1).
- Done when: the rail never wraps or scrolls at 1080/1180/1366, and the
  fold renders at 1000.

### T39.3 The grid

- `.shelf-grid` at `minmax(184px, 1fr)`, 10px gaps; cards min-height 96,
  padding 14, radius 14, name top, price bottom-left in mono, the
  favourite star still a 44px sibling target top-right.
- **The count pill**: a card in the cart shows `x2` bottom-right in the
  accent fill, from cart state, no new call. Cheap to remove if Pete
  answers layout plan question 8 the other way.
- Bundle cards keep `.shelf-bundle-mark`; contracts keep their own card
  shape and confirm (T30) and sit in the Memberships shelf.
- Width arithmetic: at 1366 the grid gets 1366 - 40 - 28 - 154 - 388 =
  756px, four columns of 184 exactly; at 1180, 570px, three columns; at
  1080, 470px, **two** columns at 184. So at the 1080 floor the cart
  narrows to 340 (the layout plan's number) to keep three columns
  (`(470 + 48 - 20) / 3 = 166` at `minmax(166px)`). One media query.
- Done when: sixteen cards fit at 1180 without the grid scrolling, the
  count pill tracks the cart, three columns hold at 1080.

### T39.4 The cart column

Built on T38's receipt, which already has the row cap, the scroll cue, the
estimate and the audit table.

- Column 388px (340 under 1180). `Ticket` and the count on one head line
  with a dashed rule; the studio heading goes.
- Rows: name and right-aligned mono total on one line; `n @ price` sub-line
  only above quantity one (14px mono muted, the recorded exception).
- **Select to reveal**: tapping a row selects it (accent border, `--bar-bg`
  fill) and only that row shows minus / quantity / plus / Remove at 64px.
  Tapping again, or another row, deselects; adding from the shelf selects
  the line it touched (the prototype does this and it reads well). Remove
  is outlined `--stop`. The per-row 64px stepper on every line is deleted,
  which is what buys back the space.
- Tapping a shelf card still increments the line (layout plan question 5
  stands).
- Totals: Subtotal and `Tax 10.35%` in 15px mono muted at 1.9 line-height
  (the rate from `/api/config`, the literal string only when the server
  sent one), then a hairline and Total at 17px beside a 26px mono figure.
- T38's Clear cart control moves out of the ticket and becomes the bar's
  `Empty cart` in T39.5, keeping its confirm.
- T38's row cap becomes the column's own height: the ticket is a flex
  column (`flex: 1; min-height: 0; overflow: auto` on the lines, per 1a),
  so it is the viewport that bounds it, not a vh figure. The fade and "N
  more below" cue stay.
- Done when: a seven-line cart with one row selected fits on a 768px-tall
  viewport without the column scrolling, T14's roster rule untouched.

### T39.5 The bottom action bar

- Full width of the overlay, 92px, `--bar-bg` with a hairline above and
  `--shadow`, sticky to the viewport's bottom edge.
- Left: `Empty cart` (T38's confirm behind it), outlined 64px. Back stays
  in the header, where every direction keeps it.
- Right: the primary at 68px, radius 14, accent fill and `--accent-ink`,
  a 20px label and a 22px mono amount. Shelf mode: `Pay $277.02`, disabled
  (`#d5cfc2`-class, a token) on an empty cart; a spinner in place of the
  figure while a reprice is in flight; **the server's figure only**, so
  while T38's estimate is showing the bar reads `Pay` with no amount.
  Payment mode: `Due $X` disabled while due is above zero, `Charge $total`
  at zero, with Charge's enablement untouched (0.3).
- Stacking: below every modal scrim (the keypad, the cart-change confirm,
  the contract confirm, the waiver), above the columns.
- Done when: the primary is in the same corner for a one-item and a
  seven-item cart, and nothing behind a scrim is tappable.

### T39.6 Two modes

The largest step and the one to review hardest.

- `saleMode: "shelf" | "pay"` in SaleScreen, reset to `shelf` on every
  open and on Done. `Pay` enters; `Back to items` on the bar's left and
  Escape leave.
- The middle column renders the grid or the payment surface; the rail
  collapses in payment mode (`minmax(0,1fr) 388px`); the cart column
  renders the same element in both modes and is not remounted.
- **PaymentPanel moves** from `.sale-left` to the middle column. Its state
  (tender lines, comp, the keypad) must survive the mode switch: keep the
  panel mounted and hidden in shelf mode rather than lifting T35's state
  out of it. Hidden, not unmounted, and `onModalChange` still reports.
- Comp: rendered only in payment mode; leaving payment mode clears it
  (section 1).
- Escape ordering per section 1, with the T35 review fix's guard still
  covering a keypad whose line has gone.
- The `disagrees` stop and the suppressed notice render in payment mode
  above the figures; Charge on the bar stays disabled exactly as today.
- Done when: a split tender entered in payment mode survives Back to items
  and returns intact, Escape peels one layer per press in the stated
  order, comp cannot be found armed in shelf mode by any sequence.

### T39.7 The payment surface (waits on section 3)

Direction-independent, built first:

- The surface per 0.2: three figure tiles (Total; Due in the `--ok` pair
  when settled with a line present; Change in the `--warn` pair when
  positive), 34px mono figures.
- Tender rows per 0.2, T35's behaviour: the amount is the button that
  opens the keypad, `covers $X` under a cash line that exceeds its due,
  the x removes the line. The hint under the rows switches between
  "Choose how they are paying." and "Tap an amount to change it."
- The foot: the quiet note and `Comp this sale`, hold to arm, unchanged.
- Tapping Cash with a cash line present opens that line's keypad (layout
  plan 2.7).
- The outcome block takes the prototype's done shape (0.3): the check,
  `Charged $277.02 · 9 items`, `Change $12.98 from the drawer` on a cash
  over-tender, `Done` back to the roster.

Direction-dependent, per Pete's call:

- Sources as **tiles with reasons and the balance badge** (Counter, Slate)
  or as **`+ Card` / `+ Cash` buttons** with Credit auto-applied (Chalk).
  Counter's tiles are recommended: T33's rule that an unavailable source
  is greyed with its reason has a home on a tile and none on a small
  button, and the badge is the one detail the layout plan singled out.
- Keypad as **the T36 modal** (Counter's, near pixel-identical) or **a
  persistent panel** (Chalk's). See 3.2.
- Done when: every T35 scenario in the sandbox checklist (TICKETS, "The
  Phase 2 sandbox run") renders and charges as it did before this plan.

### T39.8 Density and degradation pass

- The vertical budget re-measured at 768 tall: 30 banner (taller at 16px
  text), 76 header, columns, 92 bar; nothing scrolls at the studio's real
  numbers.
- The 1040 rail fold, the 1180 cart narrowing and the 860 cart fold
  verified.
- Both palettes screenshot-checked frame by frame against 1a and 1b.

### T39.9 What the roster inherits

The layout plan's short list (its section 3): the accent (already shared
by the token), the header shape, the badge idiom, tabular figures. Nothing
else travels. Layout plan question 9 (widen the roster shell too) is
answered by Pete or left at 1100.

## 3. Pete's calls

Five, one reply covers them. Steps 1 through 6 proceed meanwhile.

### 3.1 Direction: Counter, Slate or Chalk?

**Recommend Counter (1a/1b)**, for reasons that are on record rather than
taste:

- It is the only direction drawn in both palettes, and its dark variant is
  "the same tokens flipped", which is precisely our two-block rule. Slate
  and Chalk would each need the other palette invented.
- It is the only interactive one; its keypad is T36's modal almost to the
  pixel, and the decisions its logic makes are the ones already argued
  through (0.3).
- It keeps the banner as a line. Slate and Chalk shrink it to a chip, a
  narrower version of something CLAUDE.md says never to remove.
- Its source tiles carry the reason a source is unavailable; Chalk's
  buttons cannot, and T33 decided a greyed reason beats a hidden control.
- Its cards put the name first. Nine items are 90% of taps and six of them
  cost under four dollars; a teacher finds "Towel rental", not "$2.72".
- `Buy` stays the title. Chalk's `Payment` reopens T27's Sell-to-Buy
  decision.

Worth taking from the others regardless: Slate's `Pay · 9 items ·
$277.02` on the bar (the count is useful at the moment of the tap) and its
dashed border with the word "bundle" on bundle cards; Chalk's Due as the
most prominent of the three figures.

### 3.2 Keypad: the modal (T36, Counter) or Chalk's persistent panel?

T36 shipped the modal three days ago on Pete's words, "having it be a
modal is def better than this", where "this" was the inline keypad pushing
the receipt down a 400px column. Chalk puts the keypad inline in the wide
payment surface, where it pushes nothing and edits the outlined tender
line; the designer lists "put 1d's inline keypad into 1a" as a next step.
That is a different proposal from the one Pete rejected.

**Recommend the modal for T39.7, the panel as a follow-up if wanted.** The
modal is built, reviewed, carries the T35 guard, and matches Counter. The
panel needs a selected-line notion for tender lines, a rule for what it
shows with no line selected, and it puts the keys on screen for a
card-only sale that never types. Neither choice touches the money.

### 3.3 Accent: teal app-wide?

Changing `--accent` moves the roster's class dropdown and sort bar with it,
which is the "one idiom" outcome the layout plan wanted, but it is a
visible change on the screen teachers use most. Yes, or Buy-only (a second
token, which the layout plan argued against).

### 3.4 Fonts: Instrument Sans and IBM Plex Mono, or the system stack?

"Mono only for money" is most of what makes Counter read as a receipt,
and `ui-monospace` gives it on every iPad for free. Instrument Sans is a
nicer face than the system sans but not a different idea. If Pete wants
them, `next/font/google` self-hosts both at build time so the counter
never fetches a font at runtime; a font that fails to load on a studio
network is a blank screen, which is the one outcome to design against.
Recommend the system stack now, the two faces as a one-line change later.

### 3.5 Chips: set the entry, or add to it?

T36's chips set (`$20` makes the entry $20.00). The prototype's add (`$20`
then `$5` makes $25.00), with Exact still setting. Adding is how a drawer
is counted; setting is what the old cash modal did and what Pete asked to
have back. Either is a five-line change in `padChip`.

## 4. Out of scope, deliberately

- Photos, five columns, Orders/Save, Discount, per-line tax: rejected in
  the layout plan section 4, unchanged.
- The prototype's totals arithmetic (0.3).
- Any change to `/api/checkout`, `/api/price-cart` or `src/lib/sale.ts`.

## 5. Verification, per step

No test suite. Each step's review checks: `npm run typecheck`, `npm run
build`, both palettes at 1080, 1180 and 1366 wide and 768 tall against 1a
and 1b, the Escape order, and for T39.6 and T39.7 the full T35 request
mapping in the dev drawer (one line: `method` alone; two lines:
`split.legs` with no `cashTendered`; cash over-tender: `cashTendered` on a
single line).
