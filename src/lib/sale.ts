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
      };
    })
    .filter((s: CatalogItem | null): s is CatalogItem => s !== null)
    .filter((s: CatalogItem) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
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
  type: "Product" | "Service";
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
  /** totalsDisagree(expectedTotal, grandTotal); false while suppressed. */
  disagrees: boolean;
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
      (type !== "Product" && type !== "Service") ||
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
          "each item needs type (Product|Service), metadataId, " +
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
