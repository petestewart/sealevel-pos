import { judgeGuestPassSale, type SaleLike, type SaleVerdict } from "./guestpass";
import { mindbody, type Actor } from "./mindbody";
import { studioWall } from "./roster";
import {
  checkoutCart,
  rehearseCheckout,
  type CartLine,
  type CheckoutOutcome,
  type PricedCart,
} from "./sale";

/**
 * T63: the two Mindbody halves of "guest passes the way the front desk
 * does it" (Pete's screens, 2026-09-04) that are not already in sale.ts:
 * finding the sale a member's Guest Pass came from, and returning it.
 * The guest's own $0 sale reuses T45's comp path below, so the cart
 * code lives in one place.
 *
 * Every write here goes through mindbody() with the client id in the
 * options, so dry run and the write guard judge it like any other, and
 * suppression is reported, never dressed as done.
 */

/** The one-line cart for the guest's $0 Guest Pass. `price` is the
 *  catalog's, for the local estimate only; the rehearsal prices it. */
export function guestPassLine(option: {
  productId: number;
  price: number;
  taxRate: number | null;
}): CartLine {
  return {
    type: "Service",
    metadataId: option.productId,
    quantity: 1,
    price: option.price,
    taxExempt: false,
    taxRate: option.taxRate,
  };
}

/**
 * The rehearsal: T45's Test-mode pricing of the guest's cart, on the
 * service account like every rehearsal. The caller sells ONLY when
 * `grandTotal` is exactly 0.00; a Guest Pass Mindbody prices at anything
 * else is refused before any real call, with the amount.
 */
export function rehearseGuestPass(
  line: CartLine,
  guestClientId: string,
): Promise<PricedCart> {
  return rehearseCheckout([line], guestClientId);
}

/**
 * The real sale: `/sale/checkoutshoppingcart` for the GUEST with the one
 * item, `LocationId: 1, InStore: true`, paid with T45's Comp stub at $0
 * (`Payments: [{Type: "Comp", Metadata: {Amount: 0}}]`), no
 * PayerClientId (Pete: that needs a stored "Pays for" relationship),
 * `SendEmail: false`. Money-shaped even at $0: the caller runs it once,
 * never retries it, and reports a 5xx or a dead transport as ambiguous.
 */
export function sellGuestPass(
  line: CartLine,
  guestClientId: string,
  actor: Actor | null,
): Promise<CheckoutOutcome> {
  return checkoutCart([line], guestClientId, { type: "Comp", amount: 0 }, actor, false);
}

/** Whether a rehearsed total is the $0.00 the flow requires: exactly
 *  zero, never rounded to it (T63 review: a cart Mindbody prices at
 *  $0.004 is not a $0 cart, and an unknown total is not zero). */
export function isZeroTotal(grandTotal: number | null): boolean {
  return grandTotal === 0;
}

/** How far back the sale lookup reaches when the pass carries no
 *  PaymentDate: a Guest Pass lands monthly and expires at month end, so
 *  a window of 45 days holds any live one. */
const SALE_WINDOW_DAYS = 45;
/** `/sale/sales` pages at request.limit (200 is the most Mindbody
 *  serves); the read follows PaginationResponse.TotalResults up to this
 *  many pages, then gives up and reports the sale as not found (never
 *  a guess), which the 45-day window can reach on a busy site. */
const SALE_PAGE_LIMIT = 200;
const SALE_MAX_PAGES = 10;

/**
 * The sales that could be the member's Guest Pass sale, as
 * `GET /sale/sales` (sale.yml:990) lists them, judged by
 * judgeGuestPassSale. The endpoint filters by date, sale id and payment
 * method and NOT by client (latestSaleId learned the same), so the
 * window is the day of the pass's PaymentDate and a day either side
 * (T63 review: a sale posted late the evening before its PaymentDate,
 * or a date Mindbody shifted across midnight, was a "no sale found"
 * for a pass whose sale was there; the judge is what keeps the wider
 * window safe, since nothing but a lone $0 comp sale of this product
 * for this client passes it), site-local, so the strings are built
 * with studioWall's shape and never through toISOString, and the
 * client is matched here on `Sale.ClientId`. With no PaymentDate the
 * window is the last SALE_WINDOW_DAYS. A read, on the service account,
 * following the pages; a failure is thrown for the caller to report as
 * "not returned: <reason>", never as a return.
 */
