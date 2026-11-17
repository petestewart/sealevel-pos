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
 *
 * T253 review (6): with a database, an acknowledgement the table did not
 * take is NOT one (503, the hold stands, try again), so a restart cannot
 * bring back a hold a teacher was told was cleared. A hold whose charge is
 * still running cannot be acknowledged at all (409).
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
  switch (done.status) {
    case "ok":
      return NextResponse.json({ ok: true, clientId: done.clientId });
    case "gone":
      /* Already acknowledged (another iPad got there first), cleared by
       * its own answer, or lapsed: the client is not held by it. */
      return NextResponse.json({ ok: true, already: true });
    case "pending":
      return NextResponse.json(
        {
          ok: false,
          reason: "pending",
          error:
            "That charge has not answered yet, so there is nothing to acknowledge. Wait for it, then look again.",
        },
        { status: 409 },
      );
    case "unrecorded":
      return NextResponse.json(
        {
          ok: false,
          reason: "unrecorded",
          error:
            "The acknowledgement could not be recorded, so the hold stands. Try again in a moment.",
        },
        { status: 503 },
      );
  }
}
