import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { unpairDisplay } from "@/lib/display";

export const dynamic = "force-dynamic";

/** Unpair the customer display (T112). Same auth as pairing. The row and
 *  the request go, the display's cookie then names nobody, and its own
 *  screen falls back to a fresh pairing code. No Mindbody call. */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  const unpaired = await unpairDisplay();
  if (unpaired) {
    console.log(`[display] unpair by staff=${actor.session.staffId}`);
  }
  return NextResponse.json({ ok: true, unpaired, paired: false });
}