export async function findGuestPassSale(opts: {
  memberClientId: string;
  productId: number;
  paymentDate: string | null;
  now?: Date;
}): Promise<SaleVerdict & { window: { start: string; end: string }; sales: number }> {
  const now = opts.now ?? new Date();
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(opts.paymentDate ?? "")?.[1] ?? null;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const end = `${studioWall(tomorrow).slice(0, 10)}T00:00:00`;
  const start =
    day !== null
      ? `${shiftDay(day, -1)}T00:00:00`
      : `${studioWall(new Date(now.getTime() - SALE_WINDOW_DAYS * 24 * 60 * 60 * 1000)).slice(0, 10)}T00:00:00`;
  const windowEnd = day !== null ? `${shiftDay(day, 2)}T00:00:00` : end;
  const raw: unknown[] = [];
  for (let page = 0; page < SALE_MAX_PAGES; page += 1) {
    const query =
      `request.startSaleDateTime=${encodeURIComponent(start)}` +
      `&request.endSaleDateTime=${encodeURIComponent(windowEnd)}` +
      `&request.limit=${SALE_PAGE_LIMIT}` +
      `&request.offset=${page * SALE_PAGE_LIMIT}`;
    const body = await mindbody(`/sale/sales?${query}`);
    const got: unknown[] = Array.isArray(body?.Sales) ? body.Sales : [];
    raw.push(...got);
    const total = intOrNull(body?.PaginationResponse?.TotalResults);
    if (got.length === 0 || total === null || raw.length >= total) break;
  }
  const sales = raw.map(saleLike);
  const verdict = judgeGuestPassSale(sales, {
    clientId: opts.memberClientId,
    productId: opts.productId,
  });
  return { ...verdict, window: { start, end: windowEnd }, sales: sales.length };
}

/** Calendar arithmetic on a "YYYY-MM-DD" string, no timezone in it. */
function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One Sale (sale.yml:2730) as the judge reads it. Unknown shapes read
 *  as null, which the judge refuses; nothing is coerced into passing. */
function saleLike(raw: unknown): SaleLike {
  const s = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(s["PurchasedItems"]) ? (s["PurchasedItems"] as unknown[]) : [];
  const payments = Array.isArray(s["Payments"]) ? (s["Payments"] as unknown[]) : [];
  return {
    id: intOrNull(s["Id"]),
    clientId: String(s["ClientId"] ?? ""),
    saleDateTime: typeof s["SaleDateTime"] === "string" ? s["SaleDateTime"] : null,
    items: items.map((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      return {
        productId: intOrNull(i["Id"]),
        isService: typeof i["IsService"] === "boolean" ? i["IsService"] : null,
        description: typeof i["Description"] === "string" ? i["Description"] : null,
        totalAmount: numOrNull(i["TotalAmount"]),
        returned: typeof i["Returned"] === "boolean" ? i["Returned"] : null,
        quantity: numOrNull(i["Quantity"]),
      };
    }),
    payments: payments.map((raw) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      return {
        type: typeof p["Type"] === "string" ? p["Type"] : null,
        amount: numOrNull(p["Amount"]),
      };
    }),
  };
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface ReturnOutcome {
  suppressed: "dry-run" | "write-guard" | null;
  /** ReturnSaleResponse.ReturnSaleID (sale.yml:4306). */
  returnSaleId: number | null;
  /** ReturnSaleResponse.Amount, "the returned amount": 0 for the sale
   *  this flow returns; anything else is logged loudly by the caller. */
  amount: number | null;
}

/**
 * `POST /sale/returnsale {SaleId, ReturnReason}` (sale.yml:2050,
 * ReturnSaleRequest 5334): "Return a comped sale ... The sale is
 * returnable only if it is a sale of a service, product or gift card and
 * it has not been used. Currently, only the comp payment method is
 * supported." That is Mindbody's own fence around Pete's rule; the
 * judge is ours in front of it. The member's id rides in the options for
 * the write guard (the payload names a sale, not a client) and is never
 * merged into the body.
 */
export async function returnSale(opts: {
  saleId: number;
  reason: string;
  memberClientId: string;
  actor: Actor | null;
}): Promise<ReturnOutcome> {
  const res = await mindbody("/sale/returnsale", {
    method: "POST",
    body: { SaleId: opts.saleId, ReturnReason: opts.reason },
    clientId: opts.memberClientId,
    ...(opts.actor ? { actor: opts.actor } : {}),
  });
  if (res?.DryRun === true) return { suppressed: "dry-run", returnSaleId: null, amount: null };
  if (res?.WriteSuppressed === true) {
    return { suppressed: "write-guard", returnSaleId: null, amount: null };
  }
  return {
    suppressed: null,
    returnSaleId: intOrNull(res?.ReturnSaleID) ?? intOrNull(res?.ReturnSaleId),
    amount: numOrNull(res?.Amount),
  };
}
