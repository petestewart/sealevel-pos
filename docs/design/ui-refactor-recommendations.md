# UI refactor recommendations

Review of the current counter UI (`src/app/page.tsx`, `src/app/globals.css`,
post-T14) against the cafe-POS inspiration transcribed in
`docs/design/inspiration/pos-ui-inspiration.md`. Analysis only; mockups are a
separate effort. Every recommendation here is written to survive the hard
constraints: 16px floor, 64px targets, tokens in both palettes, the mode
banner, pessimistic check-in, one-tap check-in from the row, and T14's
no-expando rows.

## 1. What the current UI does well

- **The interaction model is already the inspiration's best idea.** One
  filled-ish primary action per row (`.chip.action` "check in"), with
  check-out demoted to a quiet 44px icon (`.undo-btn`) and the alert, notes
  and Mindbody links as quiet `.row-icon` circles. The cafe screenshots'
  "one primary button, everything else quiet" principle is substantially
  implemented; what is missing is the visual weight that makes it read.
- **The state machine on the chip is honest and complete**: `in`, `busy`
  (spinner, pessimistic), `failed`, `stop` (no waiver), `unpaid`/`confirm`,
  `action`. Colour pairs are consistent (`--ok/--ok-bg`, `--warn/--warn-bg`,
  `--stop/--stop-bg`) and defined in both palettes.
- **The chip column is fixed-width** (`min-width: 104px`, fixed 208px actions
  column in `--roster-cols`), so the tap target sits in one vertical line.
  That is better queue ergonomics than the inspiration's right-ragged buttons.
- **`.subline` earns its space**: gate/failure/in-flight messages outrank a
  quiet history line, and an empty history renders nothing at all.
- **The fake-unlimited rule, the `1`-left highlight (`.detail-last`), and the
  negative-balance red (`.cell-bal.neg`)** show restraint: numbers only when
  they mean something.
- **The two banners are already differentiated by shape**, not just colour:
  filled status pill (`.banner`) vs accent-rail surface (`.studio-banner`).

## 2. Recommendations

### 2.1 Surface treatment: keep flat rows, soften the ground (S)

Borrows: card-per-row on a soft neutral ground, generous radii.
Touches: `globals.css` (`--bg`, `--surface`, `.rrow`, `.roster` gap, shadows).

The rows are already cards in structure (`.rrow`: surface, 12px radius, 1px
line). What the inspiration has and we lack is *ground separation*: their
cards float on a visibly softer background. Ours barely differ
(`#fbfaf8` vs `#ffffff`). Nudge `--bg` warmer/darker a step (and the dark
`--bg` a step further from `--surface`), add `gap: 10-12px` in `.roster`, and
give `.rrow` a very soft shadow token (`--shadow: 0 1px 2px ...`, defined per
palette because a light-mode shadow is invisible in dark mode). Do NOT
increase row padding or radius past what 72px rows on iPad landscape can
afford: a 12-row class must still fit without scrolling. No risk to speed or
safety; this is paint.

### 2.2 One primary action per row: make the chip look like the button it is (S)

Borrows: exactly one FILLED primary action per card.
Touches: `.chip.action`, `.chip` sizing, `--action-bg`/new `--action-ink`.

`.chip.action` is currently `--action-bg` (a mid-warm-grey) with `--ink` text,
32px tall inside a 72px row. It reads as a status pill, not the thing you aim
at across a counter. Make the actionable chip states (`action`, `unpaid`
awaiting confirm) visibly button-shaped: taller (min-height 44-48px inside the
row, the row itself stays the 72px target), filled with the accent (see 2.6),
white/ink-token text, and keep the passive states (`in`, `busy`, `out`) as the
quiet pills they are. The distinction the inspiration draws is filled =
"tapping this does something", tinted = "this is telling you something"; our
chip set currently blurs it. Keep the fixed 104px+ width so the column edge
stays straight. Risk: none to one-tap check-in, since the whole row remains
the target; the chip just stops disguising it.

### 2.3 Metadata chips vs prose strings (M)

Borrows: small grey chips (`#001`, `DP : 50%`) instead of prose.
Touches: `.classbar .who`, `.subline`, `.cell-pay`, new `.meta-chip` class.

Three places currently concatenate prose that could be chips:

