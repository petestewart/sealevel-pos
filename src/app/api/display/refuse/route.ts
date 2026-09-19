import { NextResponse } from "next/server";

import {
  ensureDisplayLoaded,
  isPairedDisplay,
  refuseRequest,
} from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";

export const dynamic = "force-dynamic";

/** The student said "Not now" (T112). Display cookie, this display's
 *  current request id, a short reason, and no Mindbody call. */
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
  const reason =
    typeof input.reason === "string" && input.reason.trim().length > 0
      ? input.reason.trim().slice(0, 200)
      : "Not now";
  const done = await refuseRequest(id, requestId, reason);
  if (!done.ok) {
    return NextResponse.json({ error: done.error }, { status: done.status });
  }
  return NextResponse.json({ ok: true });
}
