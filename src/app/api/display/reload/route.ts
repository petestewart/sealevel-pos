import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { ensureDisplayLoaded, requestDisplayReload } from "@/lib/display";

export const dynamic = "force-dynamic";

/**
 * T246: "Reload customer screen", from the teacher's display Options
 * menu. The same auth as present and cancel (the device session and a
 * signed-in teacher), and the same rule: no Mindbody call anywhere in
 * it, and nothing a student is in is taken down. The display reloads at
 * once if it is idle, otherwise when the scene ends; the answer says
 * which the server expects, for the teacher's one line.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  await ensureDisplayLoaded();
  const done = requestDisplayReload();
  console.log(
    `[display] reload asked by staff ${actor.session.staffId}: ` +
      (done.delivered
        ? done.held === null
          ? "idle, reloading now"
          : `waiting for the ${done.held} to end`
        : "no stream open, not delivered"),
  );
  return NextResponse.json({ ok: true, delivered: done.delivered, held: done.held });
}
