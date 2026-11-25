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
 * all priced at the catalog's $1.81; and T301, 2026-11-24: 25 more
 * shapes on the fee product, twelve Metadata keys, six wrapper keys,
 * string Metadata and a negative DiscountAmount, every one priced at the
 * catalog's $0.01 or refused). T297 first sold the fee as a QUANTITY of
 * a $0.01 product, which Mindbody's sale page and receipt print as one
 * "$0.01" row per cent (Pete, sale 430178: five rows for a 5 cent fee:
 * "their receipt is going to look very unprofessional").
 *
 * T301 then sold ONE $0.26 product discounted down to the fee, which
 * Mindbody's receipt printed as "Credit card fee $0.26, Discount
 * (80.77%) -$0.21" (Pete, sale 430291: "reciept sucks").
 *
 * T302: the studio keeps one product per fee amount, $0.01 to $0.26, in
 * one category ("Fees"), and the fee is ONE unit of the product priced
 * at exactly the fee: one plain line on the receipt. The family is read
 * live (`cardFeeFamily` in src/lib/sale.ts: the category of the product
 * POS_CARD_FEE_PRODUCT_ID names, untaxed products only, one per price),
 * and an amount with no product carries no fee. Test-priced on 471
 * (2026-11-24): 25 of the 26 untaxed, and Towel Rental with BLACK26
 * beside the $0.05 one took the code's 15% off the towel only ($2.59).
 *
 * The browser does not know any of this: its fee line is still a
 * quantity of CENTS at $0.01 (/api/catalog serves the fee as a one-cent
 * unit, with the amounts that have a product), the screens show "Card
 * processing fee $0.05", and the routes check the fee in cents.
 * `src/lib/sale.ts` swaps in the product of that amount at the one place
 * every cart leaves for Mindbody (`withCardFeeShape`), and reads it back
 * the same way (the basket and the daily check take any fee product as
 * the fee line, sold once).
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
 *  quantity is the fee in cents (T302: the product of that price is swapped in for Mindbody). */
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

/** T301/T302: the largest fee this rule can make, in cents: the fee on a
 *  sale one cent under the floor: the top of the fee product family
 *  (src/lib/sale.ts cardFeeFamily reads products from 1 cent to this). */
export function maxCardFeeCents(rule: CardFeeRule): number {
  return cardFeeCents(rule.underCents - 1, rule);
}

/** T301/T302: is this cart line the card fee? Only a Product line whose id is
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
