import { NextResponse } from "next/server";

import { findReaderPayment } from "@/lib/db";
import { readerGate } from "@/lib/readergate";
import { cancelAttempt, viewOf } from "@/lib/readerpayment";

export const dynamic = "force-dynamic";

/**
 * T225: the teacher's Cancel while the Terminal waits, or before a sale
 * has claimed an approved hold. Cancels the Terminal's checkout and voids
 * every approved payment it produced (a cancel can lose the race to a
 * tap). Allowed with the switch off: releasing a hold is cleaning up.
 * An attempt already claimed for a sale (`selling` and after) is not
 * cancellable here; the checkout decides it.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await readerGate(request, { allowWhenOff: true });
  if (gate.denied) return gate.denied;
  const { id } = await ctx.params;
  const row = await findReaderPayment(id);
  if (row === "unavailable") {
    return NextResponse.json(
      { error: "The database did not answer. Try again in a moment.", reason: "database" },
      { status: 503 },
    );
  }
  if (row === null || row.staffId !== String(gate.session.staffId)) {
    return NextResponse.json({ error: "No such card reader attempt." }, { status: 404 });
  }
  const after = await cancelAttempt(id, "Cancelled. Nothing was charged.");
  console.log(`[reader] ${id} cancel asked by staff=${gate.session.staffId}: now ${after?.state ?? "unknown"}`);
  return NextResponse.json({ attempt: viewOf(after ?? row) });
}
