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
 * `Test: false`, `LocationId: 1`, `InStore: true`, and exactly ONE
 * Payments entry (sale.yml:5643) carrying the full server-priced total.
 * This is the call that moves money. It fires only from /api/checkout,
 * which fires only from an explicit Charge tap.
 *
 * `clientId` goes in the body as ClientId (sale.yml:5654) when present.
 * The spec notes "A 'ClientId' OR 'UniqueClientId' must be specified to
 * complete a sale" (5656), so an anonymous cash/comp sale is expected to
 * be refused by Mindbody; that refusal surfaces verbatim rather than
 * being second-guessed here, and if the sandbox confirms it, the fix is a
 * house walk-in client, decided with Pete rather than invented.
 */
export async function checkoutCart(
  items: readonly CartLine[],
  clientId: string | undefined,
  payment: CheckoutPayment,
): Promise<CheckoutOutcome> {
  assertCartLines(items, "checkoutCart");
  if (!Number.isFinite(payment.amount) || payment.amount < 0) {
    throw new Error("checkoutCart needs a non-negative payment amount.");
  }
  const res = await mindbody("/sale/checkoutshoppingcart", {
    method: "POST",
    body: {
      Items: cartItemsPayload(items),
      Payments: [paymentPayload(payment)],
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
    });
  }
  return { items, error: null };
}
