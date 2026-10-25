/**
 * The shape of a discount's reason (T45) and, since T79, of the discount
 * itself. Shared by the sale screen's dialog and /api/checkout so what the
 * dialog builds is what the route accepts, and rendered the same way
 * everywhere it is shown: the quiet line, the done screen, the `reason`
 * column and the Notes record.
 *
 * T43's reason was a free string the preset chips pasted in, so a "Teacher"
 * comp and a "teacher" comp were two different rows and nothing could be
 * counted. Pete: "we aren't saving an enum with the row is that right? we
 * should." So the reason is a KIND from a closed list and an optional free
 * `detail`. No hex, no React, no server imports: this module runs in both
 * places.
 *
 * T79 (Pete: "we need an option to comp part of a sale ... maybe in that
 * case it's a discount? we could switch the verbage from comp to
 * discount. 100% discount would be a comp in essense. also we don't need
 * 'Teacher' as a reason. discounts can be dollar amount or percentage"):
 * "Comp" is "Discount" everywhere a teacher reads it; a 100% discount
 * still reads "Comped". The server-side identifiers (`compReason`,
 * `comp_receipts`, `[comp]`) keep their names. The Teacher kind is gone
 * with everything only it used; a stored row with kind "teacher" keeps
 * its string, since the column is text.
 */

/** T67 (Pete, 2026-09-04): Other last. "Goodwill" was dropped from the
 *  surface ("not really something we should surface"); T79 dropped
 *  Teacher. A row already filed with either keeps its string. */
export const COMP_KINDS = ["trade", "damaged", "other"] as const;

export type CompKind = (typeof COMP_KINDS)[number];

export const COMP_KIND_LABELS: Record<CompKind, string> = {
  trade: "Trade",
  damaged: "Damaged item",
  other: "Other",
};

/** The free text's bounds. Required for `trade` and `other` (T67,
 *  Pete: "Trade and Other require notes"), where the kind says nothing
 *  about who or what; optional for the rest. The maximum is the T43
 *  bound, mirrored in the dialog's maxLength. */
export const COMP_DETAIL_MIN = 3;
export const COMP_DETAIL_MAX = 200;

/** Whether a kind needs the note written. The dialog's placeholder, its
 *  Next button and the route's check all read this one rule. */
export function compNeedsDetail(kind: CompKind): boolean {
  return kind === "trade" || kind === "other";
}

export interface CompReason {
  kind: CompKind;
  /** Trimmed free text; empty when nothing was written. */
  detail: string;
}

/** T48: a teacher's PIN is 4 to 6 digits. Here rather than in
 *  teacherpins.ts because the dialog's keypad and the routes' checks
 *  must agree, and this module is the one both can import. */
export const PIN_MIN = 4;
export const PIN_MAX = 6;
const PIN_SHAPE = /^\d{4,6}$/;

export function isPinShape(value: unknown): value is string {
  return typeof value === "string" && PIN_SHAPE.test(value);
}

export function isCompKind(value: unknown): value is CompKind {
  return (
    typeof value === "string" && (COMP_KINDS as readonly string[]).includes(value)
  );
}

/** Whether a draft reason is complete: a kind, and the detail when the
 *  kind needs it. The route applies the same rule to what arrives. */
export function compValid(reason: {
  kind: CompKind | null;
  detail: string;
}): boolean {
  if (reason.kind === null) return false;
  const detail = reason.detail.trim();
  if (detail.length > COMP_DETAIL_MAX) return false;
  if (compNeedsDetail(reason.kind) && detail.length < COMP_DETAIL_MIN) {
    return false;
  }
  return true;
}

/** The short form: `Trade`, `Damaged item`, `Other`. The detail is not
 *  in it; the done screen shows that on its own line. */
export function compHeadline(reason: CompReason): string {
  return COMP_KIND_LABELS[reason.kind];
}

/** The one-line form of the reason alone, for the quiet line and the
 *  ready step: `Trade: massage swap`, `Damaged item`. The record's line
 *  (the `reason` column, the log, the Notes entry) is discountRecordLine
 *  below, which carries the money too. */
export function compReasonLine(reason: CompReason): string {
  const label = COMP_KIND_LABELS[reason.kind];
  return reason.detail ? `${label}: ${reason.detail}` : label;
}

/* =====================================================================
 * T79: the discount itself.
 * =================================================================== */

export type DiscountMode = "amount" | "percent";

