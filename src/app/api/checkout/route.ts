import { NextResponse } from "next/server";

import {
  actorFields,
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
import { fileFormulaNote } from "@/lib/formulanote";
import { isDryRun, mindbodyHttpStatus, target } from "@/lib/mindbody";

import {
  CARD_MINIMUM_USD,
  checkoutCart,
  clientPaymentProfile,
  houseClientId,
  latestSaleId,
  parseCartLines,
  purchaseCredit,
  rehearseCheckout,
  roundToCents,
  type CheckoutPayment,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * POST /api/checkout -- the one route that moves money. Fires only from
 * an explicit Charge tap; nothing in this app auto-charges.
 *
 * Body: { items: CartLine[], clientId?: string,
 *         method: "storedcard"|"credit"|"cash"|"comp",
 *         cashTendered?: number,
 *         sendEmail?: boolean,
 *         discount?: { mode: "amount"|"percent", value: number },
 *         teacherToken?: string,
 *         compReason?: { kind, detail } }
 *         -- T53: `sendEmail` is the pay-mode "Email receipt" toggle.
 *         It is honoured only on a NAMED client's sale with something
 *         paid: an anonymous sale rides the house client, whose inbox
 *         is nobody's, and a 100% discount is nothing to receipt. Sent
 *         to Mindbody as the checkout's `SendEmail` and the credit
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
 *         discount lines and NO Payments; if Mindbody refuses that with
 *         an error naming payment, ONE retry goes out in the proven
 *         T43 shape (no DiscountAmount, one Comp payment for the full
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
 *   or, since T28, `split` instead of `method`:
 *       { items, clientId, split: { legs: [{method, amount}, {method,
 *         amount}] } } -- exactly two legs, methods from the whitelist
 *         minus comp, amounts in whole cents that sum EXACTLY to the
 *         rehearsed server total, charged as two Payments entries in ONE
 *         checkoutshoppingcart call (no two-write seam; a refusal
 *         refuses the whole sale). The card minimum applies to the card
 *         LEG; rule 1 (credit-covers-total refuses the card) does not
 *         apply to a deliberate split (the recorded P2 reversal).
 *
 * Executes PLAN 2.3's table EXACTLY, and never collapses the card paths
 * (the design doc: routing every card sale through purchaseaccountcredit
 * would record a $150 membership as a credit purchase plus redemption and
 * wreck the reporting Pete reads):
 *
 * - credit covers it   -> one checkout on DebitAccount
 * - card, total >= $10 -> one checkout on StoredCard
 * - card, total < $10  -> Test: true rehearsal, purchaseaccountcredit for
 *                         $10 on the card, checkout on DebitAccount
 *
 * Recorded ASSUMPTIONS (T24; Pete may reverse): P2, partial credit is
 * ignored -- credit is only offered when it covers the whole total; P4,
 * the $10 minimum is measured against the charged, after-tax total.
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

type Method = "storedcard" | "credit" | "cash" | "comp";

/* T28: the methods a split leg may use. Comp is deliberately excluded --
 * a comp is the whole sale given away, armed by its own dialog in the
 * UI, and half-comping through a split would dodge that dialog; since
 * T79 a partial discount is the cart's, not a leg's. */
type SplitMethod = "storedcard" | "credit" | "cash";

interface SplitLeg {
  method: SplitMethod;
  amount: number;
}

/** T79: which shape a 100% discount went out in. */
type DiscountShape = "lines" | "comp-payment";

/** Parse one untrusted split leg; a string return is the 400 reason. */
function parseSplitLeg(raw: unknown): SplitLeg | string {
  const method = (raw as { method?: unknown })?.method;
  if (method !== "storedcard" && method !== "credit" && method !== "cash") {
    return "each split leg's method must be storedcard, credit or cash";
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
  return { method, amount: cents / 100 };
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

  const parsed = parseCartLines(payload?.items);
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
    method !== "credit" &&
    method !== "cash" &&
    method !== "comp"
  ) {
    return NextResponse.json(
      { error: "method must be storedcard, credit, cash or comp" },
      { status: 400 },
    );
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
        ? verifyCompToken(teacherTokenRaw)
        : null;
    if (teacher === null) {
      return NextResponse.json(
        { error: "Enter your PIN to discount this sale.", reason: "teacher" },
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
   * and what the sale is. Never for the house client (no clientId), never
   * for a 100% discount (nothing to receipt); a non-boolean is false,
   * never an error, because a receipt must not stand between a teacher
   * and a charge. */
  const sendEmail =
    payload?.sendEmail === true &&
    clientId !== undefined &&
    /* T53 review: the house client attached BY NAME (it is a real
     * client, so search can find it) is still nobody's inbox. */
    clientId !== houseClientId() &&
    !full;
  /* Every valid split includes a client-bound leg: comp is excluded and
   * the two legs differ, so at least one is storedcard or credit. The
   * house client never rides a split. */
  if (split !== null && !clientId) {
    return NextResponse.json(
      { error: "a split sale needs a client attached" },
      { status: 400 },
    );
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

  const suppressionKind = () => (isDryRun() ? "dry-run" : "write-guard");

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
    return NextResponse.json({ ok: false, suppressed: suppressionKind() });
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
     * nothing has been charged. */
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

    const creditLeg =
      legA.method === "credit" ? legA : legB.method === "credit" ? legB : null;
    if (creditLeg !== null) {
      if (profile.balance === null || profile.balance < creditLeg.amount) {
        return NextResponse.json(
          {
            error:
              profile.balance === null
                ? "Mindbody reports no account balance for this client."
                : `Account credit is ${profile.balance.toFixed(2)}, which ` +
                  `does not cover the ${creditLeg.amount.toFixed(2)} credit leg.`,
            stage: "method",
            creditBalance: profile.balance,
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
      /* Rule 1 of the $10 minimum ("credit covers the total -> credit IS
       * the method, the card is refused") deliberately does NOT apply to
       * a split. T28 records the reversal: rule 1 and assumption P2
       * guarded against AMBIGUITY -- a teacher who never chose between
       * credit and card -- and a deliberate two-leg split is the
       * opposite of that ambiguity. Applying it here would also make
       * credit+card splits impossible for exactly the clients who hold
       * credit. */
    }

    const toPayment = (leg: SplitLeg): CheckoutPayment =>
      leg.method === "storedcard"
        ? {
            type: "StoredCard",
            amount: leg.amount,
            lastFour: (profile.card as { lastFour: string }).lastFour,
          }
        : leg.method === "credit"
          ? { type: "DebitAccount", amount: leg.amount }
          : { type: "Cash", amount: leg.amount };

    try {
      /* ONE checkoutshoppingcart call carrying both Payments entries in
       * the teacher's order: no partial seam exists, so a refusal
       * refuses the WHOLE sale and nothing partial can stand. */
      const run = await runAsActor(session, "/api/checkout", (actor) =>
        checkoutCart(
          items,
          clientId,
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
        method: "split",
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        legs: [
          { method: legA.method, amount: legA.amount },
          { method: legB.method, amount: legB.amount },
        ],
        receiptRequested: sendEmail,
        emailReceipt: null,
        ...rec,
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
            checkoutCart(items, saleClientId, [], actor, false, discount),
          { fallback: false },
        );
      } catch (first) {
        const message = errMessage(first);
        if (isAmbiguous(first) || !/payment/i.test(message)) {
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
          return NextResponse.json({ ok: false, suppressed: suppressionKind() });
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
                false,
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
        receiptRequested: false,
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
      /* ASSUMPTION P2: partial credit is ignored. Credit pays only when
       * it covers the whole total; otherwise the method is refused here
       * even if the browser thought it was fine. */
      if (profile.balance === null || profile.balance < total) {
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

    /* Rule 1 of the $10 minimum (design doc: "not a default the teacher
     * can talk themselves out of"): when account credit covers the total,
     * credit IS the method and the card is not offered. Enforced here,
     * not just greyed in the UI, because this is also what makes the
     * under-$10 split failure un-re-runnable: after the $10 credit
     * purchase, the balance covers any sub-$10 total, so a second card
     * attempt -- and its second credit purchase -- is refused with the
     * balance that must be spent instead. */
    if (profile.balance !== null && profile.balance >= total) {
      return NextResponse.json(
        {
          error:
            `Account credit is ${profile.balance.toFixed(2)} and covers the ` +
            `${total.toFixed(2)} total. Credit is the method for this sale; ` +
            "the card is not offered when credit covers it. Nothing was charged.",
          stage: "method",
          creditBalance: profile.balance,
        },
        { status: 409 },
      );
    }

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
