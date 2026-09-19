/**
 * Phase 2: the catalog, pricing and payment layer (T22 + T24, PLAN 2.1-2.3).
 *
 * T22 shipped the reads and the Test-mode pricing; T24 added the three
 * writes that move money: `checkoutCart` (a real, non-Test
 * /sale/checkoutshoppingcart), `purchaseCredit` (/sale/purchaseaccountcredit,
 * the under-$10 card path's first half) and nothing else. Every one of them
 * goes through mindbody(), so dry run and the write guard intercept them
 * exactly as they intercept a check-in, and suppression is REPORTED to the
 * caller rather than dressed as success.
 *
 * Everything is spec-verified against docs/mindbody-openapi/sale.yml:
 *
 * - GET /sale/products (sale.yml:607), filtered by `request.categoryIds`
 *   (sale.yml:636), priced for the studio via `request.locationId`
 *   (sale.yml:655: "the location ID to use to determine the tax for the
 *   products that this request returns").
 * - GET /sale/services (sale.yml:1097), the pricing options; passes are
 *   services sold via pricing options, not retail products, so the "Passes"
 *   counter category is populated from here rather than from /sale/products.
 *   `request.locationId` (sale.yml:1171) populates TaxRate/TaxIncluded.
 * - POST /sale/checkoutshoppingcart (sale.yml:1459), request shape
 *   CheckoutShoppingCartRequest (sale.yml:5632): Items (5636), Payments
 *   (5643), Test (5672), InStore (5676), CalculateTax (5680),
 *   LocationId (5692).
 *
 * Two hard rules from the design doc ("In-studio price vs online price"):
 * the screen shows `Price`, never `OnlinePrice`, and the cart is addressed
 * with `LocationId: 1` + `InStore: true` so the server prices what the
 * screen showed. Mindbody's total is the total; ours is only an assertion.
 */

import {
  discountCents,
  isFullDiscount,
  spreadDiscount,
  type Discount,
} from "./comp";
import { mindbody, type Actor } from "./mindbody";
import { plainText } from "./richtext";
import { studioWall } from "./roster";
import type { TypedCard } from "./typedcard";

/** The one physical location ("Fremont neighborhood, Seattle"). 98 is the
 *  reserved online store. A constant, not a choice; see CLAUDE.md. */
export const STUDIO_LOCATION_ID = 1;

/**
 * POS_HOUSE_CLIENT_ID: the house/walk-in client the studio creates in
 * Mindbody for anonymous counter sales. The first live sandbox run
 * (2026-08-30) proved what the spec's ClientId note (sale.yml:5656) only
 * hinted at: /sale/checkoutshoppingcart refuses a cart with no client even
 * under Test: true ("At least one of the following parameters must be
 * passed: ClientId, UniqueClientId"), so an anonymous cart can be neither
 * priced nor charged. When this is set, /api/price-cart and /api/checkout
 * substitute it server-side whenever no client is attached; the UI still
 * shows "nobody". When unset, an unattached cart shows only the local
 * estimate and cannot be charged. Creating the client is Pete's task; see
 * the T24 ticket notes.
 */
export function houseClientId(): string | null {
  const id = (process.env["POS_HOUSE_CLIENT_ID"] ?? "").trim();
  return id || null;
}

/** Fremont's sales tax at location 1 (10.35%), from the live
 *  /site/locations dump in the design doc. Since the second live test
 *  (2026-08-30) this is only the FALLBACK for a line whose catalog row
 *  carried no TaxRate: the sandbox taxes at 13%, and hardcoding 1.1035
 *  in expectedTotal made our math say $16.55 where Mindbody said $16.95
 *  on a $15 item. Each line's own TaxRate (populated because the catalog
 *  fetches carry locationId) is the authority; see expectedTotal. */
export const STUDIO_TAX_RATE = 0.1035;

/**
 * "sales tax exempt" (100000) is the one `IsSecondary: true` category at
 * this studio, referenced by `SecondaryCategoryId` on a product
 * (sale.yml:5830). It is the exception to the 10.35% invariant: an item
 * carrying it contributes untaxed. Design doc, "Categories" section.
 */
export const TAX_EXEMPT_SECONDARY_CATEGORY_ID = 100000;

/** One sellable thing, product, pricing option or package, priced for the
 *  studio. */
