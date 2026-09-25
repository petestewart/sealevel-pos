import { NextResponse } from "next/server";

import {
  claimSigninAttempt,
  recordSigninSuccess,
  requireSession,
} from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import {
  adoptServiceToken,
  revokeStaffToken,
  signInAsStaff,
  target,
  type Target,
} from "@/lib/mindbody";
import { ensureTarget, isTargetAdmin, setSignInNotice } from "@/lib/target";
import { switchBlocker, switchTarget } from "@/lib/targetswitch";
import { findStaffRow, listStaff } from "@/lib/staff";
import { hasTeacherPin } from "@/lib/teacherpins";
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
 *
 * T80: the answer carries `hasPin`, so the browser can prompt a teacher
 * with no comp PIN to choose one before they reach the roster (Pete:
 * "when a teacher first signs in, if they have not set up a PIN they
 * should be prompted to do so"). Null means PINs are unavailable here
 * (no database), which prompts for nothing. It says whether a PIN
 * exists and nothing about its value.
 *
 * T212: an optional `target` names the studio to sign in to. When it is
 * the OTHER studio, this is also the counter's target switch: the login
 * is checked against that studio, must belong to a named admin
 * (`POS_ADMIN_STAFF_IDS`), and only then does the counter move, through
 * the same `switchTarget` the drawer uses. Behind the devtools gate, both
 * credential sets and a database, exactly like the drawer's switch.
 */
function studioWord(t: Target): string {
  return t === "prod" ? "Production" : "Sandbox";
}

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
  let wanted: unknown;
  try {
    ({ username, password, target: wanted } = await request.json());
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

  /* T212: the gate's studio choice. Absent, or naming the studio the
   * counter is already on, is an ordinary sign-in. Naming the OTHER one
   * is a switch, and every guard the drawer's switch has applies before
   * a password is sent anywhere: the devtools gate, both credential
   * sets, and a database to keep the setting in. */
  if (wanted !== undefined && wanted !== "sandbox" && wanted !== "prod") {
    return NextResponse.json(
      { error: 'target must be "sandbox" or "prod"' },
      { status: 400 },
    );
  }
  await ensureTarget();
  const switchTo: Target | null =
    wanted === "sandbox" || wanted === "prod"
      ? wanted === target()
        ? null
        : wanted
      : null;
  if (switchTo !== null) {
    if (!devtoolsEnabled()) {
      return NextResponse.json(
        { error: "Switching the studio is not available on this counter." },
        { status: 404 },
      );
    }
    const blocked = await switchBlocker(switchTo);
    if (blocked) {
      return NextResponse.json({ error: blocked.error }, { status: blocked.status });
    }
  }

  let signIn;
  try {
    /* T212: a switch signs in to the studio being switched TO, which is
     * the proof: a staff login belongs to one site, and the one a
     * counter cannot sign in to is exactly the one it may need to leave. */
    signIn = await signInAsStaff(
      username.trim(),
      password,
      switchTo ?? undefined,
    );
  } catch {
    return NextResponse.json(
      { error: "Could not reach Mindbody to check that sign-in." },
      { status: 502 },
    );
  }
  if (!signIn.ok) {
    console.warn(
      `[staff] sign-in refused by Mindbody: usertoken/issue answered HTTP ${signIn.status} for ${username.trim()}`,
    );
    return NextResponse.json(
      { error: "Mindbody did not accept that sign-in.", reason: "teacher" },
      { status: 401 },
    );
  }

  if (switchTo !== null) {
    /* T212: only a named admin moves the counter, the drawer's rule,
     * checked against the id the DESTINATION studio just vouched for.
     * The refusal names that id and the variable, because a staff id is
     * per site and the list needs one for each studio an admin signs in
     * to; it names nothing else. The token is revoked where it was
     * issued, and the counter has not moved. */
    const id = signIn.user.id;
    if (!Number.isInteger(id) || id <= 0 || !isTargetAdmin(id)) {
      void revokeStaffToken(signIn.token, switchTo);
      console.warn(
        `[target] switch to ${switchTo} at sign-in refused: staff ${String(id)} on site ${signIn.siteId} is not in POS_ADMIN_STAFF_IDS`,
      );
      return NextResponse.json(
        {
          error:
            `Only an admin can switch the studio. Your ${studioWord(switchTo)} ` +
            `staff id is ${String(id)}, which is not in POS_ADMIN_STAFF_IDS. ` +
            "Nothing was switched.",
        },
        { status: 403 },
      );
    }
    const moved = await switchTarget(switchTo, id, "sign-in");
    if (!moved.ok) {
      void revokeStaffToken(signIn.token, switchTo);
      return NextResponse.json({ error: moved.error }, { status: moved.status });
    }
    /* The counter is on the destination now, and this sign-in carries on
     * exactly as an ordinary one would there: the staff list, the
     * session and the cookie all read the new target. */
  }

  /* The studio's own API login signing in as a teacher (the sandbox's
   * only login; Pete testing on the counter): one token serves both, so
   * the staff read below does not ask for a second issue the sandbox
   * refuses. */
  /* T210: the site the token was issued for, from the sign-in itself.
   * It rides with the session from here on, so the borrow, the restore
   * after a restart and the drawer all know which studio this token
   * belongs to rather than assuming it is whatever the target says
   * later. */
  const siteId = signIn.siteId;
  const isService = adoptServiceToken(username, signIn.token, siteId);
  if (isService) {
    console.log(
      `[staff] sign-in is the service account itself; reusing its token for reads on site ${siteId}`,
    );
  }

  const user = signIn.user;
  if (!Number.isInteger(user.id) || user.id <= 0) {
    console.warn(
      `[staff] sign-in refused: Mindbody issued a token for user id ${String(user.id)} type "${user.type}", which is not a staff member's id`,
    );
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
  let staff = teachers.find((t) => t.id === user.id) ?? null;
  if (!staff) {
    /* Not on the filtered list: either inactive, or a real account whose
     * NAME tripped the placeholder test (the sandbox's API user). The
     * password decided who this is; only Active decides whether they
     * may act. */
    let row: Awaited<ReturnType<typeof findStaffRow>> = null;
    try {
      row = await findStaffRow(user.id);
    } catch {
      row = null;
    }
    if (row && !row.active) {
      console.warn(
        `[staff] sign-in refused: user id ${user.id} "${row.name}" is marked inactive by Mindbody`,
      );
    } else if (row) {
      console.log(
        `[staff] sign-in: user id ${user.id} "${row.name}" is active but its name reads as a placeholder; accepted on the password`,
      );
      staff = { id: row.id, name: row.name };
    } else {
      /* Not on any page: Mindbody's staff list omits the account entirely
       * (the sandbox's API user, 2026-09-20). The sign-in answer itself
       * named it, type "Staff", and Mindbody issues no token to a
       * disabled login, so the password is the evidence and the list's
       * silence is not a refusal. */
      const name = `${user.firstName} ${user.lastName}`.trim() || `Staff ${user.id}`;
      console.warn(
        `[staff] sign-in: user id ${user.id} "${name}" type "${user.type}" is not on /staff/staff at all; accepted on the password`,
      );
      staff = { id: user.id, name };
    }
  }
  if (!staff) {
    console.warn(
      `[staff] sign-in refused: user id ${user.id} type "${user.type}" is not in the ${teachers.length} active staff rows /staff/staff returned`,
    );
    void revokeStaffToken(signIn.token);
    return NextResponse.json(
      { error: "That Mindbody login is not an active staff member here." },
      { status: 403 },
    );
  }

  /* A session already here is replaced: its token is revoked so nothing
   * keeps acting as the previous teacher from a cookie that is about to
   * be overwritten. */
  const previous = await staffSessionFrom(request);
  if (previous) await endStaffSession(previous.id);

  const teacher = { id: staff.id, name: staff.name };
  const cookie = await createStaffSession(
    teacher,
    signIn.token,
    Date.now(),
    isService,
    siteId,
  );
  if (switchTo !== null) {
    /* T212: creating this session cleared the line the switch set, and
     * that line is for every OTHER iPad, whose teacher was just signed
     * out by a switch they did not make. Put it back. */
    setSignInNotice(
      `The studio target changed to ${switchTo}. Sign in again.`,
    );
  }
  recordSigninSuccess();
  console.log(`[staff] signed in staff=${teacher.id} site=${siteId}`);
  return NextResponse.json(
    { ok: true, teacher, hasPin: await hasTeacherPin(teacher.id) },
    { headers: { "set-cookie": staffSetCookie(cookie) } },
  );
}
