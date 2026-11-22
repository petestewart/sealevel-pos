import { NextResponse } from "next/server";

import { findReaderPayment } from "@/lib/db";
import { readerGate } from "@/lib/readergate";
import { findSaleForHold, resolveCharge, resolveRelease, viewOf } from "@/lib/readerpayment";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T228: a person settles a card reader hold the checkout could not
 * (Mindbody did not answer). Admin only (POS_ADMIN_STAFF_IDS), from the
 * Sales log. Two decisions, each guarded by Mindbody's own record, read
 * fresh here:
 *   {decision: "charge"}            only when the server FINDS the sale
 *                                   (or an admin names it: {saleId});
 *                                   then the money is taken.
 *   {decision: "release"}           only when the server finds NO sale
 *                                   (a read that fails refuses: no answer
 *                                   is not "no sale"); then the hold goes.
 * Works with the switch off: settling is cleaning up.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await readerGate(request, { allowWhenOff: true });
  if (gate.denied) return gate.denied;
  if (!isTargetAdmin(gate.session.staffId)) {
    return NextResponse.json({ error: "Not an admin" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const body: any = await request.json().catch(() => ({}));
  const row = await findReaderPayment(id);
  if (row === "unavailable") {
    return NextResponse.json({ error: "The database did not answer." }, { status: 503 });
  }
  if (row === null) return NextResponse.json({ error: "No such attempt." }, { status: 404 });
  if (row.state !== "unresolved") {
    return NextResponse.json(
      { error: `This hold is ${row.state}, so there is nothing to settle.`, attempt: viewOf(row) },
      { status: 409 },
    );
  }
  const named = typeof body?.saleId === "string" && /^\d+$/.test(body.saleId.trim()) ? body.saleId.trim() : null;
  const found = await findSaleForHold(row);
  if (body?.decision === "charge") {
    const saleId = found.saleId ?? named;
    if (saleId === null) {
      return NextResponse.json(
        {
          error: found.unknown
            ? "Mindbody could not be read, so the sale could not be confirmed. Nothing was charged. Try again, or name the sale id."
            : "Mindbody shows no matching sale, so the card was not charged. Name the sale id if you can see it in Mindbody.",
        },
        { status: 409 },
      );
    }
    const after = await resolveCharge(id, saleId);
    console.log(`[reader] ${id} charge settled by staff=${gate.session.staffId} sale=${saleId}${named && !found.saleId ? " (named)" : ""}`);
    return NextResponse.json({ attempt: after ? viewOf(after) : null, saleId });
  }
  if (body?.decision === "release") {
    if (found.unknown) {
      return NextResponse.json(
        { error: "Mindbody could not be read, so it is not known whether the sale exists. Nothing was changed. Try again." },
        { status: 409 },
      );
    }
    if (found.saleId !== null) {
      return NextResponse.json(
        { error: `Mindbody shows sale ${found.saleId} for this. Charge the card instead of releasing it.`, saleId: found.saleId },
        { status: 409 },
      );
    }
    const after = await resolveRelease(id);
    console.log(`[reader] ${id} release settled by staff=${gate.session.staffId}`);
    return NextResponse.json({ attempt: after ? viewOf(after) : null });
  }
  return NextResponse.json({ error: "decision must be charge or release" }, { status: 400 });
}
