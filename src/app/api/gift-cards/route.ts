import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { giftCardProducts } from "@/lib/giftcardsale";

export const dynamic = "force-dynamic";

/**
 * GET /api/gift-cards -- the gift cards this site SELLS (T95).
 *
 * The shelf's amounts: `{ products: [{ id, cardValue, salePrice,
 * description, editable }] }`, cheapest first. The FIXED products are the
 * preset chips, each sold at its own two figures. T96: an EDITABLE
 * product (`EditableByConsumer`) is in the list too, and is the one the
 * number pad sells any amount through, because Mindbody prices it from
 * the amount paid; it carries a zero value of its own and is never
 * offered as a preset.
 *
 * Deliberately NOT part of /api/catalog, although it is shelf data and it
 * is cached the same way. A site with gift cards turned off answers this
 * endpoint with an error, and one failed read must not take the whole
 * catalog with it: four reads the counter cannot work without should not
 * depend on a fifth it can. So a failure here is `{ products: [], error }`
 * with a 200, the shelf simply has no Gift card cell, and the reason is
 * in the drawer's call log and in this answer for whoever looks.
 *
 * A read, so it goes out under dry run like every other read. Nothing
 * here is the price of a sale: /api/checkout re-reads this list
 * server-side and rehearses every purchase against Mindbody before any
 * money moves.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    return NextResponse.json({ products: await giftCardProducts(refresh) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[giftcard] the site's gift card list did not read: ${error}`);
    return NextResponse.json({ products: [], error });
  }
}
