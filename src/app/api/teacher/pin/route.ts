import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import {
  claimEnrollAttempt,
  recordEnrollSuccess,
  requireSession,
} from "@/lib/auth";
import { isPinShape, PIN_MAX, PIN_MIN, setTeacherPin } from "@/lib/teacherpins";

export const dynamic = "force-dynamic";

/**
 * POST /api/teacher/pin {pin, confirm} -- set or change the signed-in
 * teacher's comp PIN (T80, Pete: "when a teacher first signs in, if they
 * have not set up a PIN they should be prompted to do so").
 *
 * The difference from /api/teacher/enroll is what proves the identity.
 * Enrollment from the comp dialog has no session to lean on, so it signs
 * in to Mindbody there and then. Here the teacher signed in moments ago
 * and their Mindbody token is in the staff session, which is the same
 * proof: `requireActor` refuses with the usual 401 `reason: "staff"`
 * when nobody is signed in, and the PIN is stored for THAT session's
 * staff id and name, never an id the browser sent. So the prompt does
 * not ask for the password a second time.
 *
 * The PIN arrives twice (Pete: "there should be an additional box to
 * re-enter and verify the new PIN") and a mismatch is refused here as
 * well as in the form, since the form's check is a convenience and the
 * server's is the rule. Shape first, then the match: two boxes agreeing
 * on three digits get the shape line, not "they do not match".
 *
 * Rate-limited on the enrollment counter, which it shares with
 * /api/teacher/enroll: both end in a PIN being written, and neither
 * should be a loop for probing which PINs are free. Uniqueness is the
 * table's (src/lib/db.ts), refused in enroll's own words.
 *
 * Nothing about the PIN comes back: `{ ok: true }` and the teacher the
 * session names, no PIN in the answer and none in any log line.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;

  const lockedFor = claimEnrollAttempt();
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
  let confirm: unknown;
  try {
    ({ pin, confirm } = await request.json());
  } catch {
    return NextResponse.json(
      { error: `pin must be ${PIN_MIN} to ${PIN_MAX} digits` },
      { status: 400 },
    );
  }
  if (!isPinShape(pin)) {
    return NextResponse.json(
      { error: `pin must be ${PIN_MIN} to ${PIN_MAX} digits` },
      { status: 400 },
    );
  }
  if (typeof confirm !== "string" || confirm !== pin) {
    return NextResponse.json(
      { error: "The PINs do not match." },
      { status: 400 },
    );
  }

  const teacher = { id: actor.session.staffId, name: actor.session.name };
  const stored = await setTeacherPin(teacher, pin, "mindbody-signin");
  if (!stored.ok) {
    if (stored.reason === "taken") {
      return NextResponse.json(
        { error: "That PIN is taken, choose another." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        error:
          "No database to keep a PIN in. Set DATABASE_URL, or for local " +
          "work POS_TEACHER_PINS.",
      },
      { status: 503 },
    );
  }
  recordEnrollSuccess();
  console.log(`[teacher-pins] set for staff ${teacher.id} via staff session`);
  return NextResponse.json({ ok: true, teacher });
}
