import { NextResponse } from "next/server";

import { cachedRequiredClientFields } from "@/lib/clients";
import { ensureDisplayLoaded, isPairedDisplay, startSignup } from "@/lib/display";
import { displayIdFrom } from "@/lib/displayauth";
import { readSignupPayload } from "@/lib/displaysignup";
import { getWaiver } from "@/lib/waiver";

export const dynamic = "force-dynamic";

/**
 * The student starts something themselves (T204, Phase 2.5 item 5).
 *
 * The one route the DISPLAY may put a scene up with, and it takes no
 * scene: it takes a kind, and the server builds what the screen shows.
 * The display cookie alone guards it, like complete and refuse, because
 * the iPad a student holds has no session of any other sort; it is
 * accepted only from the paired display and only when nothing else is
 * in progress, so the "one thing holds the screen at a time" rule is
 * the server's and not a browser's.
 *
 * NO WRITE ANYWHERE IN IT. The two reads it makes are the studio's
 * waiver text and Mindbody's required-field list, both on the service
 * account, both cached, neither about anybody.
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
  const kind = (body ?? {}) as Record<string, unknown>;
  if (kind.kind !== "signup") {
    return NextResponse.json(
      { error: "kind must be signup" },
      { status: 400 },
    );
  }
  let waiver: { text: string; sha256: string };
  try {
    waiver = await getWaiver();
  } catch (err) {
    /* No waiver text, no sign-up: the waiver is PART of signing up here,
     * and a student must never be asked to agree to a blank screen. */
    return NextResponse.json(
      {
        error: `The waiver could not be fetched (${err instanceof Error ? err.message : String(err)}). Please ask the front desk.`,
      },
      { status: 502 },
    );
  }
  const built = readSignupPayload({
    requiredFields: await cachedRequiredClientFields(),
    waiverText: waiver.text,
  });
  if (!built.ok) {
    return NextResponse.json(
      { error: `payload: ${built.error}` },
      { status: 502 },
    );
  }
  const started = await startSignup({
    displayId: id,
    payload: built.value as unknown as Record<string, unknown>,
    /* The server-only half, exactly as T202's waiver: the wording the
     * student is about to read, so the create that finalises it can
     * refuse a signature for wording the studio has since changed. It
     * never passes through sceneFor, so it cannot reach the screen. */
    private: { textSha256: waiver.sha256 },
  });
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, reason: started.reason },
      { status: started.status },
    );
  }
  return NextResponse.json({
    ok: true,
    requestId: started.request.id,
    kind: started.request.kind,
  });
}
