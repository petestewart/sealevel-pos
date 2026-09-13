import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import { setVisitService } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * Change which pass pays for a visit: Mindbody's "Change how the client is
 * paying". Same endpoint family as check-in (`/client/updateclientvisit`),
 * same guard plumbing, and like check-in it moves no money -- it reassigns
 * a session from one already-purchased pricing option to another, and
 * doing it again with the old id reverses it. T49: as the signed-in
 * teacher when there is one, with the one loud fallback.
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
    const { visitId, clientServiceId, clientId } = await request.json();
    if (typeof visitId !== "number") {
      return NextResponse.json(
        { error: "visitId (number) is required" },
        { status: 400 },
      );
    }
    if (typeof clientServiceId !== "number") {
      return NextResponse.json(
        { error: "clientServiceId (number) is required" },
        { status: 400 },
      );
    }
    const run = await runAsActor(session, "/api/visit-payment", (actor) =>
      setVisitService(
        visitId,
        clientServiceId,
        typeof clientId === "string" ? clientId : undefined,
        actor,
      ),
    );
    return NextResponse.json({
      ok: true,
      suppressed: run.result.suppressed,
      ...actorFields(run),
    });
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
