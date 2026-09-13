import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { dbConfigured, listTeacherPins } from "@/lib/db";
import { listTeachers } from "@/lib/staff";
import { isPinShape, PIN_MAX, PIN_MIN, setTeacherPin } from "@/lib/teacherpins";

export const dynamic = "force-dynamic";

/**
 * Teacher PIN admin (T48): the one-line path for a staff member who has
 * no Mindbody login of their own to enroll with. Same double guard as
 * the banner and bundles routes (device session, then devtools), so it
 * is reachable from a laptop with POS_DEVTOOLS on and never from the
 * counter iPad. GET lists who has a PIN (ids, names, when, how; never a
 * hash). PUT {staffId, pin} sets one by staff id, the name resolved from
 * the active teachers, and reports a PIN another teacher holds as taken.
 * With no database it says to use POS_TEACHER_PINS instead of pretending
 * to save.
 */

function gate(request: Request): NextResponse | null {
  const denied = requireSession(request);
  if (denied) return denied;
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  return null;
}

export async function GET(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  return NextResponse.json({
    available: dbConfigured(),
    pins: (await listTeacherPins()) ?? [],
  });
}

export async function PUT(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  let staffId: unknown;
  let pin: unknown;
  try {
    ({ staffId, pin } = await request.json());
  } catch {
    return NextResponse.json(
      { error: "staffId and pin are required" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(staffId) || (staffId as number) <= 0) {
    return NextResponse.json(
      { error: "staffId must be a positive integer" },
      { status: 400 },
    );
  }
  if (!isPinShape(pin)) {
    return NextResponse.json(
      { error: `pin must be ${PIN_MIN} to ${PIN_MAX} digits` },
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
  const staff = teachers.find((t) => t.id === staffId);
  if (!staff) {
    return NextResponse.json(
      { error: `staff ${staffId} is not an active teacher` },
      { status: 400 },
    );
  }
  const teacher = { id: staff.id, name: staff.name };
  const stored = await setTeacherPin(teacher, pin, "admin");
  if (!stored.ok) {
    if (stored.reason === "taken") {
      return NextResponse.json(
        { error: "That PIN is taken, choose another." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "no database configured; set POS_TEACHER_PINS instead" },
      { status: 503 },
    );
  }
  console.log(`[teacher-pins] set for staff ${teacher.id} via admin`);
  return NextResponse.json({ ok: true, teacher });
}
