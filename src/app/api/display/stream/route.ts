import { NextResponse } from "next/server";

import {
  currentRequest,
  ensureDisplayLoaded,
  eventsSince,
  isPairedDisplay,
  markDisplayGone,
  markDisplayStreamOpen,
  sceneFor,
  subscribeDisplay,
  touchDisplaySeen,
} from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";
import { lastEventId, sseResponse } from "@/lib/sse";

export const dynamic = "force-dynamic";

/**
 * What the customer display holds open (T200). The display cookie and
 * nothing else guards it: the device session is deliberately not on that
 * iPad.
 *
 * On connect it replays anything missed by `Last-Event-ID` and then the
 * scene as it stands, so a reload, a Safari tab resume or a dropped
 * connection all land on the right screen rather than on whatever the
 * display last remembered. Every heartbeat stamps `last_seen_at`, which
 * is what the POS header's connection mark reads.
 *
 * T206: the teardown is the OTHER half of that mark. A heartbeat can
 * only say the screen is still there; a Safari tab closing on the
 * counter aborts this request, and `markDisplayGone` turns that into a
 * `disconnected` on the teacher's stream straight away (Pete, first
 * drive: "closed safari on ipad, display mark looks the same until i
 * refresh"). Opens are counted, so a reload's overlapping second stream
 * does not make the mark flap.
 */
export async function GET(request: Request) {
  await ensureDisplayLoaded();
  const id = displayIdFrom(request);
  if (!isPairedDisplay(id) || id === null) {
    return NextResponse.json(
      { error: "not a paired display", reason: "display" },
      { status: 401 },
    );
  }
  touchDisplaySeen(id);
  const since = lastEventId(request);
  return sseResponse(request, {
    heartbeatMs: 15_000,
    beat: () => touchDisplaySeen(id),
    start: (writer) => {
      markDisplayStreamOpen(id);
      for (const ev of eventsSince("display", since)) {
        writer.send(ev.id, ev.event, ev.data);
      }
      const scene = sceneFor(currentRequest());
      /* Id 0: the replay of the current state is not a new event and
       * must not move a reconnecting display's Last-Event-ID past
       * anything it has yet to see. */
      writer.send(0, scene.event, scene.data);
      const unsubscribe = subscribeDisplay((ev) =>
        writer.send(ev.id, ev.event, ev.data),
      );
      /* The teardown sse.ts runs on abort: the subscriber goes, and the
       * count of open streams goes with it. */
      return () => {
        unsubscribe();
        markDisplayGone(id);
      };
    },
  });
}
