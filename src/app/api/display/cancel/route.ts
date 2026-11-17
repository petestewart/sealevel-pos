import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { cancelRequest } from "@/lib/display";

export const dynamic = "force-dynamic";

/** The teacher takes the scene back down (T200). Same auth as present,
 *  and the same rule: no Mindbody call anywhere in it. Cancelling
 *  something that is not there still answers 200 and still pushes the
 *  display to idle, because the server's picture is the one that wins. */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  /* T203: `takenOver` says the teacher needed the screen for something
   * else, so the display apologises for a few seconds instead of
   * blinking back to Ready in front of a student who was half way
   * through something. A body is optional; anything unreadable is a
   * plain cancel, because a cancel must never fail for want of JSON. */
  let takenOver = false;
  let presenter: string | null = null;
  let requestId: string | undefined;
  try {
    const body: unknown = await request.json();
    const b =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>)
        : {};
    takenOver = b["takenOver"] === true;
    /* T241 second review (N3): the tab this cancel comes from. A ticket
     * another tab owns is not this cancel's to take down (a no-op that
     * answers `foreign`), unless it is a live mirror being taken over. */
    presenter = typeof b["presenter"] === "string" ? b["presenter"] : null;
    requestId =
      typeof b["requestId"] === "string" ? (b["requestId"] as string) : undefined;
  } catch {
    /* No body: a plain cancel, from no tab in particular. */
  }
  const { cancelled, foreign } = await cancelRequest(Date.now(), {
    takenOver,
    teacher: {
      presenter,
      ...(requestId !== undefined ? { requestId } : {}),
    },
  });
  return NextResponse.json({
    ok: true,
    cancelled,
    ...(foreign === true ? { foreign: true } : {}),
  });
}
