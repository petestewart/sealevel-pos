import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { dropDisplayCard } from "@/lib/displaycard";

export const dynamic = "force-dynamic";

/**
 * T241: the teacher's tender let go of a card the student typed on the
 * customer iPad (the line's X, a cart edit, a client change, a new
 * ticket), so the server lets go of it too, rather than holding it to
 * its 30 minutes. Device session and a signed-in teacher; it can only
 * ever DROP a card, never read one. No Mindbody call.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const requestId =
    typeof (body as { requestId?: unknown })?.requestId === "string"
      ? String((body as { requestId: string }).requestId)
      : "";
  if (requestId.length > 0) dropDisplayCard(requestId, "released by the teacher");
  return NextResponse.json({ ok: true });
}
