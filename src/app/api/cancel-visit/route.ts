import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import { removeClientFromClass } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * Cancel a booking: `POST /class/removeclientfromclass` with
 * `{ClientId, ClassId, SendEmail: false}` (spec-verified in
 * src/lib/roster.ts). This undoes the BOOKING, where check-out undoes a
 * sign-in; the roster row disappears rather than going grey.
 *
 * The write goes through the mindbody() client, so dry run and the
 * POS_WRITE_CLIENT_IDS guard both apply; a suppressed removal is reported
 * as such rather than pretending the booking is gone. T49: as the
 * signed-in teacher when there is one, with the one loud fallback.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad hears only the 401 and never a validation detail
   * or a Mindbody read made on its behalf. */
  const staff = requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  try {
    const { clientId, classId } = await request.json();
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    if (typeof classId !== "number") {
      return NextResponse.json(
        { error: "classId (number) is required" },
        { status: 400 },
      );
    }
    const run = await runAsActor(session, "/api/cancel-visit", (actor) =>
      removeClientFromClass(clientId, classId, actor),
    );
    return NextResponse.json({ ok: true, ...run.result, ...actorFields(run) });
  } catch (err) {
    /* T50 review: the teacher's token died under this write (the
     * session is already ended, nothing ran): 401 reason "staff", so
     * the gate comes back. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
