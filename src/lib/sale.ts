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

import { mindbody } from "./mindbody";

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
export function expectedTotal(items: readonly CartLine[]): number {
  let total = 0;
  for (const line of items) {
    const extended = line.price * line.quantity;
    /* The exempt category still contributes untaxed; otherwise the
     * line's own rate, falling back to Fremont's 10.35% (STUDIO_TAX_RATE)
     * ONLY when the catalog carried no rate for this line. */
    const rate = line.taxExempt ? 0 : (line.taxRate ?? STUDIO_TAX_RATE);
    total += extended * (1 + rate);
  }
  return roundToCents(total);
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
  /** Our local assertion, always computed. */
  expectedTotal: number;
  /** totalsDisagree(expectedTotal, grandTotal); false while suppressed,
   *  and false BY CONSTRUCTION for a package-bearing cart (see
   *  packagePricing). */
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
function cartItemsPayload(items: readonly CartLine[]): unknown[] {
  return items.map((line) => ({
    Item: {
      Type: line.type,
      Metadata: { Id: line.metadataId },
    },
    Quantity: line.quantity,
  }));
}

export async function priceCart(
  items: readonly CartLine[],
  clientId?: string,
): Promise<PricedCart> {
  assertCartLines(items, "priceCart");
  const expected = expectedTotal(items);
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
    Items: cartItemsPayload(items),
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
  const disagrees = packagePricing
    ? false
    : totalsDisagree(expected, grandTotal);
  return {
    suppressed: false,
    subTotal: num(cart?.SubTotal),
    discountTotal: num(cart?.DiscountTotal),
    taxTotal: num(cart?.TaxTotal),
    grandTotal,
    expectedTotal: expected,
    ...(disagrees ? { lineAudit: auditLines(items, cart) } : {}),
    /* The T30 carve-out: a package-bearing cart is excluded from the
     * strict assertion (no tax basis for a package line); every other
     * cart keeps it verbatim. */
    disagrees,
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
    const rate = line.taxExempt ? 0 : (line.taxRate ?? STUDIO_TAX_RATE);
    return {
      name: typeof match?.Item?.Name === "string" ? match.Item.Name : null,
      type: line.type,
      metadataId: id,
      quantity: line.quantity,
      ourPrice: line.price,
      ourTaxRate: line.taxExempt ? 0 : line.taxRate,
      ourExtended: roundToCents(line.price * line.quantity * (1 + rate)),
      theirPrice: num(match?.Item?.Price),
      theirTaxRate: num(match?.Item?.TaxRate),
      theirQuantity: num(match?.Quantity),
    };
  });
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
  | { type: "Comp"; amount: number };

/**
 * CASING: the spec's Metadata key list spells everything lowercase
 * ("amount", "lastFour"; sale.yml:3934), but the one checkout call known
 * to have PASSED against the live API (the 2026-08-26 probe, design doc
 * rung 5, a StoredCard payment under Test: true) sent PascalCase, as does
 * T22's Comp pricing stub. PascalCase is what ships; the question is
 * still open until the first sandbox run watches a payment actually bind,
 * and if Mindbody ever rejects an Amount it cannot see, lowercasing THESE
 * KEYS is the first thing to try.
 */
function paymentPayload(p: CheckoutPayment): Record<string, unknown> {
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
): Promise<CheckoutOutcome> {
  assertCartLines(items, "checkoutCart");
  const payments: readonly CheckoutPayment[] = Array.isArray(payment)
    ? payment
    : [payment as CheckoutPayment];
  if (payments.length < 1 || payments.length > 2) {
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
      Items: cartItemsPayload(items),
      Payments: payments.map(paymentPayload),
      ...(clientId ? { ClientId: clientId } : {}),
      Test: false,
      LocationId: STUDIO_LOCATION_ID,
      InStore: true,
      CalculateTax: true,
      SendEmail: false,
    },
    ...(clientId ? { clientId } : {}),
  });
  if (res?.DryRun === true) {
    return { suppressed: "dry-run", saleId: null, grandTotal: null };
  }
  if (res?.WriteSuppressed === true) {
    return { suppressed: "write-guard", saleId: null, grandTotal: null };
  }
  const cart = res?.ShoppingCart ?? {};
  return {
    suppressed: null,
    saleId: str(cart?.Id) ?? (num(cart?.Id) !== null ? String(cart.Id) : null),
    grandTotal: num(cart?.GrandTotal),
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
): Promise<PricedCart> {
  return priceCart(items, clientId);
}

/** Outcome of buying account credit; same suppression posture. */
export interface CreditPurchaseOutcome {
  suppressed: "dry-run" | "write-guard" | null;
  /** PurchaseAccountCreditResponse.AmountPaid (sale.yml:5904). */
  amountPaid: number | null;
  /** PurchaseAccountCreditResponse.SaleId (sale.yml:5913). */
  saleId: number | null;
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
      SendEmailReceipt: false,
      PaymentInfo: paymentPayload({ type: "StoredCard", amount, lastFour }),
    },
    clientId,
  });
  if (res?.DryRun === true) {
    return { suppressed: "dry-run", amountPaid: null, saleId: null };
  }
  if (res?.WriteSuppressed === true) {
    return { suppressed: "write-guard", amountPaid: null, saleId: null };
  }
  return {
    suppressed: null,
    amountPaid: num(res?.AmountPaid),
    saleId: num(res?.SaleId),
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
  return { balance: num(row?.AccountBalance), card };
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
    items.push({
      type,
      metadataId,
      quantity,
      price,
      taxExempt: entry?.taxExempt === true,
      taxRate: typeof taxRate === "number" ? taxRate : null,
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
  description: string | null;
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
  /** Business-defined terms and conditions (sale.yml:5555). */
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
        description: str(c?.Description),
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
        agreementTerms: str(c?.AgreementTerms),
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
 * - StartDate (6238): "Default: today's date". Deliberately OMITTED so
 *   Mindbody's own today (the site's timezone, not this server's UTC
 *   clock) is the start; the counter sells memberships that start now.
 * - FirstPaymentOccurs (6242): "Instant" or "StartDate". Sent as
 *   Instant: the counter charges today, on the spot. (The endpoint
 *   description at 1866 confirms the semantics: Instant pays now,
 *   StartDate defers the payment to the start date.)
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
 *   ConsumerPresent (6283)/PaymentAuthenticationCallbackUrl (6287, SCA),
 *   ProrateDate (6291): none sent; recorded so nobody re-digs.
 */
export async function purchaseContract(opts: {
  contractId: number;
  clientId: string;
  lastFour: string;
  test: boolean;
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
  const res = await mindbody("/sale/purchasecontract", {
    method: "POST",
    body: {
      ContractId: contractId,
      ClientId: clientId,
      Test: test,
      LocationId: STUDIO_LOCATION_ID,
      FirstPaymentOccurs: "Instant",
      StoredCardInfo: { LastFour: lastFour },
      SendNotifications: true,
    },
    clientId,
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
