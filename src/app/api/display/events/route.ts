import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import {
  displayConnected,
  displayState,
  ensureDisplayLoaded,
  eventsSince,
  pairedDisplay,
  subscribeTeacher,
} from "@/lib/display";
import { staffSessionFrom } from "@/lib/staffsession";
import { lastEventId, sseResponse } from "@/lib/sse";

export const dynamic = "force-dynamic";

/**
 * What the TEACHER's iPad holds open (T113): `completed`, `refused`,
 * `connected` and `disconnected`. The device session and a signed-in
 * teacher both, because these events name what a student just did at
 * this counter, and nobody else's browser has any business holding the
 * stream open.
 *
 * SSE rather than polling because the waiver case needs "the student
 * signed" on the teacher's screen with no tap, and a 350ms poll for an
 * hour is more calls than a queue makes.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const session = await staffSessionFrom(request);
  if (session === null) {
    return NextResponse.json(
      { error: "Sign in to Mindbody first.", reason: "staff" },
      { status: 401 },
    );
  }
  await ensureDisplayLoaded();
  const since = lastEventId(request);
  const state = await displayState();
  return sseResponse(request, {
    heartbeatMs: 15_000,
    start: (writer) => {
      for (const ev of eventsSince("teacher", since)) {
        writer.send(ev.id, ev.event, ev.data);
      }
      /* Id 0, as on the display's stream: the connection state on
       * connect is a replay, not a new event. */
      writer.send(0, state.connected ? "connected" : "disconnected", {
        paired: pairedDisplay() !== null,
        connected: displayConnected(),
        name: state.name,
      });
      return subscribeTeacher((ev) => writer.send(ev.id, ev.event, ev.data));
    },
  });
}
