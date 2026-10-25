import { createHash } from "node:crypto";

/**
 * T203 (Phase 2.5 item 4): the hash that ties a customer's approval to
 * the ticket they approved.
 *
 * When `customer_confirms_sale` is on, the Charge tap first puts the
 * priced ticket on the customer screen and the server records a sha256
 * of that cart on the request's SERVER-ONLY half. The checkout that
 * follows carries the approval's id, and /api/checkout hashes the cart it
 * is about to charge with THIS SAME helper: equal hashes mean the ticket
 * did not move between the customer tapping Approve and the teacher
 * tapping Charge, and a different hash is refused in words ("The ticket
 * changed after the customer approved it").
 *
 * Two rules make that honest.
 *
 * 1. **The server hashes; the browser never sends a hash.** Both routes
 *    are handed the cart in the same shape the browser already sends to
 *    /api/price-cart and /api/checkout, and each computes the digest
 *    itself. A hash from a browser would be a promise that the ticket had
 *    not changed, made by the thing that changed it.
 * 2. **One helper, so the two routes cannot drift.** If they canonicalised
 *    differently, every approval would refuse its own checkout, which is
 *    a counter that cannot sell anything.
 *
 * WHAT IS INSIDE THE HASH, exactly:
 *
 * - the client the sale is for (`clientId`, trimmed; "" for a walk-in on
 *   the house client), because an approval is one person's;
 * - every cart line: its `type`, its `metadataId` as a string, its
 *   quantity, its unit price in whole cents, and the `forClientId` of a
 *   T90 line bought for somebody else;
 * - every gift card line (T95/T96): its product id, its quantity and the
 *   chosen amount in cents when the product is the editable one;
 * - the whole-cart discount (T79), as its mode and value.
 *
 * WHAT IS DELIBERATELY NOT, and why:
 *
 * - **Tax and the total.** /api/checkout is never sent them: they are
 *   Mindbody's, read from /api/price-cart's answer, and the route
 *   rehearses its own total with `Test: true` and refuses a disagreement
 *   (T75). Hashing a figure one route holds and the other does not would
 *   make the two hashes unequal by construction. What DETERMINES the
 *   total -- the lines, the quantities, the unit prices, the discount and
 *   the client -- is in the hash, so a ticket that would price
 *   differently hashes differently.
 * - **The tender.** How the customer pays is not what they approved; they
 *   approved what is being sold and for how much. A teacher who switches
 *   from cash to a card after the tap must not have to ask again.
 * - **`taxExempt` and `taxRate`.** Catalog facts, identical on both
 *   sides, that no student reads off the screen.
 * - **Item names, receipt toggles, tokens and idempotency keys.** None of
 *   them changes what is being bought.
 *
 * ORDER DOES NOT MATTER: the lines are sorted by their own canonical text
 * before hashing, so a cart rebuilt in another order (the sale screen
 * groups lines for other clients as it renders) is the same ticket. Two
 * lines of the same item, quantity and price are interchangeable by
 * definition, so sorting cannot hide a change.
 *
 * Nothing in this file calls Mindbody, and nothing in it may.
 */

/** Domain separation, and a version to bump if the shape ever changes. */
const VERSION = "t203/cart/v1";

function cents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** One cart line, canonically. Unreadable fields become empty or 0 rather
 *  than throwing: an invalid cart is refused by the route's own parser a
 *  moment later, and this only has to be the SAME for the same body. */
function lineText(entry: unknown): string {
  const l =
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
  const type = textOf(l["type"]);
  const id =
    typeof l["metadataId"] === "string" || typeof l["metadataId"] === "number"
      ? String(l["metadataId"])
      : "";
  const qty =
    typeof l["quantity"] === "number" && Number.isFinite(l["quantity"])
      ? Math.round(l["quantity"])
      : 0;
  const price = cents(l["price"]) ?? 0;
  const forClient = textOf(l["forClientId"]);
  return `item|${type}|${id}|${qty}|${price}|${forClient}`;
}

/** One gift card line, canonically (T95's shape: a product id, how many,
 *  and an amount only for the editable custom-amount product). */
function giftText(entry: unknown): string {
  const g =
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
  const id =
    typeof g["productId"] === "number" || typeof g["productId"] === "string"
      ? String(g["productId"])
      : "";
  const qty =
    typeof g["quantity"] === "number" && Number.isFinite(g["quantity"])
      ? Math.round(g["quantity"])
      : 0;
  const amount = cents(g["amount"]);
  return `gift|${id}|${qty}|${amount === null ? "" : amount}`;
}

/** The discount, canonically, or the empty line for none. */
function discountText(raw: unknown): string {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return "discount|none";
  }
  const d = raw as Record<string, unknown>;
  const mode = textOf(d["mode"]);
  const value =
    typeof d["value"] === "number" && Number.isFinite(d["value"])
      ? Math.round(d["value"] * 100)
      : 0;
  return `discount|${mode}|${value}`;
}

/**
 * The canonical text a cart hashes to. Exported so a driver (and a
 * reader) can see exactly what went in without reversing a digest.
 *
 * `input` is the body both routes already receive: `items`, `giftCards`,
 * `discount` and `clientId` at its top level.
 */
export function canonicalCart(input: unknown): string {
  const body =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const items = Array.isArray(body["items"]) ? body["items"] : [];
  const gifts = Array.isArray(body["giftCards"]) ? body["giftCards"] : [];
  const lines = [
    ...items.map(lineText),
    ...gifts.map(giftText),
  ].sort();
  return [
    VERSION,
    `client|${textOf(body["clientId"])}`,
    ...lines,
    discountText(body["discount"]),
  ].join("\n");
}

/** The sha256 of that text, lowercase hex. */
export function cartSha256(input: unknown): string {
  return createHash("sha256").update(canonicalCart(input), "utf8").digest("hex");
}