export interface CatalogItem {
  /**
   * The id the cart's Item.Metadata refers to. For a retail product this is
   * the barcode `Id` (sale.yml:5816); for a pricing option it is
   * `ProductId`, "the unique ID of this pricing option" (sale.yml:5226);
   * for a package it is the package `Id` (sale.yml:5954).
   * The spec does not enumerate Metadata's keys (see priceCart), so which
   * id checkout wants is a Test-call question, and both ids are kept.
   */
  id: string | number;
  /** The barcode Id, when distinct (products: same as `id`). */
  barcodeId: string | null;
  /** The numeric ProductId, when present. */
  productId: number | null;
  name: string;
  /** In-studio `Price` (sale.yml:5835 products, 5201 services).
   *  NEVER OnlinePrice. */
  price: number;
  /** Tax included in the price when inclusive pricing is on, else null.
   *  Only populated when the request carried a LocationId (sale.yml:5840). */
  taxIncluded: number | null;
  /** The location's tax rate for this item, when returned (sale.yml:5845
   *  products, 5221 services). */
  taxRate: number | null;
  /** Revenue category id: a product's own (sale.yml:5820), or for a
   *  pricing option the counter category /api/catalog routed it to by
   *  its `RevenueCategory` name (T41; the Service model carries no
   *  category id, sale.yml:5197). Null for a pass on the Passes shelf. */
  categoryId: number | null;
  /** Services only: the pricing option's `RevenueCategory` name
   *  (sale.yml:5270), the one category-shaped field the Service model
   *  has. What T41 keys "Towel and Mat" on; null for products/packages. */
  revenueCategory: string | null;
  /** SecondaryCategoryId (sale.yml:5830); 100000 means tax exempt. */
  secondaryCategoryId: number | null;
  /** True when this line must be asserted untaxed. */
  taxExempt: boolean;
  /** The CheckoutItem discriminator this maps to (sale.yml:4971; the
   *  enum there is Service, Product, Package, Tip). */
  type: "Product" | "Service" | "Package";
  /** Services only: the pricing option's initial usage count
   *  (Service.Count, sale.yml:5239 "The initial count of usages
   *  available"). What lets T25's pay dialog default to a sensible
   *  single-visit option (a drop-in is Count 1). Null for products and
   *  when Mindbody omits it. */
  count: number | null;
  /** T76, services only: the option's `Type` as the live response
   *  carries it (DropIn | Series | Unlimited on site 471, 2026-09-13;
   *  the vendored Service model does not list the field), for the
   *  pass sub-category rule. Null for products and packages. */
  serviceType: string | null;
  /** T76, services only: `IsIntroOffer` (sale.yml, the Service model),
   *  true for the new-student offers. Null when absent or not a pass. */
  isIntroOffer: boolean | null;
  /** T76, services only: the program's NAME ("Classes" live), read from
   *  `Program.Name` or a bare `Program` string, whichever the response
   *  carries (the spec lists only `ProgramId`). Null otherwise. */
  program: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Retail products for the counter's hardcoded categories.
 *
 * Query params per sale.yml: `request.categoryIds` (636), repeated per id;
 * `request.locationId` (655) so Price/TaxIncluded/TaxRate come back for the
 * studio, not the online store; `request.limit` (647, default 100). The
 * bare-name spelling (CategoryIds=) also binds -- the rest of this codebase
 * uses it against other endpoints, verified live -- but the spec's literal
 * names are used here since this call was written from the spec.
 *
 * Read-only, uncached here: /api/catalog holds the 10-minute cache, and the
 * cart total never comes from this data (priceCart is always live).
 */
export async function catalogFor(
  categoryIds: readonly number[],
): Promise<CatalogItem[]> {
  if (categoryIds.length === 0) return [];
  const query =
    categoryIds
      .map((id) => `request.categoryIds=${encodeURIComponent(id)}`)
      .join("&") +
    `&request.locationId=${STUDIO_LOCATION_ID}` +
    `&request.limit=200`;
  const body = await mindbody(`/sale/products?${query}`);
  /* The first live sandbox run returned the same product twice (a product
   * can live in more than one of the queried categories), which duplicated
   * shelf rows and React keys. De-duplicate by id, keeping the FIRST row:
   * the rows describe the same sellable thing, so any of them will do, and
   * first is deterministic. This makes the shelf key (`Product-<id>`)
   * unique by construction. */
  const seen = new Set<string | number>();
  return (body?.Products ?? [])
    .map((p: any): CatalogItem | null => {
      const barcodeId = str(p?.Id);
      const productId = num(p?.ProductId);
      const price = num(p?.Price);
      const id = barcodeId ?? productId;
      /* `price <= 0` excludes both a literal $0.00 and anything negative,
       * and num() already returns null for a missing Price rather than
       * coercing it to 0. A $0 catalog price is unsellable config, not a
       * free item; comps go through the comp path. */
      if (id === null || price === null || price <= 0) return null;
      const secondary = num(p?.SecondaryCategoryId);
      return {
        id,
        barcodeId,
        productId,
        name: str(p?.Name) ?? "Item",
        price,
        taxIncluded: num(p?.TaxIncluded),
        taxRate: num(p?.TaxRate),
        categoryId: num(p?.CategoryId),
        secondaryCategoryId: secondary,
        taxExempt: secondary === TAX_EXEMPT_SECONDARY_CATEGORY_ID,
        type: "Product",
        count: null,
        serviceType: null,
        isIntroOffer: null,
        program: null,
        revenueCategory: null,
      };
    })
    .filter((p: CatalogItem | null): p is CatalogItem => p !== null)
    .filter((p: CatalogItem) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
}

/**
 * Passes: pricing options via GET /sale/services (sale.yml:1097, "Get
 * Pricing Options Available for Purchase at a Site"). The design doc's
 * "Passes" counter entry has no category id on purpose -- passes are
 * services sold as pricing options, so they come from here wholesale.
 *
 * `request.locationId` (sale.yml:1171) makes TaxRate/TaxIncluded studio
 * numbers; it does NOT filter by location, so SellAtLocationIds
 * (sale.yml:5278) is honored here instead: an option not sold at the studio
 * must not be a button a teacher can tap. The spec says only "the location
 * IDs where this pricing option is sold" and never defines an absent or
 * empty list, so absence is read permissively (sellable) rather than as
 * "sold nowhere": a wrongly shown option fails loudly at priceCart, while
 * the strict reading could silently empty the Passes shelf at a one-location
 * studio, which is the worse failure. Discontinued options are already
 * excluded by the endpoint's default (`request.includeDiscontinued`,
 * sale.yml:1149, default false).
 */
export async function pricingOptions(): Promise<CatalogItem[]> {
  const body = await mindbody(
    `/sale/services?request.locationId=${STUDIO_LOCATION_ID}` +
      `&request.limit=200`,
  );
  /* The sandbox returns duplicate pricing-option rows sharing a ProductId
   * (the Personal Training triplicates, seen before in the design work,
   * and duplicated React keys on the first live run). ProductId is the id
   * the cart's Metadata refers to, so rows sharing one are the same
   * sellable thing; keep the FIRST and drop the rest, which also makes
   * the shelf key (`Service-<id>`) unique by construction. */
  const seen = new Set<string | number>();
  return (body?.Services ?? [])
    .filter((s: any) => {
      const sellAt: unknown = s?.SellAtLocationIds;
      return (
        !Array.isArray(sellAt) ||
        sellAt.length === 0 ||
        sellAt.includes(STUDIO_LOCATION_ID)
      );
    })
    .map((s: any): CatalogItem | null => {
      const productId = num(s?.ProductId);
      const barcodeId = str(s?.Id);
      const price = num(s?.Price);
      const id = productId ?? barcodeId;
      /* Same rule as products: a missing Price stays null (never coerced
       * to 0) and excludes the row, and a $0 or negative catalog price is
       * unsellable config, not a free pass; comps go through the comp
       * path. */
      if (id === null || price === null || price <= 0) return null;
      return {
        id,
        barcodeId,
        productId,
        name: str(s?.Name) ?? "Pass",
        price,
        taxIncluded: num(s?.TaxIncluded),
        taxRate: num(s?.TaxRate),
        categoryId: null,
        secondaryCategoryId: null,
        /* Services carry no SecondaryCategoryId in the spec's Service model
         * (sale.yml:5197), so no pass is tax exempt as far as we can tell;
         * the server total is still the authority if that is ever wrong. */
        taxExempt: false,
        type: "Service",
        count: num(s?.Count),
        revenueCategory: str(s?.RevenueCategory),
        serviceType: str(s?.Type),
        isIntroOffer: typeof s?.IsIntroOffer === "boolean" ? s.IsIntroOffer : null,
        program: str(s?.Program?.Name) ?? str(s?.Program),
      };
    })
    .filter((s: CatalogItem | null): s is CatalogItem => s !== null)
    .filter((s: CatalogItem) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
}

/**
 * T63: the studio's "Guest Pass (for auto-debit members only)" pricing
 * option, the $0 one-session pass the front desk sells a GUEST before
 * booking them (Pete's screens, 2026-09-04). The same GET /sale/services
 * read as pricingOptions (sale.yml:1097, locationId 1 for studio
 * pricing, SellAtLocationIds honoured the same permissive way), but its
 * own function: pricingOptions drops every $0 option on purpose (a $0
 * shelf price is unsellable config, not a free pass), and the Guest
 * Pass is exactly that, so it never reaches the Buy screen and nothing
 * there changes. Found by name (isGuestPass), never by a hardcoded id:
 * site 471's is ProductId 462, and the sandbox's is whatever it is.
 * Null when the catalog holds none. Uncached: a guest check-in is a
 * handful of times a day, and the price it returns is only the local
 * estimate for the rehearsal, which prices the cart live.
 */
export async function guestPassOption(
  isGuestPassName: (name: string) => boolean,
): Promise<{
  productId: number;
  name: string;
  price: number;
  taxRate: number | null;
} | null> {
  const body = await mindbody(
    `/sale/services?request.locationId=${STUDIO_LOCATION_ID}` +
      `&request.limit=200`,
  );
  for (const s of (body?.Services ?? []) as any[]) {
    const name = str(s?.Name);
    const productId = num(s?.ProductId);
    if (name === null || productId === null || !isGuestPassName(name)) continue;
    const sellAt: unknown = s?.SellAtLocationIds;
    if (
      Array.isArray(sellAt) &&
      sellAt.length > 0 &&
      !sellAt.includes(STUDIO_LOCATION_ID)
    ) {
      continue;
    }
    return { productId, name, price: num(s?.Price) ?? 0, taxRate: num(s?.TaxRate) };
  }
  return null;
}

/**
 * T30: packages, via GET /sale/packages (sale.yml:506). "A package is
 * typically used to combine multiple services and/or products into a
 * single offering" (sale.yml:511). Packages ARE cart items -- the
 * CheckoutItem Type enum includes `Package` (sale.yml:4971), and
 * CheckoutItemWrapper.DiscountAmount is "ignored for packages"
 * (sale.yml:3627), which only makes sense for something that rides the
 * cart. NOTE for any future promo work: because of that line, a promo
 * that discounts cart lines must SKIP package lines (promos are not
 * built yet; recorded here so they are not built wrong).
 *
 * `request.locationId` (sale.yml:546: "the location ID to use to
 * determine the tax", default **online store**) is passed as 1 so
 * component pricing is the studio's; `request.sellOnline` is left at its
 * default false (sale.yml:570), which returns ALL packages -- this is a
 * staff counter, not the online store.
 *
 * The Package model (sale.yml:5950) carries NO price, tax rate or
 * tax-included field of its own: only Id (5954), Name (5959),
 * DiscountPercentage (5963), SellOnline (5969), Services (5974) and
 * Products (5980). The shelf price here is therefore a LOCAL estimate --
 * the sum of the component in-studio Prices with DiscountPercentage
 * (read as 0-100) taken off -- and is display-only, like every shelf
 * price. More importantly, a package may bundle taxed and untaxed
 * components and the row exposes no usable per-package tax info, so our
 * per-line tax assertion has no basis for a package line: priceCart
 * EXCLUDES package-bearing carts from the strict `disagrees` assertion
 * and reports `packagePricing: true` instead, which the UI renders as a
 * quiet "priced by Mindbody" line. The server's total remains the only
 * number charged, exactly as everywhere else.
 */
export async function sellablePackages(): Promise<CatalogItem[]> {
  const body = await mindbody(
    `/sale/packages?request.locationId=${STUDIO_LOCATION_ID}` +
      `&request.limit=200`,
  );
  const seen = new Set<string | number>();
  return (body?.Packages ?? [])
    .map((p: any): CatalogItem | null => {
      const id = num(p?.Id);
      if (id === null) return null;
      /* The local shelf estimate: component prices summed, the package's
       * DiscountPercentage off. The percentage's scale is not stated in
       * the spec (the example is "1.0"); 0-100 is the reading that
       * matches Mindbody's own UI, clamped so a bad value cannot go
       * negative. If the estimate is ever wrong the cart still shows the
       * server's total (packagePricing carve-out above). */
      const components = [
        ...(Array.isArray(p?.Services) ? p.Services : []),
        ...(Array.isArray(p?.Products) ? p.Products : []),
      ];
      const sum = components.reduce(
        (n: number, c: any) => n + (num(c?.Price) ?? 0),
        0,
      );
      const discountPct = Math.min(Math.max(num(p?.DiscountPercentage) ?? 0, 0), 100);
      const price = roundToCents(sum * (1 - discountPct / 100));
      /* Same rule as products: a $0 or negative package is unsellable
       * config, not a free bundle. */
      if (price <= 0) return null;
      return {
        id,
        barcodeId: null,
        productId: null,
        name: str(p?.Name) ?? "Package",
        price,
        taxIncluded: null,
        taxRate: null,
        categoryId: null,
        secondaryCategoryId: null,
        taxExempt: false,
        type: "Package",
        count: null,
        serviceType: null,
        isIntroOffer: null,
        program: null,
        revenueCategory: null,
      };
    })
    .filter((p: CatalogItem | null): p is CatalogItem => p !== null)
    .filter((p: CatalogItem) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
}

/** The most of one item a counter cart can hold. A teacher selling more
 *  than this of anything has mistyped, and an absurd quantity times a real
 *  price is exactly the number nobody should ever see on a Charge button. */
export const MAX_LINE_QUANTITY = 99;

/** One line of a cart to be priced. The caller (the sale screen) builds
 *  these from CatalogItems; price/taxExempt ride along ONLY to feed the
 *  local assertion and are never sent to Mindbody. */
export interface CartLine {
  type: "Product" | "Service" | "Package";
  /** Goes into Item.Metadata.Id; CatalogItem.id. */
  metadataId: string | number;
  quantity: number;
  /** In-studio unit price, for expectedTotal only. Never sent. */
  price: number;
  /** From CatalogItem.taxExempt. */
  taxExempt: boolean;
  /** From CatalogItem.taxRate: the item's own tax rate at the studio,
   *  for expectedTotal only. Never sent. Null when Mindbody omitted it,
   *  in which case expectedTotal falls back to STUDIO_TAX_RATE. */
  taxRate: number | null;
  /**
   * T90 (Pete: "a client can purchase something for another client
   * (like a membership, pass, etc.)"): the client this ONE line is
   * bought for, when it is not the client paying. Mindbody's
   * checkoutshoppingcart carries ONE ClientId for the whole cart and no
   * per-item recipient, and PayerClientId needs a stored "Pays for"
   * relationship (sale.yml:5663, which T63 established is not usable at
   * a counter), so a ticket with lines for other people is checked out
   * as one cart PER recipient (groupByRecipient below), each addressed
   * with that recipient's id so the pass lands on their account. Null
   * or absent means the line is the paying client's own.
   */
  forClientId?: string | null;
}

/**
 * One line, as BOTH sides priced it. Built only when a cart disagrees
 * (Pete, fifth live test: our math said $130.20 against Mindbody's
 * $258.85, and the disagree block could not say which line was wrong,
 * which left the studio with a correct refusal and no way to fix it).
 * Diagnostic only: nothing here is ever charged, and it exists solely so
 * the screen can name the line whose price or tax rate diverged.
 */
export interface LineAudit {
  /** Mindbody's name for the matched item, when it returned one. */
  name: string | null;
  type: CartLine["type"];
  metadataId: string;
  quantity: number;
  /** What the browser's catalog said, and what we asserted from it. */
  ourPrice: number;
  ourTaxRate: number | null;
  ourExtended: number;
  /** What Mindbody's own cart says. Null when no line matched, which is
   *  itself the answer: the item we sent is not the item it priced. */
  theirPrice: number | null;
  theirTaxRate: number | null;
  theirQuantity: number | null;
}

/** Round half-up to cents. The epsilon absorbs float dust like
 *  2.9999999999999996 from 2.72 * 1.1035 so .995-style boundaries land on
 *  the cent the arithmetic means. */
/**
 * Mindbody's refusal as a sentence a teacher can read: the internal
 * "mb.Core.BLL.ShoppingCart failed validation" prefix (and any other
 * dotted mb.* class name at the front) is dropped, the rest kept as
 * Mindbody wrote it, with a full stop. Empty in, a generic line out.
 */
export function plainRefusal(message: string): string {
  const cleaned = message
    .replace(/^\s*(mb\.[A-Za-z0-9_.]+\s+failed validation[:\s]*)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Mindbody did not accept it.";
  return /[.!?]$/.test(cleaned) ? cleaned : cleaned + ".";
}

export function roundToCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * What the studio's tax arithmetic says this cart costs: each line's
 * extended price taxed at that LINE's own rate, with tax-exempt lines
 * contributing untaxed, rounded half-up to cents. This is an ASSERTION
 * against the server's total, never a price we charge or display as
 * authoritative.
 *
 * Per-line TaxRate is the authority, found the expensive way (second
 * live test, 2026-08-30): the sandbox taxes at 13%, not Fremont's
 * 10.35%, and the hardcoded 1.1035 this replaced said $16.55 where
 * Mindbody said $16.95 on a $15 item. The catalog already maps
 * TaxIncluded/TaxRate per item (the T22 fetches carry locationId, which
 * is what populates them, products and services both), so only a line
 * with NO rate at all falls back to the studio constant -- and that
 * fallback is Fremont's rate, wrong by construction anywhere else.
 *
 * Rounding model: ONE round, of the whole cart's tax, at the end. Whether
 * Mindbody instead rounds tax per line (or per unit) is not stated anywhere
 * in the vendored spec; with the studio's real price points the models only
 * diverge by a cent on multi-line carts with fractional-cent line tax, and
 * when they do the mismatch surfaces as a loud `disagrees` error rather
 * than a wrong charge (Mindbody's total is always the one charged). If the
 * first sandbox runs show cent-level disagreement on multi-line carts,
 * change THIS model to match the observed one; never widen totalsDisagree
 * into a tolerance.
 */
export function expectedTotal(
  items: readonly CartLine[],
  /** T79: the per-line discount in CENTS (spreadDiscount), when the cart
   *  carries one; the estimate taxes each line's discounted price. */
  discount?: readonly number[],
): number {
  let total = 0;
  items.forEach((line, i) => {
    const extended =
      line.price * line.quantity - (discount?.[i] ?? 0) / 100;
    /* The exempt category still contributes untaxed; otherwise the
     * line's own rate, falling back to Fremont's 10.35% (STUDIO_TAX_RATE)
     * ONLY when the catalog carried no rate for this line. */
    const rate = line.taxExempt ? 0 : (line.taxRate ?? STUDIO_TAX_RATE);
    total += Math.max(0, extended) * (1 + rate);
  });
  return roundToCents(total);
}

/**
 * T75: what the shelf says the cart costs BEFORE tax, each line's price
 * times its quantity. This is the figure the disagree assertion compares
 * now, against Mindbody's SubTotal. Tax left the assertion on the first
 * live retail sale (2026-09-13): every product record on site 471 carries
 * TaxRate 0.1055 while the checkout taxes at 10.35%, so the tax arithmetic
 * above said $3.00 where Mindbody said $2.99 on a $2.71 drink and the
 * stop refused every retail sale. Pete: "why are we hanging on to our
 * estimate? Today we do all sales thru mindbody so the mindbody amount
 * is the right amount." Mindbody's tax is Mindbody's; what the assertion
 * is FOR is catching a cart priced somewhere other than the studio
 * (wrong LocationId or InStore prices online items differently: the 10
 * Class Pack is $230 in studio and $260 online), and that shows in the
 * pre-tax figure. expectedTotal above stays as the labelled estimate for
 * the states with no server total.
 */
export function expectedSubtotal(items: readonly CartLine[]): number {
  let total = 0;
  for (const line of items) total += line.price * line.quantity;
  return roundToCents(total);
}

/* =====================================================================
 * T90: one ticket, one cart per recipient.
 *
 * v6 checkoutshoppingcart takes ONE ClientId (sale.yml:5654) and no
 * per-item recipient, so a line bought for somebody else cannot ride the
 * payer's cart: it is its own cart, addressed with the recipient's id,
 * which is how Mindbody's own web app files a "Drop In (For: ALISON
 * STEWART)" line. The screen still shows one ticket and one total; the
 * route runs the carts sequentially and reports each one's outcome.
 * =================================================================== */

/** One recipient's share of a ticket, in the ticket's line order. */
export interface CartGroup {
  /** The recipient, or null for the paying client's own lines. */
  forClientId: string | null;
  items: CartLine[];
}

/**
 * Split a ticket into one group per recipient. The paying client's own
 * lines come FIRST (that is the only cart a stored card or an account
 * balance could ever pay, and the route charges it first), then each
 * other client in the order their first line appears, so the sequence a
 * partial failure reports matches the order the teacher rang up.
 *
 * `payerId` folds a line bought "for" the client who is paying back into
 * their own cart. The screen does that too (picking the attached client
 * clears the line's recipient), but the rule belongs here as well: the
 * same client in two carts would be two Mindbody sales for one person
 * and, worse, would turn off their own card on file for no reason. T90
 * review: reachable without the screen, and once attached late by
 * anybody who bypasses it.
 */
export function groupByRecipient(
  items: readonly CartLine[],
  payerId?: string | null,
): CartGroup[] {
  const groups: CartGroup[] = [];
  const at = new Map<string, CartGroup>();
  const own: CartGroup = { forClientId: null, items: [] };
  for (const line of items) {
    const raw = line.forClientId ?? null;
    const id = raw !== null && payerId && raw === payerId ? null : raw;
    if (id === null) {
      own.items.push(line);
      continue;
    }
    let group = at.get(id);
    if (!group) {
      group = { forClientId: id, items: [] };
      at.set(id, group);
      groups.push(group);
    }
    group.items.push(line);
  }
  return own.items.length > 0 ? [own, ...groups] : groups;
}

/**
 * T92 (Pete: "A walk-in should not be able to buy passes, only retail
 * items. if they want to buy a pass for another client, that is allowed.
 * if they want to buy for themselves they must register a mindbody
 * account"): a pass has to land on somebody's Mindbody account, and the
 * house client is not that somebody. So on a cart with NO attached
 * client, a Service or a Package line must carry a T90 recipient; a
 * Product line may ride the house client as it always has. Returns the
 * refusal in words, or null when the ticket is sound.
 *
 * `clientId` is the ATTACHED client only, never the house client
 * substituted for an anonymous cart: falling back to the house client
 * for a pass is exactly what this refuses, because the pass would be
 * sold onto a walk-in placeholder account nobody can use.
 */
export function passWithoutOwner(
  items: readonly CartLine[],
  clientId?: string | null,
): string | null {
  if (clientId) return null;
  const orphan = items.find(
    (line) =>
      (line.type === "Service" || line.type === "Package") &&
      !(line.forClientId ?? null),
  );
  if (!orphan) return null;
  return (
    "A pass on a walk-in sale needs a client. Attach a client, register " +
    "a new one, or buy the pass for another client. Nothing was charged."
  );
}

/**
 * The armed discount, divided between the groups so the parts sum to the
 * whole to the CENT. The whole ticket's spread is computed once
 * (spreadDiscount, the same function each cart's own spread then runs),
 * each group takes the sum of its lines' cents, and that sum rides as an
 * `amount` discount for that cart: re-spread inside the cart it sums back
 * to exactly the cents handed to it, because a proportional share can
 * never exceed its own line. A group whose share rounds to nothing gets
 * no discount at all rather than a zero one.
 *
 * The caller still checks each cart's expected discount against
 * Mindbody's DiscountTotal, and the sum of the carts against the armed
 * figure, before any money moves.
 */
export function splitDiscount(
  items: readonly CartLine[],
  discount: Discount,
  groups: readonly CartGroup[],
): (Discount | null)[] {
  const spread = spreadDiscount(items, discount);
  const cents = new Map<CartLine, number>();
  items.forEach((line, i) => cents.set(line, spread[i] ?? 0));
  return groups.map((group) => {
    const sum = group.items.reduce((n, line) => n + (cents.get(line) ?? 0), 0);
    return sum > 0 ? { mode: "amount" as const, value: sum / 100 } : null;
  });
}

/**
 * Strict disagreement after rounding to cents. True means the cart was
 * priced somewhere other than the studio (wrong LocationId, wrong InStore)
 * or our catalog data is stale, and the CALLER must render it as an error.
 * Never swallow a true return; PLAN 2.1 and the design doc are explicit
 * that a mismatch is a bug to surface.
 */
export function totalsDisagree(expected: number, serverTotal: number): boolean {
  return roundToCents(expected) !== roundToCents(serverTotal);
}

/** The server's pricing of a cart, plus our assertion against it. */
export interface PricedCart {
  /**
   * True when the POST never reached Mindbody (dry run or the write guard).
   * `Test: true` moves no money, but our wrapper counts every POST outside
   * /usertoken as a write, so in prod dry-run mode this call is suppressed
   * too. That costs nothing but a priced total: the UI must render
   * "pricing unavailable in dry run" gracefully, never a fake total.
   */
  suppressed: boolean;
  subTotal: number | null;
  discountTotal: number | null;
  taxTotal: number | null;
  /** The total. Mindbody's number, the only one that may be charged. */
  grandTotal: number | null;
  /** Our local estimate with tax, always computed; a labelled estimate
   *  for the states with no server total, never the assertion (T75). */
  expectedTotal: number;
  /** T75: the shelf's pre-tax sum, what `disagrees` compares. */
  expectedSubtotal: number;
  /** T79: the server-side spread's sum in dollars (0 with no discount),
   *  what `discountDisagrees` compares to Mindbody's DiscountTotal. */
  expectedDiscount: number;
  /** T79: totalsDisagree(expectedDiscount, DiscountTotal), strict to the
   *  cent, only when a discount was sent. Folded into `disagrees` too,
   *  so every existing guard on that flag holds; this one says which
   *  figure the stop should name. */
  discountDisagrees: boolean;
  /** totalsDisagree(expectedSubtotal, Mindbody's pre-tax figure): its
   *  SubTotal, or GrandTotal less TaxTotal when SubTotal is absent.
   *  False while suppressed, false when Mindbody sent no pre-tax figure
   *  to compare, and false BY CONSTRUCTION for a package-bearing cart
   *  (see packagePricing). Tax is never part of it since T75. */
  disagrees: boolean;
  /**
   * T30 carve-out: true when the cart held a Package line. The Package
   * model (sale.yml:5950) exposes no price or tax fields for the package
   * itself, and a package may bundle taxed and untaxed components, so
   * our per-line tax assertion has no basis and `disagrees` is not
   * computed for these carts. The UI renders the server's total as
   * authoritative with a quiet "priced by Mindbody" line instead of the
   * loud disagree block. Never widen this into a general tolerance:
   * package-free carts keep the strict assertion unchanged.
   */
  packagePricing: boolean;
  /**
   * Per-line comparison, present ONLY when `disagrees` is true. The
   * refusal is right either way; this is what makes it fixable, by
   * naming the line whose price or tax rate the two sides read
   * differently. Never used for pricing or charging.
   */
  lineAudit?: LineAudit[];
  /**
   * True when the Comp payment stub is what priced the cart. CONFIRMED
   * TRUE on the first live sandbox run (2026-08-30): Test-mode checkout
   * on this site demands a Payments array, so the stub is now the first
   * attempt and the Comp permission is a hard requirement. False only
   * when the stub was refused and the bare no-Payments fallback priced
   * the cart instead (kept in case other sites differ).
   */
  usedPaymentStub: boolean;
}

/**
 * Price a cart on Mindbody's side: POST /sale/checkoutshoppingcart with
 * `Test: true` (sale.yml:5672: "use this parameter during testing and when
 * checking the calculated totals of the items in the cart"), addressed to
 * the studio with `LocationId: 1` (5692) and `InStore: true` (5676).
 *
 * Item shape, per CheckoutItemWrapper (sale.yml:3613) wrapping CheckoutItem
 * (4967): `{ Item: { Type, Metadata }, Quantity }`. The spec types Metadata
 * as a string (4975) but that is a generation artifact; the live API takes
 * an object, and the enumerated-elsewhere key for an ordinary purchase is
 * the item id. The key set is officially behind a login-walled docs page
 * (the design doc's standing warning), so if Mindbody ever rejects
 * `{ Id }`, answer with a Test call, not by reading the spec harder.
 *
 * Payments: CheckoutShoppingCartRequest declares NO required properties at
 * all (sale.yml:5632-5735 carries no `required:` list), but the first live
 * sandbox run (2026-08-30) settled what the schema could not: Test-mode
 * checkout on this site refuses a cart with no Payments array, and the
 * `Comp` stub -- the only documented payment type whose Metadata needs
 * nothing but an amount (sale.yml:3934, "Comp Keys - amount"), and which
 * could move no money even if Test were ignored -- is what prices it. So
 * the stub goes FIRST now, with a bare no-Payments retry kept as the
 * fallback for a site that differs. `usedPaymentStub` reports which shape
 * worked; the Comp permission is a hard requirement of pricing here.
 *
 * `clientId` rides mindbody()'s options for the POS_WRITE_CLIENT_IDS guard
 * and, when present, goes in the body as ClientId (sale.yml:5654) since
 * client attachment can change pricing (memberships, contracts later).
 * A cart with no client at all cannot be priced: the live API refuses it
 * ("At least one of the following parameters must be passed: ClientId,
 * UniqueClientId") even under Test: true, which is why /api/price-cart
 * substitutes houseClientId() for an unattached cart and answers
 * `needsClient` instead of calling here when none is configured.
 */
/** Shared cart validation: T22's rules, needed identically by the Test
 *  pricing call and T24's real checkout. Throws on a bad cart. */
function assertCartLines(items: readonly CartLine[], caller: string): void {
  if (items.length === 0) {
    throw new Error(`${caller} needs at least one item.`);
  }
  for (const line of items) {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > MAX_LINE_QUANTITY
    ) {
      throw new Error(
        `Every cart line needs a whole quantity from 1 to ${MAX_LINE_QUANTITY}.`,
      );
    }
  }
}

/** The CheckoutShoppingCartRequest Items array (sale.yml:5636), per
 *  CheckoutItemWrapper (3613) wrapping CheckoutItem (4967). */
/** T79: `discount` is the per-line discount in CENTS (spreadDiscount),
 *  sent as CheckoutItemWrapper.DiscountAmount (sale.yml:3624, "the
 *  amount the item is discounted", in dollars) on each line that has
 *  one. Whether Mindbody reads it per line or per unit is not stated;
 *  it is sent per LINE (the extended price's share), and the strict
 *  DiscountTotal check in priceCart is what catches the other reading
 *  as a stop rather than a wrong charge. */
function cartItemsPayload(
  items: readonly CartLine[],
  discount?: readonly number[],
): unknown[] {
  return items.map((line, i) => {
    const off = discount?.[i] ?? 0;
    return {
      Item: {
        Type: line.type,
        Metadata: { Id: line.metadataId },
      },
      Quantity: line.quantity,
      ...(off > 0 ? { DiscountAmount: off / 100 } : {}),
    };
  });
}

export async function priceCart(
  items: readonly CartLine[],
  clientId?: string,
  /** T49: run the Test call as this teacher. Only the sign-in probe
   *  passes one (to prove MakeSales under the teacher's own token); the
   *  checkout rehearsal stays on the service account. */
  actor?: Actor | null,
  /** T79: the whole-cart discount, validated by the route
   *  (parseDiscount); spread over the lines HERE, never taken from the
   *  browser, and sent as DiscountAmount per line. */
  discount?: Discount | null,
): Promise<PricedCart> {
  assertCartLines(items, "priceCart");
  const spread = discount ? spreadDiscount(items, discount) : undefined;
  const expected = expectedTotal(items, spread);
  const expectedSub = expectedSubtotal(items);
  const expectedDisc = discount ? discountCents(items, discount) / 100 : 0;
  /* T30: a package line has no tax basis of its own (see PricedCart
   * .packagePricing), so the strict assertion is skipped for the whole
   * cart. NOTE for the sandbox probe: the Comp stub's Amount below is
   * our local estimate, and for a package cart that estimate is the
   * component-sum guess -- if Test-mode checkout enforces
   * payments-equal-total, a wrong guess fails the pricing call loudly
   * instead of returning a total. The first sandbox package pricing
   * tells us whether that rule bites; it is on the T30 probe list. */
  const packagePricing = items.some((line) => line.type === "Package");
  const baseBody: Record<string, unknown> = {
    Items: cartItemsPayload(items, spread),
    ...(clientId ? { ClientId: clientId } : {}),
    Test: true,
    LocationId: STUDIO_LOCATION_ID,
    InStore: true,
    CalculateTax: true,
  };

  /* STUB FIRST, since the first live sandbox run (2026-08-30):
   * usedPaymentStub came back TRUE -- Test-mode carts on this site DO
   * require a Payments array, and the Comp stub is what prices them. The
   * order this replaced (no-Payments first, stub on a payment-shaped
   * refusal) burned a doomed metered call on every single pricing, so the
   * stub is now the first attempt. The no-stub fallback below is kept in
   * case other sites differ: if the stub itself is refused (a site
   * without the Comp permission, say), ONE retry goes out with no
   * Payments at all.
   *
   * The stub's Amount is our expectation, the only number in hand before
   * the server has priced anything. If the server's total differs (the
   * exact condition `disagrees` exists for), a payments-must-equal-total
   * rule would reject the stubbed call -- which still fails loudly, just
   * as a thrown error instead of a disagrees flag. PascalCase Amount is
   * the casing the live run accepted. */
  let usedPaymentStub = true;
  let res: any;
  try {
    res = await mindbody("/sale/checkoutshoppingcart", {
      method: "POST",
      body: {
        ...baseBody,
        Payments: [{ Type: "Comp", Metadata: { Amount: expected } }],
      },
      ...(clientId ? { clientId } : {}),
      ...(actor ? { actor } : {}),
    });
  } catch (err) {
    /* Retry bare ONLY when the refusal looks aimed at the stub itself
     * (a site without the Comp permission, or one that rejects the
     * payment shape): mentions of payment, Comp, or permission. Any
     * other error -- a bad item, a missing client -- is the CART's
     * problem; retrying it without Payments would burn a second metered
     * call to fail again, and on this site (where the bare shape is
     * known-refused) would MASK the real error with a payments-required
     * one. Rethrown, the stub attempt's error names the actual problem. */
    const message = err instanceof Error ? err.message : String(err);
    /* \bcomp\b, not bare "comp": "complete a sale" is Mindbody's own
     * wording for a CLIENT error and must not read as a Comp refusal. */
    if (!/payment|\bcomp\b|permission/i.test(message)) throw err;
    /* The Comp stub was refused; maybe this site prices without
     * Payments. One retry, bare. If this fails too, ITS error is the
     * one thrown: with no payment noise in the request, it names the
     * cart's actual problem. */
    usedPaymentStub = false;
    res = await mindbody("/sale/checkoutshoppingcart", {
      method: "POST",
      body: baseBody,
      ...(clientId ? { clientId } : {}),
      ...(actor ? { actor } : {}),
    });
  }

  /* Dry run / write guard answered instead of Mindbody. No totals exist;
   * the UI must say so rather than invent a number. */
  if (res?.DryRun === true || res?.WriteSuppressed === true) {
    return {
      suppressed: true,
      subTotal: null,
      discountTotal: null,
      taxTotal: null,
      grandTotal: null,
      expectedTotal: expected,
      expectedSubtotal: expectedSub,
      expectedDiscount: expectedDisc,
      discountDisagrees: false,
      disagrees: false,
      packagePricing,
      usedPaymentStub,
    };
  }

  /* Totals live on ShoppingCart (sale.yml:4020 SubTotal, 4025
   * DiscountTotal, 4030 TaxTotal, 4035 GrandTotal). */
  const cart = res?.ShoppingCart ?? {};
  const grandTotal = num(cart?.GrandTotal);
  if (grandTotal === null) {
    throw new Error(
      "Mindbody accepted the pricing request but returned no GrandTotal.",
    );
  }
  const subTotal = num(cart?.SubTotal);
  const taxTotal = num(cart?.TaxTotal);
  /* T75: the pre-tax figure Mindbody priced, SubTotal first, else the
   * grand total less its tax. Neither present, nothing to assert. */
  const theirSubtotal =
    subTotal ?? (taxTotal !== null ? roundToCents(grandTotal - taxTotal) : null);
  const subDisagrees =
    packagePricing || theirSubtotal === null
      ? false
      : totalsDisagree(expectedSub, theirSubtotal);
  const discountTotal = num(cart?.DiscountTotal);
  /* T79: with a discount sent, Mindbody's DiscountTotal must be our
   * spread's sum to the cent (a missing DiscountTotal reads as 0, so a
   * discount Mindbody dropped is a stop, never a full-price charge that
   * the screen said was discounted). The same strictness as the
   * subtotal: never a tolerance. No discount sent, nothing asserted. */
  const discountDisagrees =
    discount !== undefined && discount !== null
      ? totalsDisagree(expectedDisc, discountTotal ?? 0)
      : false;
  const disagrees = subDisagrees || discountDisagrees;
  return {
    suppressed: false,
    subTotal,
    discountTotal,
    taxTotal,
    grandTotal,
    expectedTotal: expected,
    expectedSubtotal: expectedSub,
    expectedDiscount: expectedDisc,
    ...(disagrees ? { lineAudit: auditLines(items, cart) } : {}),
    /* The T30 carve-out: a package-bearing cart is excluded from the
     * strict assertion (no tax basis for a package line); every other
     * cart keeps it verbatim. */
    disagrees,
    discountDisagrees,
    packagePricing,
    usedPaymentStub,
  };
}

/**
 * Pair our cart lines with Mindbody's priced ones for the disagree block.
 * A Service line carries the ProductId and a Product line the barcode Id,
 * and Mindbody's CartItem exposes both, so either may match. No match at
 * all is left null deliberately: "Mindbody priced something else" is the
 * most useful finding this can report.
 */
function auditLines(items: readonly CartLine[], cart: any): LineAudit[] {
  const theirs: any[] = Array.isArray(cart?.CartItems) ? cart.CartItems : [];
  return items.map((line) => {
    const id = String(line.metadataId);
    const match = theirs.find(
      (t) =>
        String(t?.Item?.Id ?? "") === id ||
        String(t?.Item?.ProductId ?? "") === id,
    );
    return {
      name: typeof match?.Item?.Name === "string" ? match.Item.Name : null,
      type: line.type,
      metadataId: id,
      quantity: line.quantity,
      ourPrice: line.price,
      ourTaxRate: line.taxExempt ? 0 : line.taxRate,
      /* T75: before tax, like the assertion. */
      ourExtended: roundToCents(line.price * line.quantity),
      theirPrice: num(match?.Item?.Price),
      theirTaxRate: num(match?.Item?.TaxRate),
      theirQuantity: num(match?.Quantity),
    };
  });
}

/* =====================================================================
 * T103: a payment with no purchased items is not a sale.
 *
 * Found on 2026-09-17, chasing whether a gift card can be discounted. A
 * gift card product as a cart line priced, took a discount and took a
 * comp payment, and both resulting sales held `PurchasedItems: []`: the
 * cart sold nothing and answered like a sale. Nothing here noticed,
 * because until this block nothing here LOOKED: the checkout path read
 * the answer's totals and its sale id and never asked what the sale
 * holds. A pass is caught indirectly (T25 re-reads
 * /client/clientservices and matches by ProductId) and a contract is
 * its own endpoint; a retail product was not caught at all.
 *
 * So the same rail as T75's total assertion, one level further on: what
 * came back is compared against what was sent, line for line, by the id
 * that was sent and the quantity, and an answer that does not hold the
 * ticket is REFUSED. This one cannot un-take the payment, which is
 * exactly why it is loud: by the time it can run, Mindbody has the
 * money (see /api/checkout's soldNothingAnswer).
 * =================================================================== */

/**
 * One ordered line, as both sides hold it: T75's per-line audit idiom,
 * because a refusal that cannot name the line is a correct refusal
 * nobody can act on. Diagnostic only; nothing here is ever charged.
 */
export interface BasketAudit {
  type: CartLine["type"];
  metadataId: string;
  /** Mindbody's own name for the matched item, when the sale gave one. */
  name: string | null;
  /** What the ticket ordered. */
  orderedQuantity: number;
  /**
   * What the sale says it holds of this line: the matched purchased
   * items' quantities summed, counting an item with no Quantity as one
   * (PurchasedItem.Quantity is documented "applicable for products
   * only", sale.yml:2348). Null when NOTHING in the basket matched the
   * id that was sent, which is itself the finding.
   */
  soldQuantity: number | null;
  /**
   * T103 review: did Mindbody actually REPORT a quantity for this line?
   * False when every matched item came back without a `Quantity`, which
   * is the documented shape for a pricing option ("applicable for
   * products only"). Then `soldQuantity` counts the matched items and is
   * never read as short: a line of two answered by one item with no
   * quantity at all is Mindbody saying nothing about how many, and a
   * refusal has to rest on what it said.
   */
  quantityReported: boolean;
}

/** What the basket assertion decided. */
export interface BasketVerdict {
  ok: boolean;
  /**
   * What is wrong, in a teacher's words, naming the lines. Null when
   * ok. It says nothing about the money: the caller knows whether the
   * payment was taken and owns that sentence.
   */
  problem: string | null;
  audit: BasketAudit[];
  /**
   * Ids the basket holds that this ticket never ordered. Recorded, never
   * a refusal on its own (T103 review): Mindbody puts its own lines in a
   * sale (a tax line, a fee, a bundled component of a package), and an
   * extra line is not evidence that the ordered ones were missed.
   */
  unordered: string[];
  /**
   * T103 review: why this answer carries no assertable basket, or null
   * when it was asserted. `ok` is true in both cases and nothing is
   * refused; the caller logs it so it is visible to us and to nobody at
   * the counter.
   *
   * - `package`: the ticket held a Package line. A package bundles
   *   services and products into one offering, and `PurchasedItem` has
   *   no package field at all (sale.yml:2302): a package sale can only
   *   come back as its components, whose ids are nowhere in the ticket.
   *   Asserting it would refuse every package sale, so the whole cart is
   *   carved out exactly as T30 carves it out of the total assertion.
   * - `mismatch`: the SALE that was read holds items and none of them
   *   answers to this ticket at all. That is what a mis-identified sale
   *   looks like (the sale id comes from a dated list filtered on the
   *   client, not from the answer), and reading it as "you paid and got
   *   nothing" would invent a crisis out of a lookup that picked the
   *   wrong row. The answer's OWN basket is never excused this way.
   */
  unassertable: "package" | "mismatch" | null;
}

/**
 * The basket an answer carries, or null when it carries none.
 *
 * `PurchasedItems` is the Sale model's list of what a sale holds
 * (sale.yml:2772, items at 2302). The checkout answer's documented
 * shape is `ShoppingCart` with `CartItems` (4013), which is what was
 * PRICED and is deliberately not read here: the two live probes had a
 * gift card line priced in the cart and absent from the sale, so
 * asserting against CartItems would agree with itself and prove
 * nothing. So: the answer's own `PurchasedItems` when it has one (the
 * live answer's key set is wider than the vendored spec's, which is the
 * standing warning in CLAUDE.md), else null and the caller must read
 * the SALE before it trusts the answer.
 */
export function purchasedItemsOf(res: unknown): unknown[] | null {
  const r = res as Record<string, unknown> | null | undefined;
  const cart = r?.["ShoppingCart"] as Record<string, unknown> | undefined;
  for (const held of [cart?.["PurchasedItems"], r?.["PurchasedItems"]]) {
    if (Array.isArray(held)) return held;
  }
  return null;
}

/** An id a purchased item answers to: its `Id` (the pricing option's
 *  ProductId for a service, sale.yml:2311) and its `BarcodeId` (2320),
 *  which is what a Product line is sent as. The same either-way match
 *  auditLines uses, for the same reason. Folded to lower case, since a
 *  barcode is a string and the two sides must not disagree over the
 *  casing of one (T103 review). */
function purchasedIds(entry: unknown): string[] {
  const e = entry as Record<string, unknown> | null | undefined;
  const out: string[] = [];
  for (const key of ["Id", "BarcodeId"]) {
    const v = e?.[key];
    if (typeof v === "string" && v.trim() !== "") out.push(v.trim().toLowerCase());
    else if (typeof v === "number" && Number.isFinite(v)) out.push(String(v));
  }
  return out;
}

/**
 * Does this purchased item answer to this ordered line?
 *
 * The id has to match, and the item's own `IsService` (sale.yml:2314:
 * "the purchased item was a pricing option for a service") must not
 * CONTRADICT the line's type. Both id namespaces are small integers on
 * one site -- a product's barcode and a pricing option's ProductId can
 * coincide -- so without this a sale holding a pass could answer for a
 * retail product that was never sold (T103 review, proved against the
 * mock). Where the flag is absent nothing is contradicted and the
 * either-way match stands.
 */
function purchasedMatches(entry: unknown, line: CartLine): boolean {
  const id = String(line.metadataId).trim().toLowerCase();
  if (!purchasedIds(entry).includes(id)) return false;
  const isService = (entry as Record<string, unknown> | null | undefined)?.[
    "IsService"
  ];
  if (isService === true && line.type === "Product") return false;
  if (isService === false && line.type === "Service") return false;
  return true;
}

/**
 * Does this sale hold what was sent? The whole answer is refused when
 * the basket is empty, misses a line, or is short on a line's quantity
 * as Mindbody itself reported it.
 *
 * Strict in one direction only, exactly like totalsDisagree: there is no
 * tolerance, and a missing figure is never read as agreement. What it
 * does NOT claim (T103 review, each one a shape a legitimate sale comes
 * back in):
 *
 * - it never refuses for an EXTRA line. Mindbody puts lines of its own
 *   in a sale, and an extra one says nothing about the ordered ones.
 *   Extras are recorded in `unordered` and logged.
 * - it never refuses a line whose matched items carry no `Quantity`
 *   (the documented shape for a pricing option): then Mindbody has not
 *   said how many, and a short count cannot be inferred.
 * - it asserts nothing at all about a cart holding a Package line, or
 *   about a SALE READ that holds only items this ticket never ordered.
 *   See BasketVerdict.unassertable.
 *
 * `source` says where the basket came from: the checkout answer itself,
 * which is certainly this sale, or a `/sale/sales` read, which is this
 * sale as far as the lookup could tell.
 */
export function assertBasket(
  items: readonly CartLine[],
  purchased: readonly unknown[],
  source: "answer" | "sale" = "answer",
): BasketVerdict {
  /* Which ordered line each basket entry answers to, so an entry is
   * never counted twice and an entry nobody ordered is visible. */
  const claimed = new Set<number>();
  const audit: BasketAudit[] = items.map((line) => {
    const id = String(line.metadataId);
    let sold: number | null = null;
    let reported = false;
    let name: string | null = null;
    purchased.forEach((entry, i) => {
      if (!purchasedMatches(entry, line)) return;
      claimed.add(i);
      const e = entry as Record<string, unknown>;
      const qty = e["Quantity"];
      const said = typeof qty === "number" && Number.isFinite(qty);
      if (said) reported = true;
      sold = (sold ?? 0) + (said ? (qty as number) : 1);
      if (name === null) {
        for (const key of ["Name", "Description"]) {
          const v = e[key];
          if (typeof v === "string" && v.trim() !== "") {
            name = v.trim();
            break;
          }
        }
      }
    });
    return {
      type: line.type,
      metadataId: id,
      name,
      orderedQuantity: line.quantity,
      soldQuantity: sold,
      quantityReported: reported,
    };
  });
  const unordered = purchased
    .map((entry, i) =>
      claimed.has(i) ? null : (purchasedIds(entry)[0] ?? "unnamed"),
    )
    .filter((id): id is string => id !== null);

  /* T30's carve-out, one level on: a package has no basket shape of its
   * own to assert against. */
  if (items.some((line) => line.type === "Package")) {
    return {
      ok: true,
      problem: null,
      audit,
      unordered,
      unassertable: "package",
    };
  }
  const nameOf = (a: BasketAudit): string =>
    a.name ?? `${a.type.toLowerCase()} ${a.metadataId}`;
  if (purchased.length === 0) {
    return {
      ok: false,
      problem:
        "the sale holds no items at all: " +
        items.map((l) => `${l.type.toLowerCase()} ${l.metadataId}`).join(", ") +
        " was paid for and none of it was sold",
      audit,
      unordered,
      unassertable: null,
    };
  }
  /* A sale that was READ and answers to none of this ticket is more
   * likely the wrong sale than a sale that sold nothing. */
  if (
    source === "sale" &&
    audit.every((a) => a.soldQuantity === null) &&
    unordered.length > 0
  ) {
    return {
      ok: true,
      problem: null,
      audit,
      unordered,
      unassertable: "mismatch",
    };
  }
  const missing = audit.filter((a) => a.soldQuantity === null);
  const short = audit.filter(
    (a) =>
      a.soldQuantity !== null &&
      a.quantityReported &&
      a.soldQuantity < a.orderedQuantity,
  );
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`the sale does not hold ${missing.map(nameOf).join(", ")}`);
  }
  if (short.length > 0) {
    problems.push(
      "the sale is short: " +
        short
          .map(
            (a) =>
              `${nameOf(a)} ordered x${a.orderedQuantity}, sold x${a.soldQuantity}`,
          )
          .join(", "),
    );
  }
  if (problems.length === 0) {
    return { ok: true, problem: null, audit, unordered, unassertable: null };
  }
  return {
    ok: false,
    problem: problems.join("; "),
    audit,
    unordered,
    unassertable: null,
  };
}

/* =====================================================================
 * T24: payment execution (PLAN 2.2 + 2.3). Everything below can move
 * real money, which is why all of it goes through mindbody() -- dry run
 * and POS_WRITE_CLIENT_IDS intercept these POSTs exactly as they do a
 * check-in, and every function reports suppression instead of success.
 * =================================================================== */

/** The studio's card-processing floor, in dollars. Policy, not API: the
 *  amount on /sale/purchaseaccountcredit is dynamic (the request schema,
 *  sale.yml:4774-4810, carries NO Amount field; the figure travels in
 *  PaymentInfo.Metadata), so this is a config value, not a rebuild. */
export const CARD_MINIMUM_USD = 10;

/**
 * The payment shapes this counter takes, mapped to CheckoutPaymentInfo
 * (sale.yml:3924: `Type` at 3928, `Metadata` at 3932).
 *
 * The spec's documented key sets (sale.yml:3934): StoredCard - amount,
 * lastFour; DebitAccount - amount; Comp - amount. Both the Type enum and
 * the key list are truncated mid-sentence IN MINDBODY'S OWN PUBLISHED
 * DOC STRING (verified against upstream in the T22 review, 2026-08-29),
 * cutting off after DebitAccount/Comp respectively -- so "Cash" is a type
 * the spec cannot show us. /site/paymenttypes (site.yml:508) lists the
 * site's payment types by name, and the design doc's chooser table calls
 * the cash mechanism "Custom / cash payment info". `Type: "Cash"` with an
 * amount is the shape tried here; if the sandbox refuses it, the recorded
 * fallback is `Type: "Custom"` with Metadata `{ Amount, Id }` (Custom
 * keys - amount, id; sale.yml:3934), the Id being the cash row from
 * /site/paymenttypes. Deliberately NOT auto-fallback: a refused payment
 * type is a clean, nothing-charged failure, and a money call must never
 * quietly retry itself in a different shape.
 */
export type CheckoutPayment =
  | { type: "StoredCard"; amount: number; lastFour: string }
  | { type: "DebitAccount"; amount: number }
  | { type: "Cash"; amount: number }
  | { type: "Comp"; amount: number }
  /** T83: a gift card, spent by its barcode id. The number is a bearer
   *  secret: it is built into the payload here and goes nowhere else,
   *  not into a response and not into a record. T109: it is no longer
   *  struck out of the dev call log's copy of this Metadata string, on
   *  Pete's call; see src/lib/calllog.ts. */
  | { type: "GiftCard"; amount: number; cardNumber: string }
  /** T93: a card TYPED at the counter for this one sale. The whole card
   *  is a secret and lives in this payload only; calllog.ts strikes
   *  CreditCardNumber and CVV in both directions, and nothing here or
   *  above it ever returns more than the last four. */
  | { type: "CreditCard"; amount: number; card: TypedCard };

/**
 * T95 exported it under a name that says what it is: `purchasegiftcard`
 * takes a `PaymentInfo` of exactly this shape (sale.yml:5142, a
 * CheckoutPaymentInfo), so selling a gift card pays with the same
 * payment shapes a cart does and there is no second copy of them.
 *
 * CASING: the spec's Metadata key list spells everything lowercase
 * ("amount", "lastFour"; sale.yml:3934), but the one checkout call known
 * to have PASSED against the live API (the 2026-08-26 probe, design doc
 * rung 5, a StoredCard payment under Test: true) sent PascalCase, as does
 * T22's Comp pricing stub. PascalCase is what ships; the question is
 * still open until the first sandbox run watches a payment actually bind,
 * and if Mindbody ever rejects an Amount it cannot see, lowercasing THESE
 * KEYS is the first thing to try.
 */
export function checkoutPaymentPayload(
  p: CheckoutPayment,
): Record<string, unknown> {
  /* T83: the ONE entry whose Metadata goes out as a STRING of JSON with
   * lowercase keys, which is what the spec types Metadata as
   * (sale.yml:3932, `type: string`) and what Mindbody's own gift card
   * documentation lists for this type (keys `amount`, `cardNumber`; that
   * page needs a login, so it is hearsay this file cannot verify). Every
   * other type here sends a PascalCase OBJECT, because that is the shape
   * the one live checkout known to have passed used, and changing a
   * proven shape on a hunch is not a trade worth making. If Mindbody
   * refuses a GiftCard payment for a metadata it cannot read, the first
   * thing to try is the other shape -- an object, `{ Amount, CardNumber
   * }` -- and NOT an automatic retry: a refused payment type is a clean
   * nothing-charged failure, and a money call must never quietly try
   * itself again in a different shape. */
  if (p.type === "GiftCard") {
    return {
      Type: "GiftCard",
      Metadata: JSON.stringify({ amount: p.amount, cardNumber: p.cardNumber }),
    };
  }
  /* T93: the typed card. The keys are CreditCardInfo's spelling
   * (sale.yml:2867) inside the PascalCase object shape every other type
   * here uses; the spec's own key LIST for this payment type is the
   * lowercase set (sale.yml:3934), which is the by-hand thing to try if
   * this is refused and never an automatic retry. SaveInfo is what asks
   * Mindbody to keep the card on the cart's client, and it goes out only
   * for an ATTACHED client (the route refuses `keep` on a house-client
   * cart); T93 stores through T84's /client/updateclient path AFTER a
   * successful charge instead, so `keep` never reaches this payload. The
   * three optional billing lines are omitted rather than sent blank. */
  if (p.type === "CreditCard") {
    const c = p.card;
    return {
      Type: "CreditCard",
      Metadata: {
        Amount: p.amount,
        CreditCardNumber: c.number,
        ExpMonth: c.expMonth,
        ExpYear: c.expYear,
        CVV: c.cvv,
        BillingName: c.billingName,
        BillingPostalCode: c.postalCode,
        ...(c.address ? { BillingAddress: c.address } : {}),
        ...(c.city ? { BillingCity: c.city } : {}),
        ...(c.state ? { BillingState: c.state } : {}),
      },
    };
  }
  const metadata: Record<string, unknown> =
    p.type === "StoredCard"
      ? { Amount: p.amount, LastFour: p.lastFour }
      : { Amount: p.amount };
  return { Type: p.type, Metadata: metadata };
}

/** What a money write came back as. Suppression is a first-class outcome:
 *  the caller renders it amber, NEVER as a completed sale. */
export interface CheckoutOutcome {
  suppressed: "dry-run" | "write-guard" | null;
  /** ShoppingCart.Id (sale.yml:4009), the sale's handle, when returned. */
  saleId: string | null;
  /** ShoppingCart.GrandTotal as Mindbody recorded it. */
  grandTotal: number | null;
  /**
   * T103: what the ANSWER says this sale holds, asserted against what
   * was sent (assertBasket). Null in two cases, and they mean different
   * things: a suppressed write sold nothing because it never went, and
   * an answer carrying no `PurchasedItems` at all has not SAID what it
   * holds, which the caller must settle by reading the sale itself
   * (latestSale) before it reports a completed sale.
   */
  basket: BasketVerdict | null;
}

/**
 * The REAL checkout: POST /sale/checkoutshoppingcart (sale.yml:1459) with
 * `Test: false`, `LocationId: 1`, `InStore: true`, and the Payments
 * entries (sale.yml:5643) that together carry the full server-priced
 * total. This is the call that moves money. It fires only from
 * /api/checkout, which fires only from an explicit Charge tap.
 *
 * Payments takes ONE entry for every ordinary sale, and since T28 may
 * take TWO for an explicit split. The vendored schema is on side:
 * `Payments` is a plain `type: array` of CheckoutPaymentInfo with no
 * maxItems or any other constraint (sale.yml:5643-5649), so nothing
 * forbids two entries -- though note the T28 sandbox caveat: the Test:
 * true rehearsal prices with the Comp stub, so only the first REAL split
 * sale proves Mindbody accepts two entries. The entries go out in the
 * caller's order (the teacher's order, for a split). /api/checkout is
 * responsible for the amounts summing exactly to the rehearsed total;
 * this function only refuses shapes that could never be right.
 *
 * `clientId` goes in the body as ClientId (sale.yml:5654) when present.
 * The spec's "A 'ClientId' OR 'UniqueClientId' must be specified to
 * complete a sale" (5656) was confirmed live on 2026-08-30 -- it bites at
 * PRICING, Test: true included -- so /api/checkout substitutes
 * houseClientId() for an anonymous cash/comp sale and refuses cleanly
 * when none is configured; this function never invents a client.
 */
export async function checkoutCart(
  items: readonly CartLine[],
  clientId: string | undefined,
  payment: CheckoutPayment | readonly CheckoutPayment[],
  /** T49: the signed-in teacher the sale is made as, when there is one.
   *  Only the Authorization header changes; the payload is T24's. */
  actor?: Actor | null,
  /** T53: `SendEmail` (sale.yml:5688, "sends a purchase receipt email
   *  to the client ... all appropriate permissions and settings must be
   *  enabled", default false). The route decides; this function sends
   *  what it is told and nothing here reads back whether a receipt
   *  went, because the checkout response has no field for it. */
  sendEmail = false,
  /** T79: the whole-cart discount, spread here and sent as
   *  DiscountAmount per line. With a discount that covers the whole
   *  pre-tax subtotal, and ONLY then, `payment` may be an empty array:
   *  the no-Payments shape /api/checkout tries first for a 100%
   *  discount before falling back to the proven Comp payment. */
  discount?: Discount | null,
): Promise<CheckoutOutcome> {
  assertCartLines(items, "checkoutCart");
  const spread = discount ? spreadDiscount(items, discount) : undefined;
  const payments: readonly CheckoutPayment[] = Array.isArray(payment)
    ? payment
    : [payment as CheckoutPayment];
  const full = discount ? isFullDiscount(items, discount) : false;
  if (payments.length === 0 && !full) {
    throw new Error(
      "checkoutCart needs a payment unless the discount covers the entire sale.",
    );
  }
  if (payments.length > 2) {
    throw new Error("checkoutCart takes one or two payment entries.");
  }
  for (const p of payments) {
    if (!Number.isFinite(p.amount) || p.amount < 0) {
      throw new Error("checkoutCart needs a non-negative payment amount.");
    }
  }
  const res = await mindbody("/sale/checkoutshoppingcart", {
    method: "POST",
    body: {
      Items: cartItemsPayload(items, spread),
      /* T79: the no-Payments shape carries no Payments key at all. */
      ...(payments.length > 0
        ? { Payments: payments.map(checkoutPaymentPayload) }
        : {}),
      ...(clientId ? { ClientId: clientId } : {}),
      Test: false,
      LocationId: STUDIO_LOCATION_ID,
      InStore: true,
      CalculateTax: true,
      SendEmail: sendEmail,
    },
    ...(clientId ? { clientId } : {}),
    ...(actor ? { actor } : {}),
  });
  if (res?.DryRun === true) {
    return {
      suppressed: "dry-run",
      saleId: null,
      grandTotal: null,
      basket: null,
    };
  }
  if (res?.WriteSuppressed === true) {
    return {
      suppressed: "write-guard",
      saleId: null,
      grandTotal: null,
      basket: null,
    };
  }
  const cart = res?.ShoppingCart ?? {};
  /* T103: the basket assertion, right beside the sale id and the total,
   * on the answer to the call that took the money. A basket the answer
   * did not carry is null here and settled by the caller. */
  const purchased = purchasedItemsOf(res);
  return {
    suppressed: null,
    saleId: str(cart?.Id) ?? (num(cart?.Id) !== null ? String(cart.Id) : null),
    grandTotal: num(cart?.GrandTotal),
    basket: purchased === null ? null : assertBasket(items, purchased),
  };
}

/**
 * The Test: true rehearsal that must run BEFORE the under-$10 path buys
 * any credit (PLAN 2.3's mitigation): if Mindbody will not accept the
 * cart, the failure costs nothing. This IS priceCart -- the same
 * machinery, same stub-retry behavior -- under the name the checkout flow
 * means by it. It deliberately does NOT rehearse with the DebitAccount
 * payment the real call will use: at rehearsal time the client has not
 * bought the credit yet, so a balance-checked DebitAccount could fail for
 * exactly the reason the flow is about to fix, and the Comp stub (the one
 * payment shape that could move nothing even if Test were ignored) is the
 * only safe stand-in. A passing rehearsal validates the CART, not the
 * payment; the live call can still fail, which is what the structured
 * step-2 failure report exists for.
 */
export async function rehearseCheckout(
  items: readonly CartLine[],
  clientId?: string,
  /** T79: rehearsed WITH the discount the real call will carry. */
  discount?: Discount | null,
  /**
   * T112: who to rehearse AS. Null, and by default absent, is the
   * service account, which is what every rehearsal has always been and
   * what every rehearsal should stay: the teacher's token is for the
   * charge, and running the rehearsal under it would quietly make a
   * teacher's permission gap look like a cart Mindbody would not price.
   *
   * The ONE caller that passes one is /api/checkout with an "attempt"
   * override on the ticket, where the service account is precisely the
   * account whose refusal the teacher is trying to get past, so
   * rehearsing as it would fail the sale before the question was asked.
   * Nothing else about the rehearsal changes: same `Test: true`, same
   * Comp stub, same strict total and discount assertions.
   */
  actor?: Actor | null,
): Promise<PricedCart> {
  return priceCart(items, clientId, actor ?? null, discount);
}

/** Outcome of buying account credit; same suppression posture. */
export interface CreditPurchaseOutcome {
  suppressed: "dry-run" | "write-guard" | null;
  /** PurchaseAccountCreditResponse.AmountPaid (sale.yml:5904). */
  amountPaid: number | null;
  /** PurchaseAccountCreditResponse.SaleId (sale.yml:5913). */
  saleId: number | null;
  /** T53: PurchaseAccountCreditResponse.EmailReceipt (sale.yml:5918),
   *  "whether or not an email receipt was sent". True only when
   *  Mindbody said so; null on suppression or when the field is absent. */
  emailReceipt: boolean | null;
}

/**
 * POST /sale/purchaseaccountcredit (sale.yml:1778), used ONLY by the
 * under-$10 card path: charge the stored card for CARD_MINIMUM_USD of
 * account credit, then check the cart out on DebitAccount.
 *
 * Request per PurchaseAccountCreditRequest (sale.yml:4774): ClientId
 * (4779), Test (4783), LocationId (4787), SendEmailReceipt (4791),
 * PaymentInfo (4808, a CheckoutPaymentInfo). There is NO top-level
 * Amount: the amount rides PaymentInfo.Metadata, which is what makes the
 * floor a policy number rather than a preconfigured SKU (design doc,
 * "The amount is dynamic"). The card is named by lastFour per the
 * StoredCard key set (sale.yml:3934).
 */
export async function purchaseCredit(
  clientId: string,
  amount: number,
  lastFour: string,
  /** T49: the signed-in teacher, when there is one. */
  actor?: Actor | null,
  /** T53: SendEmailReceipt (sale.yml:4791). The credit purchase is a
   *  sale of its own in Mindbody's books, so it gets the same receipt
   *  decision as the cart that follows it. */
  sendEmailReceipt = false,
): Promise<CreditPurchaseOutcome> {
  if (!clientId) throw new Error("purchaseCredit needs a client id.");
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("purchaseCredit needs a positive amount.");
  }
  const res = await mindbody("/sale/purchaseaccountcredit", {
    method: "POST",
    body: {
      ClientId: clientId,
      Test: false,
      LocationId: STUDIO_LOCATION_ID,
      SendEmailReceipt: sendEmailReceipt,
      PaymentInfo: checkoutPaymentPayload({
        type: "StoredCard",
        amount,
        lastFour,
      }),
    },
    clientId,
    ...(actor ? { actor } : {}),
  });
  if (res?.DryRun === true) {
    return {
      suppressed: "dry-run",
      amountPaid: null,
      saleId: null,
      emailReceipt: null,
    };
  }
  if (res?.WriteSuppressed === true) {
    return {
      suppressed: "write-guard",
      amountPaid: null,
      saleId: null,
      emailReceipt: null,
    };
  }
  return {
    suppressed: null,
    amountPaid: num(res?.AmountPaid),
    saleId: num(res?.SaleId),
    emailReceipt:
      typeof res?.EmailReceipt === "boolean" ? res.EmailReceipt : null,
  };
}

/** A card on file, as the counter needs it: enough to offer the method,
 *  name the card, and fill the StoredCard metadata. Never the PAN. */
export interface StoredCard {
  /** ClientCreditCard.LastFour (client.yml:7397). */
  lastFour: string;
  /** ClientCreditCard.ExpMonth / ExpYear (client.yml:7389, 7393). */
  expMonth: string | null;
  expYear: string | null;
  /** True when the expiry is in the past. An expired card is REPORTED,
   *  not hidden: the method card greys with the reason. */
  expired: boolean;
}

/** Balance and card together: one /client/clients read serves both the
 *  stored-card method gate and the credit path's server-side re-read. */
export interface PaymentProfile {
  /** AccountBalance (client.yml:6370). At this studio positive means
   *  credit the client can spend. Null when Mindbody omitted it. */
  balance: number | null;
  card: StoredCard | null;
  /** T53: the client's email on file (client.yml `Email`), null when
   *  blank. The receipt toggle needs an address to send to. */
  email: string | null;
  /** T53: `SendAccountEmails` (client.yml:5286, "general account
   *  notifications by email", the receipt's own category). Mindbody
   *  defaults it to false; a record that omits it reads as false, which
   *  is the honest default for an opt-in. */
  sendAccountEmails: boolean;
  /** T53: `SendPromotionalEmails` (client.yml:5294), so the gate's
   *  "news and offers" box opens pre-set to what Mindbody holds and a
   *  teacher leaving it alone changes nothing. */
  sendPromotionalEmails: boolean;
}

/** Is an ExpMonth/ExpYear pair in the past? Unparseable dates count as
 *  expired: a card we cannot date must not be charged silently. */
function cardExpired(expMonth: string | null, expYear: string | null): boolean {
  const month = Number(expMonth);
  const year = Number(expYear);
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(year) ||
    year < 2000
  ) {
    return true;
  }
  /* Valid through the last moment of the expiry month. */
  const firstInvalid = new Date(year, month, 1);
  return Date.now() >= firstInvalid.getTime();
}

/**
 * The client's payment profile: card on file plus account balance, from
 * one GET /client/clients (client.yml:1323) by id. The response's Clients
 * are ClientWithSuspensionInfo (GetClientsResponse, client.yml:7106),
 * which carries both `ClientCreditCard` (6257) and `AccountBalance`
 * (6370). The `clientIds=` repeated-param spelling is the one the roster's
 * batched lookup verified live (src/lib/roster.ts).
 */
export async function clientPaymentProfile(
  clientId: string,
): Promise<PaymentProfile> {
  if (!clientId) throw new Error("clientPaymentProfile needs a client id.");
  const body = await mindbody(
    `/client/clients?clientIds=${encodeURIComponent(clientId)}&limit=1`,
  );
  const row = (body?.Clients ?? []).find(
    (c: any) => String(c?.Id ?? "") === clientId,
  );
  if (!row) {
    throw new Error("Mindbody returned no client record for this id.");
  }
  const cc = row?.ClientCreditCard;
  const lastFour = str(cc?.LastFour);
  const card: StoredCard | null = lastFour
    ? {
        lastFour,
        expMonth: str(cc?.ExpMonth),
        expYear: str(cc?.ExpYear),
        expired: cardExpired(str(cc?.ExpMonth), str(cc?.ExpYear)),
      }
    : null;
  return {
    balance: num(row?.AccountBalance),
    card,
    email: str(row?.Email),
    sendAccountEmails: row?.SendAccountEmails === true,
    sendPromotionalEmails: row?.SendPromotionalEmails === true,
  };
}

/** Just the card on file (last four + expiry), for the attach-time
 *  method gate. Expired cards come back marked, never hidden. */
export async function storedCardFor(
  clientId: string,
): Promise<StoredCard | null> {
  return (await clientPaymentProfile(clientId)).card;
}

/** More distinct lines than the whole catalog has items is not a cart. */
export const MAX_CART_LINES = 100;

/**
 * Parse an untrusted request-body `items` array into CartLines, with the
 * exact bounds T22 shipped. Shared by /api/price-cart and /api/checkout so
 * the cart that gets charged is validated by the same rules as the cart
 * that got priced.
 */
export function parseCartLines(
  raw: unknown,
): { items: CartLine[]; error: null } | { items: null; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { items: null, error: "items (non-empty array) is required" };
  }
  if (raw.length > MAX_CART_LINES) {
    return {
      items: null,
      error: `a cart holds at most ${MAX_CART_LINES} lines`,
    };
  }
  const items: CartLine[] = [];
  for (const entry of raw) {
    const type = entry?.type;
    const metadataId = entry?.metadataId;
    const quantity = entry?.quantity;
    const price = entry?.price;
    const taxRate = entry?.taxRate;
    if (
      taxRate !== undefined &&
      taxRate !== null &&
      (typeof taxRate !== "number" || !Number.isFinite(taxRate) || taxRate < 0)
    ) {
      return {
        items: null,
        error: "taxRate, when present, must be a non-negative number or null",
      };
    }
    if (
      (type !== "Product" && type !== "Service" && type !== "Package") ||
      (typeof metadataId !== "string" && typeof metadataId !== "number") ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_LINE_QUANTITY ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      return {
        items: null,
        error:
          "each item needs type (Product|Service|Package), metadataId, " +
          `quantity (integer, 1 to ${MAX_LINE_QUANTITY}) and ` +
          "price (non-negative number)",
      };
    }
    /* T90: the line's recipient, when it is somebody other than the
     * client paying. A string id or nothing; never an object, and never
     * trusted for more than grouping (the carts below are addressed
     * with it, and Mindbody refuses an id that is not a client). */
    const forRaw = entry?.forClientId;
    if (
      forRaw !== undefined &&
      forRaw !== null &&
      (typeof forRaw !== "string" || !forRaw.trim())
    ) {
      return {
        items: null,
        error: "forClientId, when present, must be a non-empty client id",
      };
    }
    items.push({
      type,
      metadataId,
      quantity,
      price,
      taxExempt: entry?.taxExempt === true,
      taxRate: typeof taxRate === "number" ? taxRate : null,
      ...(typeof forRaw === "string" ? { forClientId: forRaw.trim() } : {}),
    });
  }
  return { items, error: null };
}

