# UI inspiration: coffee-shop POS screenshots (Pete, 2026-08-28)

Pete shared five screenshots of a polished cafe POS ("IMAJI Coffee" style) as
UI/UX inspiration. The image files are not in the repo yet -- Pete has them;
drop them in this folder as `01-order-list.png` .. `05-logout.png` when
convenient. This file transcribes what they show so design work can proceed
without the pixels.

**Status: inspiration only. Nothing here is implemented or scheduled.** Any
refactor it motivates gets its own ticket after Pete reviews mockups.

## What the screenshots show

1. **Order list modal** ("New Self Order"): search field on top; a row of
   horizontal filter chips (All Type / Dine In / Pick Up / Delivery /
   Takeaway / Reservation) with the active one filled dark; below, a list of
   soft-grey rounded cards. Each card: circular icon avatar (order type),
   name in bold with a small gold loyalty badge, muted "2 Items" line, then a
   footer row with an id chip (`#001`), a quiet trash icon, and ONE filled
   primary button ("Process Order") right-aligned. One primary action per
   card, everything else quiet.

2. **Cancel Order modal**: focused destructive confirm. Title, one warning
   sentence, a small gold uppercase context label ("DINE IN ORDER"), then a
   summary card of the thing being acted on (name, id chip, and the key
   consequence highlighted in red: "Revenue Lost $25.00"). Buttons: outlined
   "Close" and filled red "Confirm Cancel". The entity summary inside the
   confirm dialog is the notable move.

3. **Payment screen** (Phase 2 relevant): two panes. Left is a live receipt
   preview styled like a printed ticket (monospace, dashed rules, itemized
   lines, subtotal/discount/tax/total). Right: Regular/Split bill toggle,
   payment-method cards with icons (Cash / Bank Transfer / QR Code) where the
   selected card is outlined and tinted, an amount input beside a live
   "Customer Changes" figure, quick-amount chips (Exact money / $10 / $20 /
   $50 / $100), and a large 4x3 numeric keypad with a red backspace key.
   Cancel (quiet) and Pay Now (filled) bottom-right.

4. **Reservation list**: a week strip calendar (day columns, small gold count
   badges under days that have bookings, selected day outlined) above a card
   list. Each card: a big round table badge (T4), avatar, name + badge,
   "5 Person" muted line, time right-aligned with a clock icon, id and
   deposit chips (`#001`, `DP : 50%`), trash, and the one filled action.

5. **Logout confirm**: before a shift-ending destructive action, the dialog
   shows a summary panel (Total Revenue large, then Cash / Bank Transfer /
   QR Code breakdown lines) so confirming is informed. Cancel vs filled red
   "Yes, Logout" with an icon.

## Cross-cutting techniques worth stealing

- Card-per-row lists on a soft neutral ground; generous padding; large radii.
- Exactly ONE filled primary action per card; destructive and secondary
  actions are quiet icons.
- Metadata as small grey chips (`#001`, `DP : 50%`) rather than prose.
- Filter chips as a horizontal row, active one filled.
- Confirm dialogs restate the entity and the consequence inside a summary
  card; the consequence figure is the only red text.
- Warm neutral palette (cream / warm grey / charcoal) with ONE brand accent
  (brown) and gold reserved for status badges; red only for destructive.
- Big touch keypad and quick-amount chips for money entry (Phase 2).
- Icon avatars give rows a scannable left anchor.

## Constraints ours has that theirs does not

Whatever gets borrowed must survive: a hot room and a queue (16px floor,
64px targets, high contrast), both palettes via tokens only, the mode
banner, pessimistic check-in, and rows that just got flattened into aligned
columns (T14) because the expando was friction. Cards must not reintroduce
the friction or bury the one-tap check-in.
