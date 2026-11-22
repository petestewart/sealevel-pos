import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { pairedDeviceId, testReaderOnProdRefusal } from "@/lib/cardreader";
import { cartSha256 } from "@/lib/cartsha";
import { allowedWriteClientIds } from "@/lib/mindbody";
import { parsePromotionCode } from "@/lib/promocode";
import { readerGate } from "@/lib/readergate";
import { startAttempt } from "@/lib/readerpayment";
import { houseClientId, parseCartLines, rehearseCheckout } from "@/lib/sale";
import { toCents } from "@/lib/square";

export const dynamic = "force-dynamic";

/**
 * T225: "Charge on reader", first half. Takes the ticket the checkout
 * will sell, rehearses it with Mindbody (`Test: true`, exactly as the
 * checkout does), and puts the rehearsal's GrandTotal on the Terminal as
 * a HOLD (`autocomplete: false`). Nothing is sold here and nothing is
 * taken: the second half is `/api/checkout` with `method: "reader"`
 * (T226), which re-rehearses, checks the amount to the cent against this
 * hold, sells, and only then completes the payment.
 *
 * First version, on purpose: one cart, a named client or the house
 * client, and a promotion code. A discount, an override, a split, a
 * gift card, account credit or a line for someone else is refused in
 * words (PLAN T233, T234 and the discount follow-up) so the hold can
 * never be for a different total than the sale.
 *
 * Refused before Square is asked: the switch off (readerGate), no
 * Terminal paired, a test reader on the live studio for a client the
 * write guard does not name, a dry run or write guard suppressing the
 * rehearsal ("The card reader was not used."), and a rehearsal that
 * refused or disagreed.
 */

const NOT_YET =
  "is not on the card reader yet. Use another way to pay for this sale. Nothing was charged.";

export async function POST(request: Request) {
  const gate = await readerGate(request);
  if (gate.denied) return gate.denied;
  const session = gate.session;
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const unsupported: [unknown, string][] = [
    [payload?.split, "A split payment"],
    [payload?.giftCards, "A gift card"],
    [payload?.accountCredit, "Account credit"],
    [payload?.discount, "A discount"],
    [payload?.override, "An override"],
    [payload?.typedCard ?? payload?.displayCard, "A typed card"],
  ];
  for (const [v, what] of unsupported) {
    if (v !== undefined && v !== null) {
      return NextResponse.json({ error: `${what} ${NOT_YET}`, reason: "unsupported" }, { status: 409 });
    }
  }
  if (
    Array.isArray(payload?.items) &&
    payload.items.some((l: any) => typeof l?.forClientId === "string" && l.forClientId.trim() !== "")
  ) {
    return NextResponse.json(
      { error: `A line for someone else ${NOT_YET}`, reason: "unsupported" },
      { status: 409 },
    );
  }
  const parsed = parseCartLines(payload?.items);
  if (parsed.error !== null) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const promo = parsePromotionCode(payload?.promotionCode);
  if ("error" in promo) {
    return NextResponse.json({ error: promo.error }, { status: 400 });
  }
  const named = typeof payload?.clientId === "string" ? payload.clientId.trim() : "";
  const clientId = named !== "" ? named : houseClientId();
  if (clientId === null) {
    return NextResponse.json(
      { error: "Attach a client first: this counter has no walk-in client set up.", reason: "client" },
      { status: 409 },
    );
  }

  const testRefusal = testReaderOnProdRefusal();
  if (testRefusal !== null) {
    return NextResponse.json({ error: testRefusal, reason: "test-mode" }, { status: 409 });
  }
  const guard = allowedWriteClientIds();
  if (guard.size > 0 && !guard.has(clientId)) {
    return NextResponse.json(
      {
        error:
          "The write guard is narrowing sales to its test clients, and this client is not one of them. The card reader was not used.",
        reason: "write-guard",
      },
      { status: 409 },
    );
  }
  const deviceId = await pairedDeviceId();
  if (deviceId === null) {
    return NextResponse.json(
      { error: "No card reader is connected. Connect it first. Nothing was charged.", reason: "not-paired" },
      { status: 409 },
    );
  }

  let priced;
  try {
    priced = await rehearseCheckout(parsed.items, clientId, null, null, promo.code);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Mindbody would not price this sale: ${err instanceof Error ? err.message : String(err)} The card reader was not used.`,
        reason: "rehearsal",
      },
      { status: 409 },
    );
  }
  if (priced.suppressed) {
    return NextResponse.json(
      {
        ok: false,
        suppressed: true,
        error:
          "Dry run or the write guard is on, so the sale could not be priced. The card reader was not used.",
        reason: "suppressed",
      },
      { status: 409 },
    );
  }
  if (priced.grandTotal === null || priced.disagrees) {
    return NextResponse.json(
      {
        error:
          "Mindbody's total did not match the shelf, so nothing was put on the reader. Check the prices and try again.",
        reason: "rehearsal",
      },
      { status: 409 },
    );
  }
  let amountCents: number;
  try {
    amountCents = toCents(priced.grandTotal);
  } catch {
    return NextResponse.json({ error: "Mindbody's total was not whole cents.", reason: "rehearsal" }, { status: 409 });
  }

  const key = request.headers.get("idempotency-key");
  const started = await startAttempt({
    staffId: String(session.staffId),
    clientId,
    cartSha: cartSha256(payload),
    amountCents,
    deviceId,
    tapKeySha:
      key && key.trim() !== ""
        ? createHash("sha256").update(key.trim()).digest("hex").slice(0, 32)
        : null,
    note: `Sealevel counter, ${session.name}`,
  });
  if (!started.ok) {
    return NextResponse.json({ error: started.error, reason: started.reason }, { status: started.status });
  }
  return NextResponse.json({ ok: true, attempt: started.attempt, total: priced.grandTotal });
}
