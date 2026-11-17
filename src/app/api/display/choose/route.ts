import { NextResponse } from "next/server";

import { chooseTender, ensureDisplayLoaded, isPairedDisplay } from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";

export const dynamic = "force-dynamic";

/**
 * T241: the student picked another way to pay on the customer iPad.
 *
 * The display cookie alone, the request id must be THIS display's
 * current live or approve ticket, and the choice must be one the SERVER
 * stored on that ticket's offer, which the teacher's iPad sent with the
 * ticket. The body is read for exactly two fields, `requestId` and
 * `choice`, and the choice is a key from a fixed list: nothing sent here
 * can name an amount, a card or anything else.
 *
 * NOTHING HERE CALLS MINDBODY, and nothing is charged. The pick is kept
 * in memory and the teacher's iPad is told; that iPad moves its own
 * tender, and the charge is still the teacher's own Finalize (and, with
 * "customer approves each sale" on, the student's Approve on the ticket
 * that follows).
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
  const done = await chooseTender(id, requestId, input.choice);
  if (!done.ok) {
    return NextResponse.json({ error: done.error }, { status: done.status });
  }
  return NextResponse.json({ ok: true });
}
