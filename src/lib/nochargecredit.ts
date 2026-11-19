/**
 * T259: account credit given at NO CHARGE (Pete, 2026-11-19).
 *
 * A student, Maran, was owed $10 of credit (T258). Pete tried to give it
 * from the app and met "Account credit cannot be discounted", which is
 * T256 refusing a discount on credit by design: a discount on credit
 * hands over more than was paid. He asked for a way to give credit at no
 * charge, and approved this design: "Give credit (no charge)" on Add
 * credit; the teacher's PIN plus a required reason; sold as credit paid
 * "Other", so no money is taken; the reason filed on the student; the
 * balance checked after; and its own PIN purpose.
 *
 * Live facts (prod, dummy client 100042041, 2026-11-19, T258 follow-up):
 * `purchaseaccountcredit` refuses `Comp` ("Invalid payment method."),
 * accepts `Custom` id 7 "Comp/Guest" on `Test: true` and then REFUSES it
 * for real (`NonZeroDollarNotAllowed`), and sells it for real paid
 * `Custom` id 9 "Other" (sale 429047, one "account adjustment" line,
 * balance 0 -> 1). So a Test rehearsal does not prove a payment type,
 * and the one shape known to work is "Other".
 *
 * This file is the pure half: the field's shape, the bounds, the
 * refusals and the record's wording. No React and no server imports, so
 * the browser's pad and the route read the same rules. The selling is in
 * src/lib/nochargecreditsale.ts.
 */

/** The PIN purpose a no-charge credit is authorized with: the seventh,
 *  its own value (T94 review's rule), so a PIN typed to discount a sale,
 *  to overdraw an account, to override a pass, to approve a sale, to sell
 *  a membership unsigned or to go past a waiver cannot give credit away,
 *  and the reverse. */
export const NO_CHARGE_PURPOSE = "credit" as const;

/** The most credit given at no charge in one go. A guard against a slip
 *  of the keypad (an extra 0 turns $10.00 into $100.00, two into
 *  $1,000.00), not a policy: credit bought with money keeps T256's own
 *  ceiling. */
export const NO_CHARGE_MAX_USD = 200;
export const NO_CHARGE_MIN_USD = 0.01;

/** The reason's bounds, trimmed: T211's pair, the same kind of sentence a
 *  human will read off a profile months later. */
export const NO_CHARGE_REASON_MIN = 3;
export const NO_CHARGE_REASON_MAX = 200;

/** The name the ticket line carries while a no-charge credit is armed. */
export const NO_CHARGE_TITLE = "Account credit (no charge)";

export function noChargeReasonValid(reason: string): boolean {
  const t = reason.trim();
  return t.length >= NO_CHARGE_REASON_MIN && t.length <= NO_CHARGE_REASON_MAX;
}

/** The keypad's own sentence for an amount over the cap, which is also
 *  the route's refusal, so the two cannot say it two ways. */
export function noChargeCapSentence(): string {
  return (
    `At no charge the most is $${NO_CHARGE_MAX_USD.toFixed(2)} at once, ` +
    "a guard against a slip of the keypad. Give more in Mindbody, or in " +
    "two goes."
  );
}

/** Whether a checkout body asks for a no-charge credit at all. */
export function asksNoChargeCredit(payload: unknown): boolean {
  const ac = (payload as { accountCredit?: unknown } | null)?.accountCredit;
  if (ac === null || typeof ac !== "object" || Array.isArray(ac)) return false;
  const nc = (ac as { noCharge?: unknown }).noCharge;
  return nc !== undefined && nc !== null;
}

export interface NoChargeAsk {
  amount: number;
  token: string;
  reason: string;
}

/**
 * The `accountCredit: { amount, noCharge: { token, reason } }` field, or
 * the refusal's sentence. Whole cents, $0.01 to NO_CHARGE_MAX_USD, snapped
 * to the cent so the figure sent to Mindbody is the one validated.
 */
