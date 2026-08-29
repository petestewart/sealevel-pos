import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { priceCart, type CartLine } from "@/lib/sale";

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
  const rawItems = payload?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return NextResponse.json(
      { error: "items (non-empty array) is required" },
      { status: 400 },
    );
  }
  const items: CartLine[] = [];
  for (const raw of rawItems) {
    const type = raw?.type;
    const metadataId = raw?.metadataId;
    const quantity = raw?.quantity;
    const price = raw?.price;
    if (
      (type !== "Product" && type !== "Service") ||
      (typeof metadataId !== "string" && typeof metadataId !== "number") ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      typeof price !== "number" ||
      !Number.isFinite(price)
    ) {
      return NextResponse.json(
        {
          error:
            "each item needs type (Product|Service), metadataId, " +
            "quantity (positive integer) and price (number)",
        },
        { status: 400 },
      );
    }
    items.push({
      type,
      metadataId,
      quantity,
      price,
      taxExempt: raw?.taxExempt === true,
    });
  }
  const clientId =
    typeof payload?.clientId === "string" && payload.clientId.trim()
      ? payload.clientId.trim()
      : undefined;
  try {
    const priced = await priceCart(items, clientId);
    return NextResponse.json(priced);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
