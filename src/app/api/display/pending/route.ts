import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { pendingResultFor } from "@/lib/display";

export const dynamic = "force-dynamic";

/**
 * Is there a signature waiting for this client (T202)?
 *
 * The teacher's iPad normally finalises a waiver the moment the
 * `completed` event arrives on its stream. This is the other case: the
 * iPad was asleep, or the tab was reloaded, or the stream was down for
 * the fifteen seconds it takes to retry. The result waited in the hub
 * (and in `display_requests`, which is the one reason that table
 * exists), and the dialog asks for it on open and on a stream reconnect.
 *
 * The device session and a signed-in teacher, like every other
 * teacher-facing display route: this names what a student just did at
 * this counter. It answers a request ID and a moment and NOT the
 * signature: the PNG never travels to the teacher's browser, because the
 * write route pulls it from the server's own store.
 *
 * No Mindbody call anywhere in it.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  const clientId =
    new URL(request.url).searchParams.get("clientId")?.trim() ?? "";
  if (clientId.length === 0) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  const waiting = await pendingResultFor("waiver", clientId);
  if (waiting === null) return NextResponse.json({ pending: false });
  return NextResponse.json({
    pending: true,
    requestId: waiting.id,
    kind: waiting.kind,
    completedAt:
      waiting.completedAt === null
        ? null
        : new Date(waiting.completedAt).toISOString(),
  });
}
