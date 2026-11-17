import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { ensureDisplayLoaded, passPickFor } from "@/lib/display";

export const dynamic = "force-dynamic";

/**
 * T242: how a "Your passes" scene is going, for the teacher's iPad that
 * put it up: whether it is still the current scene, which mode it is in,
 * and the student's pick if they made one (the ClientService id the
 * server mapped their key back to). The teacher's events stream carries
 * the same pick as `pass-pick`; this poll is what keeps it through a
 * dropped stream. Device session and a signed-in teacher; no Mindbody.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  await ensureDisplayLoaded();
  const requestId =
    new URL(request.url).searchParams.get("requestId")?.trim() ?? "";
  if (requestId.length === 0) {
    return NextResponse.json({ error: "requestId is required" }, { status: 400 });
  }
  return NextResponse.json(passPickFor(requestId));
}
