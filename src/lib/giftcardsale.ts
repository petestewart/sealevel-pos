/**
 * SELLING a gift card (T95, Pete: "A customer needs to be able to buy a
 * gift card ... Gift card will be an item in the store, and when it's
 * clicked a box pops up where the teacher must enter the amount ... The
 * price is always the value, and the ID is set automatically").
 *
 * T83 spends a gift card (src/lib/giftcard.ts, the tender). This is the
 * other half, and it is a DIFFERENT Mindbody mechanism: not a cart line
 * at all.
 *
 * - `GET /sale/giftcards` (sale.yml:398, operationId getGiftCards) lists
 *   the site's gift card PRODUCTS: `Id` (a ProductId), `CardValue`,
 *   `SalePrice`, `LocationIds`, `Description`.
 * - `POST /sale/purchasegiftcard` (sale.yml:1959, request at 5090) sells
 *   ONE of them, with its own `PaymentInfo` (the same CheckoutPaymentInfo
 *   shapes /api/checkout sends) and its own sale in Mindbody's books.
 *
 * **There is no amount field.** The value of the card sold is the
 * PRODUCT's CardValue; nothing in the request can override it. So Pete's
 * number pad can only ever resolve to a product the site already has,
 * and the studio needs one fixed-value gift card product per amount it
 * wants to sell (see the T95 ticket: this is the first thing Pete has to
 * set up in Mindbody). Whether the site's "Gift Card (Custom Amount)"
 * product can be given a value through this endpoint is an OPEN QUESTION
 * for a live `Test: true` probe; the spec shows no field for it, and a
 * capability this file cannot see is not a capability it may assume.
 *
 * THE BARCODE ID IS A SECRET, exactly as in T83: a gift card is a bearer
 * instrument, so the id generated here is treated like a card number.
 * The call log strikes it out of the request body (`BarcodeId` is one of
 * calllog.ts's GIFT_KEYs) and out of anything Mindbody quotes back. The
 * two places it is deliberately shown are teacher-facing and necessary:
 * the done screen ("Write this on the card") and the emailed receipt.
 */

import {
  mindbody,
  mindbodyHttpStatus,
  target,
  type Actor,
} from "./mindbody";
import {
  checkoutPaymentPayload,
  STUDIO_LOCATION_ID,
  roundToCents,
  type CheckoutPayment,
} from "./sale";
import { ensureTarget } from "./target";

/** One gift card product the site sells, as the counter needs it. */
export interface GiftCardProduct {
  /** GiftCard.Id, the ProductId `purchasegiftcard` takes as
   *  `GiftCardId`. */
  id: number;
  /** What the card is WORTH once sold (GiftCard.CardValue). */
  cardValue: number;
  /** What the customer pays for it (GiftCard.SalePrice). Pete: "The
   *  price is always the value" -- which is a statement about how the
   *  studio configures its products, not something this file may
   *  enforce, so both figures are carried and the PRICE is what is
   *  charged. A product priced differently from its value is shown at
   *  its value and charged at its price, and the ticket says so. */
  salePrice: number;
  description: string | null;
}

/**
 * The site's gift card products, cached per process for two minutes and
 * keyed by target, exactly like the catalog (src/lib/catalog.ts) and for
 * the same reasons: it changes a few times a year, it is only read when
 * someone opens Buy, and a process that switched studio must never serve
 * the other one's products. A failure is never cached.
 *
 * Nothing here is the price of a sale: /api/checkout re-reads this list
 * server-side and rehearses every purchase with `Test: true` before any
 * money moves, so a stale figure on the shelf surfaces as a refusal, not
 * as a wrong charge.
 */
const CACHE_TTL_MS = 2 * 60 * 1000;
let cache: { key: string; at: number; data: GiftCardProduct[] } | null = null;

