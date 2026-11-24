/**
 * T297: the card processing fee (Pete, 2026-11-23: "add a feature to
 * automatically add a credit card processing fee of 2.6% to credit card
 * purchases under $10. we already have a sign at the front desk stating
 * that will happen."). All card methods (card on file, a typed card, the
 * card reader); on the reader, a card Square reads as DEBIT pays no fee
 * (Pete: "Skip on reader debit").
 *
 * Mindbody has no surcharge field and ignores a price sent on a cart
 * line (probed on 471, 2026-11-23: Metadata Price, Amount and SalePrice
 * all priced at the catalog's $1.81; and T299, 2026-11-24: 25 more
 * shapes on the fee product, twelve Metadata keys, six wrapper keys,
 * string Metadata and a negative DiscountAmount, every one priced at the
 * catalog's $0.01 or refused). T297 first sold the fee as a QUANTITY of
 * a $0.01 product, which Mindbody's sale page and receipt print as one
 * "$0.01" row per cent (Pete, sale 430178: five rows for a 5 cent fee:
 * "their receipt is going to look very unprofessional").
 *
 * T299: the fee is now ONE unit of the fee product, which the studio
 * prices at or above the largest fee the rule can make ($0.26 for 2.6%
 * under $10), discounted down to the fee with the cart line's
 * DiscountAmount, the field the counter's teacher discounts have used
 * live for months. Probed on 471 with `Test: true` (2026-11-24): LMNT
 * $1.81 with DiscountAmount $1.76 priced $0.05, and Towel Rental beside
 * it with BLACK26 took the code's 15% off the towel AND the line
 * discount, $2.59, the same as the towel with five $0.01 fee units.
 *
 * The browser does not know any of this: its fee line is still a
 * quantity of CENTS at $0.01 (/api/catalog serves the fee as a one-cent
 * unit whatever the product costs), the screens show "Card processing
 * fee $0.05" as before, and the routes check the fee in cents.
 * `src/lib/sale.ts` turns that line into Mindbody's shape at the one
 * place every cart leaves for Mindbody (`withCardFeeShape`), and reads
 * it back the same way (the basket and the daily check count the fee as
 * one unit). Tax exempt still matters: a fee is not taxed.
 *
 * Shared by the browser (to put the line on the ticket) and
 * /api/checkout (to refuse a fee line that does not belong). Pure: no
 * Mindbody call, no environment read outside `cardFeeEnv`.
 */

export interface CardFeeRule {
  /** The fee product's barcode id, the cart line's metadataId. */
  productId: string;
  /** 0.026 for 2.6%. */
  rate: number;
  /** A sale charged LESS than this many cents carries the fee. */
  underCents: number;
}

/** The unit the BROWSER's fee line is counted in, in dollars: its
 *  quantity is the fee in cents. Not the fee product's price (T299). */
export const CARD_FEE_UNIT_PRICE = 0.01;

/** The tenders that carry the fee. The reader's debit exemption is
 *  decided at the checkout, once Square has read the card. */
export const CARD_FEE_METHODS = ["storedcard", "typedcard", "reader"] as const;

/** The rule from the server's environment, or null when it is off.
 *  POS_CARD_FEE_PRODUCT_ID unset (or blank) turns the whole feature off. */
export function cardFeeEnv(): CardFeeRule | null {
  const productId = (process.env.POS_CARD_FEE_PRODUCT_ID ?? "").trim();
  if (productId === "") return null;
  const rateRaw = Number(process.env.POS_CARD_FEE_RATE ?? "0.026");
  const underRaw = Number(process.env.POS_CARD_FEE_UNDER ?? "10");
  const rate = Number.isFinite(rateRaw) && rateRaw > 0 && rateRaw < 0.1 ? rateRaw : 0.026;
  const under = Number.isFinite(underRaw) && underRaw > 0 && underRaw <= 100 ? underRaw : 10;
  return { productId, rate, underCents: Math.round(under * 100) };
}

/**
 * The fee, in cents, on a sale whose total WITHOUT the fee is
 * `preFeeCents`: 0 for nothing to pay or a sale at or above the floor,
 * else the rate rounded to the cent, never less than one cent.
 */
export function cardFeeCents(preFeeCents: number, rule: CardFeeRule): number {
  if (!Number.isFinite(preFeeCents) || preFeeCents <= 0) return 0;
  if (preFeeCents >= rule.underCents) return 0;
  return Math.max(1, Math.round(preFeeCents * rule.rate));
}

/** T299: the largest fee this rule can make, in cents: the fee on a
 *  sale one cent under the floor. The fee product must cost at least
 *  this, since a discount can only bring a price down. */
export function maxCardFeeCents(rule: CardFeeRule): number {
  return cardFeeCents(rule.underCents - 1, rule);
}

/** T299: is this cart line the card fee? Only a Product line whose id is
 *  the rule's product. With the rule off, nothing is. */
export function isCardFeeProduct(
  type: string,
  id: string | number,
  rule: CardFeeRule | null = cardFeeEnv(),
): boolean {
  return rule !== null && type === "Product" && String(id) === rule.productId;
}

/** The words for the rule, for the ticket and the drawer. */
export function cardFeeWords(rule: CardFeeRule): string {
  const pct = `${(rule.rate * 100).toFixed(1).replace(/\.0$/, "")}%`;
  return `${pct} on card sales under $${(rule.underCents / 100).toFixed(0)}`;
}
