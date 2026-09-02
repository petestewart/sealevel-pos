import { NextResponse } from "next/server";

import { authRequired, requireSession, teacherFrom } from "@/lib/auth";
import { listTeachers } from "@/lib/staff";

export const dynamic = "force-dynamic";

/**
 * Who is at the counter (T44), plus what the prompt needs to ask well:
 * how many teachers have four digits on file, and the names of those
 * who do not, so the screen can say "no phone on file for A, B" instead
 * of letting them guess. Names and ids only; no phone number or digits
 * leave the server. `required` mirrors authRequired(): with no POS_PIN
 * the prompt offers a way past itself, with one it does not.
 *
 * A failed staff read is reported as `staffError` on a 200 rather than
 * a 5xx: the roster must still render, and the prompt shows the reason.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const teacher = teacherFrom(request);
  let pinsAvailable: number | null = null;
  let noPhone: string[] = [];
  let staffError: string | null = null;
  try {
    const teachers = await listTeachers();
    pinsAvailable = teachers.filter((t) => t.pinDigits !== null).length;
    noPhone = teachers.filter((t) => t.pinDigits === null).map((t) => t.name);
  } catch (err) {
    staffError = err instanceof Error ? err.message : String(err);
  }
  return NextResponse.json({
    teacher,
    required: authRequired(),
    pinsAvailable,
    noPhone,
    staffError,
  });
}
