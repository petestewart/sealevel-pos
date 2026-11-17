import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { acknowledgeChargeHold } from "@/lib/chargehold";

export const dynamic = "force-dynamic";

/**
 * T253: a teacher has read that a charge may have moved money and checked
 * it. Acknowledges ONE hold by its id, behind the device session AND a
 * signed-in teacher, whose staff id goes in the log and on the row: the
 * only thing that releases a held client before the hold lapses.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const id = typeof payload?.id === "string" ? payload.id.trim() : "";
  if (id === "" || id.length > 100) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const done = await acknowledgeChargeHold(id, String(staff.session.staffId));
  if (done === null) {
    /* Already acknowledged (another iPad got there first) or lapsed: the
     * client is not held by it, which is what the caller wanted. */
    return NextResponse.json({ ok: true, already: true });
  }
  return NextResponse.json({ ok: true, clientId: done.clientId });
}
