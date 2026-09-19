import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import {
  RESULT_LIMIT_BYTES,
  completeRequest,
  currentRequest,
  ensureDisplayLoaded,
  isPairedDisplay,
  readJsonObject,
} from "@/lib/display";
import { readContractResult } from "@/lib/displaycontract";
import { readSignupResult } from "@/lib/displaysignup";
import { readWaiverResult } from "@/lib/displaywaiver";
import { displayIdFrom } from "@/lib/displayauth";

export const dynamic = "force-dynamic";

/**
 * The student finished (T200). The display cookie alone, and the request
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
  /* T202: a waiver's result is CHECKED here, not when the write route
   * comes to file it. A signature that is not a PNG, one too big for a
   * signature, or a moment that is not from the last hour is refused
   * with a plain sentence while the student is still standing there,
   * rather than stored and found to be useless by the release it was
   * meant to accompany. The kind comes from the server's own record of
   * the request, never from the body. */
  let stored: Record<string, unknown> = kept;
  const held = currentRequest();
  /* T204: a self-serve sign-up is checked here too, and for the same
   * reason: the form, the two consent answers and the signature are
   * refused in plain words while the student is still holding the iPad,
   * rather than stored and found wanting by the create that was meant
   * to use them. The kind comes from the server's own record. */
  if (
    held !== null &&
    held.id === requestId &&
    held.kind === "register" &&
    /* Only a request still waiting for an answer is worth reading one
     * from: a second tap on a request already completed is "that is
     * already done" (409), not a validation complaint about a body the
     * server was never going to keep. */
    held.status === "pending"
  ) {
    const filled = readSignupResult(kept);
    if (!filled.ok) {
      return NextResponse.json(
        { error: `result: ${filled.error}` },
        { status: filled.status },
      );
    }
    stored = {
      form: filled.value.form,
      consent: filled.value.consent,
      signaturePng: filled.value.signaturePng,
      agreedAt: filled.value.agreedAt,
      signatureSha256: createHash("sha256").update(filled.png).digest("hex"),
    };
    const done = await completeRequest(id, requestId, stored);
    if (!done.ok) {
      return NextResponse.json({ error: done.error }, { status: done.status });
    }
    return NextResponse.json({ ok: true });
  }
  /* T205: a CONTRACT's signature is checked here by the same validator
   * the waiver's goes through, and for the same reason: a signature that
   * is not a PNG, one too big, or a moment that is not from the last
   * hour is refused in plain words while the student is still standing
   * there, rather than stored and found useless by the purchase that was
   * meant to carry it to Mindbody. */
  if (
    held !== null &&
    held.id === requestId &&
    held.kind === "contract" &&
    held.status === "pending"
  ) {
    const signed = readContractResult(kept);
    if (!signed.ok) {
      return NextResponse.json(
        { error: `result: ${signed.error}` },
        { status: signed.status },
      );
    }
    stored = {
      signaturePng: signed.value.signaturePng,
      agreedAt: signed.value.agreedAt,
      signatureSha256: createHash("sha256").update(signed.png).digest("hex"),
    };
    const done = await completeRequest(id, requestId, stored);
    if (!done.ok) {
      return NextResponse.json({ error: done.error }, { status: done.status });
    }
    return NextResponse.json({ ok: true });
  }
  if (held !== null && held.id === requestId && held.kind === "waiver") {
    const signed = readWaiverResult(kept);
    if (!signed.ok) {
      return NextResponse.json(
        { error: `result: ${signed.error}` },
        { status: signed.status },
      );
    }
    stored = {
      signaturePng: signed.value.signaturePng,
      agreedAt: signed.value.agreedAt,
      /* Recorded here for the log and the drawer; the write route hashes
       * the bytes again itself rather than trusting a stored figure. */
      signatureSha256: createHash("sha256").update(signed.png).digest("hex"),
    };
  }
  const done = await completeRequest(id, requestId, stored);
  if (!done.ok) {
    return NextResponse.json({ error: done.error }, { status: done.status });
  }
  return NextResponse.json({ ok: true });
}
