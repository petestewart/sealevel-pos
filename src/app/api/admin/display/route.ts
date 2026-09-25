import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { displayState } from "@/lib/display";

export const dynamic = "force-dynamic";

/**
 * Where the customer display stands, for the drawer's block and for the
 * POS header's fallback poll (T200).
 *
 * The device session and a signed-in teacher, and deliberately NOT the
 * admin list and NOT the devtools gate that /api/admin/target carries: a
 * teacher setting up the counter is the point (design doc), and nothing
 * here decides where a write lands. The one thing it can do is say
 * whether a second screen is paired and awake.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  const state = await displayState();
  return NextResponse.json({
    paired: state.paired,
    name: state.name,
    pairedAt: state.pairedAt,
    lastSeenAt: state.lastSeenAt,
    connected: state.connected,
    busy: state.busy,
    storage: state.storage,
    /* Whether a pairing survives a restart at all: with no database (or
     * no POS_SESSION_SECRET) it does not, and the display says the same
     * thing on its own screen rather than letting a teacher find out. */
    durable: state.durable,
  });
}
