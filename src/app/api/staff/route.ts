import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { listTeachers } from "@/lib/staff";

export const dynamic = "force-dynamic";

/**
 * GET /api/staff -- the active teachers, for the comp dialog's picker
 * (T45: "the teacher should be selected from a list"). Answers
 * `[{ id, name }]` from the cached staff read, placeholders filtered
 * (T48); nothing else from the staff row leaves the server. Read only,
 * behind the device session. T44 put the teacher session in front of it
 * too; T48 removed that layer, and the comp this list feeds asks for a
 * PIN in the dialog instead.
 *
 * A failed staff read is a 502 with the reason; the dialog says it could
 * not load teachers and keeps Comp disabled for that kind rather than
 * letting a name be guessed at.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
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
