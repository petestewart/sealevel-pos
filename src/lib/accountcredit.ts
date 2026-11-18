/**
 * T256: account credit sold at the counter (Pete, 2026-11-18: "we need to
 * add the ability to add credit to a student's account. in mindbody we do
 * it by ringing up a sale with the item ADD CREDIT to ACCOUNT. we can make
 * this more elegant in our app but the ability needs to be there").
 *
 * The ticket is its own Mindbody call, `POST /sale/purchaseaccountcredit`
 * (`purchaseCredit` in ./sale.ts), and so it stands ALONE: no cart line,
 * no gift card, no split, no discount and no promotion code beside it,
 * exactly as a gift card is its own `purchasegiftcard` per card. It rides
 * /api/checkout as `accountCredit: { amount }` so every rail that route
 * already holds applies unchanged: T113's key, T253's hold, T49's token,
 * T203/T240's approval with the tender bound, T241's display card, dry
 * run and the write guard.
 *
 * This file is the pure half: the request's shape and the sentences. It
 * calls nothing. The selling is in /api/checkout.
 *
 * Probe T256 (prod, 2026-11-18, dummy client 100042041): site 471 has NO
 * product named like credit or account in `/sale/products` or
 * `/sale/services`; the studio's "ADD CREDIT to ACCOUNT" is Mindbody's own
 * account payment item, under the system revenue category 23 "Payments on
 * Account". `purchaseaccountcredit` with `Test: true` answered `AmountPaid:
 * 1`, `SaleId: 0`, the client's id and no failures for a $1.00 Cash and a
 * $1.00 typed card payment, and the balance read -4.50 before and after
 * each, so the rehearsal moves nothing. See docs/TICKETS.md T256.
 */
import { CREDIT_MAX_USD, CREDIT_MIN_USD } from "./sale";

/** The methods account credit may be bought with, as /api/checkout spells
 *  them. Never `credit` (account credit cannot buy itself), never `comp`
 *  and not `giftcard` (see CreditTender in ./sale.ts). */
export type CreditMethod = "cash" | "storedcard" | "typedcard";

export function isCreditMethod(v: unknown): v is CreditMethod {
  return v === "cash" || v === "storedcard" || v === "typedcard";
}

/** Whether a checkout body asks for account credit at all. */
export function asksAccountCredit(payload: unknown): boolean {
  const body = (payload ?? {}) as Record<string, unknown>;
  return body["accountCredit"] !== undefined && body["accountCredit"] !== null;
}

/**
 * The `accountCredit` field, or the 400 reason. Whole cents, at least a
 * cent and at most CREDIT_MAX_USD, snapped to the exact cent value so the
 * figure sent to Mindbody is the one validated, never the float it arrived
 * as.
 */
export function parseAccountCredit(
  raw: unknown,
): { amount: number } | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "accountCredit must be an object with an amount" };
  }
  const amount = (raw as { amount?: unknown }).amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return { error: "accountCredit.amount must be a number of dollars" };
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) {
    return { error: "accountCredit.amount must be whole cents" };
  }
  if (cents < Math.round(CREDIT_MIN_USD * 100)) {
    return {
      error:
        "There is no account credit to add: the amount is nothing. Nothing " +
        "was charged.",
    };
  }
  if (cents > Math.round(CREDIT_MAX_USD * 100)) {
    return {
      error: `The most account credit this app adds at once is $${CREDIT_MAX_USD.toFixed(2)}. Nothing was charged.`,
    };
  }
  return { amount: cents / 100 };
}

/**
 * Everything a credit ticket may NOT carry, checked before any Mindbody
 * call, any PIN or any approval, in words a teacher can act on. Null when
 * the body is a credit ticket and nothing else.
 */
export function creditShapeRefusal(body: Record<string, unknown>): string | null {
  const has = (k: string) => body[k] !== undefined && body[k] !== null;
  const items = body["items"];
  if (Array.isArray(items) ? items.length > 0 : has("items")) {
    return (
      "Account credit is its own sale in Mindbody, so it cannot share a " +
      "ticket with anything else. Sell the rest on its own. Nothing was " +
      "charged."
    );
  }
  const gifts = body["giftCards"];
  if (Array.isArray(gifts) ? gifts.length > 0 : has("giftCards")) {
    return (
      "Account credit and a gift card are two separate sales. Sell them " +
      "one after the other. Nothing was charged."
    );
  }
  if (has("split")) {
    return (
      "Account credit is bought with one form of payment. Take it all in " +
      "cash or all on one card. Nothing was charged."
    );
  }
  if (has("discount") || has("teacherToken") || has("compReason")) {
    return (
      "Account credit cannot be discounted: credit is money on the " +
      "account, and a discount would hand over more than was paid. Nothing " +
      "was charged."
    );
  }
  if (has("promotionCode")) {
    return "A promotion code does not apply to account credit. Nothing was charged.";
  }
  if (has("override") || has("overdraftToken")) {
    return "Account credit takes no override and no overdraft. Nothing was charged.";
  }
  const method = body["method"];
  if (method === "credit") {
    return (
      "Account credit cannot pay for account credit. Take cash or a card. " +
      "Nothing was charged."
    );
  }
  if (method === "giftcard") {
    return (
      "Account credit is bought with cash or a card, not a gift card. " +
      "Nothing was charged."
    );
  }
  if (method === "comp") {
    return (
      "Account credit cannot be comped: it is money on the account. " +
      "Nothing was charged."
    );
  }
  if (!isCreditMethod(method)) {
    return "Account credit is bought with cash, the card on file or a typed card.";
  }
  return null;
}

/** The balance a credit purchase should leave, to the cent, or null when
 *  the balance before it is unknown. */
export function expectedBalance(before: number | null, amount: number): number | null {
  if (before === null) return null;
  return Math.round((before + amount) * 100) / 100;
}

/** Whether a balance read after the purchase agrees with what it should
 *  be, to the cent. */
export function balanceAgrees(after: number, expected: number): boolean {
  return Math.round(after * 100) === Math.round(expected * 100);
}
