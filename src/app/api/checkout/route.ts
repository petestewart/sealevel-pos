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
  compHeadline,
  compReasonLine,
  isCompKind,
  type CompReason,
  compNeedsDetail,
} from "@/lib/comp";
import { insertCompReceipt, type CompReceiptItem } from "@/lib/db";
import { fileFormulaNote } from "@/lib/formulanote";
import { isDryRun, mindbodyHttpStatus, target } from "@/lib/mindbody";
import { listTeachers } from "@/lib/staff";

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
 *         teacherToken?: string,
 *         compReason?: { kind, detail, forStaffId?, forStaffName? } }
 *         -- T53: `sendEmail` is the pay-mode "Email receipt" toggle.
 *         It is honoured only on a NAMED client's non-comp sale: an
 *         anonymous sale rides the house client, whose inbox is nobody's,
 *         and a comp is nothing to receipt. Sent to Mindbody as the
 *         checkout's `SendEmail` and the credit purchase's
 *         `SendEmailReceipt`; the answer carries `receiptRequested` and
 *         `emailReceipt` (true only when Mindbody CONFIRMED one went,
 *         which only /sale/purchaseaccountcredit reports; a cart
 *         checkout answers nothing, so it stays null and the done screen
 *         says "requested", not "emailed").
 *         -- T48: `teacherToken` is REQUIRED with method "comp" and
 *         refused beside any other method. It is the one-shot value
 *         /api/teacher/verify signed for the teacher whose PIN matched,
 *         ten minutes old at most; without a valid one the comp is 401
 *         `reason: "teacher"` before anything else is read, in every
 *         configuration (POS_PIN set or not), and the dialog goes back
 *         to its PIN step. The teacher on the receipt, the `[comp]` line
 *         and the Formula Note is the one the token names, never a name
 *         from the browser.
 *         -- T43: required with method "comp", refused beside any other
 *         method or a split. Since T45 it is data rather than a string:
 *         `kind` from comp.ts's COMP_KINDS, `detail` trimmed and at most
 *         200 characters (at least 3 for `other`, else may be empty),
 *         `forStaffId` a positive integer required for `teacher` and
 *         refused for every other kind. `forStaffName` from the browser
 *         is IGNORED: the name is resolved here from the staff list by
 *         id, and an id the list does not carry is a 400. All of it is
 *         checked before any Mindbody call. None of it reaches the
 *         checkout payload, whose request has no notes field; it is
 *         recorded in comp_receipts when a database is configured and
 *         ALWAYS as one `[comp]` server log line, and after a REAL comp
 *         for a named client it is filed on the client as a Formula Note
 *         (see recordComp below). Each item may carry a `name` on a comp,
 *         for that record only; it is never forwarded.
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
 *   carries `actorFallback`; a comp NEVER falls back (a refused comp is
 *   refused, with the message). The rehearsal stays on the service
 *   account. The payload, the single flight, the rehearsal order, the
 *   suppression and the outcome wording are T24/T28/T43's exactly.
 * - After a REAL checkout, the numeric Sale.Id is looked up (latestSaleId,
 *   bounded at 8s) and answered as `saleId`, with the cart GUID as
 *   `cartId`; a failed or ambiguous lookup answers the GUID as `saleId`,
 *   as before. The comp receipt and the Formula Note carry the same id.
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
 * a comp is the whole sale given away, armed by its own hold gesture in
 * the UI, and half-comping through a split would dodge that gesture. */
type SplitMethod = "storedcard" | "credit" | "cash";

