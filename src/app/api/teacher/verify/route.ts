import { NextResponse } from "next/server";

import {
  claimVerifyAttempt,
  isCompPurpose,
  issueCompToken,
  recordVerifySuccess,
  requireSession,
} from "@/lib/auth";
import { requireActor } from "@/lib/actor";
import { isPinShape, PIN_MAX, PIN_MIN, verifyTeacherPin } from "@/lib/teacherpins";

export const dynamic = "force-dynamic";

/**
 * The comp gate's question (T48): takes {pin}, 4 to 6 digits, and answers
 * whose it is, plus a one-shot comp token for /api/checkout to check. The
 * dialog asks this on EVERY comp, regardless of POS_PIN (Pete: "comp just
 * let me right through without entering a PIN ... that's exactly what we
 * don't want"). Behind the device session, rate-limited on its own
 * counter like /api/login: five misses, thirty seconds.
 *
 * A miss is 401 with `reason: "teacher"`, which the page's fetch wrapper
 * reads as the dialog's own business rather than the device lock. No PIN
 * store at all (no database and no dev POS_TEACHER_PINS) is 503 and says
 * so: "wrong PIN" would send a teacher hunting through digits that could
 * never match. Nothing here answers with a PIN, a hash or a phone.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* The PIN confirms the SIGNED-IN teacher (PINs are not unique since
   * migration 11), so a discount with nobody signed in is refused here
   * as every write is: 401 reason staff, and the gate comes back. */
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;

  /* Claim before the first await, as /api/login does. */
  const lockedFor = claimVerifyAttempt();
  if (lockedFor > 0) {
    return NextResponse.json(
      {
        error: "too many attempts",
        retryAfterSeconds: Math.ceil(lockedFor / 1000),
      },
      { status: 429 },
    );
  }

  let pin: unknown;
  let purposeRaw: unknown;
  try {
    ({ pin, purpose: purposeRaw } = await request.json());
  } catch {
    return NextResponse.json({ error: "pin is required" }, { status: 400 });
  }
  /* T94 review: what this PIN authorizes, signed into the token. A
   * discount is the default because it is what every caller before T94
   * asked for; an overdraft says so, and /api/checkout will not take
   * one for the other. T112 adds "override", which authorizes either
   * asking Mindbody for a refused pass again under this teacher's own
   * token or selling the configured substitute in its place. */
  if (purposeRaw !== undefined && !isCompPurpose(purposeRaw)) {
    return NextResponse.json(
      { error: "purpose must be comp, overdraft or override" },
      { status: 400 },
    );
  }
  const purpose = purposeRaw === undefined ? "comp" : purposeRaw;
  if (!isPinShape(pin)) {
    return NextResponse.json(
      { error: `pin must be ${PIN_MIN} to ${PIN_MAX} digits` },
      { status: 400 },
    );
  }

  const check = await verifyTeacherPin(pin, {
    id: actor.session.staffId,
    name: actor.session.name,
  });
  if (!check.ok) {
    if (check.reason === "nopin") {
      return NextResponse.json(
        {
          error: "You have no PIN yet. Set one up first.",
          reason: "teacher",
          noPin: true,
        },
        { status: 401 },
      );
    }
    if (check.reason === "unavailable") {
      return NextResponse.json(
        {
          error:
            "No teacher PINs are set up on this server: it needs a " +
            "database, or POS_TEACHER_PINS for local work.",
        },
        { status: 503 },
      );
    }
    /* Counted by the claim above. */
    return NextResponse.json(
      { error: "That is not your PIN.", reason: "teacher" },
      { status: 401 },
    );
  }

  recordVerifySuccess();
  return NextResponse.json({
    ok: true,
    teacher: check.teacher,
    token: issueCompToken(check.teacher, purpose),
  });
}
