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
 * all priced at the catalog's $1.81). So the fee is an ordinary retail
 * product the studio creates, priced $0.01 and tax exempt, sold at a
 * QUANTITY of cents: a 23 cent fee is 23 x $0.01. Mindbody prices it,
 * T75 and T103 check it like any line, and the sale report shows it as
 * its own item. Tax exempt matters twice: a fee is not taxed, and
 * Mindbody rounds tax per UNIT upward, so a taxed $0.01 would cost 2
 * cents a unit.
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

/** The unit price the fee product must have, in dollars. */
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

/** The words for the rule, for the ticket and the drawer. */
export function cardFeeWords(rule: CardFeeRule): string {
  const pct = `${(rule.rate * 100).toFixed(1).replace(/\.0$/, "")}%`;
  return `${pct} on card sales under $${(rule.underCents / 100).toFixed(0)}`;
}
