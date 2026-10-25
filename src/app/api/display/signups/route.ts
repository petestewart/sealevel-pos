import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { pendingSignups } from "@/lib/display";

export const dynamic = "force-dynamic";

/**
 * The tray (T204): who signed themselves up and has not been created
 * yet. Names and a moment, nothing else -- the email, the phone and the
 * signature stay on the server until a teacher opens ONE of them, which
 * is the other route.
 *
 * The device session and a signed-in teacher, like every teacher-facing
 * display route: this names people standing at this counter.
 *
 * No Mindbody call anywhere in it.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  const signups = await pendingSignups();
  return NextResponse.json({ count: signups.length, signups });
}