/* =====================================================================
 * T30: contracts (autopay memberships). A contract is NOT a cart item:
 * it sells through its own endpoint, POST /sale/purchasecontract
 * (sale.yml:1859), against the list GET /sale/contracts returns
 * (sale.yml:142). Everything here rides mindbody(), so dry run and the
 * write guard intercept the purchase exactly as they do a checkout, and
 * suppression is reported, never dressed as success.
 * =================================================================== */

/** AutopaySchedule (sale.yml:4757): how often the autopay runs. Null on
 *  a contract whose AutopayTriggerType is PricingOptionRunsOutOrExpires
 *  (sale.yml:5488). */
export interface AutopayScheduleInfo {
  /** SetNumberOfAutopays | MonthToMonth (sale.yml:4761). */
  frequencyType: string | null;
  /** Interval count; null when MonthToMonth (sale.yml:4766). */
  frequencyValue: number | null;
  /** Weekly | Monthly | Yearly; null when MonthToMonth (sale.yml:4771). */
  frequencyTimeUnit: string | null;
}

/**
 * One sellable contract, from the Contract model (sale.yml:5445), mapped
 * to what the counter's membership dialog needs. The three payment
 * figures are Mindbody's own precomputed totals -- first payment
 * (FirstPaymentAmountTotal, sale.yml:5577), the ongoing charge
 * (RecurringPaymentAmountTotal, sale.yml:5592), and the lifespan total
 * (TotalContractAmountTotal, sale.yml:5607) -- so no local tax math is
 * ever needed for a contract; the Test rehearsal still re-asks the
 * server before any real purchase.
 */
