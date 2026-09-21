/**
 * The ticket scene's payload (T201, Phase 2.5 item 2; design
 * docs/design/customer-display.md "Scene 2").
 *
 * Two modes on one shape. `live` is the mirror of the priced cart as the
 * teacher builds it, and is the one scene kind that is REPLACED in place
 * rather than completed. `summary` is what the student sees for a few
 * seconds after the charge: the same ticket plus how it was paid and a
 * thank you.
 *
 * Two rules are written into this file rather than left to the caller.
 *
 * 1. **Every figure here came from Mindbody's own pricing**, through
 *    /api/price-cart's answer or the checkout answer. The display does no
 *    arithmetic with them; it formats them. The one derived number is a
 *    line's extended price, which the teacher's ticket derives the same
 *    way from the catalog's unit price.
 * 2. **Nothing that identifies an account, an item or a card may travel.**
 *    `readTicketPayload` builds a NEW object field by field, so a client
 *    id, a pricing option id, a product id, a card number or anything
 *    else a caller put in the body is dropped on the floor rather than
 *    forwarded to a screen a student is holding. The tender is a WORD
 *    ("Cash", "Card ending 1234"), never a payment detail.
 *
 * Nothing in this file calls Mindbody, and nothing in it may.
 */

/**
 * T203 adds `approve` (Phase 2.5 item 4): the same priced ticket, plus
 * nothing, with Cancel and Approve on it. It is the one mode the student
 * ANSWERS, and the answer is a precondition /api/checkout checks, never
 * an action that charges.
 */
export type TicketMode = "live" | "summary" | "approve";

export interface TicketLine {
  /** The item's name as the catalog gave it. Rendered through plainText. */
  name: string;
  quantity: number;
  /** Dollars. */
  unitPrice: number;
  /** Dollars, this line's extended price. */
  linePrice: number;
  /** Dollars off this line, when the ticket carries a discount. */
  discount?: number;
}

export interface TicketPayload {
  mode: TicketMode;
  clientFirstName: string | null;
  lines: TicketLine[];
  /** Mindbody's figures. Null when the cart has not been priced yet, in
   *  which case the display shows the lines and no totals rather than a
   *  number nobody stands behind. */
  subtotal: number | null;
  discountTotal?: number;
  tax: number | null;
  total: number | null;
  /** Summary only: the tender in words, what was charged, and whether a
   *  receipt was CONFIRMED emailed (null when none was asked for). */
  tender?: string;
  charged?: number;
  emailedReceipt?: boolean | null;
}

/**
 * The greeting's name, and only that: a first name is the most the
 * customer screen ever learns about the person standing at the counter.
 *
 * T209 moved it here from SaleScreen so every screen that builds a
 * ticket payload -- the Cart screen and the roster's "Pay and check in"
 * -- greets the same person by the same name.
 */
export function displayFirstName(name: string | null): string | null {
  if (name === null) return null;
  const first = name.trim().split(/\s+/)[0];
  return first === undefined || first.length === 0 ? null : first;
}

/** A ticket is a handful of lines; a longer one is a bug, not a sale. */
const MAX_LINES = 40;
const MAX_NAME = 120;
const MAX_TENDER = 60;

function money(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  /* Cents, and nothing sillier than a studio's biggest ticket. */
  if (Math.abs(v) > 100_000) return null;
  return Math.round(v * 100) / 100;
}

function text(v: unknown, limit: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, limit);
}

/**
 * Reads a body's `payload` into the ticket shape, or says why it cannot.
 * Extra keys are not an error: they are simply not copied, which is what
 * makes this a strip rather than a check.
 */
export function readTicketPayload(
  value: unknown,
):
  | { ok: true; value: TicketPayload & Record<string, unknown> }
  | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== "live" && mode !== "summary" && mode !== "approve") {
    return { ok: false, error: "mode must be live, summary or approve" };
  }
  if (!Array.isArray(raw.lines)) {
    return { ok: false, error: "lines must be an array" };
  }
  if (raw.lines.length > MAX_LINES) {
    return { ok: false, error: `too many lines (over ${MAX_LINES})` };
  }
  const lines: TicketLine[] = [];
  for (const entry of raw.lines) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "each line must be an object" };
    }
    const l = entry as Record<string, unknown>;
    const name = text(l.name, MAX_NAME);
    const unitPrice = money(l.unitPrice);
    const linePrice = money(l.linePrice);
    const quantity =
      typeof l.quantity === "number" && Number.isFinite(l.quantity)
        ? Math.max(1, Math.min(999, Math.round(l.quantity)))
        : null;
    if (name === null || unitPrice === null || linePrice === null || quantity === null) {
      return {
        ok: false,
        error: "each line needs name, quantity, unitPrice and linePrice",
      };
    }
    const discount = money(l.discount);
    lines.push({
      name,
      quantity,
      unitPrice,
      linePrice,
      ...(discount !== null && discount !== 0 ? { discount } : {}),
    });
  }

  const out: TicketPayload = {
    mode,
    clientFirstName: text(raw.clientFirstName, 40),
    lines,
    subtotal: money(raw.subtotal),
    tax: money(raw.tax),
    total: money(raw.total),
  };
  const discountTotal = money(raw.discountTotal);
  if (discountTotal !== null && discountTotal !== 0) {
    out.discountTotal = discountTotal;
  }
  if (mode === "summary") {
    const tender = text(raw.tender, MAX_TENDER);
    if (tender !== null) out.tender = tender;
    const charged = money(raw.charged);
    if (charged !== null) out.charged = charged;
    out.emailedReceipt =
      typeof raw.emailedReceipt === "boolean" ? raw.emailedReceipt : null;
  }
  return { ok: true, value: out as TicketPayload & Record<string, unknown> };
}

/** Whether a stored request is an APPROVE ticket, which is the scene
 *  /api/checkout looks the customer's answer up on (T203). */
export function isApproveTicket(
  kind: string,
  payload: Record<string, unknown>,
): boolean {
  return kind === "ticket" && payload.mode === "approve";
}

/** Whether a stored request is a live ticket, which is the one scene a
 *  later present REPLACES rather than 409s against. */
export function isLiveTicket(
  kind: string,
  payload: Record<string, unknown>,
): boolean {
  return kind === "ticket" && payload.mode === "live";
}
