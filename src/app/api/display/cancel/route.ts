import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { cancelRequest } from "@/lib/display";

export const dynamic = "force-dynamic";

/** The teacher takes the scene back down (T113). Same auth as present,
 *  and the same rule: no Mindbody call anywhere in it. Cancelling
 *  something that is not there still answers 200 and still pushes the
 *  display to idle, because the server's picture is the one that wins. */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  const { cancelled } = await cancelRequest();
  return NextResponse.json({ ok: true, cancelled });
}
