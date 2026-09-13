import { NextResponse } from "next/server";

import {
  claimSigninAttempt,
  recordSigninSuccess,
  requireSession,
} from "@/lib/auth";
import { revokeStaffToken, signInAsStaff } from "@/lib/mindbody";
import { listStaff } from "@/lib/staff";
import {
  createStaffSession,
  endStaffSession,
  staffSessionFrom,
  staffSetCookie,
} from "@/lib/staffsession";

export const dynamic = "force-dynamic";

/**
 * POST /api/teacher/signin {username, password} -- start a staff session
 * (T49). The same sign-in T48's enrollment makes, kept this time: the
 * Mindbody token goes into the server-side session Map and the browser
 * gets the opaque `pos_staff` cookie, so every write from this browser
 * runs as this teacher until sign-out or twelve hours.
 *
 * Mirrors /api/teacher/enroll's discipline exactly: behind the device
 * session; rate-limited on its own counter (five misses, 30s), since
 * every attempt is a sign-in against a teacher's real password; one 401
 * with one wording for an unknown user and a wrong password alike, so
 * the route cannot list who has a login; the password touches no log,
 * no row and no answer; an owner/admin login (User.Id 0, the spec) and
 * a login that is not an active teacher are refused and their token
 * revoked at once. A sign-in over an existing session replaces it (the
 * old token revoked): a shift change is signing in as the next teacher,
 * not signing out first.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

  const lockedFor = claimSigninAttempt();
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
  try {
    ({ username, password } = await request.json());
  } catch {
    return NextResponse.json(
      { error: "username and password are required" },
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
    return NextResponse.json(
      { error: "Mindbody did not accept that sign-in.", reason: "teacher" },
      { status: 401 },
    );
  }

  const user = signIn.user;
  if (!Number.isInteger(user.id) || user.id <= 0) {
    void revokeStaffToken(signIn.token);
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
    void revokeStaffToken(signIn.token);
    return NextResponse.json(
      {
        error: `Could not read the staff list from Mindbody: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
  const staff = teachers.find((t) => t.id === user.id);
  if (!staff) {
    void revokeStaffToken(signIn.token);
    return NextResponse.json(
      { error: "That Mindbody login is not an active staff member here." },
      { status: 403 },
    );
  }

  /* A session already here is replaced: its token is revoked so nothing
   * keeps acting as the previous teacher from a cookie that is about to
   * be overwritten. */
  const previous = staffSessionFrom(request);
  if (previous) await endStaffSession(previous.id);

  const teacher = { id: staff.id, name: staff.name };
  const cookie = createStaffSession(teacher, signIn.token);
  recordSigninSuccess();
  console.log(`[staff] signed in staff=${teacher.id}`);
  return NextResponse.json(
    { ok: true, teacher },
    { headers: { "set-cookie": staffSetCookie(cookie) } },
  );
}
