import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import {
  discountCents,
  discountRefusal,
  parseDiscount,
  spreadDiscount,
  subtotalCents,
  type Discount,
} from "@/lib/comp";

import {
  expectedSubtotal,
  expectedTotal,
  groupByRecipient,
  houseClientId,
  parseCartLines,
  priceCart,
  roundToCents,
  splitDiscount,
  type PricedCart,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * POST /api/price-cart  { items: CartLine[], clientId?: string,
 *                         discount?: { mode: "amount"|"percent", value } }
 *
 * T79: an optional whole-cart `discount`, validated here against the
 * lines' pre-tax subtotal (parseDiscount) and refused for a cart with a
 * package line (discountRefusal); the per-line amounts are recomputed
 * server-side by priceCart from the validated lines and never read
 * from the browser. The answer adds `expectedDiscount` and
 * `discountDisagrees`, and `disagrees` covers both checks.
 *
 * Prices a cart on Mindbody's side (Test: true, LocationId 1, InStore).
 * Moves no money by construction; see priceCart. The response carries the
 * server's totals, our local expectation, and `disagrees` -- when that is
 * true the UI must render an error, because a mismatched total means the
 * cart was priced somewhere other than the studio. `suppressed: true`
 * (prod dry run, or the write guard on an anonymous cart) means no total
 * exists and the UI must say so rather than show a number.
 *
 * Mindbody refuses to price a cart with no client at all, Test: true
 * included (confirmed live 2026-08-30: "At least one of the following
 * parameters must be passed: ClientId, UniqueClientId"). So when no
 * client is attached this route substitutes POS_HOUSE_CLIENT_ID
 * server-side (the UI still shows "nobody"), and when that is not
 * configured either it answers `needsClient: true` immediately -- no
 * Mindbody call, no metered request -- carrying only the local
 * expectedTotal for the UI to label as an estimate, never a chargeable
 * total.
 *
 * Validation lives in parseCartLines (src/lib/sale.ts), shared with
 * /api/checkout: the cart that gets charged obeys the same bounds as the
 * cart that got priced.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = parseCartLines(payload?.items);
  if (parsed.error !== null) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const clientId =
    typeof payload?.clientId === "string" && payload.clientId.trim()
      ? payload.clientId.trim()
      : undefined;
  /* T79: the discount, checked before any Mindbody call. */
  let discount: Discount | null = null;
  if (payload?.discount !== undefined && payload?.discount !== null) {
    const refusal = discountRefusal(parsed.items);
    if (refusal !== null) {
      return NextResponse.json({ error: refusal }, { status: 400 });
    }
    const d = parseDiscount(payload.discount, subtotalCents(parsed.items));
    if (typeof d === "string") {
      return NextResponse.json({ error: d }, { status: 400 });
    }
    discount = d;
  }
  /* No client attached: price as the house client when one is configured;
   * otherwise answer needsClient without touching Mindbody (the call is
   * known to fail, so firing it would cost a metered request to learn
   * nothing). */
  const effectiveClientId = clientId ?? houseClientId() ?? undefined;
  if (!effectiveClientId) {
    return NextResponse.json({
      needsClient: true,
      suppressed: false,
      subTotal: null,
      discountTotal: null,
      taxTotal: null,
      grandTotal: null,
      expectedTotal: expectedTotal(
        parsed.items,
        discount ? spreadDiscount(parsed.items, discount) : undefined,
      ),
      expectedSubtotal: expectedSubtotal(parsed.items),
      expectedDiscount: discount ? discountCents(parsed.items, discount) / 100 : 0,
      discountDisagrees: false,
      disagrees: false,
      /* Honest even here: a package's estimate is a component-sum guess
       * (see sale.ts sellablePackages), so the UI can label it. */
      packagePricing: parsed.items.some((l) => l.type === "Package"),
      usedPaymentStub: false,
    });
  }
  /* T90: a line bought for another client is its own cart under THAT
   * client's id (see groupByRecipient), so a ticket holding one is
   * priced once per recipient and the answer carries the sum plus each
   * cart's own figures. The paying client's cart is first. A ticket with
   * no other-client line takes exactly the single call it always did. */
  const groups = groupByRecipient(parsed.items);
  const perGroupDiscount =
    discount === null
      ? groups.map(() => null)
      : splitDiscount(parsed.items, discount, groups);
  try {
    if (groups.length === 1 && groups[0]?.forClientId == null) {
      const priced = await priceCart(
        parsed.items,
        effectiveClientId,
        null,
        discount,
      );
      return NextResponse.json(priced);
    }
    const carts: {
      forClientId: string | null;
      clientId: string;
      priced: PricedCart;
    }[] = [];
    for (const [i, group] of groups.entries()) {
      const cartClientId = group.forClientId ?? effectiveClientId;
      carts.push({
        forClientId: group.forClientId,
        clientId: cartClientId,
        priced: await priceCart(
          group.items,
          cartClientId,
          null,
          perGroupDiscount[i] ?? null,
        ),
      });
    }
    /* The screen's total is the sum of MINDBODY's grand totals, never a
     * browser number and never a local estimate standing in for one: one
     * cart Mindbody could not price (or a suppressed write) makes the
     * whole ticket's total absent, exactly as a single cart's does. */
    const sum = (pick: (c: PricedCart) => number | null): number | null => {
      let total = 0;
      for (const c of carts) {
        const v = pick(c.priced);
        if (v === null) return null;
        total += v;
      }
      return roundToCents(total);
    };
    const audits = carts.flatMap((c) => c.priced.lineAudit ?? []);
    return NextResponse.json({
      suppressed: carts.some((c) => c.priced.suppressed),
      subTotal: sum((c) => c.subTotal),
      discountTotal: sum((c) => c.discountTotal),
      taxTotal: sum((c) => c.taxTotal),
      grandTotal: sum((c) => c.grandTotal),
      expectedTotal: roundToCents(
        carts.reduce((n, c) => n + c.priced.expectedTotal, 0),
      ),
      expectedSubtotal: roundToCents(
        carts.reduce((n, c) => n + c.priced.expectedSubtotal, 0),
      ),
      expectedDiscount: roundToCents(
        carts.reduce((n, c) => n + c.priced.expectedDiscount, 0),
      ),
      /* Any cart disagreeing stops the whole ticket: the carts are one
       * sale to the teacher, and a stop on part of it is a stop. */
      discountDisagrees: carts.some((c) => c.priced.discountDisagrees),
      disagrees: carts.some((c) => c.priced.disagrees),
      packagePricing: carts.some((c) => c.priced.packagePricing),
      usedPaymentStub: carts.every((c) => c.priced.usedPaymentStub),
      ...(audits.length > 0 ? { lineAudit: audits } : {}),
      /* What the screen needs to name each cart: whose it is and what
       * Mindbody priced it at. */
      carts: carts.map((c) => ({
        forClientId: c.forClientId,
        clientId: c.clientId,
        grandTotal: c.priced.grandTotal,
        subTotal: c.priced.subTotal,
        expectedSubtotal: c.priced.expectedSubtotal,
        expectedDiscount: c.priced.expectedDiscount,
        suppressed: c.priced.suppressed,
        disagrees: c.priced.disagrees,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
