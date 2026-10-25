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
  try {
    const body: unknown = await request.json();
    takenOver =
      body !== null &&
      typeof body === "object" &&
      (body as Record<string, unknown>)["takenOver"] === true;
  } catch {
    /* No body: a plain cancel. */
  }
  const { cancelled } = await cancelRequest(Date.now(), { takenOver });
  return NextResponse.json({ ok: true, cancelled });
}
