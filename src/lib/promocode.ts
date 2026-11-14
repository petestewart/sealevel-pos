/**
 * T220: a Mindbody promotion code typed at the counter.
 *
 * Pete, 2026-11-14: the studio is emailing recent drop-in students a
 * per-student, single-use code (`POST /site/addpromocode`, `MaxUses: 1`,
 * `ApplicableItems` = pricing option 581, "Welcome Back - 2 Weeks
 * Unlimited ($49)", a per-student expiry) that takes their $28 drop-in
 * off, and "that needs to be added immediately" for the students who
 * come to the counter instead of redeeming online.
 *
 * The code is sent as `PromotionCode` on the cart
 * (`CheckoutShoppingCartRequest`, sale.yml:5684, "Promotion code to be
 * applied to the cart."), on the `Test: true` rehearsal AND on the real
 * checkout, and MINDBODY is the judge of it: whether it exists, whether
 * it has been used, whether it has expired and whether it applies to
 * anything on this ticket. Nothing here lists codes (`GET
 * /site/promocodes` needs the "Set up promotions / Semester discounts"
 * permission), and nothing here computes what a code is worth: the
 * discount on the screen and the total charged are the rehearsal's own.
 *
 * A code is a CODE, not an amount, which is why typing it into a text
 * field is not a breach of T35 (CLAUDE.md, Conventions, beside the gift
 * card barcode and the discount reason).
 *
 * This module is pure: the two routes and the two screens share one
 * rule for what a code may look like and which tickets may carry one.
 */

/** Longest code accepted. Mindbody's own are short (the sandbox's one
 *  code is twelve digits); this is a bound, not a format. */
export const PROMO_CODE_MAX = 50;

/**
 * The code as it will be sent, or a refusal in words, or null for none.
 * Trimmed and otherwise sent exactly as typed: whether Mindbody matches
 * codes case-blind is not documented, so the case is not ours to change.
 * Visible ASCII only, no spaces inside: a code is something a student
 * reads off an email, and a stray control character or a pasted
 * paragraph is a mistake to refuse here rather than a metered call.
 */
export function parsePromotionCode(
  raw: unknown,
): { code: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { code: null };
  if (typeof raw !== "string") {
    return { error: "promotionCode must be a string" };
  }
  const code = raw.trim();
  if (code === "") return { code: null };
  if (code.length > PROMO_CODE_MAX) {
    return {
      error: `A promotion code is at most ${PROMO_CODE_MAX} characters.`,
    };
  }
  if (!/^[\x21-\x7E]+$/.test(code)) {
    return {
      error:
        "A promotion code is letters, numbers and symbols with no spaces. " +
        "Check what was typed.",
    };
  }
  return { code };
}

/**
 * Which tickets may carry a code, or the refusal in words, or null.
 * Every refusal here is decided before any Mindbody call:
 *
 * - **With a teacher's discount or T112's substitution.** Both arrive as
 *   `DiscountAmount` on the lines and T79 asserts Mindbody's
 *   DiscountTotal equals that figure to the cent; a code's own discount
 *   would land in the same DiscountTotal, and separating the two is
 *   exactly the arithmetic the counter does not do. One discount per
 *   ticket.
 * - **On a T90 ticket holding a line for another client.** Such a ticket
 *   is one cart per recipient, and a single-use code sent on two carts
 *   is spent by the first and refused by the second AFTER the first was
 *   charged.
 * - **Beside a gift card.** A gift card is its own
 *   `/sale/purchasegiftcard` call, which takes no promotion code (T96's
 *   field list), so "the code applies to the ticket" would be untrue.
 */
export function promotionRefusal(opts: {
  discount: boolean;
  substitute: boolean;
  otherClientLines: boolean;
  giftCards: boolean;
}): string | null {
  if (opts.substitute) {
    return (
      "A substituted pass is already discounted, so this ticket cannot take " +
      "a promotion code as well. Nothing was charged."
    );
  }
  if (opts.discount) {
    return (
      "A ticket takes a promotion code or a discount, not both. Take the " +
      "discount off to use the code. Nothing was charged."
    );
  }
  if (opts.otherClientLines) {
    return (
      "A promotion code applies to one person's sale. Ring up the lines " +
      "bought for someone else on their own ticket. Nothing was charged."
    );
  }
  if (opts.giftCards) {
    return (
      "A promotion code cannot go on a ticket holding a gift card. Sell " +
      "the gift card on its own. Nothing was charged."
    );
  }
  return null;
}

/** What became of a code on one pricing, as the routes answer it. */
export interface PromotionOutcome {
  /** The code as sent. */
  code: string;
  /** True only when Mindbody's own DiscountTotal for the coded cart was
   *  above zero. A code Mindbody accepted and took nothing off for is
   *  NOT applied: the screen must not say a code worked when the price
   *  did not move. */
  applied: boolean;
  /** Mindbody's DiscountTotal with the code, in dollars; null when not
   *  applied. Never a figure computed here. */
  discount: number | null;
  /** Why it was not applied: Mindbody's own sentence for a refusal, or
   *  ours when it accepted the code and took nothing off. Null when
   *  applied, or when the pricing was suppressed and nothing is known. */
  refusal: string | null;
}

/** The sentence for a code Mindbody accepted without taking anything
 *  off. Its own constant so both routes say the same thing. */
export const PROMO_TOOK_NOTHING =
  "Mindbody accepted that code but took nothing off this ticket. Check it " +
  "is for an item on the ticket.";
