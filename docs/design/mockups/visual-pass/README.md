# Handoff: Sealevel POS visual pass (light + dark) + Phase 2 Buy/Payment

## Overview

A visual pass over the Sealevel front-desk counter UI (`petestewart/sealevel-pos`), plus
two forward-looking Phase 2 screens (Buy, Payment) built to the two-pane shape already
specified in `docs/design/ui-refactor-recommendations.md` §2.9.

It implements the "themed pass" phase of that document: token remap, accent-driven
selected/active states, entity summary cards in the destructive dialogs, and full
light/dark parity. It does **not** change any write path, the pessimistic check-in
behaviour, or the T14 aligned-column roster.

The accent picked in review is the studio teal-green `#166d67`, replacing the cool blue
`#1d4ed8`. Red is destructive only; gold carries badges and count chips.

## About the design files

The four `.dc.html` files in this bundle are **design references written in HTML** —
self-contained prototypes of the intended look and behaviour. They are not production
code and should not be dropped into `src/`.

The task is to recreate them in the app's existing environment: Next.js 15 + React 19,
`src/app/page.tsx` for markup/state and `src/app/globals.css` for tokens and classes.
Keep the existing class vocabulary (`.rrow`, `.chip`, `.classbar`, `.sortbar`, `.subline`,
`.m-chip`, `.undo-btn`, `.row-icon`, `.modal-*`). The prototypes use inline styles only
because that is how the prototyping tool works — in the codebase these belong in
`globals.css` against the tokens below.

Each file opens directly in a browser (double-click). `support.js` is the prototype
runtime; ignore it when porting.

## Fidelity

**High-fidelity.** Colors, type sizes, row heights, grid templates and interaction states
are final and intended to be matched exactly. Copy strings are final. The only
intentionally loose parts are the product catalog contents on Buy (placeholder items
priced plausibly — real values come from Mindbody) and the Payment ticket, which is
pinned to the $4.81 / $0.19 / $5.00 example from the review screenshots.

## Constraints this design respects

From `docs/design/front-desk-pos.md` and `ui-refactor-recommendations.md`:

- **16px type floor everywhere.** No metadata, kicker, helper line or counter is below
  16px. Uppercase labels get `letter-spacing: 0.06em` at 16px rather than shrinking.
- **64px+ tap targets** for anything that moves money or state; 44px for quiet
  destructive/secondary icons.
- **Every token defined in both palettes.** Light is the default.
- **72px roster rows**, 12 rows visible on iPad landscape without scrolling.
- **Pessimistic check-in.** Spinner on the chip while the write is in flight; a failure
  rolls the row back. The prototype fakes the timing (850ms) — keep the real API call.
- **One-tap check-in from the row.** The chip does not capture the tap target.
- **No expando rows.** Aligned grid columns only.
- **The dry-run/mode banner is deliberately absent from these mockups** (review
  decision, to see the screens undisturbed). **Keep the banner in the app** — it is a
  safety requirement, and it sits above everything, pushing the layout down by its own
  height.

## Design tokens

Two palettes. Every token exists in both. Put these in `:root` and the dark palette in
`globals.css`; the prototypes carry the identical values as `--pos-*` custom properties.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--bg` | `#f0efee` | `#121313` | page ground |
| `--surface` | `#ffffff` | `#1c1d1d` | rows, bars, cards |
| `--surface-2` | `#f8f4f4` | `#252626` | quiet fills, hover, keypad keys |
| `--line` | `#d7d3d3` | `#3a3b3b` | 1px hairline between rows/cells |
| `--rule` | `#201e1d` | `#f3f2f2` | strong 2px section divider |
| `--ink` | `#201e1d` | `#f3f2f2` | body text |
| `--muted` | `#605d5d` | `#9b9797` | metadata text |
| `--accent` | `#166d67` | `#3fa89f` | actionable / selected only |
| `--accent-press` | `#0f4f4a` | `#59bdb4` | pressed / hover on accent fill |
| `--accent-ink` | `#ffffff` | `#07211f` | text on accent fill |
| `--accent-bg` | `#e3efee` | `#16302e` | accent tint (selected surface) |
| `--ok` | `#0f6b46` | `#6cc79b` | checked in |
| `--ok-bg` | `#e3f1e9` | `#12291f` | checked-in chip fill |
| `--warn` | `#7a4f00` | `#e2b768` | unpaid, no pass, change due |
| `--warn-bg` | `#f7ecd4` | `#2c2110` | unpaid chip fill |
| `--stop` | `#a32020` | `#e88b8b` | destructive / blocked only |
| `--stop-bg` | `#f8e6e6` | `#2e1616` | no-waiver chip fill, destructive hover |
| `--gold` | `#6d4a05` | `#e8cf94` | member badge, count badges, "1 left" |
| `--gold-bg` | `#f0dcae` | `#2b2410` | badge fill |
| `--scrim` | `rgba(24,22,21,.55)` | same | modal backdrop |