/** T89: a target switch drops the cached products with the catalog. */
export function clearGiftCardProducts(): void {
  cache = null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function giftCardProducts(
  refresh = false,
): Promise<GiftCardProduct[]> {
  await ensureTarget();
  const key = target();
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  /* Only the cards sold at the studio (LocationId 1 is a constant here,
   * CLAUDE.md), and only 100 of them: a site with more gift card
   * products than that has a problem a page two would not fix. */
  const res = await mindbody<{ GiftCards?: unknown }>(
    `/sale/giftcards?request.locationId=${STUDIO_LOCATION_ID}&request.limit=100`,
  );
  const raw = Array.isArray(res?.GiftCards) ? res.GiftCards : [];
  const data: GiftCardProduct[] = [];
  for (const entry of raw) {
    const e = entry as Record<string, unknown>;
    const id = num(e["Id"]);
    const cardValue = num(e["CardValue"]);
    if (id === null || cardValue === null || cardValue <= 0) continue;
    /* SalePrice is documented "if applicable"; a card with none is sold
     * at its value, which is Pete's rule for every card the studio
     * offers ("The price is always the value"). */
    const salePrice = num(e["SalePrice"]);
    data.push({
      id,
      cardValue: roundToCents(cardValue),
      salePrice: roundToCents(
        salePrice !== null && salePrice > 0 ? salePrice : cardValue,
      ),
      description:
        typeof e["Description"] === "string" && e["Description"].trim()
          ? e["Description"].trim()
          : null,
    });
  }
  /* By value, which is the order the preset chips read in. */
  data.sort((a, b) => a.cardValue - b.cardValue);
  cache = { key, at: Date.now(), data };
  return data;
}

/* ===================================================================
 * The id
 * =================================================================== */

/**
 * Pete: "use a hexadecimal ID of 5 characters (82B8X7)". His own example
 * is SIX characters and is not hexadecimal (X is not a hex digit), so the
 * words and the example disagree and the example is the thing he drew.
 * Six characters it is, from an alphabet with no I, O, 0 or 1 in it:
 * the id is written on a physical card by hand and read back off it at
 * the counter, where a 0 that is an O costs a teacher a minute and a
 * customer their balance.
 *
 * 32^6 is a billion, so a collision is vanishingly unlikely -- and it is
 * still CHECKED before every sale (see freshGiftCardId), because the spec
 * says an existing barcode id RELOADS the existing card, which must never
 * happen by accident.
 *
 * One constant to change if Pete wants it otherwise.
 */
export const GIFT_CARD_ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const GIFT_CARD_ID_LENGTH = 6;

/** A candidate id. Unbiased: the alphabet is 32 characters, so five bits
 *  of a random byte map onto it exactly and no rejection is needed. */
export function newGiftCardId(): string {
  const bytes = new Uint8Array(GIFT_CARD_ID_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    out += GIFT_CARD_ID_ALPHABET[b % 32] as string;
  }
  return out;
}

/** What `/sale/giftcardbalance` says about an id we are about to use. */
type IdState = "free" | "taken";

/** Mindbody's wording for a barcode it has never heard of. A 4xx only:
 *  a 5xx or a dead transport says nothing about the id. */
const NOT_FOUND = /not found|no gift ?card|does not exist|doesn'?t exist|invalid|cannot be found|could not be found/i;

/**
 * Is this id free? A READ, so it goes out under dry run like every other
 * read and charges nothing whatever it answers.
 *
 * Throws when the answer does not settle the question. That is the
 * deliberate posture: the sale is refused rather than risk RELOADING a
 * card someone is already holding. Exactly what Mindbody answers for an
 * unknown barcode id is unverified against the live API (the T95 ticket
 * records it as an open question); a not-found-shaped 4xx reads as free,
 * and anything else -- a 5xx, a timeout, a 200 with no balance in it --
 * refuses.
 */
async function giftCardIdState(id: string): Promise<IdState> {
  try {
    const res = await mindbody<{ RemainingBalance?: unknown }>(
      `/sale/giftcardbalance?barcodeId=${encodeURIComponent(id)}`,
    );
    if (num(res?.RemainingBalance) !== null) return "taken";
    throw new Error(
      "Mindbody answered the gift card balance read without a balance, so " +
        "whether that id is already in use is unknown.",
    );
  } catch (err) {
    const status = mindbodyHttpStatus(err);
    const message = err instanceof Error ? err.message : String(err);
    if (status !== null && status >= 400 && status < 500 && NOT_FOUND.test(message)) {
      return "free";
    }
    if (status === 404) return "free";
    throw err;
  }
}

/** How many ids to try before giving up. A collision is a one-in-a-billion
 *  event, so three failures in a row is a broken read, not bad luck. */
const ID_TRIES = 3;

/**
 * An id no gift card on this site has. Nothing has been written when this
 * returns, and nothing has been written when it throws.
 *
 * T95 review: `taken` are ids this ticket has already claimed but not yet
 * sold. Mindbody cannot know about them (they are not cards yet), so the
 * balance read would call a repeat FREE, and the second purchase would
 * RELOAD the first card instead of selling a new one. A ticket of ten
 * cards is ten draws from the same billion, so the odds are absurd and
 * the check is one comparison.
 */
export async function freshGiftCardId(
  taken: readonly string[] = [],
): Promise<string> {
  for (let i = 0; i < ID_TRIES; i++) {
    const id = newGiftCardId();
    if (!taken.includes(id) && (await giftCardIdState(id)) === "free") return id;
    /* The id is NOT logged: it is a bearer secret, and the next one will
     * be along in a moment. The count is the diagnostic. */
    console.warn(
      `[giftcard] generated id ${i + 1} of ${ID_TRIES} is already in use; regenerating`,
    );
  }
  throw new Error(
    `Could not generate an unused gift card id in ${ID_TRIES} tries. ` +
      "Nothing was charged.",
  );
}

/* ===================================================================
 * The purchase
 * =================================================================== */

/** What one `purchasegiftcard` call came back as. Suppression is a
 *  first-class outcome, exactly as in checkoutCart: the caller renders it
 *  amber, NEVER as a card that was sold. */
export interface GiftCardPurchaseOutcome {
  suppressed: "dry-run" | "write-guard" | null;
  /** PurchaseGiftCardResponse.BarcodeId (sale.yml:4916): the id
   *  Mindbody recorded, which is the one to write on the card. Ours when
   *  it echoes it back, and if it ever does not, THEIRS is the truth. */
  barcodeId: string | null;
  /** Value (4920) and AmountPaid (4924). */
  value: number | null;
  amountPaid: number | null;
  /** SaleId (4958). */
  saleId: number | null;
  /** EmailReceipt (4940), "whether or not an email receipt was sent". */
  emailReceipt: boolean | null;
}

/**
 * POST /sale/purchasegiftcard.
 *
 * `LayoutId: 0` is deliberate: it is the no-image layout, and it is what
 * makes RecipientEmail, RecipientName, Title and DeliveryDate all
 * unnecessary (each is "required if the LayoutId is not 0", sale.yml:5124
 * onward). A card sold at the counter is a physical card handed over the
 * desk; there is no recipient to email an image to.
 *
 * `SalesRepId` is deliberately NOT sent. The write already runs under the
 * signed-in teacher's own token (T49), which is how Mindbody names them
 * on every other sale this app makes; whether this endpoint also wants
 * the staff id, and whether it would refuse one that does not match the
 * token, is an open question for a live probe (T95).
 */
export async function purchaseGiftCard(opts: {
  productId: number;
  purchaserClientId: string;
  barcodeId: string;
  payment: CheckoutPayment;
  /** T49: the signed-in teacher the sale is made as. */
  actor?: Actor | null;
  /** `Test: true` is the rehearsal: it prices and validates the purchase
   *  without affecting the database (sale.yml:5108). */
  test: boolean;
  sendEmailReceipt: boolean;
}): Promise<GiftCardPurchaseOutcome> {
  if (!opts.purchaserClientId) {
    throw new Error("purchaseGiftCard needs a purchaser.");
  }
  if (!Number.isInteger(opts.productId) || opts.productId <= 0) {
    throw new Error("purchaseGiftCard needs a gift card product id.");
  }
  if (!opts.barcodeId) throw new Error("purchaseGiftCard needs a barcode id.");
  const res = await mindbody("/sale/purchasegiftcard", {
    method: "POST",
    body: {
      LocationId: STUDIO_LOCATION_ID,
      PurchaserClientId: opts.purchaserClientId,
      GiftCardId: opts.productId,
      Test: opts.test,
      LayoutId: 0,
      SendEmailReceipt: opts.sendEmailReceipt,
      PaymentInfo: checkoutPaymentPayload(opts.payment),
      BarcodeId: opts.barcodeId,
    },
    clientId: opts.purchaserClientId,
    ...(opts.actor ? { actor: opts.actor } : {}),
  });
  if (res?.DryRun === true) {
    return {
      suppressed: "dry-run",
      barcodeId: null,
      value: null,
      amountPaid: null,
      saleId: null,
      emailReceipt: null,
    };
  }
  if (res?.WriteSuppressed === true) {
    return {
      suppressed: "write-guard",
      barcodeId: null,
      value: null,
      amountPaid: null,
      saleId: null,
      emailReceipt: null,
    };
  }
  return {
    suppressed: null,
    barcodeId:
      typeof res?.BarcodeId === "string" && res.BarcodeId.trim()
        ? res.BarcodeId.trim()
        : null,
    value: num(res?.Value),
    amountPaid: num(res?.AmountPaid),
    saleId: num(res?.SaleId),
    emailReceipt:
      typeof res?.EmailReceipt === "boolean" ? res.EmailReceipt : null,
  };
}

/* ===================================================================
 * The request body
 * =================================================================== */

/** One gift card line of a ticket, as the browser sends it. */
export interface GiftCardLine {
  productId: number;
  quantity: number;
}

/** A ticket holds at most this many gift card LINES, and at most this
 *  many CARDS in total: each card is its own Mindbody call, and a tap
 *  that fires forty sequential writes is a mistake, not a sale. */
export const MAX_GIFT_CARD_LINES = 6;
export const MAX_GIFT_CARDS = 10;

/**
 * Parse an untrusted `giftCards` array. A string return is the 400
 * reason. Nothing about price or value is read from the browser: the
 * product id is the only thing that travels, and /api/checkout resolves
 * it against the live list.
 */
export function parseGiftCardLines(
  raw: unknown,
): { lines: GiftCardLine[]; error: null } | { lines: null; error: string } {
  if (raw === undefined || raw === null) return { lines: [], error: null };
  if (!Array.isArray(raw)) {
    return { lines: null, error: "giftCards must be an array of lines" };
  }
  if (raw.length > MAX_GIFT_CARD_LINES) {
    return {
      lines: null,
      error: `a ticket holds at most ${MAX_GIFT_CARD_LINES} gift card lines`,
    };
  }
  const lines: GiftCardLine[] = [];
  let cards = 0;
  for (const entry of raw) {
    const productId = (entry as { productId?: unknown } | null)?.productId;
    const quantity = (entry as { quantity?: unknown } | null)?.quantity;
    if (!Number.isInteger(productId) || (productId as number) <= 0) {
      return { lines: null, error: "each gift card line needs a productId" };
    }
    if (!Number.isInteger(quantity) || (quantity as number) < 1) {
      return {
        lines: null,
        error: "each gift card line needs a quantity of at least 1",
      };
    }
    cards += quantity as number;
    if (cards > MAX_GIFT_CARDS) {
      return {
        lines: null,
        error: `a ticket holds at most ${MAX_GIFT_CARDS} gift cards`,
      };
    }
    lines.push({ productId: productId as number, quantity: quantity as number });
  }
  return { lines, error: null };
}

/** One CARD to sell: a line's quantity expanded, because each card is a
 *  call of its own with an id of its own. */
export interface GiftCardUnit {
  productId: number;
  cardValue: number;
  salePrice: number;
}

/**
 * The units a ticket's gift card lines mean, priced from the LIVE product
 * list. A string return is the refusal to answer the browser with: a
 * product id the site does not have is a stale shelf, not something to
 * guess at.
 */
export function resolveGiftCardUnits(
  lines: readonly GiftCardLine[],
  products: readonly GiftCardProduct[],
): { units: GiftCardUnit[]; error: null } | { units: null; error: string } {
  const units: GiftCardUnit[] = [];
  for (const line of lines) {
    const product = products.find((p) => p.id === line.productId);
    if (product === undefined) {
      return {
        units: null,
        error:
          "Mindbody no longer offers one of the gift cards on this ticket. " +
          "Remove the line and add it again. Nothing was charged.",
      };
    }
    for (let i = 0; i < line.quantity; i++) {
      units.push({
        productId: product.id,
        cardValue: product.cardValue,
        salePrice: product.salePrice,
      });
    }
  }
  return { units, error: null };
}

/** What the cards on a ticket cost, to the cent. */
export function giftCardTotal(units: readonly GiftCardUnit[]): number {
  let total = 0;
  for (const u of units) total += u.salePrice;
  return roundToCents(total);
}

/**
 * A gift card sale on record, as one server log line. The T29 charter's
 * posture: the record exists with no database at all. The id is NOT in
 * it: the log is not a place a bearer secret comes to rest, and the sale
 * id plus the value identify the sale in Mindbody, which holds the
 * barcode itself.
 */
export function logGiftCardSale(o: {
  outcome: string;
  value: number;
  price: number;
  saleId: number | null;
  clientId: string;
  staffId: number | null;
}): void {
  console.log(
    `[giftcard] ${target()} sold=${o.outcome} value=${o.value.toFixed(2)} ` +
      `price=${o.price.toFixed(2)} sale=${o.saleId ?? "none"} ` +
      `client=${o.clientId} staff=${o.staffId ?? "none"}`,
  );
}
