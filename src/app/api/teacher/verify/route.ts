import { NextResponse } from "next/server";

import {
  claimVerifyAttempt,
  issueCompToken,
  recordVerifySuccess,
  requireSession,
} from "@/lib/auth";
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
  try {
    ({ pin } = await request.json());
  } catch {
    return NextResponse.json({ error: "pin is required" }, { status: 400 });
  }
  if (!isPinShape(pin)) {
    return NextResponse.json(
      { error: `pin must be ${PIN_MIN} to ${PIN_MAX} digits` },
      { status: 400 },
    );
  }

  const check = await verifyTeacherPin(pin);
  if (!check.ok) {
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
    if (check.reason === "staff") {
      return NextResponse.json(
        { error: "Could not read the staff list from Mindbody." },
        { status: 502 },
      );
    }
    /* Counted by the claim above. */
    return NextResponse.json(
      { error: "That PIN does not match any teacher.", reason: "teacher" },
      { status: 401 },
    );
  }

  recordVerifySuccess();
  return NextResponse.json({
    ok: true,
    teacher: check.teacher,
    token: issueCompToken(check.teacher),
  });
}
