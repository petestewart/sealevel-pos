import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { parseCartLines, priceCart } from "@/lib/sale";

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
  try {
    const priced = await priceCart(parsed.items, clientId);
    return NextResponse.json(priced);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