- **Class bar**: `{name} - {teacher} - {booked} booked` in one muted 16px
  string. Split the booked count into a small count chip on the button
  (matching the inspiration's gold count badges under calendar days), leaving
  name and teacher as text. This also makes "full" markable at a glance
  (chip flips to the warn pair) before a teacher even selects the class.
- **History line**: "3rd class this week" is good prose; leave it. But the
  pass facts inside the dropdown (`facts()`: "4 left · exp 9/12/26") and the
  Expires/Left columns are already tabular; do not chip those, the T14 grid
  IS the chip system there. Aligned columns beat floating chips for scanning
  a list, which is why T14 happened.
- **Member marker**: `.m-chip` is right already; restyle it gold (see 2.6) to
  match the inspiration's loyalty badge and stop spending the accent on it.

Chips must hold the 16px floor, which makes them larger than the
inspiration's; that is fine, they are counts and badges, not paragraphs.

### 2.4 The class picker strip (M)

Borrows: filter-chip row with the active one FILLED.
Touches: `.classbar`, `.classbar button[aria-pressed]`, `.sortbar` same move.

Active state today is an accent border plus inset ring, which at arm's length
in glare is subtle. Adopt the inspiration's move: the selected class button
fills (accent background, surface text), unselected stay outlined. Same for
`.sortbar`. This is the single cheapest "feels like the screenshots" change,
and it doubles as a legibility fix for the hot room. One caution: the filled
class button must not read as a status; keep booked-count chips (2.3) in
their own colour pair so "selected" and "full" cannot be confused.

### 2.5 Confirm dialogs: restate the entity in a summary card (M)

Borrows: cancel-order modal (entity summary card inside the confirm, the
consequence as the only red text).
Touches: the `checkingOut`, `redAlertPrompt`, `waiverPrompt`,
`waitlistPrompt` modals in `page.tsx`; new `.modal-entity` in `globals.css`.

Our modals lead with a title and a `.muted` sentence. The inspiration leads
with a card that restates *who* and *what state*, and reserves red for the
consequence line. Concretely:

- **Check-out**: add a summary card: name, their pass (`pricingOption`),
  and the consequence line "Marks them as not attended" as the only stop-
  coloured text. The confirm button (`.modal-confirm`) already uses the stop
  pair; keep it.
- **Red alert**: already close (title + `.ctx-alert` block). Add the small
  uppercase context label the inspiration uses ("RED ALERT" over the card)
  and keep the alert text as the sole red content. The confirm copy
  ("I have read it, check in") is good; do not shorten it.
- **Unpaid confirm**: this one is currently NOT a dialog, it is a second tap
  on the chip with a `.subline` message. Keep that. A modal here would slow
  the queue's most common exception; the inline confirm is the right call
  and the inspiration does not override it.
- **Waitlist prompt**: add the class summary (time, teacher, "26 of 26") as
  the entity card rather than folding the count into the title.

Phase 2's sale confirm is where this pattern pays off most: the summary card
is the receipt-in-miniature (client, item, price, method) and the consequence
is the charge. Establish `.modal-entity` now so it is ready.

### 2.6 Colour system: one accent, gold for status, red for destructive (M)

Borrows: warm neutral palette, ONE brand accent, gold for badges, red only
destructive.
Touches: `:root` and dark palette in `globals.css`; every `--accent` use.

Our accent is a cool blue (`#1d4ed8` / `#7ea2ff`) on a warm-neutral ground,
and it is spent in too many places: selected class, sort, member chip, studio
banner rail, Change link, checkbox accents, the undo chip. Map the
inspiration's roles onto tokens:

- `--accent`: pick a warm accent that suits the studio (the cafe's brown;
  ours might be a deep teal or terracotta; Pete's call, and it stays one
  token pair). Uses: selected/filled controls, the primary action chip (2.2),
  the Change link. This makes accent mean "actionable or selected", nothing
  else.
- New `--gold`/`--gold-bg` pair: membership chip, count badges, the
  `1`-left highlight (retiring `--warn` from that duty; `--warn` stays for
  unpaid and the LIVE banner, which are genuinely warnings).
- `--stop`: unchanged, destructive and blocked only. It is already used with
  that discipline.

Both palettes get every new token; the `themeColor` entries in `layout.tsx`
move with `--bg` if it shifts. Risk: contrast. Any candidate accent must pass
4.5:1 against `--surface` and as fill behind surface text in BOTH palettes,
checked before it lands, or the hot-room constraint loses to aesthetics.

### 2.7 Row left anchors: initials avatar (S, optional)

Borrows: icon avatars as a scannable left anchor.
Touches: `--roster-cols` (one more fixed column), `.cell-name`, new
`.avatar`.

A 40-44px circle with the client's initials gives each row a fixed left
anchor and makes name-scanning faster down a long roster. Tint it by state
(ok pair once checked in, neutral otherwise) so the left edge of the list
mirrors the chip column and a teacher can count heads from either side.
Optional because it costs ~52px of the name column on iPad landscape; if the
grid gets tight, drop this before anything else. No photos: Mindbody photo
fetches would add calls to the roster path for zero check-in value.

### 2.8 Empty and loading states (S)

Borrows: nothing directly; the inspiration's lists are never empty, ours are
daily.
Touches: `page.tsx` empty branches, new `.empty` styles.

Current empties are one `.muted` line ("No classes in the next few hours.",
"Nobody is signed up yet.", "Nobody is waiting."). Give them a centred block
with one large quiet glyph and the line at 18px, so a blank roster reads as
"nothing to do" rather than "failed to load". Add a skeleton for the roster's
first load (2-3 grey rows pulsing at the grid template), because today the
gap between class selection and rows arriving renders nothing at all.
Skeletons must never appear on refreshRoster after a booking (the old rows
stay until replaced, which is current behaviour; keep it). The `.spinner` on
the chip during pessimistic check-in is untouchable and untouched.

### 2.9 Phase 2 payment screen (forward-looking, L)

Borrows: screenshot 3 wholesale, it is the best of the five.
Touches: all new components; nothing existing.

When sales land, adopt the two-pane shape: left, a receipt preview built
live from the cart (item, in-studio price, 10.35% tax, total) styled as a
ticket; right, method cards and amount entry. Adaptations ours needs:

- **Method cards** are Stored card / Cash / Handoff-to-Mindbody, not
  Cash/Transfer/QR. Selected card outlined and tinted with the accent, one
  filled "Charge $X" button bottom-right that restates the total in its
  label, since nothing may auto-charge and the tap that moves money should
  say the amount on the button itself.
- **The keypad** (4x3, 64px keys) and quick-amount chips apply to cash only.
  For stored-card sales the amount is the cart total, not typed; do not
  render an editable amount for a card charge.
- **The receipt preview doubles as the confirm summary** (2.5): the charge
  runs pessimistically, spinner on the Charge button, exactly like check-in.
- The mode banner stays visible above both panes. A payment screen in dry
  run must say so at the moment of the tap.

## 3. What NOT to adopt

- **Small type and low-contrast grey metadata.** The screenshots live on
  ~12-13px muted text. Everything here stays at the 16px floor; where a chip
  looks oversized as a result, that is the constraint working.
- **A modal order list as the main surface.** Their list lives in a modal;
  our roster IS the screen. One screen, no navigation, is the speed
  argument.
- **Trash/destructive icons on every row.** Their cards carry a delete icon
  per row. Our destructive actions (check-out, and someday remove-booking)
  stay behind the checked-in state's `.undo-btn` plus confirm. A always-
  visible destructive target next to the check-in chip is exactly the
  mis-tap a queue produces.
- **Week-strip calendar.** The `.classbar` shows the classes around now
  because that is the job; a date picker invites browsing the schedule,
  which is Mindbody's job, and would push the roster below the fold.
- **Card layouts that stack metadata vertically.** Their cards spend three
  lines per order. T14 flattened rows into aligned grid columns because
  vertical stacks cannot be scanned down a 26-person roster; the columns
  stay. (And no expando returns in any form.)
- **A logout/end-of-shift revenue summary.** No teacher identity exists yet
  (design doc open question 3) and no money moves in Phase 1. Revisit with
  Phase 2 only if payroll attribution lands.
- **Decorative animation.** Transitions stay at current levels; the only
  motion that matters is the spinner that proves a write is in flight.

## 4. Suggested phasing

**Now (cheap polish, one PR, no Pete review needed beyond a look):**
2.1 ground/shadow softening, 2.4 filled active states on `.classbar` and
`.sortbar`, 2.8 empty states and roster skeleton, and the chip sizing half
of 2.2. All CSS plus small JSX; nothing touches a write path.

**Themed pass (after Pete picks the accent, one PR with mockup sign-off):**
2.6 token remap (accent + gold pair, both palettes, contrast-checked),
2.2 accent-filled action chip, 2.3 class-bar count chips and gold member
chip, 2.5 `.modal-entity` summary cards in the four dialogs, 2.7 avatars if
the grid affords them. This is the pass that makes it look like the
screenshots; it should land as one visual change, not a drip.

**Phase 2 (with sales):** 2.9 payment screen built to the two-pane shape
from day one, reusing `.modal-entity`, the token roles, and the pessimistic
spinner pattern already established.
