import { NextResponse } from "next/server";

import { chooseTypedCard, ensureDisplayLoaded, isPairedDisplay } from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";
import { parseTypedCard } from "@/lib/typedcard";
import { displayTypedCardAllowed } from "@/lib/approval";

export const dynamic = "force-dynamic";

/**
 * T241: the student typed their own card on the customer iPad ("A
 * different card"; Pete: "a student shouldnt have to hand them their
 * card").
 *
 * The rule: card data travels display -> this server's MEMORY -> the
 * teacher's /api/checkout, and nowhere else. So this route:
 *
 * - validates the card with T93's own parser (src/lib/typedcard.ts), the
 *   rule the teacher's typed-card modal and /api/checkout enforce;
 * - holds it in memory on the display request (src/lib/displaycard.ts),
 *   never in `display_requests` or any other table, for one charge;
 * - logs nothing of it but a last four, and answers the display NOTHING
 *   about it (not even the last four: no digit of a card goes back to a
 *   screen a student is holding);
 * - tells the teacher's iPad the last four, and nothing more.
 *
 * It calls Mindbody nowhere. The one write is the teacher's checkout,
 * under the teacher's token, which takes the card from memory by this
 * request's id.
 */
export async function POST(request: Request) {
  await ensureDisplayLoaded();
  const id = displayIdFrom(request);
  if (!isPairedDisplay(id) || id === null) {
    return NextResponse.json(
      { error: "not a paired display", reason: "display" },
      { status: 401 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  if (requestId.length === 0) {
    return NextResponse.json({ error: "requestId required" }, { status: 400 });
  }
  /* T241: the studio's setting, read on every card. Off, nothing is
   * validated, held or passed on. */
  if (!(await displayTypedCardAllowed()).on) {
    return NextResponse.json(
      {
        error:
          "Cards cannot be entered on this screen. Please pay at the front desk.",
      },
      { status: 409 },
    );
  }
  const parsed = parseTypedCard(input.card);
  if (parsed.card === null) {
    /* The parser's sentences never quote the number back. */
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const done = await chooseTypedCard(id, requestId, parsed.card);
  if (!done.ok) {
    return NextResponse.json({ error: done.error }, { status: done.status });
  }
  return NextResponse.json({ ok: true });
}
