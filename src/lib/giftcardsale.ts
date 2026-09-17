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
 * **There is no amount field, and an amount can still be chosen (T96).**
 * The request carries no value, so for a FIXED product the card is worth
 * that product's CardValue. But a product with `EditableByConsumer:
 * true` prices ITSELF from the PaymentInfo amount: rehearsed live against
 * site 471 on 2026-09-16 (`Test: true`, through this file's own
 * purchaseGiftCard), product 282 "Gift Card (Custom Amount)", CardValue
 * 0, answered `Value=$37.00 AmountPaid=$37.00` when paid $37.00 and
 * `Value=$63.50 AmountPaid=$63.50` when paid $63.50. So the counter's
 * number pad is free whenever the site has such a product, and no
 * per-amount product has to be configured. T95 had concluded the
 * opposite, because giftCardProducts() dropped every zero-value product
 * and a custom-amount product is exactly that.
 *
 * **The fixed products are not consistent, which is why both figures are
 * asserted.** On that same site the nine fixed products, paid an amount
 * that disagreed with their price, answered two different ways: six
 * issued a card worth the amount paid, three issued a card worth their
 * own CardValue while booking the smaller payment. Every documented
 * field on all nine is identical, so nothing here predicts which way one
 * goes. Every purchase is rehearsed with `Test: true` first and both
 * `Value` and `AmountPaid` are compared to the cent before anything is
 * charged (see /api/checkout): a card worth more than was paid for it is
 * money out of the studio's till.
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
import { plainText } from "./richtext";
import { giftCardHidden, type ShelfConfig } from "./shelfconfig";
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
  /**
   * T96: `EditableByConsumer`. An editable product takes its value from
   * the amount paid, so it sells for ANY amount the teacher types and its
   * own cardValue and salePrice (0 on site 471) mean nothing. A fixed
   * product sells only at its own two figures.
   */
  editable: boolean;
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
let cache: {
  key: string;
  at: number;
  data: GiftCardProduct[];
  /** T103: EVERY id the site's gift card list carried, the ones `data`
   *  drops included. See giftCardProductIds. */
  allIds: number[];
} | null = null;

/** T89: a target switch drops the cached products with the catalog. */
export function clearGiftCardProducts(): void {
  cache = null;
}

/** T101: a gift card product's Description as a one-line name, or null.
 *  `plainText` is the app's one way of showing anything Mindbody's rich
 *  text editor wrote (src/lib/richtext.ts); the newlines it can leave are
 *  no use in a button, so they collapse to spaces. */
function giftCardDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = plainText(raw).replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * T102 review: a FIGURE that is not a number is ABSENT, not zero.
 *
 * `num` is deliberately lenient (`Number(null)` is 0, `Number(true)` is
 * 1), and for the balance read at giftCardTaken that leniency is the safe
 * direction: anything that parses at all means the id is taken. On the
 * purchase answer it is the wrong direction. T96's rehearsal promises
 * that a MISSING figure refuses because "silence is not agreement where
 * a bearer instrument is", and `Value: null` is silence: read as 0 it
 * slipped past that refusal and came out as T102's "the card would be
 * worth 0.00", which blames Mindbody for saying something it never said.
 * A numeric string is still read as the number it is; the assertions
 * then compare the real figures to the cent.
 */
function figure(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") return num(v);
  return null;
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
  /* T103: every id on the list, before any of the filtering below. A
   * gift card product must never reach a cart line, and the products
   * this function DROPS (a fixed product worth nothing, one with no
   * usable figures) are exactly the ones a cart would price at zero or
   * book a payment against nothing. */
  const allIds: number[] = [];
  for (const entry of raw) {
    const e = entry as Record<string, unknown>;
    const id = num(e["Id"]);
    const cardValue = num(e["CardValue"]);
    if (id !== null) allIds.push(id);
    if (id === null || cardValue === null) continue;
    const editable = e["EditableByConsumer"] === true;
    /* T96: a zero-value product is KEPT only when it is editable, which
     * is the shape a custom-amount product comes in (site 471's product
     * 282 carries CardValue 0 and SalePrice 0, and prices itself from
     * the payment). A non-editable zero-value product is still dropped:
     * there is no amount it could be sold for. T95 dropped both, which
     * is why its author never saw the custom-amount product. */
    if (cardValue <= 0 && !editable) continue;
    /* SalePrice is documented "if applicable"; a card with none is sold
     * at its value, which is Pete's rule for every card the studio
     * offers ("The price is always the value"). Neither figure means
     * anything on an editable product: the teacher's amount is both. */
    const salePrice = num(e["SalePrice"]);
    data.push({
      id,
      editable,
      cardValue: roundToCents(Math.max(0, cardValue)),
      salePrice: roundToCents(
        salePrice !== null && salePrice > 0 ? salePrice : Math.max(0, cardValue),
      ),
      /* T101: this is the product's NAME on the counter's gift card box,
       * so it is stripped of any markup the owner typed into Mindbody
       * before it leaves the server (the T99 review flagged it as the one
       * rich-text field reaching the browser unrendered) and collapsed to
       * a single line, because it is a button's label. */
      description: giftCardDescription(e["Description"]),
    });
  }
  /* By value, which is the order the preset chips read in. An editable
   * product sorts to the front on its zero value and is never a preset
   * anyway: it is the pad's product, not a chip. */
  data.sort((a, b) => a.cardValue - b.cardValue);
  cache = { key, at: Date.now(), data, allIds };
  return data;
}

/**
 * T103: every gift card PRODUCT id the site has, so no cart line can
 * carry one.
 *
 * Two live comped sales on 2026-09-17 settled what a gift card as a cart
 * line does: the editable custom-amount product priced at $0.00 (a free
 * card), a fixed one priced and discounted correctly, and BOTH sales
 * came back holding no items at all. So the cart is not the route for a
 * gift card, `purchasegiftcard` is, and /api/checkout refuses such a
 * line before it calls anything.
 *
 * It reads through giftCardProducts' own two-minute cache rather than
 * forcing a refresh: the list changes a few times a year, the gift card
 * sale path in the same request reads it anyway, and a per-checkout
 * refresh would buy a metered call on every sale to close a window two
 * minutes wide. What it never does is FAIL OPEN: a read that does not
 * answer throws, and the route refuses the ticket, because a refusal
 * turned off by a failed read is not a rail.
 */
export async function giftCardProductIds(): Promise<Set<number>> {
  await giftCardProducts();
  return new Set(cache?.allIds ?? []);
}

/**
 * T96: the product the number pad sells through, or null when the site
 * has none (in which case the pad can only resolve to a preset, exactly
 * as T95 left it).
 *
 * Site 471 has exactly one. A site with several is not a shape Mindbody
 * documents or that this studio has, so the LOWEST id is taken and the
 * choice is recorded in the T96 ticket rather than guessed at per sale:
 * one product, chosen the same way on every call, is the only answer
 * that cannot price two identical tickets differently.
 */
export function editableGiftCardProduct(
  products: readonly GiftCardProduct[],
): GiftCardProduct | null {
  let best: GiftCardProduct | null = null;
  for (const p of products) {
    if (!p.editable) continue;
    if (best === null || p.id < best.id) best = p;
  }
  return best;
}

/**
 * T96: the amounts an editable gift card may be sold for, one constant
 * each. A dollar is the floor because a card worth less than the ink is
 * a mistyped figure, and a thousand the ceiling because a counter tap
 * should not be able to sell a car; both are refused in words, on both
 * sides, before anything is charged.
 */
export const MIN_GIFT_CARD_AMOUNT = 1;
export const MAX_GIFT_CARD_AMOUNT = 1000;

/** A dollar figure as a refusal names it: "$1.00", "$1,000.00". */
function dollars(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
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
    value: figure(res?.Value),
    amountPaid: figure(res?.AmountPaid),
    saleId: figure(res?.SaleId),
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
  /**
   * T96: the amount to sell this card for, in dollars, and ONLY for the
   * editable product: it is the one figure on a ticket the teacher does
   * choose, because Mindbody prices that product from the payment and
   * has no other way of being told. Every other number still comes from
   * the live product list. A fixed product sent an amount is refused
   * rather than honoured, so the browser cannot name a price for a card
   * Mindbody prices itself.
   */
  amount?: number;
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
    const amount = (entry as { amount?: unknown } | null)?.amount;
    if (!Number.isInteger(productId) || (productId as number) <= 0) {
      return { lines: null, error: "each gift card line needs a productId" };
    }
    if (!Number.isInteger(quantity) || (quantity as number) < 1) {
      return {
        lines: null,
        error: "each gift card line needs a quantity of at least 1",
      };
    }
    /* T96: the amount, when one came. Whole cents inside the two
     * constants, refused in words on both sides; anything else is a
     * figure nobody typed. */
    let chosen: number | null = null;
    if (amount !== undefined && amount !== null) {
      if (typeof amount !== "number" || !Number.isFinite(amount)) {
        return { lines: null, error: "a gift card amount must be a number" };
      }
      const cents = Math.round(amount * 100);
      if (Math.abs(amount * 100 - cents) > 0.001) {
        return { lines: null, error: "a gift card amount must be whole cents" };
      }
      if (cents < MIN_GIFT_CARD_AMOUNT * 100) {
        return {
          lines: null,
          error: `the smallest gift card this app sells is ${dollars(MIN_GIFT_CARD_AMOUNT)}`,
        };
      }
      if (cents > MAX_GIFT_CARD_AMOUNT * 100) {
        return {
          lines: null,
          error: `the largest gift card this app sells is ${dollars(MAX_GIFT_CARD_AMOUNT)}`,
        };
      }
      chosen = roundToCents(cents / 100);
    }
    cards += quantity as number;
    if (cards > MAX_GIFT_CARDS) {
      return {
        lines: null,
        error: `a ticket holds at most ${MAX_GIFT_CARDS} gift cards`,
      };
    }
    lines.push({
      productId: productId as number,
      quantity: quantity as number,
      ...(chosen === null ? {} : { amount: chosen }),
    });
  }
  return { lines, error: null };
}

/** One CARD to sell: a line's quantity expanded, because each card is a
 *  call of its own with an id of its own. */
export interface GiftCardUnit {
  productId: number;
  /** T96: what the card is expected to be WORTH. The product's CardValue
   *  for a fixed product, the teacher's amount for the editable one, and
   *  either way the figure Mindbody's rehearsed `Value` must equal to the
   *  cent before anything is charged. */
  cardValue: number;
  /** T96: what to CHARGE for it, and so the PaymentInfo amount. The
   *  product's SalePrice for a fixed product, the teacher's amount for
   *  the editable one (which is what makes the card worth it). */
  amount: number;
  /** T96: which of the two rules above priced this card, for the wording
   *  of a refusal and for nothing else. */
  editable: boolean;
}

/**
 * The units a ticket's gift card lines mean, priced from the LIVE product
 * list. A string return is the refusal to answer the browser with: a
 * product id the site does not have is a stale shelf, not something to
 * guess at.
 *
 * T97: `shelf`, when it is given, is the shelf config, and a preset the
 * studio turned off in the drawer is refused HERE rather than sold. The
 * screen never offers one (/api/gift-cards drops it server-side), so this
 * is the guard for the browser that is holding an older list, and it says
 * which of the two things happened in words: turned off at this counter is
 * not the same as gone from Mindbody. The editable product is never
 * hidden (`giftCardHidden`), so the pad cannot be turned off this way.
 */
export function resolveGiftCardUnits(
  lines: readonly GiftCardLine[],
  products: readonly GiftCardProduct[],
  shelf?: ShelfConfig,
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
    if (shelf !== undefined && giftCardHidden(shelf, product)) {
      return {
        units: null,
        /* T97 review: the sentence a TEACHER reads, so it does not send
         * them to the dev drawer, which 404s on the counter iPad. It still
         * says the thing that matters: this counter turned the card off,
         * which is not the same as Mindbody no longer having it. */
        error:
          "That gift card is turned off at this counter, so it cannot be " +
          "sold. Remove the line. Nothing was charged.",
      };
    }
    /* T96: the editable product is priced by the amount and by nothing
     * else, so an amount is REQUIRED with it and refused on every other
     * product. Both refusals mean the browser and the live product list
     * disagree about which card this is, which is a stale shelf, not
     * something to charge a guess for. */
    if (product.editable && line.amount === undefined) {
      return {
        units: null,
        error:
          "That gift card is sold for an amount the teacher enters, and no " +
          "amount came with it. Remove the line and add it again. Nothing " +
          "was charged.",
      };
    }
    if (!product.editable && line.amount !== undefined) {
      return {
        units: null,
        error:
          "Mindbody prices that gift card itself, so an amount cannot be " +
          "chosen for it. Remove the line and add it again. Nothing was " +
          "charged.",
      };
    }
    const cardValue = product.editable
      ? (line.amount as number)
      : product.cardValue;
    const amount = product.editable
      ? (line.amount as number)
      : product.salePrice;
    for (let i = 0; i < line.quantity; i++) {
      units.push({
        productId: product.id,
        cardValue,
        amount,
        editable: product.editable,
      });
    }
  }
  return { units, error: null };
}

/* T102: giftCardTotal lived here and was the sum of the units' own
 * amounts. What a ticket's cards COST is no longer that sum: a discount
 * comes off each card's payment (/api/checkout spreads it over the cart
 * lines and the cards together), so the figure is computed there from
 * what each card is actually charged, and a helper that ignored the
 * discount would be a wrong total waiting to be called. */

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
