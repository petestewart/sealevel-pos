import { NextResponse } from "next/server";

import { requireSession, requireTeacher } from "@/lib/auth";
import { listTeachers } from "@/lib/staff";

export const dynamic = "force-dynamic";

/**
 * GET /api/staff -- the active teachers, for the comp dialog's picker
 * (T45: "the teacher should be selected from a list"). Answers
 * `[{ id, name }]` from the same cached staff read the four-digit prompt
 * uses; nothing else from the staff row leaves the server, and above all
 * no phone number, since the last four of it are a teacher's PIN. Read
 * only. Behind the device session and the teacher session like the
 * writes it feeds: the picker exists to name who a comp was for, and a
 * counter with nobody signed in has no comp to make.
 *
 * A failed staff read is a 502 with the reason; the dialog says it could
 * not load teachers and keeps Comp disabled for that kind rather than
 * letting a name be guessed at.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const gate = requireTeacher(request);
  if (!gate.ok) return gate.denied;
  try {
    const teachers = await listTeachers();
    return NextResponse.json(teachers.map((t) => ({ id: t.id, name: t.name })));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
