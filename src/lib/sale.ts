/**
 * Phase 2 groundwork: the catalog and pricing layer (T22, PLAN 2.1).
 *
 * Catalog reads and Test-mode cart pricing only. No payment execution lives
 * here (that is T24), and nothing in this file can move money: the one POST
 * it makes is `/sale/checkoutshoppingcart` with `Test: true`, which the spec
 * documents as "the contents of the cart are validated, but the transaction
 * does not take place" (sale.yml:5674).
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

/** The studio's sales tax at location 1, from the live /site/locations dump
 *  in the design doc. An in-studio total is Price x 1.1035, which is the
 *  cheap invariant priceCart asserts against the server. */
export const STUDIO_TAX_RATE = 0.1035;

/**
 * "sales tax exempt" (100000) is the one `IsSecondary: true` category at
 * this studio, referenced by `SecondaryCategoryId` on a product
 * (sale.yml:5830). It is the exception to the 10.35% invariant: an item
 * carrying it contributes untaxed. Design doc, "Categories" section.
 */
export const TAX_EXEMPT_SECONDARY_CATEGORY_ID = 100000;

/** One sellable thing, product or pricing option, priced for the studio. */
export interface CatalogItem {
  /**
   * The id the cart's Item.Metadata refers to. For a retail product this is
   * the barcode `Id` (sale.yml:5816); for a pricing option it is
   * `ProductId`, "the unique ID of this pricing option" (sale.yml:5226).
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
  /** Revenue category id (products only; sale.yml:5820). */
  categoryId: number | null;
  /** SecondaryCategoryId (sale.yml:5830); 100000 means tax exempt. */
  secondaryCategoryId: number | null;
  /** True when this line must be asserted untaxed. */
  taxExempt: boolean;
  /** The CheckoutItem discriminator this maps to (sale.yml:4971). */
  type: "Product" | "Service";
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
  return (body?.Products ?? [])
    .map((p: any): CatalogItem | null => {
      const barcodeId = str(p?.Id);
      const productId = num(p?.ProductId);
      const price = num(p?.Price);
      const id = barcodeId ?? productId;
      if (id === null || price === null) return null;
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
      };
    })
    .filter((p: CatalogItem | null): p is CatalogItem => p !== null);
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
      if (id === null || price === null) return null;
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
      };
    })
    .filter((s: CatalogItem | null): s is CatalogItem => s !== null);
}

/** The most of one item a counter cart can hold. A teacher selling more
 *  than this of anything has mistyped, and an absurd quantity times a real
 *  price is exactly the number nobody should ever see on a Charge button. */
export const MAX_LINE_QUANTITY = 99;

/** One line of a cart to be priced. The caller (the sale screen) builds
 *  these from CatalogItems; price/taxExempt ride along ONLY to feed the
 *  local assertion and are never sent to Mindbody. */
export interface CartLine {
  type: "Product" | "Service";
  /** Goes into Item.Metadata.Id; CatalogItem.id. */
  metadataId: string | number;
  quantity: number;
  /** In-studio unit price, for expectedTotal only. Never sent. */
  price: number;
  /** From CatalogItem.taxExempt. */
  taxExempt: boolean;
}

/** Round half-up to cents. The epsilon absorbs float dust like
 *  2.9999999999999996 from 2.72 * 1.1035 so .995-style boundaries land on
 *  the cent the arithmetic means. */
export function roundToCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * What the studio's tax arithmetic says this cart costs:
 * sum(Price x qty) x 1.1035, with tax-exempt lines contributing untaxed,
 * rounded half-up to cents. This is an ASSERTION against the server's
 * total, never a price we charge or display as authoritative.
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
  let taxed = 0;
  let exempt = 0;
  for (const line of items) {
    const extended = line.price * line.quantity;
    if (line.taxExempt) exempt += extended;
    else taxed += extended;
  }
  return roundToCents(taxed * (1 + STUDIO_TAX_RATE) + exempt);
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
  /** totalsDisagree(expectedTotal, grandTotal); false while suppressed. */
  disagrees: boolean;
  /**
   * True when the no-Payments request was rejected and the Comp stub retry
   * is what priced the cart. T24 cares: it means even Test-mode checkout
   * demands a Payments array on this site.
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
 * all (sale.yml:5632-5735 carries no `required:` list), so the first
 * attempt sends no Payments array -- pricing a cart is not paying for it.
 * The live API may still demand one even under Test (the 2026-08-26 probe's
 * passing Test call happened to include a StoredCard payment, so
 * omit-ability is unproven); on a rejection that mentions payment, ONE
 * retry goes out with a `Comp` stub -- the only documented payment type
 * whose Metadata needs nothing but an amount (sale.yml:3934, "Comp Keys -
 * amount") and which could move no money even if Test were ignored.
 * `usedPaymentStub` reports which shape worked, because T24 needs to know.
 *
 * `clientId` rides mindbody()'s options for the POS_WRITE_CLIENT_IDS guard
 * and, when present, goes in the body as ClientId (sale.yml:5654) since
 * client attachment can change pricing (memberships, contracts later). An
 * anonymous cart sends no ClientId; under a configured write guard that
 * means suppression, which is the guard doing its job.
 */
export async function priceCart(
  items: readonly CartLine[],
  clientId?: string,
): Promise<PricedCart> {
  if (items.length === 0) {
    throw new Error("priceCart needs at least one item.");
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
  const expected = expectedTotal(items);
  const baseBody: Record<string, unknown> = {
    Items: items.map((line) => ({
      Item: {
        Type: line.type,
        Metadata: { Id: line.metadataId },
      },
      Quantity: line.quantity,
    })),
    ...(clientId ? { ClientId: clientId } : {}),
    Test: true,
    LocationId: STUDIO_LOCATION_ID,
    InStore: true,
    CalculateTax: true,
  };

  let usedPaymentStub = false;
  let res: any;
  try {
    res = await mindbody("/sale/checkoutshoppingcart", {
      method: "POST",
      body: baseBody,
      ...(clientId ? { clientId } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/payment/i.test(message)) throw err;
    /* The site wants a Payments array even to price. Comp stub, once. */
    usedPaymentStub = true;
    /* The stub's Amount is our expectation, the only number in hand before
     * the server has priced anything. If the server's total differs (the
     * exact condition `disagrees` exists for), a payments-must-equal-total
     * rule would reject this retry too -- which still fails loudly, just as
     * a thrown error instead of a disagrees flag. The spec's key list
     * spells the key "amount" (sale.yml:3934) where item Metadata examples
     * are PascalCase; the first sandbox run confirms the casing. */
    res = await mindbody("/sale/checkoutshoppingcart", {
      method: "POST",
      body: {
        ...baseBody,
        Payments: [{ Type: "Comp", Metadata: { Amount: expected } }],
      },
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
  return {
    suppressed: false,
    subTotal: num(cart?.SubTotal),
    discountTotal: num(cart?.DiscountTotal),
    taxTotal: num(cart?.TaxTotal),
    grandTotal,
    expectedTotal: expected,
    disagrees: totalsDisagree(expected, grandTotal),
    usedPaymentStub,
  };
}
