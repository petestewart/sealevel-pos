import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import { setSignedIn } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * The only write this app performs in Phase 1. It moves no money, it is
 * idempotent (setting SignedIn to a value it already holds is harmless),
 * and it reverses, which is what makes the undo in the UI real rather
 * than a race against a delayed send.
 *
 * T49: runs as the signed-in teacher when there is one, so Mindbody's
 * sign-in record names them; a refusal of the teacher's token falls
 * back once to the service account and says so (`actorFallback`).
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
    const { visitId, signedIn, clientId } = await request.json();
    if (typeof visitId !== "number") {
      return NextResponse.json(
        { error: "visitId (number) is required" },
        { status: 400 },
      );
    }
    const run = await runAsActor(session, "/api/checkin", (actor) =>
      setSignedIn(
        visitId,
        signedIn !== false,
        typeof clientId === "string" ? clientId : undefined,
        actor,
      ),
    );
    const { suppressed } = run.result;
    /* `suppressed` says the write never reached Mindbody (dry run or the
     * write guard). Still ok:true -- the guards working is not an error
     * -- but the caller must not chain anything that assumes a session
     * was really consumed (T26's renewal offer). */
    return NextResponse.json({ ok: true, suppressed, ...actorFields(run) });
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