export function parseNoChargeCredit(raw: unknown): NoChargeAsk | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "accountCredit must be an object with an amount" };
  }
  const amount = (raw as { amount?: unknown }).amount;
  const nc = (raw as { noCharge?: unknown }).noCharge;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return { error: "accountCredit.amount must be a number of dollars" };
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) {
    return { error: "accountCredit.amount must be whole cents" };
  }
  if (cents < Math.round(NO_CHARGE_MIN_USD * 100)) {
    return {
      error: "There is no credit to give: the amount is nothing. Nothing was given.",
    };
  }
  if (cents > Math.round(NO_CHARGE_MAX_USD * 100)) {
    return { error: `${noChargeCapSentence()} Nothing was given.` };
  }
  if (nc === null || typeof nc !== "object" || Array.isArray(nc)) {
    return { error: "accountCredit.noCharge must be an object with token and reason" };
  }
  const token = (nc as { token?: unknown }).token;
  const reason = (nc as { reason?: unknown }).reason;
  if (typeof token !== "string" || token.length === 0) {
    return { error: "Enter your PIN to give credit at no charge. Nothing was given." };
  }
  if (typeof reason !== "string" || !noChargeReasonValid(reason)) {
    return {
      error:
        /* One template, not two joined: the build's minifier folded the
         * two-part version to "3200 characters" (seen in .next/server). */
        `Write why this credit is free, in ${NO_CHARGE_REASON_MIN} to ${NO_CHARGE_REASON_MAX} characters. Nothing was given.`,
    };
  }
  return { amount: cents / 100, token, reason: reason.trim() };
}

/**
 * Everything a no-charge credit ticket may NOT carry, in words, before
 * any PIN is spent or any Mindbody call is made. It stands ALONE: the
 * credit line and nothing else, no tender of any kind. Null when the body
 * is exactly that.
 *
 * `displayApprovalId` and `approvalOverride` are deliberately not read:
 * T203's approval does not apply to a no-charge credit (nothing is
 * charged to the customer), and with that setting off both fields are
 * ignored rather than refused, so a stale dialog cannot stop it either.
 */
export function noChargeShapeRefusal(body: Record<string, unknown>): string | null {
  const has = (k: string) => body[k] !== undefined && body[k] !== null;
  const items = body["items"];
  const gifts = body["giftCards"];
  if (
    (Array.isArray(items) ? items.length > 0 : has("items")) ||
    (Array.isArray(gifts) ? gifts.length > 0 : has("giftCards"))
  ) {
    return (
      "Credit given at no charge stands alone on the ticket. Sell the " +
      "other lines on their own ticket. Nothing was given."
    );
  }
  if (
    has("method") ||
    has("split") ||
    has("cashTendered") ||
    has("typedCard") ||
    has("giftCard") ||
    has("displayCard")
  ) {
    return (
      "Credit given at no charge takes no payment. Take the payment off " +
      "the ticket. Nothing was given."
    );
  }
  if (has("discount") || has("teacherToken") || has("compReason")) {
    return "Credit given at no charge takes no discount. Nothing was given.";
  }
  if (has("promotionCode")) {
    return "A promotion code does not apply to account credit. Nothing was given.";
  }
  if (has("override") || has("overdraftToken")) {
    return "Credit given at no charge takes no override and no overdraft. Nothing was given.";
  }
  return null;
}

/**
 * THE record's wording, the one place it lives: the Notes entry (or the
 * Formula Note on a site that has them) and the server log line both
 * print this.
 *
 *   Credit $10.00 given at no charge by Dana Rivers at the counter: owed from the 11/14 sale.
 *
 * The teacher's name comes from the token the server verified, never
 * from the browser.
 */
export function noChargeRecordLine(
  amount: number,
  teacherName: string,
  reason: string,
): string {
  const by = teacherName.trim() || "a teacher";
  return (
    `Credit $${amount.toFixed(2)} given at no charge by ${by} at the ` +
    `counter: ${reason.trim()}`
  );
}
