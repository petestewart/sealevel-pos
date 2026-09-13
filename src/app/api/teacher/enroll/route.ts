import { NextResponse } from "next/server";

import {
  claimEnrollAttempt,
  recordEnrollSuccess,
  requireSession,
} from "@/lib/auth";
import { revokeStaffToken, signInAsStaff } from "@/lib/mindbody";
import { listStaff } from "@/lib/staff";
import { isPinShape, PIN_MAX, PIN_MIN, setTeacherPin } from "@/lib/teacherpins";

export const dynamic = "force-dynamic";

/**
 * Set up or change a comp PIN by signing in to Mindbody (T48, Pete's
 * question: "is it possible to use a mindbody sign in for identification
 * of the teacher?" Yes). Takes {username, password, pin}: the username
 * and password go to `/usertoken/issue` (user-token.yml) exactly once,
 * through signInAsStaff, which never caches the token, never logs the
 * body and never records the call; the id Mindbody answers with is
 * checked against the active teachers, the PIN is stored hashed, the
 * token is revoked, and the password is gone. It touches no log, no row
 * and no answer.
 *
 * Behind the device session, rate-limited on its own counter: every
 * attempt is a sign-in against a teacher's real Mindbody password, so a
 * guessing loop here gets five tries and thirty seconds like the doors.
 * A wrong login and an unknown login are the same 401 with the same
 * words, so the route cannot be used to list who has an account.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

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

  let username: unknown;
  let password: unknown;
  let pin: unknown;
  try {
    ({ username, password, pin } = await request.json());
  } catch {
    return NextResponse.json(
      { error: "username, password and pin are required" },
      { status: 400 },
    );
  }
  if (
    typeof username !== "string" ||
    username.trim().length < 3 ||
    username.length > 200 ||
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 200
  ) {
    return NextResponse.json(
      { error: "username and password are required" },
      { status: 400 },
    );
  }
  if (!isPinShape(pin)) {
    return NextResponse.json(
      { error: `pin must be ${PIN_MIN} to ${PIN_MAX} digits` },
      { status: 400 },
    );
  }

  let signIn;
  try {
    signIn = await signInAsStaff(username.trim(), password);
  } catch {
    return NextResponse.json(
      { error: "Could not reach Mindbody to check that sign-in." },
      { status: 502 },
    );
  }
  if (!signIn.ok) {
    /* One message for every refusal: a wrong password and a username
     * Mindbody has never heard of read the same. Counted by the claim. */
    return NextResponse.json(
      { error: "Mindbody did not accept that sign-in.", reason: "teacher" },
      { status: 401 },
    );
  }
  /* Whatever follows, the token is not kept: revoke it now, in the
   * background, and let the enrollment run on the id it gave us. */
  void revokeStaffToken(signIn.token);

  const user = signIn.user;
  if (!Number.isInteger(user.id) || user.id <= 0) {
    /* The spec: "always 0 for Admin and Owner type users". An owner
     * login is real but names no staff row a comp could be for. */
    return NextResponse.json(
      {
        error:
          "That sign-in is an owner or admin account, not a teacher's. " +
          "Use the teacher's own Mindbody login.",
      },
      { status: 403 },
    );
  }
  let teachers;
  try {
    teachers = await listStaff();
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not read the staff list from Mindbody: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
  const staff = teachers.find((t) => t.id === user.id);
  if (!staff) {
    return NextResponse.json(
      { error: "That Mindbody login is not an active staff member here." },
      { status: 403 },
    );
  }
  /* The name as the staff list has it, not as the token has it: the same
   * spelling the comp picker shows. */
  const teacher = { id: staff.id, name: staff.name };
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
  console.log(`[teacher-pins] set for staff ${teacher.id} via mindbody-signin`);
  return NextResponse.json({ ok: true, teacher });
}
