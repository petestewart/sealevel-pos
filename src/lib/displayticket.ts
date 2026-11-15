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
 *    from a fixed list ("Account balance", "Card", "Cash", "Gift card",
 *    "No charge"), with an amount on a split, and never a payment
 *    detail: since T240 not even a card's last four reaches that screen.
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
  /**
   * T240 (Pete: "we should always list the payment method on the custmer
   * ipad"): how the student is paying, on every mode. One entry per
   * tender, in the teacher's order. `amount` is present only when it is
   * not simply the whole total, which is a split's two legs (or one leg
   * that does not yet cover the ticket, on the live mirror). Absent when
   * no tender is on the ticket yet.
   */
  tenders?: TicketTender[];
  /**
   * T241 (Pete: "would be better to surface a choice to the customer for
   * the payment method if they want to switch it"): the other ways to pay
   * that the TEACHER'S iPad will accept for this ticket, in a fixed
   * order. Present only on a live or approve ticket whose tender is ONE
   * method or none yet (a split shows no Change control) and whose total
   * Mindbody has priced. Each entry is a key from TENDER_CHOICES and nothing else; the
   * account entry carries the balance it would draw on, and the "A
   * different card" entry whether a "Save this card" box may be offered.
   * The display renders these; /api/display/choose and /api/display/card
   * refuse anything not on the list the SERVER stored.
   */
  choices?: TenderOffer[];
  /** Summary only: what was charged, and whether a receipt was
   *  CONFIRMED emailed (null when none was asked for). */
  charged?: number;
  emailedReceipt?: boolean | null;
}

/**
 * T240: the only words a tender may be on the customer screen. A fixed
 * list rather than free text, so `readTicketPayload` can refuse anything
 * else outright: there is no string a caller could put here that
 * carries a card's digits, a gift card's number or a client's name.
 */
export const TENDER_WORDS = [
  "Account balance",
  "Card",
  "Cash",
  "Gift card",
  "No charge",
] as const;
export type TenderWord = (typeof TENDER_WORDS)[number];

export interface TicketTender {
  word: TenderWord;
  /** Dollars, Mindbody-priced or the teacher's own split. */
  amount?: number;
}

/**
 * T241: the ways to pay a student may pick on the customer iPad, as
 * /api/checkout spells the method each one becomes. A fixed list, in the
 * order the Change list draws them, so nothing the display sends can be
 * anything but one of these five keys.
 */
export const TENDER_CHOICES = [
  "credit",
  "storedcard",
  "cash",
  "giftcard",
  "typedcard",
] as const;
export type TenderChoice = (typeof TENDER_CHOICES)[number];

export function isTenderChoice(v: unknown): v is TenderChoice {
  return (
    typeof v === "string" && (TENDER_CHOICES as readonly string[]).includes(v)
  );
}

export interface TenderOffer {
  choice: TenderChoice;
  /** `credit` only, and required there: the balance, in dollars, which
   *  covers the whole total (Pete, on showing the balance: "yes"). */
  available?: number;
  /** `typedcard` only: true when the ticket's client is a real person,
   *  so a "Save this card for next time" box may be offered (T93's keep
   *  on file, which /api/checkout refuses for the house client). */
  keep?: boolean;
}

/** T241: the words a choice reads as on the CUSTOMER screen. No digits
 *  of any card, ever: "Card on file" is the whole of it. */
export function choiceWord(offer: TenderOffer): string {
  switch (offer.choice) {
    case "credit":
      return offer.available === undefined
        ? "Account balance"
        : `Account balance (${offer.available.toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
          })} available)`;
    case "storedcard":
      return "Card on file";
    case "cash":
      return "Cash";
    case "giftcard":
      return "Gift card";
    case "typedcard":
      return "A different card";
  }
}

/** T241: the same choice in the TEACHER's sentence ("Taylor chose
 *  Cash"). */
export function choiceTeacherWord(choice: TenderChoice): string {
  switch (choice) {
    case "credit":
      return "Account balance";
    case "storedcard":
      return "Card on file";
    case "cash":
      return "Cash";
    case "giftcard":
      return "Gift card";
    case "typedcard":
      return "a different card";
  }
}

/**
 * T240: a tender method, as /api/checkout spells it, in the customer
 * screen's words. A stored card and a card typed at the counter are both
 * "Card" to the person paying; a comp is "No charge".
 */
export function tenderWord(method: unknown): TenderWord | null {
  switch (method) {
    case "credit":
      return "Account balance";
    case "storedcard":
    case "typedcard":
      return "Card";
    case "cash":
      return "Cash";
    case "giftcard":
      return "Gift card";
    case "comp":
      return "No charge";
    default:
      return null;
  }
}

/**
 * T240: the tender a charge body describes, in words, or null when it
 * describes none. Reads ONLY `method`, and `split.legs[].method` and
 * `.amount`, the shape /api/checkout accepts (and that the approval cart
 * carries, without any card or gift card number), so the words a student
 * approves and the tender the server hashes come from the same fields.
 * A single method carries no amount: it pays the whole total, which the
 * ticket already shows.
 */
