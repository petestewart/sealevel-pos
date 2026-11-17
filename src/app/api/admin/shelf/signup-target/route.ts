import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import {
  classesOfSchedule,
  readEnrolTarget,
  targetLabel,
  wallLabel,
  type EnrolTarget,
} from "@/lib/enrolonpurchase";

export const dynamic = "force-dynamic";

/**
 * T219: what an id IS, for the Shelf tab's sign-up rules.
 *
 * `GET /api/admin/shelf/signup-target?id=743` asks Mindbody the three
 * questions an id copied out of Mindbody could be the answer to, and
 * says what each found:
 *
 * - `enrollment`: a course (workshop) whose ClassScheduleId is this id.
 *   Mindbody's own workshop page carries this one as "classID=".
 * - `class`: one class on the schedule whose ClassId is this id.
 * - `schedule`: the classes a class schedule with this id puts on the
 *   calendar, because a one-off class's schedule id is ALSO small, and
 *   is not the id addclienttoclass takes. The drawer offers each as a
 *   "class" rule.
 *
 * Read only, three metered reads, each in its own try so one refusal
 * does not hide the other answers. Guarded like the rest of the Shelf
 * tab: the device session, then the devtools gate.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  const raw = new URL(request.url).searchParams.get("id") ?? "";
  const id = Number(raw);
  if (!/^[0-9]{1,10}$/.test(raw) || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { error: "id must be a positive whole number" },
      { status: 400 },
    );
  }
  const describe = (t: EnrolTarget | null) =>
    t === null ? null : { ...t, label: targetLabel(t) };
  const settle = async <T,>(run: () => Promise<T>) => {
    try {
      return { value: await run(), error: null as string | null };
    } catch (err) {
      return {
        value: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  const [enrollment, cls, schedule] = await Promise.all([
    settle(() => readEnrolTarget("enrollment", id)),
    settle(() => readEnrolTarget("class", id)),
    settle(() => classesOfSchedule(id)),
  ]);
  return NextResponse.json({
    id,
    enrollment: describe(enrollment.value),
    enrollmentError: enrollment.error,
    class: describe(cls.value),
    classError: cls.error,
    schedule: (schedule.value ?? []).map((c) => ({
      ...c,
      label: wallLabel(c.startsAt) ? `${c.name}, ${wallLabel(c.startsAt)}` : c.name,
    })),
    scheduleError: schedule.error,
  });
}
