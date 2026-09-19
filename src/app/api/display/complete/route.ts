import { NextResponse } from "next/server";

import {
  RESULT_LIMIT_BYTES,
  completeRequest,
  ensureDisplayLoaded,
  isPairedDisplay,
  readJsonObject,
} from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";

export const dynamic = "force-dynamic";

/**
 * The student finished (T113). The display cookie alone, and the request
 * id must be THIS display's current one, so a stale id (a scene the
 * teacher cancelled, a result already sent) is refused with 409 rather
 * than overwriting something.
 *
 * The display never sends a client id, a staff id or a price, and this
 * route would ignore them if it did: the server looks up what the
 * request was. The result is stored and nothing else happens; the write
 * belongs to the teacher's iPad, under the teacher's token, through the
 * routes that already exist.
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
  const result = readJsonObject(input.result ?? {}, RESULT_LIMIT_BYTES);
  if (!result.ok) {
    return NextResponse.json(
      { error: `result: ${result.error}` },
      { status: 400 },
    );
  }
  /* Whatever the display thought it knew about who this is stays on the
   * display. Only the scene's own answer is kept. */
  const { clientId, staffId, price, ...kept } = result.value;
  void clientId;
  void staffId;
  void price;
  const done = await completeRequest(id, requestId, kept);
  if (!done.ok) {
    return NextResponse.json({ error: done.error }, { status: done.status });
  }
  return NextResponse.json({ ok: true });
}