export function tendersFromCharge(input: unknown): TicketTender[] | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const body = input as Record<string, unknown>;
  const split = body["split"];
  if (split !== undefined && split !== null) {
    const legs = (split as { legs?: unknown })?.legs;
    if (!Array.isArray(legs) || legs.length === 0 || legs.length > 2) {
      return null;
    }
    const out: TicketTender[] = [];
    for (const leg of legs) {
      const word = tenderWord((leg as { method?: unknown })?.method);
      const amount = money((leg as { amount?: unknown })?.amount);
      if (word === null || amount === null) return null;
      out.push({ word, amount });
    }
    return out;
  }
  const word = tenderWord(body["method"]);
  return word === null ? null : [{ word }];
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
/** T240: /api/checkout takes one method or exactly two split legs. */
const MAX_TENDERS = 2;

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
  /* T240: the tender, rebuilt like the lines: each entry a word from
   * TENDER_WORDS and an optional amount, and nothing else copied. A
   * malformed list is refused rather than half-shown, because a student
   * reading one of two payments has been told something untrue. */
  if (raw.tenders !== undefined && raw.tenders !== null) {
    const tenders = readTenders(raw.tenders);
    if (typeof tenders === "string") return { ok: false, error: tenders };
    if (tenders.length > 0) out.tenders = tenders;
  }
  /* T241: the offer, rebuilt like the tender. Kept only where a Change
   * control belongs: a live or approve ticket, priced above zero, paid
   * by ONE method that is not a full comp. Anything else is dropped
   * rather than refused, because an offer that cannot apply is simply
   * not made. */
  if (
    raw.choices !== undefined &&
    raw.choices !== null &&
    mode !== "summary" &&
    /* T241 review: no tender yet counts too, so a student whose card was
     * let go of (or whose gift card entry was cancelled) can choose
     * again rather than wait for the teacher to pick a tile. */
    (out.tenders === undefined ||
      (out.tenders.length === 1 && out.tenders[0]?.word !== "No charge")) &&
    out.total !== null &&
    out.total > 0
  ) {
    const choices = readChoices(raw.choices, out.total);
    if (typeof choices === "string") return { ok: false, error: choices };
    if (choices.length > 0) out.choices = choices;
  }
  if (mode === "summary") {
    const charged = money(raw.charged);
    if (charged !== null) out.charged = charged;
    out.emailedReceipt =
      typeof raw.emailedReceipt === "boolean" ? raw.emailedReceipt : null;
  }
  return { ok: true, value: out as TicketPayload & Record<string, unknown> };
}

/** T240: a payload's tender list, or the reason it is not one. */
function readTenders(value: unknown): TicketTender[] | string {
  if (!Array.isArray(value)) return "tenders must be an array";
  if (value.length > MAX_TENDERS) {
    return `too many tenders (over ${MAX_TENDERS})`;
  }
  const out: TicketTender[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return "each tender must be an object";
    }
    const t = entry as Record<string, unknown>;
    const word = TENDER_WORDS.find((w) => w === t.word);
    if (word === undefined) {
      return `each tender's word must be one of ${TENDER_WORDS.join(", ")}`;
    }
    if (t.amount === undefined || t.amount === null) {
      out.push({ word });
      continue;
    }
    const amount = money(t.amount);
    if (amount === null || amount < 0) {
      return "a tender's amount must be dollars";
    }
    out.push({ word, amount });
  }
  return out;
}

/** T241: a payload's offer, in TENDER_CHOICES order with no repeats,
 *  or the reason it is not one. An account entry whose balance does not
 *  cover `total` is dropped: Pete's rule is that it is offered only
 *  when the balance pays the whole ticket. */
function readChoices(value: unknown, total: number): TenderOffer[] | string {
  if (!Array.isArray(value)) return "choices must be an array";
  if (value.length > TENDER_CHOICES.length) return "too many choices";
  const seen = new Map<TenderChoice, TenderOffer>();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return "each choice must be an object";
    }
    const c = entry as Record<string, unknown>;
    if (!isTenderChoice(c.choice)) {
      return `each choice must be one of ${TENDER_CHOICES.join(", ")}`;
    }
    if (seen.has(c.choice)) continue;
    if (c.choice === "credit") {
      const available = money(c.available);
      if (available === null || available < total) continue;
      seen.set("credit", { choice: "credit", available });
      continue;
    }
    if (c.choice === "typedcard") {
      seen.set("typedcard", { choice: "typedcard", keep: c.keep === true });
      continue;
    }
    seen.set(c.choice, { choice: c.choice });
  }
  return TENDER_CHOICES.flatMap((k) => {
    const o = seen.get(k);
    return o === undefined ? [] : [o];
  });
}

/** T241: whether a stored ticket's offer includes `choice`. Read off
 *  the payload the SERVER rebuilt and keeps, never off a request body. */
export function offerOf(
  payload: Record<string, unknown>,
  choice: TenderChoice,
): TenderOffer | null {
  const list = payload.choices;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      (entry as TenderOffer).choice === choice
    ) {
      return entry as TenderOffer;
    }
  }
  return null;
}

/** T240: the tender as one line of words, "Card", or on a split
 *  "Account balance $15.00, Card $10.00". The display's own formatting
 *  of figures it was handed; no arithmetic. */
export function tenderSentence(tenders: readonly TicketTender[]): string {
  return tenders
    .map((t) =>
      t.amount === undefined
        ? t.word
        : `${t.word} ${t.amount.toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
          })}`,
    )
    .join(", ");
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
