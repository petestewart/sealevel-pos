import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { isDryRun } from "@/lib/mindbody";

import {
  CARD_MINIMUM_USD,
  checkoutCart,
  clientPaymentProfile,
  parseCartLines,
  purchaseCredit,
  rehearseCheckout,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * POST /api/checkout -- the one route that moves money. Fires only from
 * an explicit Charge tap; nothing in this app auto-charges.
 *
 * Body: { items: CartLine[], clientId?: string,
 *         method: "storedcard"|"credit"|"cash"|"comp",
 *         cashTendered?: number }
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
 */

/** Was this thrown by the transport (outcome unknown) rather than by
 *  Mindbody answering (outcome known)? mindbody() surfaces an HTTP error
 *  as a plain Error carrying Mindbody's message; a timeout or connection
 *  failure comes out of fetch as a DOMException (TimeoutError/AbortError)
 *  or a TypeError. For a money write the distinction is everything: a
 *  refusal is safe to retry, an unanswered POST is not. */
function isAmbiguous(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Method = "storedcard" | "credit" | "cash" | "comp";

export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
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

  const method: unknown = payload?.method;
  if (
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

  const suppressionKind = () => (isDryRun() ? "dry-run" : "write-guard");

  /* Step 1, every path: the Test: true rehearsal, which is also where
   * the AUTHORITATIVE total comes from. The browser's number is never
   * trusted; the amount charged below is the one Mindbody just priced.
   * For the under-$10 card path this is exactly PLAN 2.3's mitigation:
   * a cart Mindbody will not accept fails HERE, before any credit is
   * bought, and the failure costs nothing. */
  let priced;
  try {
    priced = await rehearseCheckout(items, clientId);
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

  if (
    typeof cashTendered === "number" &&
    method === "cash" &&
    cashTendered > 0 &&
    cashTendered < total
  ) {
    return NextResponse.json(
      { error: "Tendered cash is less than the total." },
      { status: 400 },
    );
  }

  const m = method as Method;
  try {
    if (m === "comp" || m === "cash") {
      const outcome = await checkoutCart(
        items,
        clientId,
        m === "cash"
          ? { type: "Cash", amount: total }
          : { type: "Comp", amount: total },
      );
      if (outcome.suppressed) {
        return NextResponse.json({ ok: false, suppressed: outcome.suppressed });
      }
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: outcome.saleId,
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
      const outcome = await checkoutCart(items, clientId, {
        type: "DebitAccount",
        amount: total,
      });
      if (outcome.suppressed) {
        return NextResponse.json({ ok: false, suppressed: outcome.suppressed });
      }
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: outcome.saleId,
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

    /* ASSUMPTION P4: the $10 floor is measured against the charged,
     * after-tax total -- the minimum is a card-processing floor, so the
     * amount that matters is the amount the card would be charged. */
    if (total >= CARD_MINIMUM_USD) {
      /* Card path one: the total itself satisfies the floor. ONE call,
       * StoredCard, never routed through account credit. */
      const outcome = await checkoutCart(items, clientId, {
        type: "StoredCard",
        amount: total,
        lastFour: card.lastFour,
      });
      if (outcome.suppressed) {
        return NextResponse.json({ ok: false, suppressed: outcome.suppressed });
      }
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: outcome.saleId,
      });
    }

    /* Card path two, total under $10: the rehearsal already passed above,
     * so buy $10 of account credit on the card, then check out on
     * DebitAccount. Two calls with a real seam between them; each failure
     * mode below reports EXACTLY what state the client is in. */
    let credit;
    try {
      credit = await purchaseCredit(
        clientId as string,
        CARD_MINIMUM_USD,
        card.lastFour,
      );
    } catch (err) {
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
      return NextResponse.json({ ok: false, suppressed: credit.suppressed });
    }

    try {
      const outcome = await checkoutCart(items, clientId, {
        type: "DebitAccount",
        amount: total,
      });
      if (outcome.suppressed) {
        /* The credit purchase went out and the checkout did not: the same
         * seam as a step-2 failure, reported the same way. Should be
         * unreachable (the guard decided identically two calls ago), but
         * if it happens the teacher must know the credit exists. */
        throw new Error(
          "the checkout was suppressed by the write guard after the credit purchase went through",
        );
      }
      return NextResponse.json({
        ok: true,
        method: m,
        total,
        saleId: outcome.saleId,
        creditPurchased: CARD_MINIMUM_USD,
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
