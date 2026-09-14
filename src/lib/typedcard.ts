/**
 * T93: a card TYPED at the counter and charged for this one sale (Pete:
 * "the Card button should have a number keypad icon on its right. this
 * will open a credit card manual entry modal ... if there is a client
 * currently selected, they can add or replace this as a stored card, or
 * just use it temporarily. If it is a walk in sale, they can just use it
 * for the sale").
 *
 * The mechanism is a `CreditCard` entry in the checkout's Payments array.
 * The spec's key list for that type (docs/mindbody-openapi/sale.yml:3934)
 * is: amount, creditCardNumber, expMonth, expYear, cvv, billingName,
 * billingAddress, billingCity, billingState, billingPostalCode, saveInfo,
 * cardId. The `CreditCardInfo` model (sale.yml:2867) spells the same
 * fields PascalCase: CreditCardNumber, ExpMonth, ExpYear, BillingName,
 * BillingAddress, BillingCity, BillingState, BillingPostalCode, SaveInfo,
 * CardId, CVV. src/lib/sale.ts sends the PascalCase OBJECT shape, the one
 * shape a live checkout is known to have passed with; the lowercase
 * string shape is the by-hand thing to try if Mindbody refuses this one,
 * and never an automatic retry, because a money call must not quietly
 * send itself again in a different shape.
 *
 * WHY THIS MODULE IS PURE: no mindbody(), no database, no logging. The
 * browser's modal imports the same validator, so the rule the form
 * enforces IS the rule the route enforces. Everything that touches this
 * file is holding a PAN, so nothing here may write one anywhere.
 *
 * The number and the CVV live in the request they are sent in and nowhere
 * else: never in our database (the charter forbids a copy of Mindbody's
 * data anyway), never in a log line (mindbody()'s suppression lines go
 * through redactRequest), never in the dev call log (src/lib/calllog.ts
 * strikes CreditCardNumber and CVV in both directions and strikes any
 * card-shaped run of digits out of free text, which is how a refusal
 * quotes one back), and never in a route answer, which carries the last
 * four at most. The design doc's "never touch a PAN" rule was relaxed by
 * T84 for a card on file and by T93 for a charge, both at Pete's explicit
 * ask; everything else about it holds.
 */

import { cardDigits, cardExpired, luhnOk } from "./cardrules";

/** The card as the teacher typed it, validated. `number` is digits only.
 *  `cvv` is required for a charge (the spec lists it for this payment
 *  type) and is NEVER stored: Mindbody's ClientCreditCard model has no
 *  CVV field, so it cannot reach a card on file even by accident. */
export interface TypedCard {
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  billingName: string;
  postalCode: string;
  /** Optional, behind the modal's "Billing address" disclosure: the
   *  studio's processor may want them and the spec has fields for them.
   *  Empty means "not given", and the payment omits the key rather than
   *  sending a blank. */
  address: string;
  city: string;
  state: string;
  /** T93: "and keep on file". Refused server-side for a walk-in
   *  (house-client) cart, because a card kept on a catch-all record
   *  belongs to nobody. The store runs AFTER a successful charge through
   *  T84's proven /client/updateclient path, so a refused charge stores
   *  nothing and a stored card never precedes a charge. */
  keep: boolean;
}

/** The four digits that may reach a screen, a log line or a response. */
export function typedCardLastFour(number: string): string {
  return number.slice(-4);
}

const MIN_DIGITS = 13;
const MAX_DIGITS = 19;

/** One optional billing line: trimmed and length-capped, never rejected.
 *  These are a courtesy to the processor, and a charge must not fail over
 *  a street address. */
function optional(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Validate what the browser sent. Runs on the SERVER as the rule, and in
 * the modal so a typo costs a quiet line rather than a round trip. The
 * messages are teacher-facing: they say what to fix, and none of them
 * quotes the number back.
 */
export function parseTypedCard(
  raw: unknown,
  now = new Date(),
): { card: TypedCard; error: null } | { card: null; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const number = cardDigits(typeof b["number"] === "string" ? b["number"] : "");
  if (number === "") return { card: null, error: "Card number is required." };
  if (
    !/^\d+$/.test(number) ||
    number.length < MIN_DIGITS ||
    number.length > MAX_DIGITS
  ) {
    return {
      card: null,
      error: `Card number must be ${MIN_DIGITS} to ${MAX_DIGITS} digits.`,
    };
  }
  if (!luhnOk(number)) {
    return { card: null, error: "That card number does not check out." };
  }
  const month = String(b["expMonth"] ?? "").trim();
  const year = String(b["expYear"] ?? "").trim();
  if (!/^\d{1,2}$/.test(month) || Number(month) < 1 || Number(month) > 12) {
    return { card: null, error: "Expiry month must be 1 to 12." };
  }
  if (!/^\d{4}$/.test(year)) {
    return { card: null, error: "Expiry year must be four digits." };
  }
  if (cardExpired(month, year, now)) {
    return { card: null, error: "That expiry date has already passed." };
  }
  /* Three digits, or four on an AMEX. */
  const cvv = String(b["cvv"] ?? "").trim();
  if (!/^\d{3,4}$/.test(cvv)) {
    return { card: null, error: "The security code is three or four digits." };
  }
  const billingName = String(b["billingName"] ?? "").trim();
  if (billingName === "") {
    return { card: null, error: "Name on card is required." };
  }
  if (billingName.length > 100) {
    return { card: null, error: "Name on card is too long." };
  }
  const postalCode = String(b["postalCode"] ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/.test(postalCode)) {
    return { card: null, error: "Postal code does not look right." };
  }
  return {
    card: {
      number,
      /* Mindbody's ExpMonth is a string, two digits on its own screens. */
      expMonth: month.padStart(2, "0"),
      expYear: year,
      cvv,
      billingName,
      postalCode,
      address: optional(b["address"], 100),
      city: optional(b["city"], 50),
      state: optional(b["state"], 50),
      keep: b["keep"] === true,
    },
    error: null,
  };
}