/**
 * A discount on the WHOLE cart (Pete was offered per-line and did not
 * take it). `value` is dollars for `amount` (0.01 up to the pre-tax
 * subtotal) and a whole number of percent for `percent` (1 to 100). The
 * dialog's "Entire sale" segment is `percent` 100. Applied to the lines by
 * spreadDiscount, which is the only place the per-line figures come
 * from, on both sides: the browser for the ticket, the server for what
 * goes to Mindbody (the browser's per-line numbers are never trusted).
 */
export interface Discount {
  mode: DiscountMode;
  value: number;
}

export const DISCOUNT_PERCENT_MIN = 1;
export const DISCOUNT_PERCENT_MAX = 100;

/** A cart line as the spread needs it: the unit price and the quantity,
 *  nothing else. CartLine (sale.ts) and the screen's CartEntry both map
 *  onto it. */
export interface DiscountLine {
  price: number;
  quantity: number;
}

/** A line's pre-tax extended price in whole cents. */
export function lineCents(line: DiscountLine): number {
  return Math.round((line.price * line.quantity + Number.EPSILON) * 100);
}

/** The cart's pre-tax subtotal in whole cents: the sum of the lines'
 *  extended prices, each rounded, which is what expectedSubtotal
 *  (sale.ts) says in dollars. */
export function subtotalCents(lines: readonly DiscountLine[]): number {
  return lines.reduce((sum, line) => sum + lineCents(line), 0);
}

/**
 * Validate an untrusted discount against a cart's pre-tax subtotal (in
 * cents). A string return is the 400 reason. Every bound is here so the
 * dialog's keypad clamps and the route's refusal agree: a percent is a
 * whole number 1 to 100; an amount is whole cents, at least one, at
 * most the subtotal (a discount past the subtotal would be a negative
 * sale). A $0 subtotal (a cart of free items) has nothing to discount.
 */
export function parseDiscount(
  raw: unknown,
  subtotal: number,
): Discount | string {
  if (raw === null || typeof raw !== "object") {
    return "discount must be an object with mode and value";
  }
  const mode = (raw as { mode?: unknown }).mode;
  const value = (raw as { value?: unknown }).value;
  if (mode !== "amount" && mode !== "percent") {
    return "discount.mode must be amount or percent";
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "discount.value must be a positive number";
  }
  if (mode === "percent") {
    if (
      !Number.isInteger(value) ||
      value < DISCOUNT_PERCENT_MIN ||
      value > DISCOUNT_PERCENT_MAX
    ) {
      return `a percent discount is a whole number from ${DISCOUNT_PERCENT_MIN} to ${DISCOUNT_PERCENT_MAX}`;
    }
    if (subtotal <= 0) return "there is nothing to discount";
    return { mode, value };
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) {
    return "a discount amount must be whole cents";
  }
  if (cents < 1) return "a discount amount must be at least one cent";
  if (cents > subtotal) {
    return (
      `a discount of ${(cents / 100).toFixed(2)} is more than the ` +
      `${(subtotal / 100).toFixed(2)} subtotal`
    );
  }
  return { mode, value: cents / 100 };
}

/**
 * Spread a whole-cart discount over its lines, in CENTS per line, in
 * `lines` order. The cart answer has no cart-level discount field, only
 * CheckoutItemWrapper.DiscountAmount per item (sale.yml:3624), so a
 * discount on the sale is a discount on each line:
 *
 * - percent: each line's extended price times the percent, rounded to
 *   the cent, so the line figures are exact and the cart total is their
 *   sum (which is what the price check compares to DiscountTotal).
 * - amount: over the lines in proportion to their extended prices,
 *   floored to cents, with the leftover cents handed out one at a time
 *   to the largest lines first, never past a line's own price. The
 *   sum equals the amount exactly (a proportional share can never
 *   exceed the line, and the leftover is fewer cents than there are
 *   lines, each of which has room by the same argument).
 *
 * A discount on a Package line is ignored by Mindbody (the spec), so a
 * package-bearing cart is refused before this runs (see
 * discountRefusal); nothing here knows about types.
 */