Notes:
- `--accent` on `--surface` clears 4.5:1 in both palettes; the dark accent is lightened
  precisely for that. Do not reuse the light accent on the dark ground.
- Accent means **actionable or selected**, nothing else. It is no longer spent on the
  member chip (now gold), the studio banner rail, or the undo control.

### Type

Archivo (400 / 600 / 800), one family for headings and body.
`@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap')`

| Use | Size / weight |
| --- | --- |
| Numeric hero (Total, Due, Change) | 34px / 800, tabular-nums |
| Screen title, Total in ticket | 22–26px / 800 |
| Class name in the class bar | 22px / 800, `letter-spacing:-0.01em` |
| Stat counters (signed up etc.) | 26px / 800 |
| Primary button labels | 17–22px / 800 |
| **Client names** | **19px / 600** (body weight — 800 tested too heavy) |
| Body / payment cell | 16px / 400–600 |
| Metadata, sublines, helper text | 16px / 400, `--muted` |
| Uppercase kickers & column heads | 16px / 600, `letter-spacing:0.06em`, uppercase |

Numbers that align in a column (balances, prices, amounts) all use
`font-variant-numeric: tabular-nums`.

### Geometry

- **Radius: 0 everywhere.** No rounded corners, no pills. Chips, buttons, badges, cards
  and modals are all square. This is the largest visual departure from the current build
  (which uses 12px radii and 999px pills) and is the point of the pass.
- Structure is drawn with rules, not shadows or gaps: `2px solid var(--rule)` between
  major regions (header/body/footer, pane borders, table head), `1px solid var(--line)`
  between rows and cells.
- No shadows except modals (`--shadow-lg`).
- Everything flush left, including labels inside wide buttons. The Pay/Charge button
  reads `Pay · 2 items · $5.00` left-aligned in its own bar segment.
- Spacing: 4 / 8 / 12 / 16 / 20 / 24px. Horizontal screen padding 20px.

## The nav bar (T85, supersedes the per-screen navigation below)

Pete, on the counter build: "navigation is inconsistent and unclear. the screens are
sign-in, buy, pay. the buttons are in different spots and 'back' is unclear as to where
it's going. also, no reason the teacher profile icon shouldn't be available in all
those. and 'Buy' doesn't need to display on the buy page. maybe a nav bar at the bottom
... sign-in, buy, pay, profile, and dev should all be in the nav bar."

One bar, the same element on every screen, fixed to the bottom across the full width:
64px plus `env(safe-area-inset-bottom)`, on `--surface` under a `2px solid var(--rule)`.
Items are evenly spaced, each a 26px icon over a 16px/800 label, split by 1px lines:

| Item | Goes to | Off when |
| --- | --- | --- |
| **Sign-in** | the roster; the cart and its client survive | mid-charge |
| **Buy** | the shelf (from the roster, or back from the payment step) | mid-charge |
| **Pay** | the payment step, through the shelf Pay's own gates | nothing to pay, and it names the reason |
| **Profile** | the signed-in teacher's account modal, from any screen | never |
| **Dev** | toggles the call-log drawer; absent unless devtools answered | never |

The current screen's item is `--accent` with a **4px accent top edge** (the same "this
one" marker the payment tiles and the rail's cells use); the rest are `--ink` on the
surface. An item that cannot be tapped is `aria-disabled` with the reason as its title,
never hidden and never silent. Mid-charge the two items that would leave the payment
step are off and **Pay stays lit and inert**: money is moving and the outcome renders on
the surface it is on. The bar is z-index 22, over the sale overlay and the dev drawer
and under every modal scrim, the lock screen and the sign-in gate.

