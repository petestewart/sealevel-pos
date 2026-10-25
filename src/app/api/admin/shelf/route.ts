import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { currentShelfConfig, rawCatalog } from "@/lib/catalog";
import {
  dbAvailable,
  dbConfigured,
  getSetting,
  setSetting,
  storageMode,
} from "@/lib/db";
import {
  editableGiftCardProduct,
  giftCardProducts,
  type GiftCardProduct,
} from "@/lib/giftcardsale";
import {
  applyShelfConfig,
  giftCardHidden,
  itemKey,
  productCategoryOverrides,
  SHELF_SETTING_KEY,
  validateShelfConfig,
  type ShelfItemType,
} from "@/lib/shelfconfig";

export const dynamic = "force-dynamic";

/**
 * Shelf admin (T74): the dev drawer's Shelf tab is the whole client.
 *
 * Guarded twice, like /api/admin/bundles: the PIN session first, then
 * the devtools gate, so this 404s on the counter iPad exactly as the
 * devlog does. GET lists the UNFILTERED catalog (every product, pass,
 * package and contract, hidden ones included, because the point is to
 * pick which to hide) from the same cached reads /api/catalog uses; the
 * only call it can add is T97's gift card read, itself cached two
 * minutes. PUT stores the whole config after the same
 * validation the catalog route applies on the way out. With no database
 * the route answers honestly (available: false, 503 on write) and the
 * shelf keeps serving the code default.
 *
 * T97: the site's GIFT CARD products are listed too, from
 * /sale/giftcards rather than the catalog, because Pete wants the same
 * hide list over them ("the app should only have these preset options +
 * the custom amount one ... what is the best way to do that so we can
 * edit what is available easily"). They are read in their own try: a site
 * with gift cards turned off must not take the whole Shelf tab with it,
 * exactly as /api/gift-cards keeps one failed read off the catalog. The
 * EDITABLE product (T96, the number pad's) is listed with no toggle, and
 * the PUT refuses a hide key naming it, in words.
 */

function gate(request: Request): NextResponse | null {
  const denied = requireSession(request);
  if (denied) return denied;
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  return null;
}

/** The slice the panel lists: kind, id, name and a display price. */
interface ShelfAdminItem {
  type: ShelfItemType;
  id: string | number;
  key: string;
  name: string;
  price: number;
  /** Where the counter files this item as the config stands ("Passes >
   *  Specials", "Retail > Food/Drink", "Rentals", "hidden", or "not on
   *  any shelf: category 27"), computed the way /api/catalog computes
   *  it, so the drawer answers "why is X not showing" without a guess
   *  (Pete, live: "2026 Annual Unlimited Special is not showing up
   *  anywhere in the UI"). */
  placement: string;
  /** T97, gift cards only: the custom amount product, which the number
   *  pad sells any amount through and which therefore has no hide
   *  toggle. Absent on every other kind. */
  editable?: boolean;
}

/** T97: one gift card product as the Shelf tab lists it. The name is the
 *  product's own description when it has one, and otherwise its value,
 *  which is how the preset chips read on the Buy screen. T97 review: the
 *  figure is the card's VALUE rather than its sale price, because the
 *  chip a teacher is deciding to turn off carries the value (T95: shown
 *  at its value, charged at its price), and the two rarely but legally
 *  differ. The editable product has neither, and the row shows none. */
function giftCardItem(
  card: GiftCardProduct,
  hidden: boolean,
): ShelfAdminItem {
  return {
    type: "GiftCard",
    id: card.id,
    key: itemKey("GiftCard", card.id),
    name: card.description ?? `$${card.cardValue.toFixed(2)} gift card`,
    price: card.editable ? 0 : card.cardValue,
    editable: card.editable,
    placement: card.editable
      ? "Cart > Gift cards: the custom amount"
      : hidden
        ? "hidden"
        : "Cart > Gift cards",
  };
}

