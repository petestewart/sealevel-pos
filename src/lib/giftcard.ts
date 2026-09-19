/**
 * Gift cards as a tender (T83, Pete: "Add gift card as a form of
 * payment").
 *
 * Two Mindbody touches and nothing else: `GET /sale/giftcardbalance`
 * (sale.yml:333, operationId getGiftCardBalance) answers a card's
 * remaining balance from its barcode id, and the checkout carries the
 * number in a `GiftCard` payment entry (src/lib/sale.ts). Buying a gift
 * card is a different endpoint (`/sale/purchasegiftcard`) and a
 * different ticket; this file only spends one.
 *
 * THE NUMBER IS A SECRET. A gift card is a bearer instrument: whoever
 * has the number can spend the balance, so it is treated like a card
 * number throughout -- never stored, never returned to the browser, and
 * only the last four ever reach a screen or a record.
 *
 * It is NOT struck out of the dev call log any more (T109, Pete: "no
 * redactions at all. these are all things the teacher can see already
 * and i am not worried about it."). The teacher typed it off the card in
 * their hand, the drawer is gated behind POS_DEVTOOLS, and a balance
 * read whose id cannot be seen is a call that cannot be diagnosed.
 */

import { mindbody } from "./mindbody";

/** A barcode id long enough to be one, short enough to be a typo.
 *  Mindbody types the field as a string and documents no format, so
 *  this is deliberately loose: digits, letters and dashes, which is
 *  every gift card barcode anyone has shown us. The teacher-facing
 *  refusal says the bounds. */
export const GIFT_CARD_MIN = 4;
export const GIFT_CARD_MAX = 32;
const SHAPE = /^[A-Za-z0-9-]+$/;

/**
 * A gift card number from an untrusted source, trimmed, or a string
 * saying why it is not one. Spaces inside are dropped (a barcode read
 * aloud comes in groups); nothing else is repaired.
 */
export function parseGiftCardNumber(raw: unknown): { number: string } | string {
  if (typeof raw !== "string") return "a gift card number is required";
  const number = raw.replace(/\s+/g, "");
  if (number.length < GIFT_CARD_MIN || number.length > GIFT_CARD_MAX) {
    return `a gift card number is ${GIFT_CARD_MIN} to ${GIFT_CARD_MAX} characters`;
  }
  if (!SHAPE.test(number)) {
    return "a gift card number is digits, letters and dashes only";
  }
  return { number };
}

/** The only part of the number that may be shown or recorded. Short
 *  numbers keep what they have rather than being padded, so this can
 *  never widen into the whole number. */
export function giftCardLastFour(number: string): string {
  return number.slice(-4);
}

/**
 * What Mindbody says is left on the card, in dollars.
 *
 * A READ, so it goes out under dry run like every other read and runs
 * as the service account (CLAUDE.md: reads stay there). The number
 * rides in the query string, which is why calllog redacts `barcodeId`
 * out of the recorded path: the drawer's `copy all` must not be a way
 * to lift a spendable number off an iPad.
 *
 * Throws Mindbody's own refusal for an unknown card or a gift card
 * feature the site does not have; a missing RemainingBalance is a
 * refusal too, never a zero, because a zero would read as "spent" and
 * invite a $0 tender.
 */
export async function giftCardBalance(number: string): Promise<number> {
  const res = await mindbody<{ RemainingBalance?: unknown }>(
    `/sale/giftcardbalance?barcodeId=${encodeURIComponent(number)}`,
  );
  const raw = res?.RemainingBalance;
  const balance = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(balance)) {
    throw new Error(
      "Mindbody did not report a balance for that gift card. Nothing was charged.",
    );
  }
  /* Cents, and never negative: a negative balance is not a tender. */
  return Math.max(0, Math.round(balance * 100) / 100);
}