What it replaced: the roster header's accent `Buy` cell and its account icon, the Buy
screen's `Buy` wordmark and its `Back`, the action bar's `Back to items`, and the dev
drawer's floating pill. The action bar is gone with them, and its two remaining controls
are feet of the column they belong to: `Empty cart` over the accent `Pay` at the foot of
the ticket pane (outside the ticket's own scroll), and `Finalize Sale` at the foot of the
payment pane beside `Discount`. Since T82 neither carries a count or an amount.
The sun stays where it was, the last cell of the header, on every screen.

## Screens

### 1. Roster — `Roster.dc.html`

Replaces the current counter screen (`src/app/page.tsx`, `.classbar` / `.sortbar` /
`.roster` region). Frame 1194×834 (iPad landscape), fixed, no page scroll.

**Layout, top to bottom:**

1. **Top bar, 76px**, `--surface`, `border-bottom: 2px solid var(--rule)`. A single row of
   cells separated by 1px lines:
   - *Class picker* (flex, fills): kicker `Thu Sep 3 · 7:00 PM` (16px/600 uppercase,
     `--muted`), title `Hot 26 & 2 (60 min) — Kate Jarvis` (22px/800), lucide
     `chevron-down` right-aligned. Tap opens the dropdown.
   - *Calendar* icon cell, 76px wide (lucide `calendar`).
   - *Three stat cells* — 152 / 152 / 128px, each 1px-divided: uppercase kicker +
     26px/800 number. CHECKED IN's number is `--ok`.
   - *Theme toggle* icon cell, 64px, the last cell. (The accent `Buy` cell and the
     staff icon that used to follow the stats are the nav bar's Buy and Profile items
     since T85.)
2. **Class dropdown** (absolute, under the picker, `2px solid var(--rule)`,
   `--shadow-lg`, 120ms fade-in): one 72px row per class — time (108px, 18px/800), name +
   teacher, and a count badge right (gold pair; neutral when 0). The selected class row
   is filled `--accent-bg`. Three classes around now, per the "classes around now, never
   a date picker" rule.
3. **Walk-in search**, 60px: borderless 19px input, placeholder
   `Search for a walk-in (press Enter)`, plus a 76px search-icon cell.
   Keep the existing debounce → Mindbody behaviour.
4. **Column header**, `border-bottom: 2px solid var(--rule)`: NAME / PAYMENT /
   BALANCE (right) / (chip col) / sort icon (lucide `arrow-up-down`), 16px/600 uppercase
   `--muted`.
5. **Roster rows**, 72px each, `1px solid var(--line)` between. Grid:
   `minmax(0,2.1fr) minmax(0,1.4fr) 104px 132px 188px`, `gap:16px`, `padding:0 20px`.
   - **Name cell**: name 19px/600; optional 24px square gold `M` member badge; lucide
     `info` circle (18px, `--muted`); subline 16px `--muted` under it.
   - **Payment cell**: pass name 16px/600 (`--warn` when `No pass`), expiry/left line
     16px `--muted` under it.
   - **Balance**: right-aligned, tabular, 600.
   - **Chip**: 48px tall, square, fixed column so the tap line stays straight.
   - **Actions**: right-aligned 44px icon squares, 2px apart — undo (`rotate-ccw`, only
     when checked in), remove booking (`trash-2`), sell to client (`circle-dollar-sign`),
     client profile (`user`), open in Mindbody (`external-link`). Hover tints: destructive
     ones go `--stop` on `--stop-bg`, sell goes `--accent` on `--accent-bg`, neutral ones
     `--ink` on `--surface-2`.
     *The sell icon is a dollar circle specifically because a shopping bag read as a
     second trash can at arm's length.*
6. **Footer, 56px**: hint text left, prototype nav links right (drop these in the app).

**Chip state machine** — the current states, restyled. All square, 48px, flush-left label:

| State | Fill | Text | Border | Label | Tap |
| --- | --- | --- | --- | --- | --- |
| `action` | `--surface-2` | `--ink` | 1px `--line` | `check in` | starts check-in |
| `busy` | `--accent` | `--accent-ink` | 2px `--accent` | `checking in` + spinner | inert |
| `in` | `--ok-bg` | `--ok` | none | `checked in` + check glyph | inert (undo icon appears) |
| `stop` | `--stop-bg` | `--stop` | 2px `--stop` | `no waiver` | opens waiver dialog |
| `unpaid` | `--warn-bg` | `--warn` | 2px `--warn` | `unpaid` | arms inline confirm |
| `confirm` | `--warn` | `#ffffff` | 2px `--warn` | `check in anyway` | checks in unpaid |

The tap goes quiet → accent-filled → green: the row lights up *while the write is in
flight* and settles to the calm checked-in pill. Reviewed and chosen deliberately in this
direction (an earlier version had it accent-first, quiet-during; rejected).

The `unpaid` → `confirm` transition stays the **inline second tap** with a `--warn`
subline (`No pass on file — tap again to check in unpaid`) — not a modal. Per §2.5.

**Spinner:** 15px, 2px border, transparent top, `pos-spin 700ms linear infinite`.

### 2. Buy — `Buy.dc.html`

New (Phase 2). Frame 1194×834. Three panes under a 76px header, over the nav bar.

- **Header**: since T85 no `Buy` wordmark (the lit nav item says which screen this is);
  then either
  - *no client yet*: `+ Attach a client / for stored card or account credit` cell (plus
    icon in `--accent`, title 17px/800, sub 16px `--muted`) and a `Walk-in` cell; or
  - *client attached*: an `--accent-bg` cell with kicker `SALE FOR` in `--accent`, the
    name at 18px/800, and an `×` to detach.
  - Right: the refresh icon cell (T75), then the theme toggle. No `Back` since T85:
    Sign-in on the nav bar is the way to the roster.
- **Category rail, 190px**, `border-right: 2px solid var(--rule)`. Six 64px cells:
  Favorites, Food/Drink, Passes, Memberships, Accessories, Clothing. Active cell is
  **filled `--accent`** with `--accent-ink` (per §2.4 — filled active, not a ring).
- **Item grid**: 3 columns, 12px gap, 18px padding, cards 104px tall,
  `1px solid var(--line)` (→ `2px solid var(--accent)` once in the cart). Name 17px/800
  top-left, favourite star top-right (gold filled when starred), price 18px `--muted`
  bottom-left, and a `×N` accent-filled quantity badge bottom-right when in the cart.
  Tapping adds one.
- **Ticket pane, 320px**, `border-left: 2px solid var(--rule)`:
  - 52px head: `TICKET` uppercase + item count `--muted`, `2px` rule under.
  - 56px lines: name left, amount right (tabular 600). Tapping a line removes it
    (hover tints `--stop-bg`). Empty state: `Nothing on the ticket yet. Tap an item.`
  - Totals block above a 2px rule: Subtotal, `Tax 10.35%`, then Total (18px/800 label,
    26px/800 amount).
- **Ticket pane foot** (T85, was the 80px action bar): `Empty cart` (quiet, 64px, press
  → `--stop`) over the accent-filled `Pay · 2 items · $5.00` (72px), both the pane's
  width and outside the ticket's scroll. The `API n` counter is in the dev drawer's own
  head now.

**Tax rule (important, matches the review screenshots):** tax is charged per line, not on
the whole subtotal — retail is taxable, rentals/passes/memberships are not. Hence
$1.81 LMNT + $3.00 mat rental = subtotal $4.81, tax $0.19, total $5.00. In production
**take pricing and tax from Mindbody**; do not compute it client-side. The prototype
computes it only so the numbers move.

### 3. Attach-a-client modal — inside `Buy.dc.html`

760px wide, `2px solid var(--rule)`, `--shadow-lg`, over a `--scrim`, 84px from the top,
max-height 680px.

- Head: `Attach a client to the sale` (22px/800) + `×`, `2px` rule under.
- 60px search row: `Who is the sale for? (press Enter)` + search-icon cell.
- Filter row above a 2px rule: accent-filled `In class` label cell; a class select
  (`6:00 AM · Hot 26 & 2 (90 min) — Sally Zapata`, chevron); then three 108px segmented
  cells `All` / `Signed in` / `Not yet` — active one filled `--accent`.
- Result rows, 68px: name 19px/600, a status tag right (`signed up` on `--surface-2`
  `--muted`; `checked in` on the `--ok` pair), then a 40px `user` icon. Row hover
  `--accent-bg`; tapping attaches and closes.

### 4. Payment — `Payment.dc.html`

New (Phase 2), the §2.9 two-pane shape. Left pane + the same 320px ticket.

- **Header**: `SALE FOR / Walk-in sale` (`--accent-bg`) with `×`; refresh; theme
  toggle. (No `Buy`, no `Back` since T85.)
- **Amount tiles**: two equal cells, 1px-divided, over a 2px rule — TOTAL and CHANGE
  (T82 removed DUE; what is unpaid is said in words by the foot's quiet line).
  Kicker 16px/600 uppercase, amount 34px/800 tabular. CHANGE turns `--warn` when
  non-zero.
- **Method cards**: two equal 96px cells, `Card` and `Cash`, each icon (lucide
  `credit-card` / `banknote`) + 20px/800 label + a 16px `--muted` note. The selected
  method fills `--accent-bg`, colors its icon/label `--accent`, and carries a **4px
  accent bottom edge** (the "selected" marker — no ring, no radius). Notes are honest:
  `Nothing left to cover` when due is 0, `Charge $X to the reader`, or
  `In the payment. Tap to change it.`
- **Tender rows**, 64px, `1px solid var(--line)`: method label 19px/800; a 160px amount
  cell (22px/800 tabular, hover `--accent-bg`) that opens the keypad; a 64px `×` cell to
  remove the tender.
- **Keypad panel** (only while editing an amount), `2px solid var(--accent)`:
  - Left: `CASH RECEIVED` kicker + the live 30px/800 entry, quick-amount cells
    (`Exact`, `$10`, `$20`, `$50` — 52px, outlined, hover → accent), and
    `Change due $X` under.
  - Middle: 3×4 keypad, 300px wide, 56px keys on `--surface-2`, `del` in `--stop`.
  - Right: 96px accent-filled `Done`.
  - **Cash only.** A stored-card charge is always the cart total — never render an
    editable amount for it (§2.9).
- `Tap an amount to change it.` helper, then the **Email receipt** row (64px,
  `--surface-2`, 0.7 opacity, right-hand note `No client to email on a walk-in sale`),
  then a right-aligned quiet `Comp this sale` (hover → `--stop`).
- **Ticket pane** additionally shows, under Total and a hairline: one
  `<Method> received $X` line per tender in `--muted`, then **`Change due $15.00`** in
  `--warn` (20px/800 amount) when the tender exceeds the total, or `Still due` when it
  falls short. This is the counter's actual question and it belongs on the receipt side.
- **Payment pane foot** (T85, was the action bar): the quiet line, then `Discount`,
  then the primary — `--surface-2` / `--muted` and inert while anything is still due;
  accent-filled once covered; spinner beside the label during the write; `--ok` fill +
  check glyph + `Charged $5.00` after, in a foot of its own under the done block. Since
  T82 the label is `Finalize Sale` in every state and carries no amount (the amount is
  in the tiles, in the title and on the done foot). `Back to items` is gone: the nav
  bar's Buy item is the way back to the shelf.

### 5. Dialogs — `Dialogs.dc.html`

The §2.5 `.modal-entity` pattern, shown as two cards side by side on a scrim ground.
Both are `2px solid var(--rule)` on `--surface` with `--shadow-lg`.

Structure (use for all four dialogs — check-out, red alert, waiver, waitlist):

1. Head, 2px rule under: uppercase kicker 16px/600 (`CHECK OUT`; `RED ALERT` in
   `--stop`) + title 22px/800.
2. Body: an **entity card** (`1px solid var(--line)` on `--surface-2`, 14/16px padding)
   restating who and what state — name 18px/800 + `10 Class Card · 9 left · checked in
   6:52 PM` in `--muted`. The red alert nests the flag text inside it as a `--stop-bg`
   block. Then the consequence as the **only** stop-colored line
   (`Marks them as not attended.`).
3. Actions: two equal 68px cells split by a 1px line — `Cancel` on `--surface`,
   the destructive one filled `--stop` with white text. Labels flush left.
   Confirm copy stays long: `I have read it, check in`.

## Interactions & behaviour

| Interaction | Behaviour |
| --- | --- |
| Tap a roster row / `check in` chip | Optimistic-in-UI, pessimistic-on-write: chip → `busy` (accent + spinner), API call runs, success → `checked in` and the CHECKED IN counter increments; failure → roll the row back and put the reason in the subline |
| Tap `unpaid` | Arms the inline confirm (`check in anyway` + warn subline). Second tap checks in. No modal |
| Tap `no waiver` | Opens the waiver dialog (Dialogs pattern) |
| Undo icon on a checked-in row | Opens the check-out confirm |
| Class picker | Dropdown of the classes around now; selecting refetches the roster (no skeleton on refresh — keep old rows until replaced) |
| Category cell (Buy) | Swaps the item grid; active cell fills accent |
| Item card (Buy) | Adds 1 to the ticket; card border → 2px accent, `×N` badge appears |
| Ticket line (Buy) | Tap removes the line |
| Attach a client | Opens the modal; picking a client sets `SALE FOR` in the header |
| Method card (Payment) | Adds a tender for the outstanding due; Cash also opens the keypad |
| Amount cell (Payment) | Opens the keypad for that tender; `Done` commits, recomputing due/change and the ticket lines |
| `Charge` | Inert until due is 0; then busy spinner → charged. Nothing may auto-charge |
| Theme toggle | Swaps the whole token set. **In the app, drive this from `prefers-color-scheme` plus a manual override, and move the `themeColor` entries in `layout.tsx` with `--bg`** |
| Transitions | None beyond the 120–140ms modal/dropdown fade and the spinner. No decorative animation (§3) |

## State (prototype → app)

Prototype state, for reference — the real state lives in your existing hooks:

- Roster: `dark`, `pickerOpen`, `classIdx`, `states[rowId]` (`action|busy|in|stop|unpaid|confirm`).
- Buy: `cat`, `cart[{name,price,tax,qty}]`, `client | walkin`, `attachOpen`, `filter`, `api`.
- Payment: `tenders[{type,amount}]`, `editing`, `entry` (keypad string), `phase`
  (`idle|busy|done`), `api`.

Derived, not stored: subtotal, tax, total, due, change, item count, counters.

## Assets

- **Font**: Archivo 400/600/800 from Google Fonts.
- **Icons**: Lucide, 18–24px, `stroke-width:2`, `stroke-linecap:square` (square caps are
  part of the look — do not use the default round caps). Used: `chevron-down`, `calendar`,
  `user`, `search`, `arrow-up-down`, `info`, `trash-2`, `circle-dollar-sign`,
  `external-link`, `rotate-ccw`, `sun`, `star`, `credit-card`, `banknote`, `x`, `check`,
  `plus`, `arrow-left`. The prototypes inline them as SVG; use your icon dependency.
- No images or photography.

## Files in this bundle

| File | What it is |
| --- | --- |
| `Roster.dc.html` | Counter/check-in screen, all chip states, class dropdown, light+dark |
| `Buy.dc.html` | Item grid + ticket + attach-a-client modal |
| `Payment.dc.html` | Amount tiles, methods, keypad, receipt with change due |
| `Dialogs.dc.html` | Check-out and red-alert confirms (the entity-card pattern) |
| `_ds/modernist-…/styles.css` | Token/type source the palette above was built on |
| `support.js` | Prototype runtime — not part of the design |

Every screen has a sun icon in its top bar that flips light/dark; check both before
calling a port done. Light is the default and the preferred mode.

## Suggested order of work

1. Token remap in `globals.css` (both palettes) + radius to 0 + rule/hairline pass. Most
   of the pass lands here with no JSX change.
2. Chip restyle and the state table above; gold member chip and count badges.
3. Filled active states on `.classbar` / `.sortbar`; class-bar count chips.
4. `.modal-entity` summary cards in the four dialogs.
5. Only then Phase 2: Buy and Payment, reusing the tokens, the entity card and the
   pessimistic-spinner pattern.

Do not port the prototype's fake timers, the `API n` counter values, or the footer nav
links, and do not drop the dry-run banner.
