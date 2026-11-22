import { NextResponse } from "next/server";

import { findReaderPayment } from "@/lib/db";
import { readerGate } from "@/lib/readergate";
import { refreshAttempt, viewOf } from "@/lib/readerpayment";

export const dynamic = "force-dynamic";

/**
 * T225: the one second poll while the Terminal waits for a card. Reads
 * Square and moves the row (authorized, declined, cancelled on the
 * reader, timed out). Answers the attempt as it now stands. Works with
 * the switch off too, so an iPad watching a hold when an admin switched
 * the reader off still learns how it ended. An attempt is only read by
 * the teacher who started it.
 */
export async function GET(
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
  const now = (await refreshAttempt(id)) ?? row;
  return NextResponse.json({ attempt: viewOf(now) });
}
