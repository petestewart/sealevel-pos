import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { giftCardBalance, parseGiftCardNumber } from "@/lib/giftcard";

export const dynamic = "force-dynamic";

/**
 * GET /api/gift-card?number=... -- what is left on a gift card (T83).
 *
 * The "Check balance" step of the gift-card tender: the teacher enters
 * the barcode from the card, and this reads Mindbody's answer so the
 * amount can be pre-filled and capped by it. A READ, so it goes out
 * under dry run like every other read; guarded by requireSession
 * because it answers a spendable balance.
 *
 * The number is a secret in the same way a card number is: it comes in
 * and nothing goes back out with it. The answer is `{ balance }` and
 * nothing else -- no barcode echo, not even the last four (the browser
 * typed the number and already knows it) -- and the call log strikes
 * the barcode out of the recorded path (src/lib/calllog.ts). Nothing is
 * cached: /api/checkout re-reads the balance server-side at charge time
 * and never trusts this number.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const parsed = parseGiftCardNumber(
    new URL(request.url).searchParams.get("number") ?? undefined,
  );
  if (typeof parsed === "string") {
    return NextResponse.json({ error: parsed }, { status: 400 });
  }
  try {
    return NextResponse.json({ balance: await giftCardBalance(parsed.number) });
  } catch (err) {
    /* Mindbody's own words for an unknown card, a card from another
     * site or a site without gift cards at all. Already scrubbed of
     * anything number-shaped by mindbody(); nothing is added here. */
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
