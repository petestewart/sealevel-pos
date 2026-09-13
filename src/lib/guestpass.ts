/**
 * T59c: what makes a pass a guest pass, in one place for both sides of
 * the wire. The studio's pricing option is "Guest Pass (for auto-debit
 * members only)", a $0 one-session pass the auto-renew membership drops
 * onto the MEMBER's account each month (T47, T59); the name is the only
 * thing that marks it, and Mindbody carries no "guest" flag. The match
 * is on the words, case-insensitively, so a renamed option still reads
 * as one as long as it says "guest pass".
 *
 * Pure functions, no I/O: page.tsx (the picker, the row action) and the
 * guest route (the server's own re-check before it writes) share them.
 */

export interface GuestPassLike {
  id: number | null;
  name: string;
  remaining: number | null;
}

export function isGuestPass(name: string): boolean {
  return /guest\s*pass/i.test(name);
}

/** A guest pass with a session left and an id to write with, or null.
 *  A guest pass at zero is not offered: the pass list is ShowActiveOnly
 *  so it usually is not there at all (T57), and a null Remaining is
 *  treated as unknown rather than unlimited, because a guest pass is
 *  one session and a Mindbody that omitted the count is not evidence
 *  of a session to spend. */
/**
 * T62: whether the guest's visit really landed on the member's pass.
 * Pete's live probe (2026-09-04): Mindbody ACCEPTED `addclienttoclass`
 * with the member's Guest Pass id on the guest, paid the visit with the
 * guest's OWN pass, left the member's pass at 1 left, and said nothing;
 * the app reported success. So the write's answer is not the record,
 * the visit and the pass are, and both are read back:
 *
 *   - `visit` is what Mindbody says paid the visit (the booking answer's
 *     ServiceId, or a `/class/classvisits` re-read); null when neither
 *     could be read. A visit on a different pass, or on none, is the
 *     probe's case exactly.
 *   - `remaining` is the member's pass before and after; `after` null
 *     means the pass has left the ShowActiveOnly list (T57), which a
 *     spent one-session pass does. A count that did not move is the
 *     other half of the probe's evidence, and trips the judgement on
 *     its own: a visit Mindbody says is on the pass while the pass still
 *     shows the session is a Mindbody in two minds, and the safe answer
 *     is the one that writes nothing more.
 *
 * "unverified" is both reads failing: nothing is known either way, and
 * the caller says so rather than guessing. Pure, so it can be tested
 * without Mindbody.
 */
export type GuestPassVerdict = "landed" | "ignored" | "unverified";

export function judgeGuestPass(opts: {
  sent: number;
  visit: { clientServiceId: number | null } | null;
  remaining: { before: number; after: number | null } | null;
}): GuestPassVerdict {
  const { sent, visit, remaining } = opts;
  if (visit === null && remaining === null) return "unverified";
  if (visit !== null && visit.clientServiceId !== sent) return "ignored";
  if (remaining !== null && remaining.after !== null && remaining.after >= remaining.before) {
    return "ignored";
  }
  return "landed";
}

/** The sentence the sheet shows for an ignored pass id: what Mindbody
 *  did instead, and the one remedy that gives the session back. T63:
 *  the id sent is the $0 Guest Pass just sold to the GUEST (T62 sent
 *  the member's), so the sentence names that; the member's name stays
 *  for the sheet's "whose guest" reading. */
export function ignoredPassMessage(opts: {
  guestName: string;
  memberName: string;
  /** The pass Mindbody used instead; null when the visit carries none;
   *  undefined when the visit could not be read and only the unmoved
   *  count says the pass was not spent. */
  ownPass: string | null | undefined;
}): string {
  const instead =
    opts.ownPass === undefined
      ? `${opts.guestName} without spending`
      : opts.ownPass === null
        ? `${opts.guestName} with no pass instead of`
        : `${opts.guestName} on another pass (${opts.ownPass}) instead of`;
  return (
    `Mindbody booked ${instead} the $0 Guest Pass just sold to them ` +
    `as ${opts.memberName}'s guest. Remove them from the class to give that session back.`
  );
}

