import { NextResponse } from "next/server";

import {
  actorFields,
  type ActorFallback,
  endedStaffSession,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import {
  requireSession,
  spendCompToken,
  teacherLogTag,
  verifyCompToken,
  type TeacherIdentity,
} from "@/lib/auth";
import {
  COMP_DETAIL_MAX,
  COMP_DETAIL_MIN,
  discountCents,
  discountPercentLabel,
  discountRecordLine,
  discountRefusal,
  isCompKind,
  isFullDiscount,
  parseDiscount,
  subtotalCents,
  type CompReason,
  type Discount,
  compNeedsDetail,
} from "@/lib/comp";
import { insertCompReceipt, type CompReceiptItem } from "@/lib/db";
import {
  giftCardBalance,
  giftCardLastFour,
  parseGiftCardNumber,
} from "@/lib/giftcard";
import {
  freshGiftCardId,
  giftCardProducts,
  giftCardTotal,
  logGiftCardSale,
  parseGiftCardLines,
  purchaseGiftCard,
  resolveGiftCardUnits,
} from "@/lib/giftcardsale";
import { fileFormulaNote } from "@/lib/formulanote";
import { dryRunState, mindbodyHttpStatus, target } from "@/lib/mindbody";

import {
  parseTypedCard,
  typedCardLastFour,
  type TypedCard,
} from "@/lib/typedcard";
import { saveClientCard } from "@/lib/clientcard";

import {
  CARD_MINIMUM_USD,
  checkoutCart,
  clientPaymentProfile,
  groupByRecipient,
  houseClientId,
  latestSaleId,
  parseCartLines,
  passWithoutOwner,
  purchaseCredit,
  rehearseCheckout,
  roundToCents,
  splitDiscount,
  type CartLine,
  type CheckoutPayment,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * POST /api/checkout -- the one route that moves money. Fires only from
 * an explicit Charge tap; nothing in this app auto-charges.
 *
 * Body: { items: CartLine[], clientId?: string,
 *         method: "storedcard"|"typedcard"|"credit"|"cash"|"giftcard"|"comp",
 *         giftCard?: { number },
 *         typedCard?: { number, expMonth, expYear, cvv, billingName,
 *                       postalCode, address?, city?, state?, keep? },
 *         cashTendered?: number,
 *         sendEmail?: boolean,
 *         discount?: { mode: "amount"|"percent", value: number },
 *         teacherToken?: string,
 *         compReason?: { kind, detail } }
 *         -- T53: `sendEmail` is the pay-mode "Email receipt" toggle.
 *         It is honoured only on a NAMED client's sale: an anonymous
 *         sale rides the house client, whose inbox is nobody's. T82:
 *         a comped sale receipts exactly like a paid one (Pete:
 *         "Receipts should get emailed even with comp, today it
 *         disallows it"), so nothing about the discount is read here.
 *         Sent to Mindbody as the checkout's `SendEmail` and the credit
 *         purchase's `SendEmailReceipt`; the answer carries
 *         `receiptRequested` and `emailReceipt` (true only when Mindbody
 *         CONFIRMED one went, which only /sale/purchaseaccountcredit
 *         reports; a cart checkout answers nothing, so it stays null and
 *         the done screen says "requested", not "emailed").
 *         -- T79: `discount` is a discount on the WHOLE cart (Pete: "if
 *         it's $100 sale i should be able to comp $60 of it and they pay
 *         $40 ... 100% discount would be a comp in essense"). Validated
 *         by parseDiscount against the lines' pre-tax subtotal and
 *         refused for a cart with a package line (Mindbody ignores a
 *         discount on a package). The per-line amounts are recomputed
 *         SERVER-SIDE from the cart lines (sale.ts spreadDiscount) and
 *         sent as CheckoutItemWrapper.DiscountAmount; nothing per-line
 *         from the browser is read. A discount needs `teacherToken` and
 *         `compReason`, both refused without one. Method "comp" is the
 *         100% case only: the discount must cover the whole subtotal,
 *         no tender is read, and the write goes out first with the
 *         discount lines and NO Payments; if Mindbody ANSWERS a 4xx
 *         naming payment -- a definite refusal, so nothing was written,
 *         never a 5xx, a dead transport or an error raised on our own
 *         side -- ONE retry goes out in the proven T43 shape (no DiscountAmount, one Comp payment for the full
 *         undiscounted total, rehearsed first), and the answer and the
 *         record carry `discountShape: "lines" | "comp-payment"`. Any
 *         other method (or a split) needs a discount that leaves
 *         something to pay, and pays Mindbody's discounted total the
 *         ordinary way.
 *         -- T48: `teacherToken` is REQUIRED with a discount and refused
 *         without one. It is the one-shot value /api/teacher/verify
 *         signed for the teacher whose PIN matched, ten minutes old at
 *         most; without a valid one the discount is 401 `reason:
 *         "teacher"` before anything else is read, in every
 *         configuration (POS_PIN set or not), and the dialog goes back
 *         to its PIN step. The teacher on the receipt, the `[comp]` line
 *         and the Notes record is the one the token names, never a name
 *         from the browser.
 *         -- T43/T45: `compReason` is data: `kind` from comp.ts's
 *         COMP_KINDS (trade, damaged, other since T79), `detail` trimmed
 *         and at most 200 characters (at least 3 for trade and other,
 *         else may be empty). Checked before any Mindbody call. None of
 *         it reaches the checkout payload, whose request has no notes
 *         field; it is recorded in comp_receipts when a database is
 *         configured and ALWAYS as one `[comp]` server log line, and
 *         after a REAL discounted sale for a named client it is filed
 *         on the client (see recordDiscount below). Each item may carry
 *         a `name` on a discounted sale, for that record only; it is
 *         never forwarded.
 *         -- T83: `method: "giftcard"` spends a gift card, and needs
 *         `giftCard: { number }`, the barcode id off the card. The
 *         balance is re-read here (`GET /sale/giftcardbalance`) and an
 *         amount above it is refused 409 with the balance named and
 *         nothing written; the number goes out only inside the
 *         `GiftCard` Payments entry and appears in NO log line, note,
 *         receipt row or response, which carry the last four alone. A
 *         gift card needs no client, like cash: an anonymous sale rides
 *         the house client.
 *         -- T94: `overdraftToken`, a one-shot token from
 *         /api/teacher/verify, is what allows an account charge ABOVE the
 *         live balance (Pete: "Accounts should be able to be charged even
 *         if there is insufficient balance ... This will require the
 *         teacher's PIN to authorize"). Without it the 409 stands. It is
 *         refused beside any method that is not an account charge, spent
 *         once like a discount's token, and the shortfall is this route's
 *         own arithmetic on the profile it re-read; the browser's balance
 *         decides nothing. The overdraft is logged with the teacher's
 *         staff id and filed on the client (T45's note path) after the
 *         charge resolved. The DebitAccount payment shape is unchanged:
 *         whether Mindbody itself accepts a DebitAccount above the
 *         balance is an OPEN QUESTION for a live probe, and its refusal
 *         is a plain refusal, never retried in another shape.
 *         -- T93: `method: "typedcard"` charges a card TYPED at the
 *         counter (Pete: "this will open a credit card manual entry
 *         modal ... If it is a walk in sale, they can just use it for
 *         the sale"), as a `CreditCard` Payments entry. It needs
 *         `typedCard`, validated here by parseTypedCard (Luhn, expiry
 *         not past, CVV, name, postal code) exactly as the modal
 *         validated it, because a browser's checks are a courtesy and
 *         not a rule. Like cash and a gift card it needs no client; a
 *         walk-in sale rides the house client. `typedCard.keep` asks
 *         for the card to be kept on file and is REFUSED without an
 *         attached client (a card on the house client belongs to
 *         nobody); when it is asked for, the store runs AFTER a
 *         successful charge, through T84's /api/client-card path
 *         (saveClientCard), so a refused charge stores nothing and a
 *         stored card never precedes a charge. Its outcome is reported
 *         separately as `cardKept` / `cardKeptError`: a store that
 *         failed after a charge that succeeded is said so in words and
 *         never hidden. The number and the CVV go out only inside the
 *         CreditCard payment and appear in NO log line, note, receipt
 *         row or response: those carry `typedCard: { lastFour }` and
 *         nothing more.
 *   or, since T28, `split` instead of `method`:
 *       { items, clientId, split: { legs: [{method, amount}, {method,
 *         amount}] } } -- exactly two legs, methods from the whitelist
 *         minus comp (T83: a `giftcard` leg carries its own `number`
 *         and is balance-checked exactly as the whole-sale case is;
 *         T93: a `typedcard` leg carries its own `typedCard`), amounts in whole cents that sum EXACTLY to the
 *         rehearsed server total, charged as two Payments entries in ONE
 *         checkoutshoppingcart call (no two-write seam; a refusal
 *         refuses the whole sale). The card minimum applies to the card
 *         LEG.
 *
 * Executes PLAN 2.3's table EXACTLY, and never collapses the card paths
 * (the design doc: routing every card sale through purchaseaccountcredit
 * would record a $150 membership as a credit purchase plus redemption and
 * wreck the reporting Pete reads):
 *
 * - credit, chosen     -> one checkout on DebitAccount
 * - card, total >= $10 -> one checkout on StoredCard
 * - card, total < $10  -> Test: true rehearsal, purchaseaccountcredit for
 *                         $10 on the card, checkout on DebitAccount
 *
 * Recorded ASSUMPTIONS (T24; Pete may reverse): P4, the $10 minimum is
 * measured against the charged, after-tax total. T82 retires P2 and
 * rule 1 both (Pete: "Credit should be an option, not forced. If the
 * client has credit, they can choose to not use it and pay with cash or
 * card, etc"): credit is a tender like the others, never applied
 * automatically and never required, so a cash or card sale is NOT
 * refused because credit could have covered it. A credit line is still
 * refused above the live balance.
 *
 * The response never lies about an outcome:
 * - 200 { ok: true, ... }            the sale completed, saleId attached.
 * - 200 { ok: false, suppressed }    dry run or the write guard ate the
 *                                    write. The UI renders this amber,
 *                                    NEVER as a completed sale.
 * - 4xx/502 { error, stage, ... }    a definite failure, with Mindbody's
 *                                    reason. `stage` says how far it got;
 *                                    "checkout-after-credit" carries
 *                                    creditPurchased and creditBalance so
 *                                    the UI can tell the teacher the $10
 *                                    credit EXISTS and must not be bought
 *                                    again.
 * - `ambiguous: true` on an error    the transport failed (timeout,
 *                                    reset) so the write MAY have gone
 *                                    through: the UI must say so and must
 *                                    not invite a retry.
 *
 * T49, two additions and nothing else:
 * - Every money write runs AS THE SIGNED-IN TEACHER when there is one
 *   (runAsActor), so Mindbody's sale names them. A 4xx refusal of the
 *   teacher's token retries once as the service account and the answer
 *   carries `actorFallback`; a 100% discount (a comp) NEVER falls back
 *   (a refused comp is refused, with the message). The rehearsal stays
 *   on the service account. The payload, the single flight, the
 *   rehearsal order, the suppression and the outcome wording are
 *   T24/T28/T43's exactly.
 * - After a REAL checkout, the numeric Sale.Id is looked up (latestSaleId,
 *   bounded at 8s) and answered as `saleId`, with the cart GUID as
 *   `cartId`; a failed or ambiguous lookup answers the GUID as `saleId`,
 *   as before. The comp receipt and the Notes record carry the same id.
 */

/** Is the outcome of a money write UNKNOWN after this error? Two shapes
 *  qualify: the transport died (timeout/reset: fetch throws a DOMException
 *  named TimeoutError/AbortError, or a TypeError) so Mindbody may never
 *  have answered; or Mindbody answered with a 500-class status, which is
 *  the server failing MID-request -- possibly after the charge processed
 *  -- not refusing it. Only a definite refusal (a 4xx answer) may be
 *  reported as "nothing was charged"; everything else must not invite a
 *  retry. */
function isAmbiguous(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const status = mindbodyHttpStatus(err);
  return status !== null && status >= 500;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Method =
  | "storedcard"
  /** T93: a card typed at the counter for this sale. */
  | "typedcard"
  | "credit"
  | "cash"
  | "giftcard"
  | "comp";

/* T28: the methods a split leg may use. Comp is deliberately excluded --
 * a comp is the whole sale given away, armed by its own dialog in the
 * UI, and half-comping through a split would dodge that dialog; since
 * T79 a partial discount is the cart's, not a leg's. */
type SplitMethod = "storedcard" | "typedcard" | "credit" | "cash" | "giftcard";

interface SplitLeg {
  method: SplitMethod;
  amount: number;
  /** T83: a gift card leg's barcode id. Present for that method and
   *  refused on every other, so a number can never ride a leg that
   *  would not spend it. */
  giftCardNumber?: string;
  /** T93: a typed card leg's card. Present for that method and refused
   *  on every other, for the same reason a gift card number is. */
  typedCard?: TypedCard;
}

/** T79: which shape a 100% discount went out in. */
type DiscountShape = "lines" | "comp-payment";

/** Parse one untrusted split leg; a string return is the 400 reason. */
function parseSplitLeg(raw: unknown): SplitLeg | string {
  const method = (raw as { method?: unknown })?.method;
  if (
    method !== "storedcard" &&
    method !== "typedcard" &&
    method !== "credit" &&
    method !== "cash" &&
    method !== "giftcard"
  ) {
    return (
      "each split leg's method must be storedcard, typedcard, credit, " +
      "cash or giftcard"
    );
  }
  /* T83: the gift card's number belongs to its own leg, and nowhere
   * else. A number on a cash leg is a mistake, not something to
   * ignore. */
  const numberRaw = (raw as { number?: unknown })?.number;
  let giftCardNumber: string | undefined;
  if (method === "giftcard") {
    const parsed = parseGiftCardNumber(numberRaw);
    if (typeof parsed === "string") return parsed;
    giftCardNumber = parsed.number;
  } else if (numberRaw !== undefined) {
    return "only a giftcard leg carries a number";
  }
  /* T93: the typed card belongs to its own leg, and nowhere else. */
  const typedRaw = (raw as { typedCard?: unknown })?.typedCard;
  let typedCard: TypedCard | undefined;
  if (method === "typedcard") {
    const parsed = parseTypedCard(typedRaw);
    if (parsed.card === null) return parsed.error;
    typedCard = parsed.card;
  } else if (typedRaw !== undefined) {
    return "only a typedcard leg carries a typedCard";
  }
  const amount = (raw as { amount?: unknown })?.amount;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return "each split leg needs a positive amount";
  }
  /* Whole cents only: a sub-cent leg could never sum to a real total and
   * is a typo, not a tender. The epsilon absorbs float dust (10.05 * 100
   * is 1005.0000000000001 in a double) without admitting 10.005. */
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) {
    return "split leg amounts must be whole cents";
  }
  /* Snap to the exact cent value: everything downstream -- the sum
   * check, the card-minimum and balance comparisons, and above all the
   * Payments entry sent to Mindbody -- must carry the validated cent
   * amount, never the raw float it arrived as (10.000000001 passes the
   * epsilon but is not a tender anyone typed). */
  return {
    method,
    amount: cents / 100,
    ...(giftCardNumber === undefined ? {} : { giftCardNumber }),
    ...(typedCard === undefined ? {} : { typedCard }),
  };
}

export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad hears only the 401 and never a validation detail
   * or a Mindbody read made on its behalf. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  /* T95: the gift card lines, read before the cart lines because they
   * change what an EMPTY cart means. A ticket holding only gift cards
   * has no Mindbody cart at all (a gift card is not a cart item; it
   * sells through /sale/purchasegiftcard), so `items` may legitimately
   * be absent, and parseCartLines refuses an empty array. Nothing about
   * a card's price or value is read from the browser: the product id is
   * all that travels, and the live list below prices it. */
  const giftParsed = parseGiftCardLines(payload?.giftCards);
  if (giftParsed.error !== null) {
    return NextResponse.json({ error: giftParsed.error }, { status: 400 });
  }
  const giftLines = giftParsed.lines;
  const rawItems: unknown = payload?.items;
  const cartLinesOmitted =
    giftLines.length > 0 &&
    (rawItems === undefined ||
      rawItems === null ||
      (Array.isArray(rawItems) && rawItems.length === 0));
  const parsed = cartLinesOmitted
    ? ({ items: [] as CartLine[], error: null } as const)
    : parseCartLines(rawItems);
  if (parsed.error !== null) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const items = parsed.items;

  /* T28: an optional `split` -- exactly two payment legs, in the
   * teacher's order, charged in ONE checkoutshoppingcart call so there
   * is no two-write seam. Mutually exclusive with `method`: a request
   * carrying both is refused rather than guessed at. */
  let split: [SplitLeg, SplitLeg] | null = null;
  if (payload?.split !== undefined && payload?.split !== null) {
    if (payload?.method !== undefined) {
      return NextResponse.json(
        { error: "send method or split, not both" },
        { status: 400 },
      );
    }
    const legsRaw: unknown = payload.split?.legs;
    if (!Array.isArray(legsRaw) || legsRaw.length !== 2) {
      return NextResponse.json(
        { error: "split.legs must be exactly two legs" },
        { status: 400 },
      );
    }
    const legA = parseSplitLeg(legsRaw[0]);
    if (typeof legA === "string") {
      return NextResponse.json({ error: legA }, { status: 400 });
    }
    const legB = parseSplitLeg(legsRaw[1]);
    if (typeof legB === "string") {
      return NextResponse.json({ error: legB }, { status: 400 });
    }
    if (legA.method === legB.method) {
      return NextResponse.json(
        { error: "a split's two legs must use different methods" },
        { status: 400 },
      );
    }
    split = [legA, legB];
  }

  const method: unknown = payload?.method;
  if (
    split === null &&
    method !== "storedcard" &&
    method !== "typedcard" &&
    method !== "credit" &&
    method !== "cash" &&
    method !== "giftcard" &&
    method !== "comp"
  ) {
    return NextResponse.json(
      {
        error:
          "method must be storedcard, typedcard, credit, cash, giftcard " +
          "or comp",
      },
      { status: 400 },
    );
  }

  /* T83: the gift card's number on the single-method shape, validated
   * before anything else is read. It is a bearer secret: from here it
   * reaches the Payments entry and nothing else, and only
   * giftCardLastFour() of it is ever answered. */
  const giftCardRaw: unknown = (payload?.giftCard as { number?: unknown })
    ?.number;
  let giftCardNumber: string | null = null;
  if (method === "giftcard") {
    const parsed = parseGiftCardNumber(giftCardRaw);
    if (typeof parsed === "string") {
      return NextResponse.json({ error: parsed }, { status: 400 });
    }
    giftCardNumber = parsed.number;
  } else if (payload?.giftCard !== undefined) {
    return NextResponse.json(
      { error: "giftCard applies only to method giftcard" },
      { status: 400 },
    );
  }

  /* T93: the typed card on the single-method shape, validated by the same
   * rule the modal greys its button with. Refused on every other method:
   * a card riding a request that would not charge it is a mistake, not
   * something to ignore. */
  let typedCard: TypedCard | null = null;
  if (method === "typedcard") {
    const parsed = parseTypedCard(payload?.typedCard);
    if (parsed.card === null) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    typedCard = parsed.card;
  } else if (payload?.typedCard !== undefined) {
    return NextResponse.json(
      { error: "typedCard applies only to method typedcard" },
      { status: 400 },
    );
  }

  /* ==================================================================
   * T95: the shapes a gift card ticket will not be sold in.
   *
   * Up here, ahead of the generic checks, because those would refuse the
   * same requests for the wrong reason: a split's card leg would be
   * refused for having no client, and a discount would be refused for
   * having no subtotal to take it off. Both are true and neither is what
   * a teacher needs to read. Nothing below costs a Mindbody call; the
   * selling itself is further down, after the cart's own validation.
   * ================================================================== */
  if (giftLines.length > 0) {
    const refuse = (error: string) =>
      NextResponse.json({ error, stage: "method" }, { status: 409 });
    if (items.some((line) => line.forClientId != null)) {
      return refuse(
        "A gift card and a line bought for another client cannot be on one " +
          "ticket. The card is a bearer instrument and belongs to whoever " +
          "holds it, so sell it on its own. Nothing was charged.",
      );
    }
    if (split !== null) {
      return refuse(
        "A gift card purchase takes one form of payment. Remove a part of " +
          "the split, or sell the card on its own. Nothing was charged.",
      );
    }
    if (payload?.discount !== undefined && payload?.discount !== null) {
      /* A discounted gift card is money given away that then spends like
       * cash. Pete has not asked for it, and the one place this app gives
       * money away (the discount dialog) is aimed at passes and retail;
       * until he does, it is refused rather than half built. */
      return refuse(
        "A gift card cannot be discounted or comped: the card is worth its " +
          "face value whatever was paid for it. Remove the discount, or " +
          "sell the card on its own. Nothing was charged.",
      );
    }
    if (method === "giftcard") {
      return refuse(
        "A gift card cannot buy a gift card. Take cash or a card. Nothing " +
          "was charged.",
      );
    }
    if (method === "credit") {
      /* Whether Mindbody lets account credit buy a gift card is unknown:
       * the spec says nothing, and an account balance turning into a
       * bearer instrument is exactly the conversion a studio would want
       * to decide on deliberately. Refused until probed (T95's open
       * questions), never attempted and then read back from the error. */
      return refuse(
        "Account credit cannot buy a gift card yet: whether Mindbody allows " +
          "it has not been established. Take cash or a card. Nothing was " +
          "charged.",
      );
    }
    if (method !== "cash" && method !== "storedcard") {
      return refuse(
        "A gift card is paid for with cash or a card on file. Nothing was " +
          "charged.",
      );
    }
  }

  /* T79: the discount, checked before the token, the reason and the
   * client, and before any Mindbody call. A package-bearing cart is
   * refused (Mindbody ignores DiscountAmount on a package, so the sale
   * would silently discount less than the screen said); the bounds are
   * parseDiscount's, against the lines' own pre-tax subtotal. */
  const discountRaw: unknown = payload?.discount;
  let discount: Discount | null = null;
  if (discountRaw !== undefined && discountRaw !== null) {
    const refusal = discountRefusal(items);
    if (refusal !== null) {
      return NextResponse.json({ error: refusal }, { status: 400 });
    }
    const d = parseDiscount(discountRaw, subtotalCents(items));
    if (typeof d === "string") {
      return NextResponse.json({ error: d }, { status: 400 });
    }
    discount = d;
  }
  const full = discount !== null && isFullDiscount(items, discount);
  /* Method comp IS the 100% discount: nothing else may use it, and a
   * discount that leaves something to pay needs a tender. */
  if (method === "comp" && !full) {
    return NextResponse.json(
      {
        error:
          discount === null
            ? "a comp needs a discount covering the whole sale " +
              "(discount: { mode: \"percent\", value: 100 })"
            : "the discount leaves something to pay; choose how they are paying",
      },
      { status: 400 },
    );
  }
  if (method !== "comp" && full) {
    return NextResponse.json(
      {
        error:
          "the discount covers the whole sale, so there is nothing to " +
          "pay; send method comp",
      },
      { status: 400 },
    );
  }

  /* T48: who is discounting. Checked FIRST, before the client, the
   * reason and the rehearsal: a discount with nobody's PIN behind it
   * costs no Mindbody call at all and is refused the same way with the
   * device lock on or off. Pete's live test had a real $2 comp go
   * through with teacher=none; this is the line that makes that
   * impossible. T79: every discount asks, not only a 100% one. */
  const teacherTokenRaw: unknown = payload?.teacherToken;
  if (discount === null && teacherTokenRaw !== undefined) {
    return NextResponse.json(
      { error: "teacherToken applies only to a discounted sale" },
      { status: 400 },
    );
  }
  let teacher: TeacherIdentity | null = null;
  if (discount !== null) {
    teacher =
      typeof teacherTokenRaw === "string"
        ? verifyCompToken(teacherTokenRaw, "comp")
        : null;
    /* T94 review: and it must be THIS teacher's. /api/teacher/verify
     * only ever mints a token for the signed-in teacher, so a token
     * naming somebody else is one carried across a sign-out inside its
     * ten minutes: the name on the record would not be the name behind
     * the tap. */
    if (teacher !== null && teacher.id !== session.staffId) teacher = null;
    if (teacher === null) {
      return NextResponse.json(
        { error: "Enter your PIN to discount this sale.", reason: "teacher" },
        { status: 401 },
      );
    }
  }
  /**
   * T94: an AUTHORIZED account overdraft (Pete: "Accounts should be able
   * to be charged even if there is insufficient balance ... This will
   * require the teacher's PIN to authorize"). `overdraftToken` is a
   * one-shot token from /api/teacher/verify, exactly as a discount's is,
   * and it is the ONLY thing that lets the credit check below pass an
   * amount above the live balance. Its own field rather than
   * `teacherToken`: a discounted sale can also overdraw the account, and
   * one one-shot token cannot answer for two authorizations.
   *
   * It applies to an account charge and nothing else, so a request that
   * carries one with no credit line is refused rather than ignored: a
   * token quietly dropped is a teacher's PIN spent on nothing.
   */
  const overdraftTokenRaw: unknown = payload?.overdraftToken;
  const creditAsked =
    method === "credit" ||
    (split !== null &&
      (split[0].method === "credit" || split[1].method === "credit"));
  if (overdraftTokenRaw !== undefined && !creditAsked) {
    return NextResponse.json(
      { error: "overdraftToken applies only to an account payment" },
      { status: 400 },
    );
  }
  /* T94 review: T90 refuses an account payment outright on a ticket
   * holding a line for another client, and no PIN moves that: the
   * balance belongs to the payer and v6 has no per-item payer. Refused
   * HERE, before the token is spent, so a refusal nothing could have
   * satisfied does not cost a teacher their one-shot authorization. */
  const payerRaw =
    typeof payload?.clientId === "string" ? payload.clientId.trim() : "";
  if (
    overdraftTokenRaw !== undefined &&
    items.some((line) => line.forClientId && line.forClientId !== payerRaw)
  ) {
    return NextResponse.json(
      {
        error:
          "The account balance pays only for the client on the sale. Take " +
          "cash, a card at the reader, or a gift card for lines bought " +
          "for someone else. Nothing was charged.",
        stage: "method",
      },
      { status: 409 },
    );
  }
  let overdraftTeacher: TeacherIdentity | null = null;
  if (overdraftTokenRaw !== undefined) {
    overdraftTeacher =
      typeof overdraftTokenRaw === "string"
        ? verifyCompToken(overdraftTokenRaw, "overdraft")
        : null;
    /* Its own purpose, signed in: a PIN typed to discount a sale is not
     * a PIN typed to overdraw an account, and separate request fields
     * are no separation while one token answers for both. And this
     * teacher's, for the reason the discount token's check gives. */
    if (overdraftTeacher !== null && overdraftTeacher.id !== session.staffId) {
      overdraftTeacher = null;
    }
    if (overdraftTeacher === null) {
      return NextResponse.json(
        {
          error: "Enter your PIN to charge past the account balance.",
          reason: "teacher",
        },
        { status: 401 },
      );
    }
  }

  const clientId =
    typeof payload?.clientId === "string" && payload.clientId.trim()
      ? payload.clientId.trim()
      : undefined;
  if ((method === "storedcard" || method === "credit") && !clientId) {
    return NextResponse.json(
      { error: `${method} needs a client attached to the sale` },
      { status: 400 },
    );
  }
  /* T53: the receipt decision, made once here from what the toggle said
   * and who the sale is for. Never for the house client (no clientId); a
   * non-boolean is false, never an error, because a receipt must not
   * stand between a teacher and a charge. T82: a comp receipts too, so
   * the discount is not read here at all. */
  const sendEmail =
    payload?.sendEmail === true &&
    clientId !== undefined &&
    /* T53 review: the house client attached BY NAME (it is a real
     * client, so search can find it) is still nobody's inbox. */
    clientId !== houseClientId();
  /* A client-bound leg needs the client it is bound to. T83 made this
   * conditional: cash and a gift card are both bearer tenders, so
   * "gift card $40 plus $9 cash" is a walk-in sale with nobody
   * attached, and it rides the house client exactly as a whole-sale
   * cash payment does. A storedcard or credit leg still refuses
   * without a client, before any Mindbody call. */
  const boundLeg =
    split === null
      ? null
      : (split.find((l) => l.method === "storedcard" || l.method === "credit") ??
        null);
  if (boundLeg !== null && !clientId) {
    return NextResponse.json(
      { error: `a ${boundLeg.method} leg needs a client attached to the sale` },
      { status: 400 },
    );
  }
  /* T93: the typed card, on the single shape or on a leg. */
  const typedLeg =
    split === null ? null : (split.find((l) => l.method === "typedcard") ?? null);
  const typed = typedCard ?? typedLeg?.typedCard ?? null;
  /* "and keep on file" needs somebody to keep it FOR. A walk-in sale
   * rides the house client, which is a catch-all record shared by every
   * anonymous sale, so a card kept on it belongs to nobody and would be
   * offered as "the card on file" to the next walk-in. Refused before any
   * Mindbody call, never silently downgraded to a charge-only: the
   * teacher chose "keep", and a request that cannot honour that must say
   * so rather than do half of it. */
  if (typed?.keep === true) {
    const house = houseClientId();
    if (!clientId || (house !== null && clientId === house)) {
      return NextResponse.json(
        {
          error:
            "Keeping a card on file needs a client attached to the sale. " +
            "Attach them, or use the card once. Nothing was charged.",
        },
        { status: 400 },
      );
    }
  }
  /* Mindbody requires a client on EVERY sale, pricing included (confirmed
   * live 2026-08-30). An anonymous cash/comp sale rides the configured
   * house client server-side -- the UI still says "nobody" -- and without
   * one it is refused here, before any Mindbody call, with the same
   * reason the disabled Charge button gave. During guarded testing
   * POS_WRITE_CLIENT_IDS must include this id or the write guard
   * suppresses every anonymous sale; see the T24 ticket notes. */
  /* T43: a discount needs its reason, and nothing else may carry one.
   * The check is before the house-client substitution and the
   * rehearsal so a reasonless discount costs no metered call. */
  const compReasonRaw: unknown = payload?.compReason;
  if (discount === null && compReasonRaw !== undefined) {
    return NextResponse.json(
      { error: "compReason applies only to a discounted sale" },
      { status: 400 },
    );
  }
  let compReason: CompReason | null = null;
  if (discount !== null) {
    /* T45: the reason is data. A kind from the closed list and the
     * detail within its bounds (required for trade and other, the kinds
     * that say nothing by themselves). */
    const raw =
      compReasonRaw && typeof compReasonRaw === "object"
        ? (compReasonRaw as Record<string, unknown>)
        : null;
    if (raw === null || !isCompKind(raw["kind"])) {
      return NextResponse.json(
        {
          error:
            "a discount needs a compReason with a kind of trade, damaged " +
            "or other",
        },
        { status: 400 },
      );
    }
    const kind = raw["kind"];
    const detailRaw = raw["detail"];
    if (detailRaw !== undefined && typeof detailRaw !== "string") {
      return NextResponse.json(
        { error: "compReason.detail must be a string when present" },
        { status: 400 },
      );
    }
    const detail = typeof detailRaw === "string" ? detailRaw.trim() : "";
    if (detail.length > COMP_DETAIL_MAX) {
      return NextResponse.json(
        {
          error: `compReason.detail is at most ${COMP_DETAIL_MAX} characters`,
        },
        { status: 400 },
      );
    }
    if (compNeedsDetail(kind) && detail.length < COMP_DETAIL_MIN) {
      return NextResponse.json(
        {
          error:
            `a discount of kind ${kind} needs a detail of ${COMP_DETAIL_MIN} to ` +
            `${COMP_DETAIL_MAX} characters`,
        },
        { status: 400 },
      );
    }
    if (raw["forStaffId"] !== undefined) {
      /* T79: the Teacher kind is gone with its staff id. */
      return NextResponse.json(
        { error: "compReason.forStaffId is no longer a field" },
        { status: 400 },
      );
    }
    compReason = { kind, detail };
  }
  /* The comp receipt's line list: OUR record of what was given away
   * (type, id, name, quantity, price), read off the validated items with
   * the names the browser sent alongside them. Never forwarded: the
   * Mindbody payload is built from `items` alone, exactly as before. */
  const compItems: CompReceiptItem[] = items.map((line, i) => {
    const rawName: unknown = Array.isArray(payload?.items)
      ? payload.items[i]?.name
      : undefined;
    return {
      type: line.type,
      id: String(line.metadataId),
      name:
        typeof rawName === "string" && rawName.trim()
          ? rawName.trim().slice(0, 120)
          : null,
      quantity: line.quantity,
      price: line.price,
    };
  });

  /* T92: the same rule the pricing route applies, at the last gate
   * before a client id is chosen. A Service or a Package with neither an
   * attached client nor a T90 recipient is refused in words and NEVER
   * filed under the house client: a pass sold onto the walk-in
   * placeholder is a pass nobody can use. Retail is untouched. */
  const orphanPass = passWithoutOwner(items, clientId);
  if (orphanPass !== null) {
    return NextResponse.json(
      { error: orphanPass, stage: "method" },
      { status: 400 },
    );
  }
  const saleClientId = clientId ?? houseClientId() ?? undefined;
  if (!saleClientId) {
    return NextResponse.json(
      {
        error:
          "Mindbody requires a client on every sale. Attach a client, or " +
          "set POS_HOUSE_CLIENT_ID to a house walk-in client for " +
          "anonymous counter sales. Nothing was charged.",
        stage: "method",
      },
      { status: 409 },
    );
  }
  /* Tendered cash is DISPLAY-ONLY arithmetic for the change line; the
   * spec gives Cash no tendered/change metadata to send, so it is
   * validated for sanity and then deliberately not forwarded. */
  const cashTendered: unknown = payload?.cashTendered;
  if (
    cashTendered !== undefined &&
    (typeof cashTendered !== "number" || !Number.isFinite(cashTendered) ||
      cashTendered < 0)
  ) {
    return NextResponse.json(
      { error: "cashTendered must be a non-negative number when present" },
      { status: 400 },
    );
  }
  /* In a split, a cash leg needs no tender math: the leg's amount IS
   * what is collected, so a tendered figure has no meaning here. */
  if (split !== null && cashTendered !== undefined) {
    return NextResponse.json(
      {
        error:
          "a split's cash leg records its leg amount; cashTendered does " +
          "not apply",
      },
      { status: 400 },
    );
  }

  /* T48: the teacher token is SPENT here, after every check above and
   * before the rehearsal, which is the first Mindbody call: a second
   * charge on the same token, however it got here, goes back to the PIN
   * step and costs no call. */
  if (discount !== null && !spendCompToken(teacherTokenRaw as string)) {
    return NextResponse.json(
      { error: "Enter your PIN to discount this sale.", reason: "teacher" },
      { status: 401 },
    );
  }

  /* T94: the overdraft token is spent in the same place and for the same
   * reason: a token is never reused across two checkouts, and a replayed
   * one costs no Mindbody call. It is spent whether or not the balance
   * turns out to need it, because it was entered for THIS sale: a token
   * left unspent because the balance had meanwhile covered the total
   * would still be a live authorization for the next one. */
  if (overdraftTeacher !== null && !spendCompToken(overdraftTokenRaw as string)) {
    return NextResponse.json(
      {
        error: "Enter your PIN to charge past the account balance.",
        reason: "teacher",
      },
      { status: 401 },
    );
  }

  /* T89 review: dry run can be the server's (POS_DRY_RUN) or this
   * browser's own (the pos_dry_run cookie), so the label asks
   * dryRunState() rather than reading the env flag. Reading isDryRun()
   * here labelled a cookie suppression "write-guard", which names the
   * wrong rail to whoever is looking at why a sale did not go out. */
  const suppressionKind = async () =>
    (await dryRunState()).on ? "dry-run" : "write-guard";

  /**
   * T83: what Mindbody says is on the gift card RIGHT NOW, and the
   * refusal when the tender asks for more than that. The browser's
   * "Check balance" answer is never the basis for the money decision,
   * for the same reason the card and the credit balance are re-read
   * here: it may be minutes old, and the same card may have been spent
   * at the counter in between. A READ, so a failure here charged
   * nothing. Answers null when the amount is good, else the response to
   * send.
   */
  const giftCardRefusal = async (
    number: string,
    amount: number,
    part: string,
  ): Promise<NextResponse | null> => {
    let balance: number;
    try {
      balance = await giftCardBalance(number);
    } catch (err) {
      return NextResponse.json(
        {
          error: `Could not read the gift card: ${errMessage(err)} Nothing was charged.`,
          stage: "method",
        },
        { status: 502 },
      );
    }
    if (balance <= 0) {
      return NextResponse.json(
        {
          error: "That gift card has nothing left on it. Nothing was charged.",
          stage: "method",
          giftCardBalance: balance,
        },
        { status: 409 },
      );
    }
    if (roundToCents(amount) > roundToCents(balance)) {
      return NextResponse.json(
        {
          error:
            `The gift card has ${balance.toFixed(2)} on it, which does not ` +
            `cover the ${amount.toFixed(2)} ${part}. Nothing was charged.`,
          stage: "method",
          giftCardBalance: balance,
        },
        { status: 409 },
      );
    }
    return null;
  };

  /**
   * T93: "and keep on file", AFTER a charge that stood.
   *
   * The checkout's own `saveInfo` key would store the card in the same
   * call, but T84 already has a proven store path -- one
   * `/client/updateclient` carrying ClientCreditCard, the same validation
   * and a read-back so the answer is Mindbody's card and not an echo --
   * and using it means the charge is settled BEFORE anything is stored:
   * a refused charge stores nothing, and a stored card never precedes a
   * charge. The order is the point.
   *
   * The cost is that the store can fail on its own after a charge that
   * succeeded, and that is reported rather than hidden: `cardKept: false`
   * with `cardKeptError` in words, which the screen renders as "Charged.
   * The card was not kept on file: ...". This can NEVER change the sale's
   * outcome: it throws nothing, and a dead staff token here is reported
   * as a store that failed, not as a sale that did not happen (the sale
   * did happen).
   *
   * Called only on a real success. `keep` was refused above for a
   * house-client cart, so clientId is a named client here.
   */
  const keepTypedCard = async (
    card: TypedCard,
  ): Promise<Record<string, unknown>> => {
    if (!card.keep || !clientId) return {};
    try {
      const run = await runAsActor(session, "/api/checkout keep-card", (actor) =>
        saveClientCard(
          clientId,
          {
            number: card.number,
            expMonth: card.expMonth,
            expYear: card.expYear,
            cardHolder: card.billingName,
            postalCode: card.postalCode,
          },
          actor,
        ),
      );
      if (run.result.suppressed) {
        return {
          cardKept: false,
          cardKeptError:
            run.result.suppressed === "dry-run"
              ? "dry run is on, so nothing was sent to Mindbody."
              : "the write guard allows only the clients listed in " +
                "POS_WRITE_CLIENT_IDS.",
        };
      }
      /* A failed read-back is not a failed save (T84 review): the card is
       * on file either way, so this is reported as kept. */
      return {
        cardKept: true,
        cardKeptLastFour: run.result.card?.lastFour ?? null,
      };
    } catch (err) {
      /* No card detail in this line: the exchange is in the call log with
       * the number redacted. */
      console.warn(
        `[card] charged, but keeping the typed card on client ${clientId} ` +
          `failed: ${errMessage(err)}`,
      );
      return { cardKept: false, cardKeptError: errMessage(err) };
    }
  };
  /* ===========================================================   * T90: lines bought for another client.
  /* ==================================================================
   * T95: selling a gift card.
   *
   * Pete: "A customer needs to be able to buy a gift card ... Gift card
   * will be an item in the store, and when it's clicked a box pops up
   * where the teacher must enter the amount ... The price is always the
   * value, and the ID is set automatically."
   *
   * A gift card is NOT a cart item. It sells through
   * /sale/purchasegiftcard, one call per card, each with its own
   * PaymentInfo and its own sale in Mindbody's books. So a ticket
   * holding gift cards checks out as: the ordinary cart (when there are
   * other lines) PLUS one purchase per card, sequentially, in this one
   * request, with the T90 posture throughout. Every part is rehearsed
   * with `Test: true` before any of them is charged; there is no retry,
   * no roll back and no refund; and the answer names exactly what
   * landed.
   *
   * The barcode id is generated HERE, checked against Mindbody for an
   * existing card first (the spec says a known id RELOADS that card,
   * which must never happen by accident) and shown to the teacher
   * afterwards so they can write it on the card.
   * ================================================================== */
  if (giftLines.length > 0) {
    /* The shape refusals ran above, before the cart's own validation. */
    /* The live product list, which is where a card's VALUE and PRICE come
     * from: there is no amount field on the purchase, so the amount IS
     * the product. A read, so a failure here charged nothing. */
    let products;
    try {
      products = await giftCardProducts();
    } catch (err) {
      return NextResponse.json(
        {
          error:
            "Could not read the gift cards Mindbody offers: " +
            `${errMessage(err)} Nothing was charged.`,
          stage: "method",
        },
        { status: 502 },
      );
    }
    const resolved = resolveGiftCardUnits(giftLines, products);
    if (resolved.error !== null) {
      return NextResponse.json(
        { error: resolved.error, stage: "method" },
        { status: 409 },
      );
    }
    const units = resolved.units;
    const cardsTotal = giftCardTotal(units);

    /* The cart half, when the ticket has one: rehearsed exactly as every
     * other sale is, and its total is Mindbody's. */
    let cartTotal = 0;
    if (items.length > 0) {
      let cartPriced;
      try {
        cartPriced = await rehearseCheckout(items, saleClientId);
      } catch (err) {
        return NextResponse.json(
          { error: errMessage(err), stage: "rehearsal" },
          { status: 502 },
        );
      }
      if (cartPriced.suppressed) {
        return NextResponse.json({
          ok: false,
          suppressed: await suppressionKind(),
        });
      }
      if (cartPriced.disagrees || cartPriced.grandTotal === null) {
        return NextResponse.json(
          {
            error:
              "Totals disagree between our math and Mindbody's. Nothing was " +
              "charged; this is a bug to report, not a state to charge from.",
            stage: "rehearsal",
          },
          { status: 409 },
        );
      }
      cartTotal = cartPriced.grandTotal;
    }
    /* A gift card carries no tax (the product's own SalePrice is what the
     * purchase charges), so the ticket's total is Mindbody's cart total
     * plus each card's price. */
    const ticketTotal = roundToCents(cartTotal + cardsTotal);
    if (
      typeof cashTendered === "number" &&
      method === "cash" &&
      cashTendered < ticketTotal
    ) {
      return NextResponse.json(
        { error: "Tendered cash is less than the total." },
        { status: 400 },
      );
    }

    /* Each part is its own Mindbody sale and so its own card charge,
     * which is what the $10 floor is measured against (the same reading
     * as assumption P4). A part under it is REFUSED with the reason,
     * never topped up: the under-$10 credit dance exists for one cart,
     * and running it per part would turn one tap into a row of seams. */
    const parts: number[] = [
      ...(items.length > 0 ? [cartTotal] : []),
      ...units.map((u) => u.salePrice),
    ];
    let cardOnFile: { lastFour: string } | null = null;
    if (method === "storedcard") {
      let profile;
      try {
        profile = await clientPaymentProfile(clientId as string);
      } catch (err) {
        return NextResponse.json(
          {
            error:
              "Could not read the client's payment profile: " +
              `${errMessage(err)} Nothing was charged.`,
            stage: "method",
          },
          { status: 502 },
        );
      }
      if (!profile.card) {
        return NextResponse.json(
          { error: "No card on file for this client.", stage: "method" },
          { status: 409 },
        );
      }
      if (profile.card.expired) {
        return NextResponse.json(
          {
            error: `The card on file (ending ${profile.card.lastFour}) is expired.`,
            stage: "method",
          },
          { status: 409 },
        );
      }
      const short = parts.find((p) => p < CARD_MINIMUM_USD);
      if (short !== undefined) {
        return NextResponse.json(
          {
            error:
              "A gift card is its own sale in Mindbody, so the card is " +
              "charged once per part of this ticket, and " +
              `${short.toFixed(2)} is under the $${CARD_MINIMUM_USD} card ` +
              "minimum. Take cash, or sell the parts separately. Nothing " +
              "was charged.",
            stage: "method",
          },
          { status: 409 },
        );
      }
      cardOnFile = { lastFour: profile.card.lastFour };
    }
    const paymentFor = (amount: number): CheckoutPayment =>
      method === "storedcard"
        ? {
            type: "StoredCard",
            amount,
            lastFour: (cardOnFile as { lastFour: string }).lastFour,
          }
        : { type: "Cash", amount };

    /* An id per CARD, each checked against Mindbody before it is used.
     * A read, so nothing has been charged if this fails, and it fails
     * loudly rather than risk reloading a card someone is holding. */
    const ids: string[] = [];
    try {
      /* T95 review: each id is drawn clear of the ones this ticket has
       * already claimed as well as of Mindbody's own cards. An id
       * repeated inside one ticket would read FREE (it is not a card
       * yet) and the second purchase would RELOAD the first card. */
      for (let i = 0; i < units.length; i++) {
        ids.push(await freshGiftCardId(ids));
      }
    } catch (err) {
      return NextResponse.json(
        { error: `${errMessage(err)} Nothing was charged.`, stage: "method" },
        { status: 502 },
      );
    }

    /* REHEARSE EVERY PURCHASE FIRST (T90's rule), with the real id and
     * the real payment, under `Test: true`: a card Mindbody will not sell
     * stops the whole ticket with nothing spent. It is also the one place
     * that can catch a product whose value is not what the shelf said. */
    for (const [i, unit] of units.entries()) {
      let trial;
      try {
        trial = await purchaseGiftCard({
          productId: unit.productId,
          purchaserClientId: saleClientId,
          barcodeId: ids[i] as string,
          payment: paymentFor(unit.salePrice),
          test: true,
          sendEmailReceipt: false,
        });
      } catch (err) {
        return NextResponse.json(
          {
            error:
              `Mindbody refused the ${unit.cardValue.toFixed(2)} gift card: ` +
              `${errMessage(err)} Nothing was charged.`,
            stage: "rehearsal",
          },
          { status: 502 },
        );
      }
      if (trial.suppressed) {
        /* Dry run and the write guard both intercept a `Test: true` POST
         * (the wrapper counts every POST as a write), so this is the
         * ordinary suppressed answer: nothing was sent, nothing charged. */
        return NextResponse.json({ ok: false, suppressed: trial.suppressed });
      }
      /* The rehearsal's Value is Mindbody's own word on what the card
       * would be worth. A figure that disagrees with the product record
       * means the shelf and the site have drifted, and the teacher is
       * about to hand over a card worth something else. A MISSING value
       * is not a disagreement: the field is optional in the answer, and
       * inventing a refusal for an absent field is not this route's job. */
      /* T95 review: and what Mindbody says it COSTS. The payment sent
       * with each purchase is the cached product's SalePrice, so a price
       * that has moved since the list was read would charge the customer
       * one figure while Mindbody books another. Absent is not a
       * disagreement, for the reason the value check gives. */
      if (
        trial.amountPaid !== null &&
        roundToCents(trial.amountPaid) !== unit.salePrice
      ) {
        return NextResponse.json(
          {
            error:
              `Mindbody charges ${trial.amountPaid.toFixed(2)} for that gift ` +
              `card, not the ${unit.salePrice.toFixed(2)} on the ticket. ` +
              "Nothing was charged; tap Recheck prices and try again.",
            stage: "rehearsal",
          },
          { status: 409 },
        );
      }
      if (
        trial.value !== null &&
        roundToCents(trial.value) !== unit.cardValue
      ) {
        return NextResponse.json(
          {
            error:
              `Mindbody prices that gift card at ${trial.value.toFixed(2)}, ` +
              `not the ${unit.cardValue.toFixed(2)} on the ticket. Nothing ` +
              "was charged; this is a bug to report, not a state to charge " +
              "from.",
            stage: "rehearsal",
          },
          { status: 409 },
        );
      }
    }

    /* ---------------- the real calls, in order ---------------- */
    const startedAt = new Date();
    /** What landed, in the order it was charged. */
    const sold: {
      value: number;
      price: number;
      barcodeId: string;
      saleId: string | null;
    }[] = [];
    let cartSale: {
      total: number;
      saleId: string | null;
      cartId: string | null;
    } | null = null;
    let failure: { what: string; message: string; ambiguous: boolean } | null =
      null;
    let fallbackNote: ActorFallback | null = null;
    let gone: Response | null = null;
    let suppressedKind: string | null = null;
    /* T53: the one confirmation Mindbody gives here. A cart checkout
     * answers nothing either way; a gift card purchase answers
     * EmailReceipt, and only its own `true` counts. */
    let receiptConfirmed: boolean | null = null;

    if (items.length > 0) {
      try {
        const run = await runAsActor(session, "/api/checkout", (actor) =>
          checkoutCart(
            items,
            saleClientId,
            paymentFor(cartTotal),
            actor,
            sendEmail,
          ),
        );
        if (run.actorFallback) fallbackNote = run.actorFallback;
        const outcome = run.result;
        if (outcome.suppressed) {
          /* The rehearsal was not suppressed and this was: the guard
           * judges by client id and nothing changed between them, so this
           * should be unreachable. Reported as suppression, never as a
           * sale, and nothing after it runs. */
          suppressedKind = outcome.suppressed;
        } else {
          const numeric = await latestSaleId(saleClientId, startedAt);
          cartSale = {
            total: cartTotal,
            saleId: numeric === null ? outcome.saleId : String(numeric),
            cartId: outcome.saleId,
          };
        }
      } catch (err) {
        const ended = staffSessionEndedResponse(err);
        if (ended) return ended;
        failure = {
          what: "the rest of the ticket",
          message: isAmbiguous(err)
            ? "it did not answer, so it MAY have gone through. Check the " +
              "dev drawer or Mindbody before charging again"
            : errMessage(err),
          ambiguous: isAmbiguous(err),
        };
      }
    }

    /** T95 review: how many cards were actually sent to Mindbody, which
     *  is what the "was not attempted" list is measured from. Zero when
     *  the cart half failed first. */
    let cardsAttempted = 0;
    if (failure === null && suppressedKind === null) {
      for (const [i, unit] of units.entries()) {
        const id = ids[i] as string;
        cardsAttempted += 1;
        try {
          const run = await runAsActor(session, "/api/checkout", (actor) =>
            purchaseGiftCard({
              productId: unit.productId,
              purchaserClientId: saleClientId,
              barcodeId: id,
              payment: paymentFor(unit.salePrice),
              actor,
              test: false,
              sendEmailReceipt: sendEmail,
            }),
          );
          if (run.actorFallback) fallbackNote = run.actorFallback;
          const outcome = run.result;
          if (outcome.suppressed) {
            suppressedKind = outcome.suppressed;
            break;
          }
          if (outcome.emailReceipt === true) receiptConfirmed = true;
          /* Mindbody's own BarcodeId when it echoes one, ours when it
           * does not: what goes on the card has to be what the card is
           * known by, and Mindbody holds the record. */
          sold.push({
            value: outcome.value ?? unit.cardValue,
            price: outcome.amountPaid ?? unit.salePrice,
            barcodeId: outcome.barcodeId ?? id,
            saleId: outcome.saleId === null ? null : String(outcome.saleId),
          });
          logGiftCardSale({
            outcome: "yes",
            value: outcome.value ?? unit.cardValue,
            price: outcome.amountPaid ?? unit.salePrice,
            saleId: outcome.saleId,
            clientId: saleClientId,
            staffId: session.staffId,
          });
        } catch (err) {
          const ended = staffSessionEndedResponse(err);
          if (ended && sold.length === 0 && cartSale === null) {
            gone = ended;
            break;
          }
          failure = {
            what: `the ${unit.cardValue.toFixed(2)} gift card`,
            message: isAmbiguous(err)
              ? "it did not answer, so it MAY have gone through. Check the " +
                "dev drawer or Mindbody before charging again"
              : errMessage(err),
            ambiguous: isAmbiguous(err),
          };
          logGiftCardSale({
            outcome: failure.ambiguous ? "unknown" : "no",
            value: unit.cardValue,
            price: unit.salePrice,
            saleId: null,
            clientId: saleClientId,
            staffId: session.staffId,
          });
          /* No retry, no roll back, no refund, and no later card charged
           * on the strength of a broken one. */
          break;
        }
      }
    }
    if (gone) return gone;

    const landedWords: string[] = [
      ...(cartSale !== null
        ? [`the ticket (${cartSale.total.toFixed(2)})`]
        : []),
      ...sold.map((c) => `a ${c.value.toFixed(2)} gift card`),
    ];

    if (failure !== null) {
      /* T95 review: what was never attempted. A CARD failed at index
       * sold.length, so everything after it is untried; a CART failure
       * happened before any card, so every card is untried. Slicing from
       * `sold.length + 1` in both cases silently dropped the first card
       * from the sentence when the cart was the thing that broke. */
      const notDone = units
        .slice(cardsAttempted)
        .map((u) => `the ${u.cardValue.toFixed(2)} gift card`);
      return NextResponse.json(
        {
          error: [
            landedWords.length > 0 ? `Sold ${landedWords.join(", ")}.` : "",
            `${failure.what} was NOT sold: ${failure.message}.`,
            notDone.length > 0
              ? `${notDone.join(", ")} was not attempted.`
              : "",
            "Nothing was retried or refunded.",
          ]
            .filter(Boolean)
            .join(" "),
          stage: "checkout",
          ambiguous: failure.ambiguous,
          partial: landedWords.length > 0,
          total: ticketTotal,
          giftCardsSold: sold,
          ...(cartSale !== null ? { cartSold: cartSale } : {}),
        },
        { status: 502 },
      );
    }
    if (suppressedKind !== null) {
      return NextResponse.json({
        ok: false,
        suppressed: suppressedKind,
        ...(landedWords.length > 0
          ? {
              summary:
                `Sold ${landedWords.join(", ")}. The rest was not sent to ` +
                `Mindbody (${suppressedKind}).`,
              giftCardsSold: sold,
            }
          : {}),
        ...actorFields({
          actorFallback: fallbackNote,
          staffSessionEnded: false,
        }),
      });
    }
    return NextResponse.json({
      ok: true,
      method: method as Method,
      total: ticketTotal,
      saleId: cartSale?.saleId ?? sold[0]?.saleId ?? null,
      cartId: cartSale?.cartId ?? null,
      /* What the done screen shows large, one per card: the id to write
       * on it and what it is worth. The done screen and the emailed
       * receipt are the only two places the id is meant to be read. */
      giftCardsSold: sold,
      ...(cartSale !== null ? { cartSold: cartSale } : {}),
      receiptRequested: sendEmail,
      emailReceipt: sendEmail ? receiptConfirmed : null,
      ...actorFields({ actorFallback: fallbackNote, staffSessionEnded: false }),
    });
  }

  /* ==================================================================
   * T90: lines bought for another client.
   *
   * Pete: "a client can purchase something for another client (like a
   * membership, pass, etc.) that option needs to exist in the app." One
   * ClientId per Mindbody cart and no per-item recipient, so this ticket
   * is one sale PER recipient, run SEQUENTIALLY (the paying client's
   * cart first) in this one request: one tap, one flight, and each cart
   * rehearsed before any of them is charged.
   *
   * Honest partial results are the whole point of the block below:
   * nothing is retried, rolled back or refunded, and when cart two fails
   * after cart one charged the answer names both.
   * ================================================================== */
  /* T90 review: a line "for" the client paying is that client's own. */
  const groups = groupByRecipient(items, saleClientId);
  if (groups.length > 1 || groups[0]?.forClientId != null) {
    /* Display names for the wording only. They arrive beside the items
     * (like T43's `name`), are never forwarded to Mindbody, and no
     * decision is made on them: the carts are addressed by id. */
    const rawItems: unknown[] = Array.isArray(payload?.items)
      ? payload.items
      : [];
    const indexOf = new Map<CartLine, number>();
    items.forEach((line, i) => indexOf.set(line, i));
    const trimmed = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
    const nameOfLine = (line: CartLine): string => {
      const raw = rawItems[indexOf.get(line) ?? -1] as
        | Record<string, unknown>
        | undefined;
      return trimmed(raw?.["name"]) ?? `${line.type} ${line.metadataId}`;
    };
    const nameOfGroup = (group: (typeof groups)[number]): string => {
      if (group.forClientId === null) {
        /* The payer's own name when the browser sent it, for the same
         * reason the recipients' names ride along: the sentence a
         * teacher reads should name people. Display only. */
        const named = trimmed(payload?.clientName);
        if (named) return named;
        return clientId ? "the client on the sale" : "the walk-in account";
      }
      for (const line of group.items) {
        const raw = rawItems[indexOf.get(line) ?? -1] as
          | Record<string, unknown>
          | undefined;
        const named = trimmed(raw?.["forClientName"]);
        if (named) return named;
      }
      return `client ${group.forClientId}`;
    };
    const itemsOf = (group: (typeof groups)[number]): string =>
      group.items.map(nameOfLine).join(", ");

    /* A split cannot be spread over carts: its two legs sum to ONE
     * total, and there is no matrix of legs against recipients here.
     * Refused in words rather than guessed at. */
    if (split !== null) {
      return NextResponse.json(
        {
          error:
            "A split payment cannot pay for a line bought for another " +
            "client. Take one tender for the whole ticket, or sell the " +
            "other client's line on its own. Nothing was charged.",
          stage: "method",
        },
        { status: 409 },
      );
    }
    /* The card on file and the account balance belong to the client
     * paying, and a recipient's cart cannot draw on them: v6 has no
     * per-item payer, and PayerClientId needs a stored "Pays for"
     * relationship (T63). Never attempted, so no refusal has to be read
     * as proof it charged nothing. */
    if (method === "storedcard" || method === "credit") {
      return NextResponse.json(
        {
          error:
            "The card on file pays only for the client on the sale. Take " +
            "cash, a card at the reader, or a gift card for lines bought " +
            "for someone else. Nothing was charged.",
          stage: "method",
        },
        { status: 409 },
      );
    }
    /* T93 x T90 review (Pete, 2026-09-14: "Allow two charges."): a typed
     * card DOES pay a ticket holding a line for another client. This
     * branch is one Mindbody cart per recipient, so the card is charged
     * once per cart, each for that cart's own rehearsed total, in the
     * T90 order (the payer's cart first). The per-cart floor is checked
     * below, once every cart has been priced and before any is charged,
     * and a second charge refused or ambiguous after the first stood is
     * reported as exactly that by the loop's existing wording: never
     * retried, never refunded. */

    const perCart =
      discount === null
        ? groups.map(() => null)
        : splitDiscount(items, discount, groups);

    /* Every cart is rehearsed BEFORE any is charged, so a cart Mindbody
     * will not price stops the whole ticket with nothing spent. */
    const rehearsed: {
      group: (typeof groups)[number];
      clientId: string;
      discount: Discount | null;
      total: number;
      subtotal: number;
      discounted: number;
    }[] = [];
    for (const [i, group] of groups.entries()) {
      const cartClientId = group.forClientId ?? saleClientId;
      const cartDiscount = perCart[i] ?? null;
      let cartPriced;
      try {
        cartPriced = await rehearseCheckout(
          group.items,
          cartClientId,
          cartDiscount,
        );
      } catch (err) {
        return NextResponse.json(
          { error: errMessage(err), stage: "rehearsal" },
          { status: 502 },
        );
      }
      if (cartPriced.suppressed) {
        /* T90 review: one suppressed cart suppresses the whole ticket,
         * BEFORE any of them is charged. Dry run suppresses every cart
         * anyway; the write guard judges each by its own client id, so
         * the listed cart could have gone out alone, and deliberately
         * does not: a ticket the teacher rang up as one sale must not
         * half exist because a test rail let one client through. The
         * sentence names the cart that stopped it, since otherwise
         * nothing on screen says which. */
        const kind = await suppressionKind();
        return NextResponse.json({
          ok: false,
          suppressed: kind,
          summary:
            `Nothing was sent to Mindbody (${kind}). The cart for ` +
            `${nameOfGroup(group)} was suppressed, and a ticket holding a ` +
            "line for another client goes out whole or not at all.",
        });
      }
      if (cartPriced.disagrees || cartPriced.grandTotal === null) {
        return NextResponse.json(
          {
            error:
              `${nameOfGroup(group)}: ` +
              (cartPriced.discountDisagrees
                ? `the discount disagrees: ours $${cartPriced.expectedDiscount.toFixed(2)}, ` +
                  `Mindbody's $${(cartPriced.discountTotal ?? 0).toFixed(2)}. `
                : "totals disagree between our math and Mindbody's. ") +
              "Nothing was charged; this is a bug to report, not a state " +
              "to charge from.",
            stage: "rehearsal",
          },
          { status: 409 },
        );
      }
      rehearsed.push({
        group,
        clientId: cartClientId,
        discount: cartDiscount,
        total: cartPriced.grandTotal,
        subtotal: cartPriced.expectedSubtotal,
        discounted: cartPriced.expectedDiscount,
      });
    }
    /* The armed discount must arrive at Mindbody whole: the carts' own
     * discounts, as Mindbody just priced them, have to sum to the cent
     * to the figure the teacher armed, or nothing goes out. */
    if (discount !== null) {
      const armedCents = discountCents(items, discount);
      const sumCents = rehearsed.reduce(
        (n, c) => n + Math.round(c.discounted * 100),
        0,
      );
      if (sumCents !== armedCents) {
        return NextResponse.json(
          {
            error:
              `The discount splits to $${(sumCents / 100).toFixed(2)} across ` +
              `the carts but was armed at $${(armedCents / 100).toFixed(2)}. ` +
              "Nothing was charged; this is a bug to report, not a state " +
              "to charge from.",
            stage: "rehearsal",
          },
          { status: 409 },
        );
      }
    }
    const ticketTotal = roundToCents(
      rehearsed.reduce((n, c) => n + c.total, 0),
    );
    /* The whole ticket's pre-tax figures, as the carts were just priced:
     * what the answer's `discount` block reports. */
    const ticketSubtotal = roundToCents(
      rehearsed.reduce((n, c) => n + c.subtotal, 0),
    );
    const ticketDiscounted = roundToCents(
      rehearsed.reduce((n, c) => n + c.discounted, 0),
    );
    if (
      typeof cashTendered === "number" &&
      method === "cash" &&
      cashTendered < ticketTotal
    ) {
      return NextResponse.json(
        { error: "Tendered cash is less than the total." },
        { status: 400 },
      );
    }
    /* T93 review: the $10 floor is a card-processing floor and each cart
     * is its OWN authorization on the same card, so it applies per cart,
     * not to the ticket. Checked here, after every cart has been priced
     * and before any has been charged, so a ticket holding a cart under
     * the floor costs nothing; the sentence names the cart, since
     * otherwise nothing on screen says which one stopped it. */
    if (method === "typedcard") {
      const under = rehearsed.find((c) => c.total < CARD_MINIMUM_USD);
      if (under !== undefined) {
        return NextResponse.json(
          {
            error:
              `The cart for ${nameOfGroup(under.group)} is ` +
              `${under.total.toFixed(2)}, under the $${CARD_MINIMUM_USD} ` +
              "card minimum, and a typed card is charged once per cart. " +
              "Take cash or a gift card for this ticket, or sell that " +
              "line on its own. Nothing was charged.",
            stage: "method",
          },
          { status: 409 },
        );
      }
    }
    /* T83's gift card does not care whose cart it pays, so it pays all of
     * them: ONE live balance read against the whole ticket (a read, so a
     * refusal here charged nothing), and then each cart's own share. */
    if (method === "giftcard") {
      const refusedCard = await giftCardRefusal(
        giftCardNumber as string,
        ticketTotal,
        "total",
      );
      if (refusedCard) return refusedCard;
    }

    /** One cart's outcome, in the order the carts ran. */
    const sales: {
      forClientId: string | null;
      clientId: string;
      name: string;
      items: string;
      productIds: string[];
      total: number;
      saleId: string | null;
      cartId: string | null;
      suppressed: string | null;
    }[] = [];
    let failure: { name: string; message: string; ambiguous: boolean } | null =
      null;
    let fallbackNote: ActorFallback | null = null;
    let sessionEnded = false;
    let gone: Response | null = null;

    for (const cart of rehearsed) {
      const startedAt = new Date();
      const isComp = method === "comp";
      try {
        const run = await runAsActor(
          session,
          "/api/checkout",
          (actor) =>
            isComp
              ? checkoutCart(
                  cart.group.items,
                  cart.clientId,
                  [],
                  actor,
                  sendEmail,
                  cart.discount,
                )
              : checkoutCart(
                  cart.group.items,
                  cart.clientId,
                  method === "giftcard"
                    ? {
                        type: "GiftCard",
                        amount: cart.total,
                        cardNumber: giftCardNumber as string,
                      }
                    : method === "typedcard"
                      ? {
                          /* T93 review: this cart's own authorization on
                           * the card, for the total Mindbody just
                           * rehearsed for it. */
                          type: "CreditCard",
                          amount: cart.total,
                          card: typedCard as TypedCard,
                        }
                      : { type: "Cash", amount: cart.total },
                  actor,
                  sendEmail,
                  cart.discount,
                ),
          /* A comp is never redone as the studio account (T49). */
          isComp ? { fallback: false } : undefined,
        );
        const outcome = run.result;
        if (run.actorFallback) fallbackNote = run.actorFallback;
        if (run.staffSessionEnded) sessionEnded = true;
        const ids =
          outcome.suppressed !== null
            ? { saleId: null, cartId: null }
            : await (async () => {
                const numeric = await latestSaleId(cart.clientId, startedAt);
                return {
                  saleId:
                    numeric === null ? outcome.saleId : String(numeric),
                  cartId: outcome.saleId,
                };
              })();
        sales.push({
          forClientId: cart.group.forClientId,
          clientId: cart.clientId,
          name: nameOfGroup(cart.group),
          items: itemsOf(cart.group),
          productIds: cart.group.items.map((l) => String(l.metadataId)),
          total: isComp ? 0 : cart.total,
          saleId: ids.saleId,
          cartId: ids.cartId,
          suppressed: outcome.suppressed,
        });
        /* T79's record, per cart: each cart IS a sale, so each one's
         * discount is filed on its own client with its own figures. */
        if (discount !== null && compReason !== null) {
          const paid = isComp ? 0 : cart.total;
          const line = discountRecordLine({
            discount,
            discounted: cart.discounted,
            subtotal: cart.subtotal,
            paid,
            full,
            reason: compReason,
            teacherName: teacher?.name ?? null,
          });
          const suppressedHere = outcome.suppressed !== null;
          let noteId: number | null = null;
          const house = houseClientId();
          if (
            !suppressedHere &&
            cart.clientId !== house
          ) {
            const filed = await fileFormulaNote({
              session,
              clientId: cart.clientId,
              note: [
                `${line}${teacher ? "." : ""}`,
                ids.saleId ? `Sale ${ids.saleId}.` : null,
              ]
                .filter(Boolean)
                .join(" "),
              route: "/api/checkout formula-note",
              logTag: "[comp]",
            });
            noteId = filed.id;
          }
          console.log(
            `[comp] ${target()} sale=${suppressedHere ? "suppressed" : (ids.saleId ?? "unknown")} ` +
              `client=${cart.clientId} total=${cart.discounted.toFixed(2)} ` +
              `reason=${JSON.stringify(line)} kind=${compReason.kind} ` +
              `discount=${discount.mode}:${discount.value} ` +
              `off=${cart.discounted.toFixed(2)} paid=${paid.toFixed(2)} ` +
              `shape=lines for=${cart.group.forClientId ?? "self"} ` +
              teacherLogTag(teacher) +
              (noteId !== null ? ` note=${noteId}` : ""),
          );
          await insertCompReceipt({
            saleId: suppressedHere ? null : ids.saleId,
            cartId: suppressedHere ? null : ids.cartId,
            clientId: cart.clientId,
            totalCents: Math.round(cart.discounted * 100),
            items: cart.group.items.map((l) => ({
              type: l.type,
              id: String(l.metadataId),
              name: nameOfLine(l),
              quantity: l.quantity,
              price: l.price,
            })),
            reason: line,
            target: target(),
            suppressed: suppressedHere,
            teacherId: teacher === null ? null : String(teacher.id),
            teacherName: teacher?.name ?? null,
            kind: compReason.kind,
            detail: compReason.detail ? compReason.detail : null,
            formulaNoteId: noteId,
            discountAmount: cart.discounted,
            discountPercent: discount.mode === "percent" ? discount.value : null,
            saleTotal: paid,
          });
        }
      } catch (err) {
        const ended = staffSessionEndedResponse(err);
        if (ended && sales.length === 0) {
          gone = ended;
          break;
        }
        failure = {
          name: nameOfGroup(cart.group),
          message: isAmbiguous(err)
            ? "it did not answer, so it MAY have gone through. Check the " +
              "dev drawer or Mindbody before charging again"
            : errMessage(err),
          ambiguous: isAmbiguous(err),
        };
        /* Nothing after a failure runs: no retry, no roll back, no
         * refund, and no later cart charged on the strength of a broken
         * one. */
        break;
      }
    }
    if (gone) return gone;

    /* T93 review: "keep on file" stores the card ONCE, on the attached
     * client, after that client's own cart has gone through; a recipient
     * never gets the card, and a ticket whose carts all failed stores
     * nothing. `keep` was refused above without an attached client, so
     * there is somebody to keep it for. A ticket made entirely of lines
     * for other people has no payer cart at all, and then the first cart
     * that stood is what the store waits on: the card was used, and the
     * teacher asked for it to be kept. */
    let typedKeep: Record<string, unknown> = {};
    const typedFour =
      method === "typedcard" && typedCard !== null
        ? { typedCard: { lastFour: typedCardLastFour(typedCard.number) } }
        : {};
    if (method === "typedcard" && typedCard?.keep === true) {
      const payerCart = sales.find((sale) => sale.forClientId === null);
      const waitOn = payerCart ?? sales[0];
      if (waitOn !== undefined && waitOn.suppressed === null) {
        typedKeep = await keepTypedCard(typedCard);
      }
    }

    const landed = sales.filter((sale) => sale.suppressed === null);
    const suppressedSales = sales.filter((sale) => sale.suppressed !== null);
    const said = (list: typeof sales): string =>
      list
        .map((sale) => `${sale.items} for ${sale.name}`)
        .join("; ");
    const soldLine = landed.length > 0 ? `Sold ${said(landed)}.` : "";
    const suppressedLine =
      suppressedSales.length > 0
        ? `${said(suppressedSales)} was not sent to Mindbody ` +
          `(${suppressedSales[0]?.suppressed}).`
        : "";

    if (failure !== null) {
      const notSold = rehearsed
        .slice(sales.length)
        .map((c) => `${itemsOf(c.group)} for ${nameOfGroup(c.group)}`)
        .join("; ");
      return NextResponse.json(
        {
          error: [
            soldLine,
            suppressedLine,
            `${notSold} was NOT sold: ${failure.message}.`,
            "Nothing was retried or refunded.",
          ]
            .filter(Boolean)
            .join(" "),
          stage: "checkout",
          ambiguous: failure.ambiguous,
          partial: landed.length > 0,
          sales,
          total: ticketTotal,
          ...typedFour,
          ...typedKeep,
          ...(sessionEnded ? { staffSessionEnded: true } : {}),
        },
        { status: 502 },
      );
    }
    if (landed.length === 0) {
      /* Every cart suppressed: the ordinary suppressed answer, which the
       * screen renders amber and never as a sale. */
      return NextResponse.json({
        ok: false,
        suppressed: sales[0]?.suppressed ?? (await suppressionKind()),
        sales,
        ...actorFields({
          actorFallback: fallbackNote,
          staffSessionEnded: sessionEnded,
        }),
      });
    }
    if (suppressedSales.length > 0) {
      /* Mixed, and the write guard judges each cart by its own client
       * id, so this is reachable: some carts went out and some did not.
       * Never reported as done. */
      return NextResponse.json({
        ok: false,
        suppressed: suppressedSales[0]?.suppressed,
        summary: `${soldLine} ${suppressedLine}`.trim(),
        sales,
        total: ticketTotal,
        ...typedFour,
        ...typedKeep,
        ...actorFields({
          actorFallback: fallbackNote,
          staffSessionEnded: sessionEnded,
        }),
      });
    }
    return NextResponse.json({
      ok: true,
      method: method as Method,
      total: method === "comp" ? 0 : ticketTotal,
      /* The ticket's own sale ids, one per recipient; `saleId` stays the
       * first cart's so every existing reader keeps working. */
      saleId: sales[0]?.saleId ?? null,
      cartId: sales[0]?.cartId ?? null,
      sales,
      carts: sales.length,
      ...(method === "giftcard"
        ? { giftCard: { lastFour: giftCardLastFour(giftCardNumber as string) } }
        : {}),
      ...typedFour,
      ...typedKeep,
      receiptRequested: sendEmail,
      emailReceipt: null,
      ...(discount !== null && compReason !== null
        ? {
            discountShape: "lines",
            discount: {
              mode: discount.mode,
              value: discount.value,
              amount: ticketDiscounted,
              subtotal: ticketSubtotal,
              percent: discountPercentLabel(
                discount,
                ticketDiscounted,
                ticketSubtotal,
              ),
              full,
              reason: compReason,
              teacher: teacher ? { id: teacher.id, name: teacher.name } : null,
            },
          }
        : {}),
      ...actorFields({
        actorFallback: fallbackNote,
        staffSessionEnded: sessionEnded,
      }),
    });
  }

  /* Step 1, every path: the Test: true rehearsal, which is also where
   * the AUTHORITATIVE total comes from. The browser's number is never
   * trusted; the amount charged below is the one Mindbody just priced.
   * T79: rehearsed WITH the discount lines the real call will carry, so
   * the total is the discounted one and the DiscountTotal check runs.
   * For the under-$10 card path this is exactly PLAN 2.3's mitigation:
   * a cart Mindbody will not accept fails HERE, before any credit is
   * bought, and the failure costs nothing. */
  let priced;
  try {
    priced = await rehearseCheckout(items, saleClientId, discount);
  } catch (err) {
    return NextResponse.json(
      { error: errMessage(err), stage: "rehearsal" },
      { status: 502 },
    );
  }
  if (priced.suppressed) {
    /* The rehearsal never left the building, so the real write would not
     * either. Report suppression for the whole checkout; nothing was
     * charged and no total exists. */
    return NextResponse.json({
      ok: false,
      suppressed: await suppressionKind(),
    });
  }
  if (priced.disagrees || priced.grandTotal === null) {
    return NextResponse.json(
      {
        error: priced.discountDisagrees
          ? `The discount disagrees: ours $${priced.expectedDiscount.toFixed(2)}, ` +
            `Mindbody's $${(priced.discountTotal ?? 0).toFixed(2)}. Nothing was ` +
            "charged; this is a bug to report, not a state to charge from."
          : "Totals disagree between our math and Mindbody's. Nothing was " +
            "charged; this is a bug to report, not a state to charge from.",
        stage: "rehearsal",
      },
      { status: 409 },
    );
  }
  const total = priced.grandTotal;

  /* T49: the ids a real sale is answered with. `cartId` is
   * ShoppingCart.Id, the GUID every path has always answered as
   * `saleId`; `saleId` becomes the numeric Sale.Id when the lookup finds
   * one and stays the GUID when it does not. Never called for a
   * suppressed write (there is no sale to find). `startedAt` is taken
   * here, before any write below goes out: a sale timed before it is
   * not this one (review). */
  const startedAt = new Date();
  const saleIds = async (
    cartId: string | null,
  ): Promise<{ saleId: string | null; cartId: string | null }> => {
    if (cartId === null) return { saleId: null, cartId: null };
    const numeric = await latestSaleId(saleClientId, startedAt);
    return { saleId: numeric === null ? cartId : String(numeric), cartId };
  };

  /* A PRESENT tendered amount below the total is a short tender, zero
   * included ("" was never sent; an explicit 0 is an entry). Display-only
   * or not, the server refuses to record a cash sale the drawer cannot
   * cover. */
  if (
    typeof cashTendered === "number" &&
    method === "cash" &&
    cashTendered < total
  ) {
    return NextResponse.json(
      { error: "Tendered cash is less than the total." },
      { status: 400 },
    );
  }

  /* ------------------------ T79: the record -------------------------
   * T43: ALWAYS one server log line, so a discount is on record even
   * with no database (the T29 charter: DATABASE_URL unset runs on
   * fallbacks); the table row on top of it when there is one. Written
   * only once the Mindbody call has resolved, with the sale id it
   * returned, or `suppressed` for a write the guard or dry run ate.
   * Nothing here touches the payload, the single flight or the outcome
   * wording: the record is a side effect of an answer, never a step
   * before one. The wording is discountRecordLine's, the one place it
   * lives ("Discount $60.00 (60%) on $100.00, paid $40.00: Trade,
   * massage swap. By Kim Farrell", or "Comped $100.00: ..." at 100%).
   *
   * `subtotal` and `discounted` are the pre-tax figures the server
   * spread (expectedSubtotal and expectedDiscount, which the rehearsal
   * just proved equal to Mindbody's SubTotal and DiscountTotal); `paid`
   * is Mindbody's grand total, what the client pays. */
  const subtotal = priced.expectedSubtotal;
  const discounted = priced.expectedDiscount;
  const recordLine = (paid: number): string =>
    compReason === null || discount === null
      ? ""
      : discountRecordLine({
          discount,
          discounted,
          subtotal,
          paid,
          full,
          reason: compReason,
          teacherName: teacher?.name ?? null,
        });
  /* T45: the log line's data tags, on every [comp] line. */
  const compTags = (paid: number, shape: DiscountShape) =>
    `reason=${JSON.stringify(recordLine(paid))} ` +
    `kind=${compReason?.kind ?? "none"} ` +
    `discount=${discount ? `${discount.mode}:${discount.value}` : "none"} ` +
    `off=${discounted.toFixed(2)} paid=${paid.toFixed(2)} shape=${shape} ` +
    teacherLogTag(teacher);

  /* T45: the note on the client. Mindbody's checkout carries no notes
   * field, but a client has Formula Notes (`POST
   * /client/addclientformulanote`, client.yml), which is where a record
   * of the discount belongs for the studio's own eyes; on site 471,
   * which has them disabled, the same sentence lands as a T58-signed
   * Notes entry (T62, src/lib/formulanote.ts). Filed only after a REAL
   * sale (not suppressed, not refused, not ambiguous) for a NAMED
   * client: the house client is a catch-all and a note on it names
   * nobody. The write itself goes through mindbody() with the client
   * id in the options, as the signed-in teacher with the ordinary
   * fallback, bounded to FORMULA_NOTE_WAIT_MS, never throwing. It runs
   * AFTER the outcome is decided and can never change it: the sale
   * already happened, so a failure here is one log line and a null on
   * the receipt. */
  const fileDiscountNote = async (
    saleId: string | null,
    paid: number,
  ): Promise<{ id: number | null; via: "formula" | "notes" | null }> => {
    const none = { id: null, via: null };
    if (compReason === null) return none;
    const house = houseClientId();
    if (clientId === undefined || (house !== null && clientId === house)) {
      console.log(`[comp] formula-note skipped: house client`);
      return none;
    }
    const note = [
      `${recordLine(paid)}${teacher ? "." : ""}`,
      saleId ? `Sale ${saleId}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const filed = await fileFormulaNote({
      session,
      clientId,
      note,
      route: "/api/checkout formula-note",
      logTag: "[comp]",
    });
    return { id: filed.id, via: filed.via };
  };

  /**
   * T94: the overdraft this charge actually IS, filled in by whichever
   * credit check found the balance short with a PIN behind it. Null until
   * then, so a sale that stayed inside the balance records nothing even
   * when a token was presented.
   */
  let overdraft: {
    charged: number;
    balance: number;
    teacher: TeacherIdentity;
  } | null = null;

  /**
   * T94: the record of an overdraft, once the charge it describes has
   * resolved. One server log line ALWAYS (the teacher's staff id and the
   * shortfall, never the token), and on a real sale for a named client
   * the same sentence filed on the client the way a comp's reason is
   * (T45, with T62's Notes fallback), through mindbody() with the client
   * id so dry run and the write guard apply to it as to any write. It is
   * filed AFTER the money moved and can never change that outcome; a
   * suppressed sale files nothing, and says so.
   */
  const recordOverdraft = async (
    saleId: string | null,
    suppressed: boolean,
  ): Promise<Record<string, unknown>> => {
    if (overdraft === null) return {};
    const short = roundToCents(overdraft.charged - overdraft.balance);
    console.log(
      `[overdraft] ${target()} sale=${suppressed ? "suppressed" : (saleId ?? "unknown")} ` +
        `client=${clientId ?? "house"} charged=${overdraft.charged.toFixed(2)} ` +
        `balance=${overdraft.balance.toFixed(2)} short=${short.toFixed(2)} ` +
        `teacher=${overdraft.teacher.id}`,
    );
    let via: "formula" | "notes" | null = null;
    const house = houseClientId();
    const onHouse = clientId !== undefined && house !== null && clientId === house;
    if (onHouse) console.log(`[overdraft] note skipped: house client`);
    if (!suppressed && clientId !== undefined && !onHouse) {
      /* T94 review: an account can already be negative when it is
       * charged again, and "$-5.00" is not how money reads. */
      const usd = (n: number) =>
        `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
      const note =
        `Account charged ${usd(overdraft.charged)} against a ` +
        `${usd(overdraft.balance)} balance, authorized by ` +
        `${overdraft.teacher.name || `staff ${overdraft.teacher.id}`}.` +
        (saleId ? ` Sale ${saleId}.` : "");
      const filed = await fileFormulaNote({
        session,
        clientId,
        note,
        route: "/api/checkout overdraft-note",
        logTag: "[overdraft]",
      });
      via = filed.via;
    }
    return {
      overdraft: {
        charged: overdraft.charged,
        balanceBefore: overdraft.balance,
        shortfall: short,
        teacher: overdraft.teacher.name,
        noteVia: via,
      },
    };
  };

  /** After any path's write resolved: the note (real sales only), the
   *  log line and the receipt row. Answers the fields the response
   *  carries for a discounted sale, or nothing when there is none. */
  const recordDiscount = async (o: {
    saleId: string | null;
    cartId: string | null;
    suppressed: boolean;
    paid: number;
    shape: DiscountShape;
    /** The comp-payment shape comps the whole undiscounted total, tax
     *  included; that is the amount on the studio for that shape. */
    onStudio: number;
  }): Promise<Record<string, unknown>> => {
    if (discount === null || compReason === null) return {};
    const filed = o.suppressed
      ? { id: null, via: null }
      : await fileDiscountNote(o.saleId, o.paid);
    console.log(
      `[comp] ${target()} sale=${o.suppressed ? "suppressed" : (o.saleId ?? "unknown")} ` +
        `client=${clientId ?? "house"} total=${o.onStudio.toFixed(2)} ` +
        compTags(o.paid, o.shape) +
        (filed.id !== null ? ` note=${filed.id}` : ""),
    );
    await insertCompReceipt({
      saleId: o.suppressed ? null : o.saleId,
      cartId: o.suppressed ? null : o.cartId,
      clientId: clientId ?? null,
      totalCents: Math.round(o.onStudio * 100),
      items: compItems,
      reason: recordLine(o.paid),
      target: target(),
      suppressed: o.suppressed,
      teacherId: teacher === null ? null : String(teacher.id),
      teacherName: teacher?.name ?? null,
      kind: compReason.kind,
      detail: compReason.detail ? compReason.detail : null,
      formulaNoteId: filed.id,
      discountAmount: discounted,
      discountPercent: discount.mode === "percent" ? discount.value : null,
      saleTotal: o.paid,
    });
    return {
      noteVia: filed.via,
      discountShape: o.shape,
      discount: {
        mode: discount.mode,
        value: discount.value,
        amount: discounted,
        subtotal,
        percent: discountPercentLabel(discount, discounted, subtotal),
        full,
        reason: compReason,
        teacher: teacher ? { id: teacher.id, name: teacher.name } : null,
      },
    };
  };

  /* -------------------------- T28: split ---------------------------- */
  if (split !== null) {
    const [legA, legB] = split;

    /* The legs must sum EXACTLY to the rehearsed server total, compared
     * after cent rounding. The client sends AMOUNTS only, so the
     * teacher's chosen split is honored -- but the SUM is the server's
     * total, never the browser's: each leg is charged only because
     * together they equal the number Mindbody just priced. */
    const legSum = roundToCents(legA.amount + legB.amount);
    if (legSum !== roundToCents(total)) {
      return NextResponse.json(
        {
          error:
            `The split's legs sum to ${legSum.toFixed(2)}, but Mindbody's ` +
            `total is ${total.toFixed(2)}. Nothing was charged; re-enter ` +
            "the split against the current total.",
          stage: "method",
          total,
        },
        { status: 409 },
      );
    }

    /* Both methods pass their T24 availability checks server-side, on a
     * profile read at charge time -- the browser's snapshot is never the
     * basis for a money decision. A failure here is a failed READ;
     * nothing has been charged. T83: read only when a leg is bound to
     * the client, since a cash-and-gift-card split may have no client
     * at all; the checks below each require it and are the only readers
     * of it. */
    let profile: Awaited<ReturnType<typeof clientPaymentProfile>> | null = null;
    if (boundLeg !== null) {
      try {
        profile = await clientPaymentProfile(clientId as string);
      } catch (err) {
        return NextResponse.json(
          {
            error: `Could not read the client's payment profile: ${errMessage(err)} Nothing was charged.`,
            stage: "method",
          },
          { status: 502 },
        );
      }
    }

    const creditLeg =
      legA.method === "credit" ? legA : legB.method === "credit" ? legB : null;
    if (creditLeg !== null) {
      /* A credit leg is a bound leg, so the profile above was read. */
      const balance = profile?.balance ?? null;
      /* T94: a PIN authorizes charging past the balance, and only a PIN
       * does. The browser's number decides nothing: the shortfall is
       * computed here, from the balance just read. */
      if (
        (balance ?? 0) < creditLeg.amount &&
        overdraftTeacher !== null &&
        clientId !== undefined
      ) {
        overdraft = {
          charged: creditLeg.amount,
          balance: balance ?? 0,
          teacher: overdraftTeacher,
        };
      } else if (balance === null || balance < creditLeg.amount) {
        return NextResponse.json(
          {
            error:
              balance === null
                ? "Mindbody reports no account balance for this client."
                : `Account credit is ${balance.toFixed(2)}, which ` +
                  `does not cover the ${creditLeg.amount.toFixed(2)} credit leg.`,
            stage: "method",
            creditBalance: balance,
          },
          { status: 409 },
        );
      }
    }

    const cardLeg =
      legA.method === "storedcard"
        ? legA
        : legB.method === "storedcard"
          ? legB
          : null;
    if (cardLeg !== null) {
      /* A card leg is a bound leg, so the profile above was read. */
      const onFile = profile?.card ?? null;
      if (!onFile) {
        return NextResponse.json(
          { error: "No card on file for this client.", stage: "method" },
          { status: 409 },
        );
      }
      if (onFile.expired) {
        return NextResponse.json(
          {
            error: `The card on file (ending ${onFile.lastFour}) is expired.`,
            stage: "method",
          },
          { status: 409 },
        );
      }
      /* The $10 minimum applies to the CARD LEG's amount: the floor is a
       * card-processing floor, so what matters is what the card is
       * charged (the same reading as assumption P4). A card leg under
       * $10 is REFUSED with the reason, never topped up: the under-$10
       * credit dance (buy $10 of credit, then debit) on top of a two-leg
       * split is complexity nobody asked for, and it would turn the
       * split's one-call no-seam guarantee into a two-write seam. The
       * teacher's fix is to move the split point or use one method. */
      if (cardLeg.amount < CARD_MINIMUM_USD) {
        return NextResponse.json(
          {
            error:
              `The card leg is ${cardLeg.amount.toFixed(2)}, under the ` +
              `$${CARD_MINIMUM_USD} card minimum. Make the card leg at ` +
              `least $${CARD_MINIMUM_USD}, or use one method. Nothing was charged.`,
            stage: "method",
          },
          { status: 409 },
        );
      }
    }

    /* T83: the gift card leg, checked against the live balance the same
     * way the credit leg is checked against the account. */
    const giftLeg =
      legA.method === "giftcard"
        ? legA
        : legB.method === "giftcard"
          ? legB
          : null;
    if (giftLeg !== null) {
      const refused = await giftCardRefusal(
        giftLeg.giftCardNumber as string,
        giftLeg.amount,
        "gift card part",
      );
      if (refused) return refused;
    }

    /* T93: the $10 floor is a CARD-PROCESSING floor, so it applies to a
     * typed card leg exactly as it does to a stored one. There is no
     * credit-purchase path here to top it up (that one needs a client and
     * a stored card), so this is a plain refusal with nothing charged. */
    if (typedLeg !== null && typedLeg.amount < CARD_MINIMUM_USD) {
      return NextResponse.json(
        {
          error:
            `The card leg is ${typedLeg.amount.toFixed(2)}, under the ` +
            `$${CARD_MINIMUM_USD} card minimum. Make the card leg at ` +
            `least $${CARD_MINIMUM_USD}, or use one method. Nothing was charged.`,
          stage: "method",
        },
        { status: 409 },
      );
    }

    const toPayment = (leg: SplitLeg): CheckoutPayment =>
      leg.method === "storedcard"
        ? {
            type: "StoredCard",
            amount: leg.amount,
            lastFour: (profile?.card as { lastFour: string }).lastFour,
          }
        : leg.method === "typedcard"
          ? {
              type: "CreditCard",
              amount: leg.amount,
              card: leg.typedCard as TypedCard,
            }
          : leg.method === "credit"
            ? { type: "DebitAccount", amount: leg.amount }
            : leg.method === "giftcard"
              ? {
                  type: "GiftCard",
                  amount: leg.amount,
                  cardNumber: leg.giftCardNumber as string,
                }
              : { type: "Cash", amount: leg.amount };

    try {
      /* ONE checkoutshoppingcart call carrying both Payments entries in
       * the teacher's order: no partial seam exists, so a refusal
       * refuses the WHOLE sale and nothing partial can stand. */
      const run = await runAsActor(session, "/api/checkout", (actor) =>
        checkoutCart(
          items,
          /* T83: the house client when nobody is attached, exactly as
           * every other anonymous sale. Identical to `clientId`
           * whenever there is one. */
          saleClientId,
          [toPayment(legA), toPayment(legB)],
          actor,
          sendEmail,
          discount,
        ),
      );
      const outcome = run.result;
      if (outcome.suppressed) {
        const rec = await recordDiscount({
          saleId: null,
          cartId: null,
          suppressed: true,
          paid: total,
          shape: "lines",
          onStudio: discounted,
        });
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...rec,
          ...(await recordOverdraft(null, true)),
          ...actorFields(run),
        });
      }
      const ids = await saleIds(outcome.saleId);
      const rec = await recordDiscount({
        ...ids,
        suppressed: false,
        paid: total,
        shape: "lines",
        onStudio: discounted,
      });
      const od = await recordOverdraft(ids.saleId, false);
      return NextResponse.json({
        ok: true,
        method: "split",
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        legs: [
          { method: legA.method, amount: legA.amount },
          { method: legB.method, amount: legB.amount },
        ],
        /* T83: the last four, never the number. */
        ...(giftLeg === null
          ? {}
          : {
              giftCard: {
                lastFour: giftCardLastFour(giftLeg.giftCardNumber as string),
              },
            }),
        /* T93: the same rule for a typed card leg, and the keep outcome
         * reported separately from the charge. */
        ...(typedLeg === null
          ? {}
          : {
              typedCard: {
                lastFour: typedCardLastFour(
                  (typedLeg.typedCard as TypedCard).number,
                ),
              },
              ...(await keepTypedCard(typedLeg.typedCard as TypedCard)),
            }),
        receiptRequested: sendEmail,
        emailReceipt: null,
        ...rec,
        ...od,
        ...actorFields(run),
      });
    } catch (err) {
      /* Same posture as the single-method catch below: only a definite
       * 4xx refusal reports "not charged"; a 5xx or dead transport is
       * honest ambiguity and invites no retry. */
      const gone = staffSessionEndedResponse(err);
      if (gone) return gone;
      const ambiguous = isAmbiguous(err);
      return NextResponse.json(
        {
          error: ambiguous
            ? "The charge did not answer. It MAY have gone through. Check " +
              "the dev drawer or Mindbody before charging again."
            : errMessage(err),
          stage: "checkout",
          ambiguous,
        },
        { status: 502 },
      );
    }
  }

  const m = method as Method;
  try {
    if (m === "comp") {
      /* T79: the 100% discount. First the discount lines with NO
       * Payments (whether Mindbody takes a $0 cart that way is
       * unverified); if Mindbody refuses that with an error naming
       * payment, and ONLY a definite refusal (an ambiguous outcome may
       * already have written the sale, and is never retried), ONE
       * retry goes out in T43's proven shape: no DiscountAmount, one
       * Comp payment for the full undiscounted total, which a second
       * Test: true rehearsal prices first (a read in all but name; it
       * moves nothing). The answer says which shape Mindbody took. A
       * comp never falls back to the service account. */
      let run;
      let shape: DiscountShape = "lines";
      let onStudio = discounted;
      try {
        run = await runAsActor(
          session,
          "/api/checkout",
          (actor) =>
            checkoutCart(items, saleClientId, [], actor, sendEmail, discount),
          { fallback: false },
        );
      } catch (first) {
        const message = errMessage(first);
        /* The ONE documented fallback opens on a DEFINITE 4xx answer
         * from Mindbody naming payment, and on nothing else. Asking
         * !isAmbiguous() was not that: an error with no HTTP status at
         * all reads as not-ambiguous, so an error raised on our own
         * side before the request -- a staff session the token check
         * just ended, or checkoutCart's own "needs a payment" argument
         * guards, which carry the word -- would have opened it and sent
         * a second write. A 4xx is the only answer that says Mindbody
         * read the cart and refused it. */
        const status = mindbodyHttpStatus(first);
        const refusedForPayment =
          status !== null &&
          status >= 400 &&
          status < 500 &&
          !endedStaffSession(first) &&
          /payment/i.test(message);
        if (!refusedForPayment) {
          console.log(
            `[comp] ${target()} sale=none outcome=${isAmbiguous(first) ? "ambiguous" : "refused"} ` +
              `client=${clientId ?? "house"} total=${discounted.toFixed(2)} ` +
              compTags(0, "lines") +
              ` error=${JSON.stringify(message)}`,
          );
          throw first;
        }
        console.log(
          `[comp] ${target()} no-payment shape refused (${JSON.stringify(message)}); ` +
            "retrying once as a Comp payment",
        );
        let plain;
        try {
          plain = await rehearseCheckout(items, saleClientId);
        } catch (err) {
          return NextResponse.json(
            { error: errMessage(err), stage: "rehearsal" },
            { status: 502 },
          );
        }
        if (plain.suppressed) {
          return NextResponse.json({
            ok: false,
            suppressed: await suppressionKind(),
          });
        }
        if (plain.disagrees || plain.grandTotal === null) {
          return NextResponse.json(
            {
              error:
                "Totals disagree between our math and Mindbody's. Nothing was " +
                "charged; this is a bug to report, not a state to charge from.",
              stage: "rehearsal",
            },
            { status: 409 },
          );
        }
        shape = "comp-payment";
        onStudio = plain.grandTotal;
        const compTotal = plain.grandTotal;
        try {
          run = await runAsActor(
            session,
            "/api/checkout",
            (actor) =>
              checkoutCart(
                items,
                saleClientId,
                { type: "Comp", amount: compTotal },
                actor,
                sendEmail,
              ),
            { fallback: false },
          );
        } catch (err) {
          /* A refused or unanswered comp records no receipt (there is
           * no sale to receipt), but the attempt and its outcome go in
           * the log; the error itself is answered by the catch below
           * exactly as it always was. */
          console.log(
            `[comp] ${target()} sale=none outcome=${isAmbiguous(err) ? "ambiguous" : "refused"} ` +
              `client=${clientId ?? "house"} total=${compTotal.toFixed(2)} ` +
              compTags(0, shape) +
              ` error=${JSON.stringify(errMessage(err))}`,
          );
          throw err;
        }
      }
      const outcome = run.result;
      const ids =
        outcome.suppressed !== null
          ? { saleId: null, cartId: null }
          : await saleIds(outcome.saleId);
      const rec = await recordDiscount({
        ...ids,
        suppressed: outcome.suppressed !== null,
        paid: 0,
        shape,
        onStudio,
      });
      if (outcome.suppressed) {
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...rec,
          ...actorFields(run),
        });
      }
      return NextResponse.json({
        ok: true,
        method: m,
        total: 0,
        saleId: ids.saleId,
        cartId: ids.cartId,
        /* T82: a comp receipts like any sale (Pete: "Receipts should get
         * emailed even with comp, today it disallows it"). The cart
         * checkout confirms nothing either way, so emailReceipt stays
         * null and the done screen says "requested". */
        receiptRequested: sendEmail,
        emailReceipt: null,
        ...rec,
        ...actorFields(run),
      });
    }

    if (m === "cash") {
      /* T49: cash takes the ordinary one loud fallback. */
      const run = await runAsActor(session, "/api/checkout", (actor) =>
        checkoutCart(
          items,
          saleClientId,
          { type: "Cash", amount: total },
          actor,
          sendEmail,
          discount,
        ),
      );
      const outcome = run.result;
      const ids =
        outcome.suppressed !== null
          ? { saleId: null, cartId: null }
          : await saleIds(outcome.saleId);
      const rec = await recordDiscount({
        ...ids,
        suppressed: outcome.suppressed !== null,
        paid: total,
        shape: "lines",
        onStudio: discounted,
      });
      if (outcome.suppressed) {
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...rec,
          ...actorFields(run),
        });
      }
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        receiptRequested: sendEmail,
        emailReceipt: null,
        ...rec,
        ...actorFields(run),
      });
    }

    if (m === "typedcard") {
      /* T93: a whole sale on a card typed at the counter. Like cash and a
       * gift card it needs no client (a walk-in rides the house client);
       * unlike the stored card there is no credit-purchase path under the
       * $10 floor, so a total under it is refused plainly. The $10 floor
       * is the studio's card-processing floor and does not care whose
       * card it is. */
      const card = typedCard as TypedCard;
      if (total < CARD_MINIMUM_USD) {
        return NextResponse.json(
          {
            error:
              `The total is ${total.toFixed(2)}, under the ` +
              `$${CARD_MINIMUM_USD} card minimum. Take it in cash, or on ` +
              "the card on file. Nothing was charged.",
            stage: "method",
          },
          { status: 409 },
        );
      }
      const run = await runAsActor(session, "/api/checkout", (actor) =>
        checkoutCart(
          items,
          saleClientId,
          { type: "CreditCard", amount: total, card },
          actor,
          sendEmail,
          discount,
        ),
      );
      const outcome = run.result;
      const ids =
        outcome.suppressed !== null
          ? { saleId: null, cartId: null }
          : await saleIds(outcome.saleId);
      const rec = await recordDiscount({
        ...ids,
        suppressed: outcome.suppressed !== null,
        paid: total,
        shape: "lines",
        onStudio: discounted,
      });
      if (outcome.suppressed) {
        /* Suppression is never success, so nothing is kept on file
         * either: the charge did not happen. */
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...rec,
          ...actorFields(run),
        });
      }
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        /* The last four, which is all the done screen and any record ever
         * see of the number. */
        typedCard: { lastFour: typedCardLastFour(card.number) },
        /* T93: the store runs only now, after the charge stood. */
        ...(await keepTypedCard(card)),
        receiptRequested: sendEmail,
        emailReceipt: null,
        ...rec,
        ...actorFields(run),
      });
    }

    if (m === "giftcard") {
      /* T83: a whole sale on one gift card. Like cash it needs no
       * client (an anonymous sale rides the house client) and takes the
       * ordinary one loud fallback; unlike cash it is checked against a
       * live balance first, because the card can be short. */
      const number = giftCardNumber as string;
      const refused = await giftCardRefusal(number, total, "total");
      if (refused) return refused;
      const run = await runAsActor(session, "/api/checkout", (actor) =>
        checkoutCart(
          items,
          saleClientId,
          { type: "GiftCard", amount: total, cardNumber: number },
          actor,
          sendEmail,
          discount,
        ),
      );
      const outcome = run.result;
      const ids =
        outcome.suppressed !== null
          ? { saleId: null, cartId: null }
          : await saleIds(outcome.saleId);
      const rec = await recordDiscount({
        ...ids,
        suppressed: outcome.suppressed !== null,
        paid: total,
        shape: "lines",
        onStudio: discounted,
      });
      if (outcome.suppressed) {
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...rec,
          ...actorFields(run),
        });
      }
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        /* The last four, which is all the done screen and the record
         * ever see of the number. */
        giftCard: { lastFour: giftCardLastFour(number) },
        receiptRequested: sendEmail,
        emailReceipt: null,
        ...rec,
        ...actorFields(run),
      });
    }

    /* Card and credit both re-read the client server-side at charge time:
     * the balance or card the browser saw at attach may be minutes old,
     * and a money decision is made only on what Mindbody says NOW. A
     * failure here is a failed READ; nothing has been charged. */
    let profile;
    try {
      profile = await clientPaymentProfile(clientId as string);
    } catch (err) {
      return NextResponse.json(
        {
          error: `Could not read the client's payment profile: ${errMessage(err)} Nothing was charged.`,
          stage: "method",
        },
        { status: 502 },
      );
    }

    if (m === "credit") {
      /* A WHOLE-SALE credit payment: this one line is the entire sale,
       * so the balance has to cover the whole total, and it is checked
       * here against the live read even if the browser thought it was
       * fine. Not assumption P2, which T82 retired with rule 1 (see the
       * header): partial credit is not ignored any more, it is a credit
       * LEG of a split, refused above the live balance in the split's
       * own branch. */
      /* T94: the same authorization, on the whole-sale path. The
       * shortfall is this route's arithmetic on this route's read. */
      if (
        (profile.balance ?? 0) < total &&
        overdraftTeacher !== null &&
        clientId !== undefined
      ) {
        overdraft = {
          charged: total,
          balance: profile.balance ?? 0,
          teacher: overdraftTeacher,
        };
      } else if (profile.balance === null || profile.balance < total) {
        return NextResponse.json(
          {
            error:
              profile.balance === null
                ? "Mindbody reports no account balance for this client."
                : `Account credit is ${profile.balance.toFixed(2)}, which does not cover the ${total.toFixed(2)} total.`,
            stage: "method",
            creditBalance: profile.balance,
          },
          { status: 409 },
        );
      }
      const run = await runAsActor(session, "/api/checkout", (actor) =>
        checkoutCart(
          items,
          clientId,
          { type: "DebitAccount", amount: total },
          actor,
          sendEmail,
          discount,
        ),
      );
      const outcome = run.result;
      if (outcome.suppressed) {
        const rec = await recordDiscount({
          saleId: null,
          cartId: null,
          suppressed: true,
          paid: total,
          shape: "lines",
          onStudio: discounted,
        });
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...rec,
          ...(await recordOverdraft(null, true)),
          ...actorFields(run),
        });
      }
      const ids = await saleIds(outcome.saleId);
      const rec = await recordDiscount({
        ...ids,
        suppressed: false,
        paid: total,
        shape: "lines",
        onStudio: discounted,
      });
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        receiptRequested: sendEmail,
        emailReceipt: null,
        ...rec,
        ...(await recordOverdraft(ids.saleId, false)),
        ...actorFields(run),
      });
    }

    /* m === "storedcard" */
    const card = profile.card;
    if (!card) {
      return NextResponse.json(
        { error: "No card on file for this client.", stage: "method" },
        { status: 409 },
      );
    }
    if (card.expired) {
      return NextResponse.json(
        {
          error: `The card on file (ending ${card.lastFour}) is expired.`,
          stage: "method",
        },
        { status: 409 },
      );
    }

    /* T82: rule 1 is gone. It refused this card because account credit
     * could have covered the total, which made credit compulsory for
     * anyone holding any; Pete: "Credit should be an option, not
     * forced." A card sale for a client with credit is now an ordinary
     * card sale. Nothing else about the card path changes: the card is
     * still re-read here, still refused when expired or absent, and a
     * credit LINE is still refused above the live balance in its own
     * branch. */

    /* ASSUMPTION P4: the $10 floor is measured against the charged,
     * after-tax total -- the minimum is a card-processing floor, so the
     * amount that matters is the amount the card would be charged. */
    if (total >= CARD_MINIMUM_USD) {
      /* Card path one: the total itself satisfies the floor. ONE call,
       * StoredCard, never routed through account credit. */
      const run = await runAsActor(session, "/api/checkout", (actor) =>
        checkoutCart(
          items,
          clientId,
          { type: "StoredCard", amount: total, lastFour: card.lastFour },
          actor,
          sendEmail,
          discount,
        ),
      );
      const outcome = run.result;
      if (outcome.suppressed) {
        const rec = await recordDiscount({
          saleId: null,
          cartId: null,
          suppressed: true,
          paid: total,
          shape: "lines",
          onStudio: discounted,
        });
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...rec,
          ...actorFields(run),
        });
      }
      const ids = await saleIds(outcome.saleId);
      const rec = await recordDiscount({
        ...ids,
        suppressed: false,
        paid: total,
        shape: "lines",
        onStudio: discounted,
      });
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        receiptRequested: sendEmail,
        emailReceipt: null,
        ...rec,
        ...actorFields(run),
      });
    }

    /* T82: the ONE piece of rule 1 that survives it, and it is not rule
     * 1: this path BUYS $10 of account credit on the card, so credit
     * that already covers the total must be spent instead of buying
     * more. Rule 1 refused every card sale a balance could have covered
     * and so made credit compulsory (retired above); this refuses only
     * the sale whose card charge would add a second $10 of credit beside
     * the first. It is also what keeps the seam below un-re-runnable:
     * after a credit purchase that went through and a checkout that did
     * not, the balance covers any sub-$10 total, and a second tap must
     * not buy a second $10. A card sale at $10 or more never reaches
     * here and is never refused for holding credit. */
    if (profile.balance !== null && profile.balance >= total) {
      return NextResponse.json(
        {
          error:
            `This ${total.toFixed(2)} sale is under the ` +
            `$${CARD_MINIMUM_USD} card minimum, so paying it by card would ` +
            `buy another $${CARD_MINIMUM_USD} of account credit. There is ` +
            `already ${profile.balance.toFixed(2)} on the account: spend ` +
            "that instead. Nothing was charged.",
          stage: "method",
          creditBalance: profile.balance,
        },
        { status: 409 },
      );
    }

    /* Card path two, total under $10: the rehearsal already passed above,
     * so buy $10 of account credit on the card, then check out on
     * DebitAccount. Two calls with a real seam between them; each failure
     * mode below reports EXACTLY what state the client is in. */
    let credit;
    let creditRun;
    try {
      creditRun = await runAsActor(session, "/api/checkout", (actor) =>
        purchaseCredit(
          clientId as string,
          CARD_MINIMUM_USD,
          card.lastFour,
          actor,
          sendEmail,
        ),
      );
      credit = creditRun.result;
    } catch (err) {
      /* T50 review: a dead teacher token is refused at the gate, so
       * nothing was charged; the sign-in gate says so. */
      const gone = staffSessionEndedResponse(err);
      if (gone) return gone;
      const ambiguous = isAmbiguous(err);
      return NextResponse.json(
        {
          error: ambiguous
            ? `The $${CARD_MINIMUM_USD} credit purchase did not answer. It ` +
              "MAY have charged the card. Check the dev drawer or Mindbody " +
              "before trying again."
            : `The $${CARD_MINIMUM_USD} credit purchase was refused: ` +
              errMessage(err) +
              " Nothing was charged.",
          stage: "credit-purchase",
          ambiguous,
        },
        { status: 502 },
      );
    }
    if (credit.suppressed) {
      const rec = await recordDiscount({
        saleId: null,
        cartId: null,
        suppressed: true,
        paid: total,
        shape: "lines",
        onStudio: discounted,
      });
      return NextResponse.json({
        ok: false,
        suppressed: credit.suppressed,
        ...rec,
        ...actorFields(creditRun),
      });
    }

    try {
      const run = await runAsActor(session, "/api/checkout", (actor) =>
        checkoutCart(
          items,
          clientId,
          { type: "DebitAccount", amount: total },
          actor,
          sendEmail,
          discount,
        ),
      );
      const outcome = run.result;
      if (outcome.suppressed) {
        /* The credit purchase went out and the checkout did not: the same
         * seam as a step-2 failure, reported the same way. Should be
         * unreachable (the guard decided identically two calls ago), but
         * if it happens the teacher must know the credit exists. */
        throw new Error(
          "the checkout was suppressed by the write guard after the credit purchase went through",
        );
      }
      const ids = await saleIds(outcome.saleId);
      const rec = await recordDiscount({
        ...ids,
        suppressed: false,
        paid: total,
        shape: "lines",
        onStudio: discounted,
      });
      /* Either write may have fallen back; one note covers both. */
      const fallback = creditRun.actorFallback ?? run.actorFallback;
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        creditPurchased: CARD_MINIMUM_USD,
        receiptRequested: sendEmail,
        /* T53: the one confirmation Mindbody gives: the credit sale's
         * EmailReceipt. The cart checkout after it reports nothing. */
        emailReceipt: sendEmail ? credit.emailReceipt : null,
        ...rec,
        ...actorFields({
          actorFallback: fallback,
          staffSessionEnded: creditRun.staffSessionEnded || run.staffSessionEnded,
        }),
      });
    } catch (err) {
      /* THE seam. The card was charged $10 of credit; the sale did not
       * complete. Nothing is lost -- the credit persists -- but the UI
       * must say exactly that, with the live balance, or a teacher
       * re-runs the whole flow and buys a second $10. */
      let creditBalance: number | null = null;
      try {
        creditBalance = (await clientPaymentProfile(clientId as string))
          .balance;
      } catch {
        /* best effort; null renders as "balance unknown" */
      }
      return NextResponse.json(
        {
          error: errMessage(err),
          stage: "checkout-after-credit",
          ambiguous: isAmbiguous(err),
          creditPurchased: CARD_MINIMUM_USD,
          creditBalance,
        },
        { status: 502 },
      );
    }
  } catch (err) {
    /* T50 review: a dead teacher token (a comp's included) is refused
     * at Mindbody's gate before anything ran, so nothing was charged:
     * 401 reason "staff", and the sign-in gate says why. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    const ambiguous = isAmbiguous(err);
    return NextResponse.json(
      {
        error: ambiguous
          ? "The charge did not answer. It MAY have gone through. Check " +
            "the dev drawer or Mindbody before charging again."
          : errMessage(err),
        stage: "checkout",
        ambiguous,
      },
      { status: 502 },
    );
  }
}
