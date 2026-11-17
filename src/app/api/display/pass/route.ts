import { NextResponse } from "next/server";

import { choosePass, ensureDisplayLoaded, isPairedDisplay } from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";

export const dynamic = "force-dynamic";

/**
 * T242: the student tapped "Use this pass" on "Your passes".
 *
 * The display cookie alone. The body is read for exactly two fields,
 * `requestId` and `key`, and the key must be one the SERVER stored on
 * this scene's offer: it names a pass the teacher's iPad offered, by an
 * opaque handle, and nothing else. NOTHING HERE CALLS MINDBODY. The pick
 * is kept in memory and the teacher's iPad is told which pass it was;
 * that iPad assigns it and checks the student in, under the teacher's
 * token, through `/api/visit-payment` and `/api/checkin`.
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
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  if (requestId.length === 0) {
    return NextResponse.json({ error: "requestId required" }, { status: 400 });
  }
  const done = await choosePass(id, requestId, input.key);
  if (!done.ok) {
    return NextResponse.json({ error: done.error }, { status: done.status });
  }
  return NextResponse.json({ ok: true });
}
