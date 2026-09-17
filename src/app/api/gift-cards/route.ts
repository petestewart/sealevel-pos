import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { currentShelfConfig } from "@/lib/catalog";
import { giftCardProducts } from "@/lib/giftcardsale";
import { visibleGiftCards } from "@/lib/shelfconfig";

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
 * T97: the shelf config's hide list is applied HERE, server-side, so a
 * preset the studio turned off in the drawer cannot be shown, or sold, by
 * a browser holding an older list (/api/checkout refuses the id too).
 * Pete: "the app should only have these preset options + the custom amount
 * one". The EDITABLE product is never hidden, whatever the config says:
 * it is the number pad's product (see `giftCardHidden`).
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
    /* Two reads: the products (cached two minutes, metered) and the shelf
     * config (local, per request, exactly as /api/catalog reads it, so a
     * hide toggled in the drawer shows on the next load rather than up to
     * two minutes later). */
    const [products, { config }] = await Promise.all([
      giftCardProducts(refresh),
      currentShelfConfig(),
    ]);
    return NextResponse.json({
      products: visibleGiftCards(products, config),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[giftcard] the site's gift card list did not read: ${error}`);
    return NextResponse.json({ products: [], error });
  }
}
