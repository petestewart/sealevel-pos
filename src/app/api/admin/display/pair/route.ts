import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { claimPairAttempt, recordPairSuccess, requireSession } from "@/lib/auth";
import { pairCode } from "@/lib/display";

export const dynamic = "force-dynamic";

/**
 * A teacher types the six digits the display is showing (T113).
 *
 * Device session plus a signed-in teacher, and nothing else: not the
 * admin list, not the devtools gate. Pairing decides which screen a
 * waiver appears on, never whether a write happens or which studio it
 * lands in, and a teacher setting up the counter is exactly the case
 * this has to serve.
 *
 * The limiter is claimed BEFORE the code is read, the T44 idiom, so a
 * burst of parallel guesses cannot all pass the check before any of them
 * counted. No Mindbody call.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;

  const locked = claimPairAttempt();
  if (locked > 0) {
    return NextResponse.json(
      {
        error: "Too many tries. Wait half a minute and read the code again.",
        retryInMs: locked,
      },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const code = String(input.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json(
      { error: "The code is six digits." },
      { status: 400 },
    );
  }
  const name =
    typeof input.name === "string" && input.name.trim().length > 0
      ? input.name.trim().slice(0, 60)
      : null;

  const paired = await pairCode(code, name);
  if (!paired.ok) {
    return NextResponse.json({ error: paired.error }, { status: 404 });
  }
  recordPairSuccess();
  console.log(
    `[display] pair by staff=${actor.session.staffId} display=${paired.display.id}`,
  );
  return NextResponse.json({
    ok: true,
    paired: true,
    name: paired.display.name,
    pairedAt: new Date(paired.display.pairedAt).toISOString(),
  });
}
