import { NextResponse } from "next/server";

import {
  currentRequest,
  ensureDisplayLoaded,
  eventsSince,
  isPairedDisplay,
  sceneFor,
  subscribeDisplay,
  touchDisplaySeen,
} from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";
import { lastEventId, sseResponse } from "@/lib/sse";

export const dynamic = "force-dynamic";

/**
 * What the customer display holds open (T113). The display cookie and
 * nothing else guards it: the device session is deliberately not on that
 * iPad.
 *
 * On connect it replays anything missed by `Last-Event-ID` and then the
 * scene as it stands, so a reload, a Safari tab resume or a dropped
 * connection all land on the right screen rather than on whatever the
 * display last remembered. Every heartbeat stamps `last_seen_at`, which
 * is what the POS header's connection mark reads.
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
      for (const ev of eventsSince("display", since)) {
        writer.send(ev.id, ev.event, ev.data);
      }
      const scene = sceneFor(currentRequest());
      /* Id 0: the replay of the current state is not a new event and
       * must not move a reconnecting display's Last-Event-ID past
       * anything it has yet to see. */
      writer.send(0, scene.event, scene.data);
      return subscribeDisplay((ev) => writer.send(ev.id, ev.event, ev.data));
    },
  });
}
