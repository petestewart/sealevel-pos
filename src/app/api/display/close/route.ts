import { NextResponse } from "next/server";

import {
  closeOnDisplay,
  ensureDisplayLoaded,
  isPairedDisplay,
} from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";

export const dynamic = "force-dynamic";

/** T244: the student's own Close on a live ticket or a post-sale
 *  summary. Display cookie, this display's current request id, and no
 *  Mindbody call. An approval, a waiver, a sign-up and a contract are
 *  refused here: each has its own answer on its own scene. */
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
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  if (requestId.length === 0) {
    return NextResponse.json({ error: "requestId required" }, { status: 400 });
  }
  const done = await closeOnDisplay(id, requestId);
  if (!done.ok) {
    return NextResponse.json({ error: done.error }, { status: done.status });
  }
  return NextResponse.json({ ok: true });
}
