import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { giftCardBalance, parseGiftCardNumber } from "@/lib/giftcard";

export const dynamic = "force-dynamic";

/**
 * POST /api/gift-card { number } -- what is left on a gift card (T83).
 *
 * The "Check balance" step of the gift-card tender: the teacher enters
 * the barcode from the card, and this reads Mindbody's answer so the
 * amount can be pre-filled and capped by it. A READ of Mindbody, so it
 * goes out under dry run like every other read; guarded by
 * requireSession because it answers a spendable balance.
 *
 * T83 review: a POST, and the number in the BODY, although the read
 * itself is a GET. A gift card number is a bearer secret, and a query
 * string is the one place a secret is copied by machines nobody asked:
 * `next dev` prints every request line ("GET /api/gift-card?number=605..
 * 200 in 40ms"), and a proxy or platform access log in front of the app
 * does the same in production. The body is in none of them.
 *
 * The number comes in and nothing goes back out with it. The answer is
 * `{ balance }` and nothing else -- no barcode echo, not even the last
 * four (the browser typed the number and already knows it). The dev call
 * log does show the barcode in the Mindbody path it recorded, since T109
 * (src/lib/calllog.ts); that buffer is memory only and behind
 * POS_DEVTOOLS. Nothing is cached: /api/checkout re-reads the
 * balance server-side at charge time and never trusts this answer.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const payload = await request.json().catch(() => null);
  const parsed = parseGiftCardNumber(
    (payload as { number?: unknown } | null)?.number,
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
