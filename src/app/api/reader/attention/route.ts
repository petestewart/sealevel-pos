import { NextResponse } from "next/server";

import { readerPaymentsIn } from "@/lib/db";
import { readerGate } from "@/lib/readergate";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T228: card reader attempts that need a person: `unresolved` (the card
 * is on hold, or money was taken with no sale) and `uncollected` (sold in
 * Mindbody, the card not charged), from the last 36 hours, the longest a
 * hold can live. Admin only, for the Sales log. Ids, amounts, the card's
 * brand and last four, the client id, and the sentence; no card data.
 */
export async function GET(request: Request) {
  const gate = await readerGate(request, { allowWhenOff: true });
  if (gate.denied) return gate.denied;
  if (!isTargetAdmin(gate.session.staffId)) {
    return NextResponse.json({ error: "Not an admin" }, { status: 403 });
  }
  const rows = await readerPaymentsIn(["unresolved", "uncollected"], Date.now() - 36 * 3600_000);
  if (rows === null) {
    return NextResponse.json({ error: "The database did not answer.", rows: [] }, { status: 503 });
  }
  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id,
      state: r.state,
      amountCents: r.amountCents,
      clientId: r.clientId,
      staffId: r.staffId,
      cardBrand: r.cardBrand,
      lastFour: r.lastFour,
      paymentId: r.paymentId,
      mbSaleId: r.mbSaleId,
      failure: r.failure,
      createdAt: r.createdAt,
    })),
  });
}
