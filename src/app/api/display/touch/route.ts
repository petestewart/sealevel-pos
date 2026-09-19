import { NextResponse } from "next/server";

import { ensureDisplayLoaded, isPairedDisplay, touchSignup } from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";

export const dynamic = "force-dynamic";

/**
 * "The student is still here" (T204). The sign-up screen posts this on
 * any input, throttled to once every twenty seconds, and the hub re-arms
 * the two minute abandon clock. Nothing else: no scene, no result, no
 * Mindbody call.
 *
 * A touch for a request that is not the sign-up in progress answers 200
 * with `touched: false` rather than an error. It is a heartbeat, and a
 * heartbeat arriving a moment after the screen went idle is not a fault
 * worth showing a student.
 */
export async function POST(request: Request) {
  await ensureDisplayLoaded();
  const id = displayIdFrom(request);
  if (!isPairedDisplay(id) || id === null) {
    return NextResponse.json(
      { error: "not a paired display", reason: "display" },
      { status: 401 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  return NextResponse.json({ touched: touchSignup(id, requestId) });
}