export async function GET(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  try {
    const [{ data }, { config, shelfSource }, available, giftCards] =
      await Promise.all([
        rawCatalog(),
        currentShelfConfig(),
        dbAvailable(),
        /* T97: its own read and its own failure. A site without gift cards
         * answers this endpoint with an error, and the rest of the tab
         * still has to work. */
        giftCardProducts().then(
          (cards) => ({ cards, error: null as string | null }),
          (err: unknown) => ({
            cards: [] as GiftCardProduct[],
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ]);
    const shelf = applyShelfConfig(data, config);
    /* T86: a product the config moved is listed under its NEW category,
     * so the placement line answers "where will this land" rather than
     * "where does Mindbody file it". One reading of the overrides for the
     * shelf and for this line. */
    const moved = productCategoryOverrides(config);
    const shown = new Set<string>([
      ...shelf.products.map((p) => itemKey("Product", p.id)),
      ...shelf.passes.map((p) => itemKey("Service", p.id)),
      ...shelf.packages.map((p) => itemKey("Package", p.id)),
      ...shelf.contracts.map((c) => itemKey("Contract", c.id)),
    ]);
    const passGroup = new Map(
      shelf.passes.map((p) => [itemKey("Service", p.id), p.group]),
    );
    const categoryLabel = (categoryId: number | null): string | null => {
      const c = data.categories.find((x) => x.categoryIds.includes(categoryId ?? NaN));
      return c ? (c.section === "Rentals" ? c.label : `${c.section} > ${c.label}`) : null;
    };
    const item = (
      type: ShelfItemType,
      id: string | number,
      name: string,
      price: number,
      categoryId: number | null,
    ): ShelfAdminItem => {
      const key = itemKey(type, id);
      const placement = !shown.has(key)
        ? "hidden"
        : type === "Service"
          ? (passGroup.get(key)
              ? `Passes > ${passGroup.get(key)}`
              : (categoryLabel(categoryId) ?? "not on any shelf"))
          : type === "Package"
            ? "Passes > Packages"
            : type === "Contract"
              ? "Passes > Memberships"
              : (categoryLabel(categoryId) ??
                `not on any shelf: category ${categoryId ?? "none"}`);
      return { type, id, key, name, price, placement };
    };
    const items: ShelfAdminItem[] = [
      ...data.products.map((p) =>
        item(
          "Product",
          p.id,
          p.name,
          p.price,
          moved.get(itemKey("Product", p.id)) ?? p.categoryId,
        ),
      ),
      ...data.passes.map((p) => item("Service", p.id, p.name, p.price, p.categoryId)),
      ...data.packages.map((p) => item("Package", p.id, p.name, p.price, null)),
      /* A contract's headline is its recurring charge (what the shelf
       * card shows, T30), else the first payment. */
      ...data.contracts.map((c) =>
        item(
          "Contract",
          c.id,
          c.name,
          c.recurringPaymentTotal ?? c.firstPaymentTotal ?? 0,
          null,
        ),
      ),
      /* T97: the gift card products, in the same order the Buy screen
       * reads them (cheapest first, the editable one at the front). */
      ...giftCards.cards.map((c) => giftCardItem(c, giftCardHidden(config, c))),
    ];
    return NextResponse.json({
      storage: storageMode(),
      available,
      configured: dbConfigured(),
      config,
      shelfSource,
      items,
      /* T97: why the gift card section is empty, when it is. */
      giftCardError: giftCards.error,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function PUT(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    /* T97: which gift card product the number pad sells through, so the
     * validator can refuse a hide key naming it in words. A read that
     * fails leaves the option unset and the save goes through: the filter
     * never hides an editable product anyway (`giftCardHidden`), so the
     * pad is safe either way, and a gift card read being down is no reason
     * to refuse a change to the pass groups. */
    let editableGiftCardId: number | null = null;
    try {
      editableGiftCardId =
        editableGiftCardProduct(await giftCardProducts())?.id ?? null;
    } catch (err) {
      console.warn(
        "[shelf-config] the gift card products did not read, so a hide key " +
          `naming the custom amount product cannot be refused here: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
    const result = validateShelfConfig(body?.config ?? body, {
      editableGiftCardId,
    });
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const saved = await setSetting(SHELF_SETTING_KEY, JSON.stringify(result));
    if (!saved) {
      return NextResponse.json(
        {
          error: "no database configured; the shelf keeps its code default",
          available: false,
        },
        { status: 503 },
      );
    }
    /* Read back what landed, so the panel shows the stored truth. */
    const stored = await getSetting(SHELF_SETTING_KEY);
    return NextResponse.json({
      config: stored === null ? result : JSON.parse(stored),
      available: true,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