export function spreadDiscount(
  lines: readonly DiscountLine[],
  discount: Discount,
): number[] {
  const exts = lines.map(lineCents);
  const sub = exts.reduce((a, b) => a + b, 0);
  if (sub <= 0) return exts.map(() => 0);
  if (discount.mode === "percent") {
    const pct = Math.min(DISCOUNT_PERCENT_MAX, Math.max(0, discount.value));
    return exts.map((ext) =>
      Math.min(ext, Math.round((ext * pct) / 100 + Number.EPSILON)),
    );
  }
  const want = Math.min(sub, Math.max(0, Math.round(discount.value * 100)));
  const shares = exts.map((ext) => Math.min(ext, Math.floor((want * ext) / sub)));
  let left = want - shares.reduce((a, b) => a + b, 0);
  /* Largest lines first, ties by position, one cent per pass. */
  const order = exts
    .map((ext, i) => ({ ext, i }))
    .sort((a, b) => b.ext - a.ext || a.i - b.i)
    .map((x) => x.i);
  while (left > 0) {
    let moved = false;
    for (const i of order) {
      if (left === 0) break;
      const ext = exts[i] as number;
      const cur = shares[i] as number;
      if (cur < ext) {
        shares[i] = cur + 1;
        left -= 1;
        moved = true;
      }
    }
    /* Unreachable when want <= sub; guards a malformed input from
     * spinning. */
    if (!moved) break;
  }
  return shares;
}

/** The spread's sum, in cents: what the price check expects Mindbody's
 *  DiscountTotal to be. */
export function discountCents(
  lines: readonly DiscountLine[],
  discount: Discount,
): number {
  return spreadDiscount(lines, discount).reduce((a, b) => a + b, 0);
}

/** Whether a discount takes the whole pre-tax subtotal: the case that
 *  reads "Comped", skips the tender, and needs no payment. */
export function isFullDiscount(
  lines: readonly DiscountLine[],
  discount: Discount,
): boolean {
  const sub = subtotalCents(lines);
  return sub > 0 && discountCents(lines, discount) >= sub;
}

/** Why a cart cannot take a discount, or null. One rule today: Mindbody
 *  ignores DiscountAmount on a package (sale.yml:3627), so a discount on
 *  a cart with a package line would silently discount less than the
 *  screen said. */
export function discountRefusal(
  lines: readonly { type: string }[],
): string | null {
  return lines.some((l) => l.type === "Package")
    ? "A package cannot be discounted: Mindbody ignores a discount on a package line. Remove it from the cart first."
    : null;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** The percent a discount amounts to, as the record prints it: the
 *  chosen percent for a percent discount, else the amount's share of the
 *  subtotal to at most one decimal ("60%", "33.3%"). */
export function discountPercentLabel(
  discount: Discount,
  discounted: number,
  subtotal: number,
): string {
  if (discount.mode === "percent") return `${discount.value}%`;
  if (subtotal <= 0) return "0%";
  const pct = (discounted / subtotal) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * THE record's wording, the one place it lives (the `[comp]` log line,
 * comp_receipts.reason and the T62 Notes entry all print this):
 *
 *   Discount $60.00 (60%) on $100.00, paid $40.00: Trade, massage swap. By Kim Farrell
 *   Comped $100.00: Damaged item. By Kim Farrell
 *
 * `discounted` and `subtotal` are pre-tax dollars (the spread's sum and
 * the cart's subtotal); `paid` is what the client paid, Mindbody's
 * grand total. `full` says which sentence: a 100% discount is a comp.
 */
export function discountRecordLine(r: {
  discount: Discount;
  discounted: number;
  subtotal: number;
  paid: number;
  full: boolean;
  reason: CompReason;
  teacherName: string | null;
}): string {
  const why = r.reason.detail
    ? `${compHeadline(r.reason)}, ${r.reason.detail}`
    : compHeadline(r.reason);
  const head = r.full
    ? `Comped ${usd(r.subtotal)}`
    : `Discount ${usd(r.discounted)} (${discountPercentLabel(
        r.discount,
        r.discounted,
        r.subtotal,
      )}) on ${usd(r.subtotal)}, paid ${usd(r.paid)}`;
  return `${head}: ${why}.${r.teacherName ? ` By ${r.teacherName}` : ""}`;
}

/**
 * T203: the comp-token purpose a teacher's PIN mints to approve a sale
 * themselves when the customer screen could not (the D1 override). It
 * lives HERE, beside the PIN shape the same dialog reads, because
 * src/lib/approval.ts reaches the database and the dialog is a browser
 * component: a client bundle must not pull `pg` in for one string.
 */
export const APPROVE_PURPOSE = "approve" as const;

/**
 * T205: the comp-token purpose a teacher's PIN mints to sell a
 * membership WITHOUT the customer's signature (the D5 override). Its own
 * purpose, beside APPROVE_PURPOSE, for T94 review's reason: a PIN typed
 * to approve a sale must not also start somebody's autopay unsigned.
 * Here, beside the PIN shape the same dialog reads, because
 * src/lib/approval.ts reaches the database and the dialog is a browser
 * component.
 */
export const CONTRACT_PURPOSE = "contract" as const;