export function usableGuestPass<P extends GuestPassLike>(
  passes: readonly P[] | null | undefined,
): (P & { id: number }) | null {
  for (const p of passes ?? []) {
    if (
      p.id !== null &&
      isGuestPass(p.name) &&
      p.remaining !== null &&
      p.remaining > 0
    ) {
      return p as P & { id: number };
    }
  }
  return null;
}

/* T63 ----------------------------------------------------------------
 * Guest passes the way the front desk does it (Pete, 2026-09-04): the
 * GUEST is sold their own $0 Guest Pass, booked on it, and the MEMBER's
 * Guest Pass is retired by RETURNING the sale it came from. Both halves
 * have a pure judgement here so they can be tested without Mindbody. */

/** A pass on an account as the T63 flow reads it (PassInfo's fields). */
export interface PassInstance {
  id: number | null;
  name: string;
  remaining: number | null;
  paymentDate: string | null;
}

/**
 * The Guest Pass a checkout just put on the guest's account. The checkout
 * answer carries no ClientService (sale.yml CheckoutShoppingCartResponse:
 * ShoppingCart, Classes, Appointments, Enrollments), so the guest's pass
 * list is read again and the new one is picked out: a guest pass whose
 * id was NOT on the list read before the sale, when that list is known;
 * otherwise the guest pass with the newest PaymentDate (the brief's
 * fallback, for a before-read that failed). Ties on the date go to the
 * higher id, which Mindbody hands out in order. A pass with no id
 * cannot be booked with and is never picked. Null when no guest pass
 * with a session left is on the list at all.
 */
export function pickNewGuestPass<P extends PassInstance>(
  after: readonly P[],
  beforeIds: ReadonlySet<number> | null,
): (P & { id: number }) | null {
  const candidates = after.filter(
    (p): p is P & { id: number } =>
      p.id !== null && isGuestPass(p.name) && p.remaining !== null && p.remaining > 0,
  );
  const fresh =
    beforeIds === null ? candidates : candidates.filter((p) => !beforeIds.has(p.id));
  const pool = fresh.length > 0 ? fresh : beforeIds === null ? candidates : [];
  if (pool.length === 0) return null;
  return pool.reduce((best, p) => {
    const a = p.paymentDate ?? "";
    const b = best.paymentDate ?? "";
    if (a > b) return p;
    if (a === b && p.id > best.id) return p;
    return best;
  });
}

/** A sale as GET /sale/sales lists it (sale.yml Sale, PurchasedItem,
 *  SalePayment), the fields the judgement reads. */
export interface SaleLike {
  id: number | null;
  clientId: string;
  saleDateTime: string | null;
  items: {
    /** PurchasedItem.Id: "use this ID when calling GET Services", the
     *  pricing option's ProductId for a service. */
    productId: number | null;
    isService: boolean | null;
    description: string | null;
    totalAmount: number | null;
    returned: boolean | null;
    /** PurchasedItem.Quantity: "Negative numbers indicate returned
     *  items" (sale.yml), so a negative one is a return on the list. */
    quantity: number | null;
  }[];
  payments: { type: string | null; amount: number | null }[];
}

export type SaleVerdict =
  | { returnable: true; saleId: number }
  | { returnable: false; reason: string };

/** Payment types that mean money or credit changed hands, matched on the
 *  type's words: a card brand, a stored card, account credit, a gift
 *  card, cash, a check, ACH. Anything else that is not plainly a comp is
 *  refused too (the allow list is the rule; this list names the reason). */
const MONEY_PAYMENT_RE = /card|visa|master|amex|american|discover|credit|debit|account|gift|cash|check|cheque|ach|bank|stripe|paypal/i;
const COMP_PAYMENT_RE = /\bcomp\b|guest/i;