interface SplitLeg {
  method: SplitMethod;
  amount: number;
}

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
  const staff = requireActor(request);
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
  /* T48: who is comping. Checked FIRST, before the client, the reason
   * (whose teacher branch reads the staff list) and the rehearsal: a
   * comp with nobody's PIN behind it costs no Mindbody call at all and
   * is refused the same way with the device lock on or off. Pete's live
   * test had a real $2 comp go through with teacher=none; this is the
   * line that makes that impossible. */
  const teacherTokenRaw: unknown = payload?.teacherToken;
  if (method !== "comp" && teacherTokenRaw !== undefined) {
    return NextResponse.json(
      { error: "teacherToken applies only to method comp" },
      { status: 400 },
    );
  }
  let teacher: TeacherIdentity | null = null;
  if (method === "comp") {
    teacher =
      typeof teacherTokenRaw === "string"
        ? verifyCompToken(teacherTokenRaw)
        : null;
    if (teacher === null) {
      return NextResponse.json(
        { error: "Enter your PIN to comp this sale.", reason: "teacher" },
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
   * for a comp; a non-boolean is false, never an error, because a receipt
   * must not stand between a teacher and a charge. */
  const sendEmail =
    payload?.sendEmail === true &&
    clientId !== undefined &&
    /* T53 review: the house client attached BY NAME (it is a real
     * client, so search can find it) is still nobody's inbox. */
    clientId !== houseClientId() &&
    method !== "comp";
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
  /* T43: a comp needs its reason, and nothing else may carry one. The
   * check is before the house-client substitution and the rehearsal so
   * a reasonless comp costs no metered call. */
  const compReasonRaw: unknown = payload?.compReason;
  if (method !== "comp" && compReasonRaw !== undefined) {
    return NextResponse.json(
      { error: "compReason applies only to method comp" },
      { status: 400 },
    );
  }
  let compReason: CompReason | null = null;
  if (method === "comp") {
    /* T45: the reason is data. A kind from the closed list, the detail
     * within its bounds (required only for `other`, the one kind that
     * says nothing by itself), and for a teacher comp a staff id that the
     * staff list can name. The browser's `forStaffName` is not read at
     * all: the name on the receipt is the one Mindbody's staff row
     * carries for that id, resolved here. */
    const raw =
      compReasonRaw && typeof compReasonRaw === "object"
        ? (compReasonRaw as Record<string, unknown>)
        : null;
    if (raw === null || !isCompKind(raw["kind"])) {
      return NextResponse.json(
        {
          error:
            "a comp needs a compReason with a kind of teacher, trade, " +
            "damaged or other",
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
            `a comp of kind ${kind} needs a detail of ${COMP_DETAIL_MIN} to ` +
            `${COMP_DETAIL_MAX} characters`,
        },
        { status: 400 },
      );
    }
    const forStaffRaw = raw["forStaffId"];
    if (kind !== "teacher") {
      if (forStaffRaw !== undefined) {
        return NextResponse.json(
          { error: "compReason.forStaffId applies only to kind teacher" },
          { status: 400 },
        );
      }
      compReason = { kind, detail };
    } else {
      if (
        typeof forStaffRaw !== "number" ||
        !Number.isInteger(forStaffRaw) ||
        forStaffRaw <= 0
      ) {
        return NextResponse.json(
          {
            error:
              "a teacher comp needs compReason.forStaffId, a positive integer",
          },
          { status: 400 },
        );
      }
      /* The staff list is the cached read /api/staff serves; cold, it
       * is one metered staff read, never a money call. A read
       * that fails with nothing cached is answered as such: the comp is
       * refused rather than filed for a name nobody could check. */
      let teachers;
      try {
        teachers = await listTeachers();
      } catch (err) {
        return NextResponse.json(
          {
            error: `Could not read the staff list to name the teacher: ${errMessage(err)} Nothing was charged.`,
            stage: "method",
          },
          { status: 502 },
        );
      }
      const forStaff = teachers.find((t) => t.id === forStaffRaw);
      if (!forStaff) {
        return NextResponse.json(
          {
            error: `compReason.forStaffId ${forStaffRaw} is not an active teacher`,
          },
          { status: 400 },
        );
      }
      compReason = {
        kind,
        detail,
        forStaffId: forStaff.id,
        forStaffName: forStaff.name,
      };
    }
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

  /* T48: the comp token is SPENT here, after every check above and
   * before the rehearsal, which is the first Mindbody call: a second
   * charge on the same token, however it got here, goes back to the PIN
   * step and costs no call. */
  if (method === "comp" && !spendCompToken(teacherTokenRaw as string)) {
    return NextResponse.json(
      { error: "Enter your PIN to comp this sale.", reason: "teacher" },
      { status: 401 },
    );
  }

  const suppressionKind = () => (isDryRun() ? "dry-run" : "write-guard");

  /* Step 1, every path: the Test: true rehearsal, which is also where
   * the AUTHORITATIVE total comes from. The browser's number is never
   * trusted; the amount charged below is the one Mindbody just priced.
   * For the under-$10 card path this is exactly PLAN 2.3's mitigation:
   * a cart Mindbody will not accept fails HERE, before any credit is
   * bought, and the failure costs nothing. */
  let priced;
  try {
    priced = await rehearseCheckout(items, saleClientId);
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
        error:
          "Totals disagree between our math and Mindbody's. Nothing was " +
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
        ),
      );
      const outcome = run.result;
      if (outcome.suppressed) {
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...actorFields(run),
        });
      }
      const ids = await saleIds(outcome.saleId);
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
        ...actorFields(run),
      });
    } catch (err) {
      /* Same posture as the single-method catch below: only a definite
       * 4xx refusal reports "not charged"; a 5xx or dead transport is
       * honest ambiguity and invites no retry. */
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

  /* T43: the comp record. ALWAYS one server log line, so a comp is on
   * record even with no database (the T29 charter: DATABASE_URL unset
   * runs on fallbacks); the table row on top of it when there is one.
   * Written only once the Mindbody call has resolved, with the sale id
   * it returned, or `suppressed` for a write the guard or dry run ate.
   * Nothing here touches the payload, the single flight or the outcome
   * wording: the record is a side effect of an answer, never a step
   * before one. */
  const reasonLine = compReason === null ? "" : compReasonLine(compReason);
  /* T45: the log line's data tags, on every [comp] line. */
  const compTags =
    `reason=${JSON.stringify(reasonLine)} ` +
    `kind=${compReason?.kind ?? "none"} for=${compReason?.forStaffId ?? "none"} ` +
    teacherLogTag(teacher);

  /* T45: the Formula Note. Mindbody's checkout carries no notes field,
   * but a client has Formula Notes: dated, staff-only entries on the
   * profile (`POST /client/addclientformulanote`, client.yml), which is
   * where a record of the comp belongs for the studio's own eyes. Filed
   * only after a REAL comp (not suppressed, not refused, not ambiguous)
   * for a NAMED client: the house client is a catch-all and a note on it
   * names nobody. The write itself (through mindbody() with the client
   * id in the options, as the signed-in teacher with the ordinary
   * fallback, bounded to FORMULA_NOTE_WAIT_MS, never throwing) lives in
   * src/lib/formulanote.ts since T59c, shared with the guest route;
   * only the comp's wording and its preconditions are here. It runs
   * AFTER the outcome is decided and can never change it: the sale
   * already happened, so a failure here is one log line and a null on
   * the receipt. */
  const fileCompNote = async (
    saleId: string | null,
  ): Promise<{ id: number | null; via: "formula" | "notes" | null }> => {
    const none = { id: null, via: null };
    if (compReason === null) return none;
    const house = houseClientId();
    if (clientId === undefined || (house !== null && clientId === house)) {
      console.log(`[comp] formula-note skipped: house client`);
      return none;
    }
    const note = [
      `Comped $${total.toFixed(2)} at the counter: ${compHeadline(compReason)}.`,
      compReason.detail ? `Note: ${compReason.detail}.` : null,
      teacher ? `By ${teacher.name}.` : null,
      saleId ? `Sale ${saleId}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    /* T49: filed as the signed-in teacher too, with the ordinary
     * fallback (the note is a record, not the comp; a permission gap
     * here is one warn line, and the note still lands). T62: on a site
     * without Formula Notes (471) the same sentence lands as a signed
     * Notes entry, `via: "notes"`, and the receipt's note id is null. */
    const filed = await fileFormulaNote({
      session,
      clientId,
      note,
      route: "/api/checkout formula-note",
      logTag: "[comp]",
    });
    return { id: filed.id, via: filed.via };
  };

  const recordComp = async (outcome: {
    saleId: string | null;
    cartId: string | null;
    suppressed: boolean;
    formulaNoteId: number | null;
  }) => {
    console.log(
      `[comp] ${target()} sale=${outcome.suppressed ? "suppressed" : (outcome.saleId ?? "unknown")} ` +
        `client=${clientId ?? "house"} total=${total.toFixed(2)} ` +
        compTags +
        (outcome.formulaNoteId !== null ? ` note=${outcome.formulaNoteId}` : ""),
    );
    await insertCompReceipt({
      saleId: outcome.suppressed ? null : outcome.saleId,
      cartId: outcome.suppressed ? null : outcome.cartId,
      clientId: clientId ?? null,
      totalCents: Math.round(total * 100),
      items: compItems,
      reason: reasonLine,
      target: target(),
      suppressed: outcome.suppressed,
      teacherId: teacher === null ? null : String(teacher.id),
      teacherName: teacher?.name ?? null,
      kind: compReason?.kind ?? "",
      detail: compReason?.detail ? compReason.detail : null,
      forStaffId:
        compReason?.forStaffId === undefined
          ? null
          : String(compReason.forStaffId),
      forStaffName: compReason?.forStaffName ?? null,
      formulaNoteId: outcome.formulaNoteId,
    });
  };

  const m = method as Method;
  try {
    if (m === "comp" || m === "cash") {
      let run;
      try {
        /* T49: a comp never falls back to the service account; cash
         * takes the ordinary one loud fallback. */
        run = await runAsActor(
          session,
          "/api/checkout",
          (actor) =>
            checkoutCart(
              items,
              saleClientId,
              m === "cash"
                ? { type: "Cash", amount: total }
                : { type: "Comp", amount: total },
              actor,
              sendEmail,
            ),
          { fallback: m !== "comp" },
        );
      } catch (err) {
        /* A refused or unanswered comp records no receipt (there is no
         * sale to receipt), but the attempt and its outcome go in the
         * log; the error itself is answered by the catch below exactly
         * as it always was. */
        if (m === "comp") {
          console.log(
            `[comp] ${target()} sale=none outcome=${isAmbiguous(err) ? "ambiguous" : "refused"} ` +
              `client=${clientId ?? "house"} total=${total.toFixed(2)} ` +
              compTags +
              ` error=${JSON.stringify(errMessage(err))}`,
          );
        }
        throw err;
      }
      const outcome = run.result;
      const ids =
        outcome.suppressed !== null
          ? { saleId: null, cartId: null }
          : await saleIds(outcome.saleId);
      /* T62: where the comp's record landed, additive on the answer:
       * "formula", "notes" (the fallback on a site without Formula
       * Notes), or null (not a comp, the house client, suppressed, or
       * the record failed). Nothing else about the answer changes. */
      let noteVia: "formula" | "notes" | null = null;
      if (m === "comp") {
        /* T45: the outcome is decided (the call resolved), so the Formula
         * Note goes out now, for a real sale only, and its id rides on the
         * receipt. Neither can throw; see fileCompNote. */
        const filed =
          outcome.suppressed !== null
            ? { id: null, via: null }
            : await fileCompNote(ids.saleId);
        noteVia = filed.via;
        await recordComp({
          saleId: ids.saleId,
          cartId: ids.cartId,
          suppressed: outcome.suppressed !== null,
          formulaNoteId: filed.id,
        });
      }
      if (outcome.suppressed) {
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
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
        noteVia,
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
        ),
      );
      const outcome = run.result;
      if (outcome.suppressed) {
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...actorFields(run),
        });
      }
      const ids = await saleIds(outcome.saleId);
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        receiptRequested: sendEmail,
        emailReceipt: null,
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
        ),
      );
      const outcome = run.result;
      if (outcome.suppressed) {
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...actorFields(run),
        });
      }
      const ids = await saleIds(outcome.saleId);
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: ids.saleId,
        cartId: ids.cartId,
        receiptRequested: sendEmail,
        emailReceipt: null,
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
      return NextResponse.json({
        ok: false,
        suppressed: credit.suppressed,
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