export interface ContractSummary {
  /** Contract.Id (sale.yml:5449). */
  id: number;
  name: string;
  /** What the client pays when signing up today (sale.yml:5577). */
  firstPaymentTotal: number | null;
  /** The ongoing charge per autopay run (sale.yml:5592). */
  recurringPaymentTotal: number | null;
  /** The lifespan total, when Mindbody computes one (sale.yml:5607). */
  totalContractTotal: number | null;
  /** DepositAmount (sale.yml:5516), when the contract demands one. */
  depositAmount: number | null;
  /** AutopayEnabled (sale.yml:5563): whether this contract establishes
   *  an autopay at all. */
  autopayEnabled: boolean;
  autopaySchedule: AutopayScheduleInfo | null;
  /** How many times the autopay runs; null when MonthToMonth
   *  (sale.yml:5489). */
  numberOfAutopays: number | null;
  /** OnSetSchedule | PricingOptionRunsOutOrExpires (sale.yml:5494). */
  autopayTriggerType: string | null;
  /** ContractExpires | ContractAutomaticallyRenews (sale.yml:5498). */
  actionUponCompletionOfAutopays: string | null;
  /** When clients are charged: OnSaleDate, FirstOfTheMonth, ...,
   *  SpecificDate (sale.yml:5502). */
  clientsChargedOn: string | null;
  /** The date when clientsChargedOn is SpecificDate (sale.yml:5506). */
  clientsChargedOnSpecificDate: string | null;
  /** Business-defined terms and conditions (sale.yml:5555), already
   *  reduced to plain text (T99): Mindbody serves this as HTML, and it
   *  is shown as text, never injected. */
  agreementTerms: string | null;
  /** SoldOnline (sale.yml:5471): false means staff-only, which is fine
   *  here -- this IS a staff counter. Kept for display/debug only. */
  soldOnline: boolean;
}

