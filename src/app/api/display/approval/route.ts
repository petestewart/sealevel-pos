import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { displayConnected, loadRequest, pairedDisplay } from "@/lib/display";
import { isApproveTicket } from "@/lib/displayticket";

export const dynamic = "force-dynamic";

/**
 * How an approval is going (T203, Phase 2.5 item 4).
 *
 * The teacher's iPad asks this while it waits: the customer tapped
 * Approve or Cancel, the teacher's own tab was reloaded, or the screen
 * went dark under it. The teacher's events stream carries the same two
 * events; this is what makes the wait survive a reconnect, a sleep and a
 * reload, which the waiver's own `/api/display/pending` does for the same
 * reason.
 *
 * It answers a STATUS and nothing else: no cart, no hash, no client id.
 * The hash it would name is the server's own record of what was
 * approved, and /api/checkout is the only thing that ever compares it.
 *
 * Device session and a signed-in teacher, like every other teacher-facing
 * display route. No Mindbody call anywhere in it.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;

  const requestId =
    new URL(request.url).searchParams.get("requestId")?.trim() ?? "";
  if (requestId.length === 0) {
    return NextResponse.json({ error: "requestId is required" }, { status: 400 });
  }
  const held = await loadRequest(requestId);
  const connected = pairedDisplay() !== null && displayConnected();
  if (held === null || !isApproveTicket(held.kind, held.payload)) {
    return NextResponse.json({ status: "unknown", connected });
  }
  return NextResponse.json({
    status: held.status,
    approved: held.status === "completed" && held.result?.approved === true,
    reason: held.reason,
    consumed: held.consumedAt !== null,
    connected,
  });
}