/**
 * Pete's hard rule (T63): the member's Guest Pass sale is returned ONLY
 * when the sale holds exactly one item, that item is the Guest Pass
 * (its ProductId, never its name alone), it has not already been
 * returned, its total is $0.00, and it carries no card, stored-card,
 * account, gift-card or cash payment: a Comp, or no payment at all, is
 * the only thing that passes. `/sale/returnsale` takes a SaleId, not a
 * line, so a sale bundling the pass with the monthly autopay would be
 * returned whole, and this is what stops that. Nothing here is ever a
 * refund: a sale that fails any test is left alone and the reason is
 * shown, and the pass stays on the account until someone returns it in
 * Mindbody by hand.
 *
 * `sales` is every sale the window held for this client; the newest
 * one carrying the pass is judged (a member with two guest-pass sales
 * in the window is rare, and the newest is the one the roster shows).
 *
 * T63 review: the total and every payment amount must be exactly 0,
 * not rounded to it, and an amount Mindbody did not give is refused,
 * not read as zero; a sale on the list with the pass at a negative
 * quantity is a return record, so the pass counts as already returned.
 */
export function judgeGuestPassSale(
  sales: readonly SaleLike[],
  opts: { clientId: string; productId: number },
): SaleVerdict {
  const withPass = sales
    .filter((s) => s.clientId === opts.clientId)
    .filter((s) => s.items.some((i) => i.productId === opts.productId))
    .sort((a, b) => (b.saleDateTime ?? "").localeCompare(a.saleDateTime ?? ""));
  const returnRecord = withPass.find((s) =>
    s.items.some(
      (i) => i.productId === opts.productId && i.quantity !== null && i.quantity < 0,
    ),
  );
  if (returnRecord !== undefined) {
    return {
      returnable: false,
      reason: `sale ${returnRecord.id ?? "?"} on their account is a return of the Guest Pass, so it was already returned`,
    };
  }
  const carrying = withPass.filter((s) =>
    s.items.some((i) => i.productId === opts.productId && i.returned !== true),
  );
  const sale = carrying[0];
  if (sale === undefined) {
    const already = withPass[0];
    return {
      returnable: false,
      reason:
        already === undefined
          ? "no sale of the Guest Pass was found on their account"
          : `sale ${already.id ?? "?"} of the Guest Pass was already returned`,
    };
  }
  if (sale.id === null) {
    return { returnable: false, reason: "the sale has no id to return" };
  }
  if (sale.items.length !== 1) {
    const others = sale.items
      .filter((i) => i.productId !== opts.productId)
      .map((i) => i.description ?? "another item")
      .join(", ");
    return {
      returnable: false,
      reason: `sale ${sale.id} bundles it with ${others || "other items"}, and a return would take back the whole sale`,
    };
  }
  const item = sale.items[0]!;
  /* Proof, not absence of evidence: an item Mindbody did not mark as a
   * pricing option, or did not price, is refused as unknown. */
  if (item.isService !== true) {
    return { returnable: false, reason: `sale ${sale.id}'s item is not a pricing option` };
  }
  if (item.totalAmount === null) {
    return { returnable: false, reason: `sale ${sale.id}'s total is not known` };
  }
  if (item.totalAmount !== 0) {
    /* A sub-cent total is not $0.00 either; the reason shows the raw
     * number then, so the line never reads "$0.00, not $0.00". */
    const cents = item.totalAmount.toFixed(2);
    const shown = cents === "0.00" || cents === "-0.00" ? String(item.totalAmount) : cents;
    return { returnable: false, reason: `sale ${sale.id} was for $${shown}, not $0.00` };
  }
  for (const p of sale.payments) {
    const type = (p.type ?? "").trim();
    if (p.amount === null) {
      return {
        returnable: false,
        reason: `sale ${sale.id} carries a ${type || "payment"} whose amount is not known`,
      };
    }
    const amount = p.amount;
    if (amount !== 0) {
      return {
        returnable: false,
        reason: `sale ${sale.id} carries a ${type || "payment"} of $${amount.toFixed(2)}`,
      };
    }
    if (MONEY_PAYMENT_RE.test(type) || !COMP_PAYMENT_RE.test(type)) {
      return {
        returnable: false,
        reason: `sale ${sale.id} was paid by ${type || "an unnamed method"}, not a comp`,
      };
    }
  }
  return { returnable: true, saleId: sale.id };
}