/**
 * The contracts sellable at the studio: GET /sale/contracts
 * (sale.yml:142) with the REQUIRED `request.locationId` (sale.yml:157,
 * "The ID of the location that has the requested contracts and AutoPay
 * options") as the studio's 1. `request.soldOnline` is left at its
 * default false (sale.yml:214), which returns ALL contracts -- staff-only
 * ones included, correct for a counter. The endpoint also takes
 * `request.promoCode` (sale.yml:206) and `request.uniqueClientId`
 * (sale.yml:222); neither is used yet (promos are their own future
 * ticket) and both are recorded here so the next reader does not re-dig.
 *
 * Filtered like the rest of the shelf: a contract that charges nothing
 * (no first payment AND no recurring amount) is unsellable config, and
 * LocationPurchaseRestrictionIds (sale.yml:5540, "If there are no
 * restrictions, this value is null") must be absent or include the
 * studio.
 */
export async function contractsFor(): Promise<ContractSummary[]> {
  const body = await mindbody(
    `/sale/contracts?request.locationId=${STUDIO_LOCATION_ID}` +
      `&request.limit=100`,
  );
  const seen = new Set<number>();
  return (body?.Contracts ?? [])
    .filter((c: any) => {
      const restrict: unknown = c?.LocationPurchaseRestrictionIds;
      return (
        !Array.isArray(restrict) ||
        restrict.length === 0 ||
        restrict.includes(STUDIO_LOCATION_ID)
      );
    })
    .map((c: any): ContractSummary | null => {
      const id = num(c?.Id);
      if (id === null) return null;
      const firstPaymentTotal = num(c?.FirstPaymentAmountTotal);
      const recurringPaymentTotal = num(c?.RecurringPaymentAmountTotal);
      if ((firstPaymentTotal ?? 0) <= 0 && (recurringPaymentTotal ?? 0) <= 0) {
        return null;
      }
      const sched = c?.AutopaySchedule;
      return {
        id,
        name: str(c?.Name) ?? "Membership",
        firstPaymentTotal,
        recurringPaymentTotal,
        totalContractTotal: num(c?.TotalContractAmountTotal),
        depositAmount: num(c?.DepositAmount),
        autopayEnabled: c?.AutopayEnabled === true,
        autopaySchedule: sched
          ? {
              frequencyType: str(sched?.FrequencyType),
              frequencyValue: num(sched?.FrequencyValue),
              frequencyTimeUnit: str(sched?.FrequencyTimeUnit),
            }
          : null,
        numberOfAutopays: num(c?.NumberOfAutopays),
        autopayTriggerType: str(c?.AutopayTriggerType),
        actionUponCompletionOfAutopays: str(c?.ActionUponCompletionOfAutopays),
        clientsChargedOn: str(c?.ClientsChargedOn),
        clientsChargedOnSpecificDate: str(c?.ClientsChargedOnSpecificDate),
        /* T99: the owner writes these terms in Mindbody's rich text
         * editor, so the string carries markup. Cleaned HERE so the
         * browser never holds the markup at all; Contract.Description
         * is not served at all any more (Pete: "we don't need the
         * description. remove it."). */
        agreementTerms: plainText(str(c?.AgreementTerms)) || null,
        soldOnline: c?.SoldOnline === true,
      };
    })
    .filter((c: ContractSummary | null): c is ContractSummary => c !== null)
    .filter((c: ContractSummary) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
}

/* =====================================================================
 * T99: a chosen start date for a membership.
 *
 * Pete: "we should add an option to customize the billing date. if a
 * customer wants to start their contract on a different date, we can do
 * that and pro-rate their first month."
 *
 * The arithmetic is MINDBODY'S, never ours. The endpoint description
 * (sale.yml:1866) is explicit about what the three fields do together:
 * "If the date is passed, the Totals returned will always include the
 * pro-rate amount for instant payment ... `FirstPaymentOccurs` =
 * `StartDate` => returns pro-rate amount + contract amount requiring
 * instant payment. The rest of the contract will be due on `StartDate`.
 * Pro-rate amount payment on `StartDate` is not supported by this
 * endpoint." So a chosen day sends StartDate + ProrateDate +
 * FirstPaymentOccurs: StartDate, and the Totals that come back ARE what
 * the card is charged today. No proration is computed in this codebase.
 * =================================================================== */

/** Today as the studio's `YYYY-MM-DD`. The studio's day, not the
 *  server's: a container on UTC is already tomorrow at 5pm Seattle. */
export function studioDayKey(at: Date = new Date()): string {
  return studioWall(at).slice(0, 10);
}

/** How far ahead a membership may be started. A year is far past any
 *  real counter conversation; beyond it a mistyped year is the likelier
 *  explanation than a customer's intention. */
export const CONTRACT_START_MAX_DAYS = 365;

/** Midnight UTC for a `YYYY-MM-DD`, or null when the key is not a real
 *  calendar day (2026-02-31 parses and then rolls over, so the parts are
 *  checked back out of the Date). */
function dayKeyUtc(key: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== m - 1 ||
    back.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
}

/**
 * Why this `YYYY-MM-DD` cannot be a membership's start date, in words
 * for the screen, or null when it can. Both sides check it: the dialog
 * so a teacher is told, and the route so a body that never passed
 * through the dialog is refused too.
 */
export function contractStartProblem(key: string): string | null {
  const chosen = dayKeyUtc(key);
  if (chosen === null) {
    return "A start date has to be a real calendar day.";
  }
  const todayKey = studioDayKey();
  const today = dayKeyUtc(todayKey);
  if (today === null) return null;
  if (chosen < today) {
    return "A membership cannot start in the past. Pick today or a later day.";
  }
  const days = Math.round((chosen - today) / 86400000);
  if (days > CONTRACT_START_MAX_DAYS) {
    return (
      "A membership cannot be started more than a year ahead. Pick a " +
      "day within the next " + CONTRACT_START_MAX_DAYS + " days."
    );
  }
  return null;
}

/** Outcome of a contract purchase (or its Test rehearsal); the same
 *  suppression posture as every money write here. */
export interface ContractPurchaseOutcome {
  suppressed: "dry-run" | "write-guard" | null;
  /** Whether this outcome came from a Test: true call. */
  test: boolean;
  /** PurchaseContractResponse.ClientContractId (sale.yml:3188), "the ID
   *  of the specific contract being purchased by this specific client".
   *  Null on Test and on suppression. */
  clientContractId: number | null;
  /** PurchaseContractResponseTotals (sale.yml:2805): Total (2809),
   *  SubTotal (2814), Discount (2819), Tax (2824). This is the FIRST
   *  payment's pricing -- what the card is charged today. */
  totals: {
    total: number | null;
    subTotal: number | null;
    discount: number | null;
    tax: number | null;
  } | null;
}

/**
 * POST /sale/purchasecontract (sale.yml:1859), the membership sale.
 *
 * Request per PurchaseContractRequest (sale.yml:6210), which declares NO
 * `required:` list at all -- every requirement below is description-level
 * and recorded here because the T30 dialog depends on the exact reading:
 *
 * - ContractId (6214), LocationId (6224, "used for AutoPays"): sent.
 * - ClientId (6229) or UniqueClientId (6233): one is REQUIRED per the
 *   UniqueClientId note; ClientId is what this codebase holds. A
 *   contract NEVER rides the house client: an autopay bound to the
 *   walk-in account is a standing charge against nobody, so the route
 *   refuses an unattached purchase outright.
 * - Test (6219): supported, "validates input information, but does not
 *   commit it" -- so the dialog rehearses first and shows the server's
 *   first-payment total, same posture as the cart.
 * - StartDate (6238): "Default: today's date". OMITTED when the sale
 *   starts today, so Mindbody's own today (the site's timezone, not
 *   this server's UTC clock) is the start. T99: when a teacher chooses
 *   a later day it is sent as a studio WALL-CLOCK string
 *   ("YYYY-MM-DDT00:00:00"), because Mindbody reads a datetime
 *   parameter as site-local and ignores any offset or Z.
 * - FirstPaymentOccurs (6242): "Instant" or "StartDate". Instant for a
 *   sale starting today: the counter charges now, on the spot. T99: a
 *   chosen day sends "StartDate" instead, which per the endpoint
 *   description (1866) charges the pro-rate amount plus whatever the
 *   contract requires instantly, and leaves the rest due on the start
 *   date.
 * - ProrateDate (6291): T99, sent as the chosen start date and only
 *   then. Per 1866 its presence is what puts the pro-rate amount into
 *   the Totals, which is the figure the dialog shows. Nothing here
 *   computes a proration.
 * - Payment: exactly one of CreditCardInfo (6261, "only required if
 *   StoredCardInfo is not passed and both UseDirectDebit and
 *   UseAccountCredit are false"), StoredCardInfo (6264, the mirror
 *   wording), UseDirectDebit (6275), UseAccountCredit (6279). The
 *   counter sends StoredCardInfo, whose whole model is `{ LastFour }`
 *   (sale.yml:5189-5196) -- there is NO CardId; the card on file is
 *   addressed by its last four, exactly like a StoredCard cart payment.
 *   No card on file means no counter membership sale, surfaced honestly.
 * - ClientSignature (6246): OPTIONAL (no required list, and the
 *   description only says what happens when it IS sent: a Base64 PNG
 *   filed to the client's documents). Deliberately not collected: the
 *   counter flow does not put a signature pad between a teacher and a
 *   queue unless Mindbody demands one. If a site setting ever makes the
 *   API refuse without it, that refusal renders verbatim and the pad
 *   becomes a real ticket. Recorded on T30.
 * - SendNotifications (6267, default true): sent as true, deliberately
 *   unlike the cart's SendEmail: false -- a recurring agreement is
 *   something the client should have in their inbox.
 * - PromotionCode/PromotionCodes (6251/6255), SalesRepId (6270),
 *   ConsumerPresent (6283)/PaymentAuthenticationCallbackUrl (6287, SCA): none
 *   sent; recorded so nobody re-digs.
 */
export async function purchaseContract(opts: {
  contractId: number;
  clientId: string;
  lastFour: string;
  test: boolean;
  /** T99: the day the membership starts, as a studio `YYYY-MM-DD`.
   *  Absent, null, or today's own key all mean today's behaviour
   *  exactly: no StartDate, no ProrateDate, FirstPaymentOccurs
   *  Instant. */
  startDate?: string | null;
  /** T49: the signed-in teacher, when there is one. */
  actor?: Actor | null;
}): Promise<ContractPurchaseOutcome> {
  const { contractId, clientId, lastFour, test } = opts;
  if (!Number.isInteger(contractId)) {
    throw new Error("purchaseContract needs an integer contract id.");
  }
  if (!clientId) throw new Error("purchaseContract needs a client id.");
  if (!lastFour) {
    throw new Error(
      "purchaseContract needs the stored card's last four digits.",
    );
  }
  /* T99: a chosen later day, or today. A start date that is today's own
   * key is today: the request shape does not change, so a teacher who
   * opened the control and picked today cannot send anything a teacher
   * who never opened it would not. An unusable date throws here as well
   * as being refused by the route: this is the last gate before the
   * write. */
  const start = opts.startDate ?? null;
  if (start !== null) {
    const problem = contractStartProblem(start);
    if (problem) throw new Error(problem);
  }
  const deferred = start !== null && start !== studioDayKey();
  /* Studio wall clock, no offset and no Z: Mindbody reads the parameter
   * as site-local either way, and toISOString() would land this seven
   * hours out (CLAUDE.md, and roster.ts studioWall). */
  const startWall = deferred ? `${start}T00:00:00` : null;
  const res = await mindbody("/sale/purchasecontract", {
    method: "POST",
    body: {
      ContractId: contractId,
      ClientId: clientId,
      Test: test,
      LocationId: STUDIO_LOCATION_ID,
      FirstPaymentOccurs: deferred ? "StartDate" : "Instant",
      ...(startWall !== null
        ? { StartDate: startWall, ProrateDate: startWall }
        : {}),
      StoredCardInfo: { LastFour: lastFour },
      SendNotifications: true,
    },
    clientId,
    ...(opts.actor ? { actor: opts.actor } : {}),
  });
  if (res?.DryRun === true) {
    return { suppressed: "dry-run", test, clientContractId: null, totals: null };
  }
  if (res?.WriteSuppressed === true) {
    return {
      suppressed: "write-guard",
      test,
      clientContractId: null,
      totals: null,
    };
  }
  const totals = res?.Totals
    ? {
        total: num(res.Totals?.Total),
        subTotal: num(res.Totals?.SubTotal),
        discount: num(res.Totals?.Discount),
        tax: num(res.Totals?.Tax),
      }
    : null;
  return {
    suppressed: null,
    test,
    clientContractId: num(res?.ClientContractId),
    totals,
  };
}

/* =====================================================================
 * T49: the numeric sale id.
 * =================================================================== */

/** Sale ids already handed to a done screen this process, so two sales
 *  in a row for the same client (the house client, typically) cannot be
 *  answered with the same id. Bounded by the day: nothing older than
 *  today's window is ever a candidate, and the set is small. */
const seenSaleIds = new Set<number>();

/** Per client, the REAL checkouts this process made whose sale id was
 *  never found: the list had not caught up, or the lookup failed or hung
 *  (T49 review). Each is an id somewhere above the ones seen, and a later
 *  lookup for the same client must leave room for it: the newest unseen
 *  id is THIS checkout's only when there are more unseen ids than earlier
 *  checkouts still waiting for one. Without this, a list one sale behind
 *  handed the previous sale's number to the next sale.
 *
 *  T105: each entry is WHEN that checkout went out, not a bare count, so
 *  the waiting can age out. A count never came down: one sale the dated
 *  read could not name left the room reserved for the life of the
 *  process, so every later lookup for that client answered null and
 *  T103's basket assertion had no evidence for any of them (measured:
 *  after one unnamed sale, five consecutive empty baskets were reported
 *  as completed sales). */
const unresolvedSales = new Map<string, number[]>();

/** How long the done screen waits for the sale list before settling
 *  for the cart GUID (the Formula Note's own bound, T45 review). */
const SALE_LOOKUP_WAIT_MS = 8_000;

/** How far before the checkout started a candidate's SaleDateTime may
 *  fall and still be this sale: clock skew between this server and
 *  Mindbody's, nothing more. A sale from earlier (the web app this
 *  morning, another counter, a sale from before a restart) is never a
 *  candidate, however unseen. */
const SALE_CLOCK_SKEW_MS = 2 * 60 * 1000;

/** T105: how long an unnamed checkout keeps its room reserved.
 *
 *  The basis is the CLOCK, and not any clock: it is exactly the window in
 *  which that checkout's sale could still turn up as a candidate. A
 *  candidate must carry a `SaleDateTime` no earlier than this lookup's
 *  `startedAt` less SALE_CLOCK_SKEW_MS, so an earlier sale stamped around
 *  its own start can only clear that floor while it is younger than the
 *  skew allowance, plus the time its own lookup could still have been
 *  running (SALE_LOOKUP_WAIT_MS), plus a second skew allowance for the
 *  stamp itself. Past that the floor excludes it anyway, which is the
 *  whole reason ageing it out cannot misname anything: the guard is
 *  dropped only once the older guard has taken over.
 *
 *  Wrong in one direction (too long) and the rail stays off for that
 *  client for longer: sale ids fall back to the cart GUID and baskets go
 *  unasserted, which is what T105 was opened to end but is safe. Wrong in
 *  the other (too short) and an earlier sale that appears late could be
 *  named as a later sale's, which is a receipt with someone else's number
 *  on it, so the window is deliberately the generous end of what the
 *  floor allows. The one shape it cannot survive is Mindbody stamping a
 *  sale more than two minutes after it happened, which is the assumption
 *  SALE_CLOCK_SKEW_MS already makes and this ticket did not change. */
const SALE_UNRESOLVED_TTL_MS = SALE_LOOKUP_WAIT_MS + 2 * SALE_CLOCK_SKEW_MS;

/** T105: the unnamed checkouts for this client that could still be named,
 *  as of `now`. Older ones are forgotten, loudly: nothing else in this
 *  process would ever say the count came down. */
function waitingFor(clientId: string, now: Date): number {
  const kept: number[] = [];
  let aged = 0;
  for (const at of unresolvedSales.get(clientId) ?? []) {
    if (now.getTime() - at <= SALE_UNRESOLVED_TTL_MS) kept.push(at);
    else aged++;
  }
  if (aged > 0) {
    console.log(
      `[sale-id] aged out ${aged} unnamed sale${aged === 1 ? "" : "s"} for ` +
        `client ${clientId} (older than ${Math.round(SALE_UNRESOLVED_TTL_MS / 1000)}s, ` +
        `so the date floor excludes them); ${kept.length} still waiting`,
    );
  }
  if (kept.length === 0) unresolvedSales.delete(clientId);
  else unresolvedSales.set(clientId, kept);
  return kept.length;
}

/** T105: this checkout joins the waiting, stamped with when it went out.
 *  `startedAt` and not the time of this line, because it is that moment
 *  the date floor will measure the sale against. Prunes as it goes, so a
 *  run of failed reads cannot leave stale entries behind either. */
function joinWaiting(clientId: string, startedAt: Date): void {
  const kept = unresolvedSales.get(clientId) ?? [];
  kept.push(startedAt.getTime());
  unresolvedSales.set(clientId, kept);
  waitingFor(clientId, new Date());
}

/**
 * The numeric `Sale.Id` (sale.yml:2734) of the sale a REAL checkout just
 * completed, or null when it cannot be found unambiguously.
 *
 * `checkoutshoppingcart` answers with `ShoppingCart.Id`, a cart GUID,
 * which is not the number Mindbody's own receipts and sales reports show.
 * `GET /sale/sales` (sale.yml:992) lists sales by date range: it takes
 * `StartSaleDateTime`/`EndSaleDateTime`, `Limit`, `Offset`, `SaleId` and
 * `PaymentMethodId`, and NO client parameter, so the client is filtered
 * here on `Sale.ClientId` (2763). The window is today, studio-local
 * (studioWall: Mindbody reads the parameter as wall-clock time and
 * ignores any offset). Under the service account: a read, like every
 * other read here. Bounded at SALE_LOOKUP_WAIT_MS by the caller-side
 * race below; the call itself runs on to its own timeout and its
 * answer is dropped.
 *
 * A candidate is a sale for this client with an integer Id this process
 * has not handed out and a `SaleDateTime` (site-local, 2748) no earlier
 * than `startedAt` less the clock skew allowance, so nothing from before
 * this checkout began can be named. The newest candidate is this sale's
 * only when the candidates outnumber the earlier checkouts for this
 * client still waiting for an id (unresolvedSales); the rest are those
 * earlier sales' and are marked seen. Otherwise the answer is null and
 * this checkout joins the waiting count; the done screen then shows the
 * GUID as it did before T49. Nothing about the outcome of the sale
 * depends on this: a failed or empty lookup is one log line and the
 * GUID.
 */
export async function latestSaleId(
  clientId: string,
  /** When the checkout call went out; nothing sold before it counts. */
  startedAt: Date,
): Promise<number | null> {
  return (await latestSale(clientId, startedAt)).id;
}

/**
 * T103: latestSaleId's read, with the found sale's own basket.
 *
 * The lookup already reads `GET /sale/sales`, and `PurchasedItems`
 * (sale.yml:2772) is the field the two live probes read the empty
 * baskets from, so the sale a checkout just made can be checked for
 * what it HOLDS without a second metered call. `purchasedItems` is null
 * whenever the sale was not found (a list that has not caught up, a
 * failed or timed-out read): then nothing is known about the basket, and
 * a caller must say so rather than invent either verdict.
 */
export async function latestSale(
  clientId: string,
  startedAt: Date,
): Promise<{ id: number | null; purchasedItems: unknown[] | null }> {
  const now = new Date();
  const dayStart = `${studioWall(now).slice(0, 10)}T00:00:00`;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dayEnd = `${studioWall(tomorrow).slice(0, 10)}T00:00:00`;
  const query =
    `request.startSaleDateTime=${encodeURIComponent(dayStart)}` +
    `&request.endSaleDateTime=${encodeURIComponent(dayEnd)}` +
    `&request.limit=200`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      mindbody(`/sale/sales?${query}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`no answer in ${SALE_LOOKUP_WAIT_MS / 1000}s`),
            ),
          SALE_LOOKUP_WAIT_MS,
        );
      }),
    ]);
    const sales: unknown[] = Array.isArray(body?.Sales) ? body.Sales : [];
    /* T103: the candidate sales' own baskets, by id, so the winner's can
     * be answered with it. */
    const baskets = new Map<number, unknown[] | null>();
    const floor = studioWall(
      new Date(startedAt.getTime() - SALE_CLOCK_SKEW_MS),
    );
    const candidates: number[] = [];
    for (const raw of sales) {
      const sale = raw as Record<string, unknown>;
      if (String(sale["ClientId"] ?? "") !== clientId) continue;
      const id = sale["Id"];
      if (typeof id !== "number" || !Number.isInteger(id)) continue;
      if (seenSaleIds.has(id)) continue;
      /* Same naive site-local shape as the query window, so a string
       * comparison orders them; a sale with no time cannot be placed
       * and is not a candidate. */
      const at = sale["SaleDateTime"];
      if (typeof at !== "string" || at.slice(0, 19) < floor) continue;
      candidates.push(id);
      const held = sale["PurchasedItems"];
      baskets.set(id, Array.isArray(held) ? held : null);
    }
    const waiting = waitingFor(clientId, now);
    if (candidates.length <= waiting) {
      joinWaiting(clientId, startedAt);
      console.log(
        `[sale-id] none new for client ${clientId} (${sales.length} sales today, ` +
          `${candidates.length} candidates, ${waiting} earlier still unnamed)`,
      );
      return { id: null, purchasedItems: null };
    }
    const best = Math.max(...candidates);
    for (const id of candidates) seenSaleIds.add(id);
    unresolvedSales.delete(clientId);
    return { id: best, purchasedItems: baskets.get(best) ?? null };
  } catch (err) {
    joinWaiting(clientId, startedAt);
    console.log(
      `[sale-id] lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { id: null, purchasedItems: null };
  } finally {
    clearTimeout(timer);
  }
}
