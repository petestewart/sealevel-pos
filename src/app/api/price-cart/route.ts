import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import {
  expectedTotal,
  houseClientId,
  parseCartLines,
  priceCart,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * POST /api/price-cart  { items: CartLine[], clientId?: string }
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
      expectedTotal: expectedTotal(parsed.items),
      disagrees: false,
      /* Honest even here: a package's estimate is a component-sum guess
       * (see sale.ts sellablePackages), so the UI can label it. */
      packagePricing: parsed.items.some((l) => l.type === "Package"),
      usedPaymentStub: false,
    });
  }
  try {
    const priced = await priceCart(parsed.items, effectiveClientId);
    return NextResponse.json(priced);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
