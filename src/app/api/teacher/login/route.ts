import { NextResponse } from "next/server";

import {
  claimTeacherAttempt,
  issueTeacherToken,
  recordTeacherSuccess,
  requireSession,
  safeEqual,
  teacherSetCookie,
} from "@/lib/auth";
import { listTeachers } from "@/lib/staff";

export const dynamic = "force-dynamic";

/**
 * Takes {pin} (four digits) and names the teacher (T44). Behind the
 * device session: this is the second door, not a way around the first.
 * Rate-limited like /api/login, on its own counter.
 *
 * One teacher whose phone ends in those digits: the teacher cookie is
 * set and `{ok: true, teacher}` answers. Several: `{ok: false, choices}`
 * lists them and the browser posts again with `{pin, staffId}`; the id
 * must be one of THAT pin's matches, so a staff id alone names nobody.
 * None: 401. A staff read that fails with nothing cached: 502 with the
 * reason, so the prompt can say what is wrong rather than "wrong PIN".
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;

  /* Claim before the first await, as /api/login does. */
  const lockedFor = claimTeacherAttempt();
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
  let staffId: unknown;
  try {
    ({ pin, staffId } = await request.json());
  } catch {
    return NextResponse.json({ error: "pin is required" }, { status: 400 });
  }
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return NextResponse.json(
      { error: "pin must be four digits" },
      { status: 400 },
    );
  }
  if (staffId !== undefined && !Number.isInteger(staffId)) {
    return NextResponse.json(
      { error: "staffId must be an integer when given" },
      { status: 400 },
    );
  }

  let teachers;
  try {
    teachers = await listTeachers();
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not read the staff list from Mindbody: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  /* Every teacher is compared, constant-time each, no early exit: the
   * time this takes must not say how far down the list the match sat. */
  const matches = teachers.filter(
    (t) => t.pinDigits !== null && safeEqual(t.pinDigits, pin as string),
  );
  if (matches.length === 0) {
    /* Counted by the claim above. */
    return NextResponse.json(
      { error: "No teacher has a phone ending in those digits." },
      { status: 401 },
    );
  }

  let chosen = matches.length === 1 ? matches[0] : undefined;
  if (matches.length > 1) {
    if (staffId === undefined) {
      /* The digits were right, so this is not a failed guess. */
      recordTeacherSuccess();
      return NextResponse.json({
        ok: false,
        choices: matches.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    chosen = matches.find((t) => t.id === staffId);
    if (!chosen) {
      return NextResponse.json(
        { error: "That name does not go with those digits." },
        { status: 401 },
      );
    }
  }
  if (!chosen) {
    return NextResponse.json({ error: "no match" }, { status: 401 });
  }

  recordTeacherSuccess();
  const teacher = { id: chosen.id, name: chosen.name };
  const response = NextResponse.json({ ok: true, teacher });
  response.headers.set(
    "Set-Cookie",
    teacherSetCookie(issueTeacherToken(teacher), request),
  );
  return response;
}
