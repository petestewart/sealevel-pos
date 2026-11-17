import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { usablePassesForVisit } from "@/lib/visitpasses";

export const dynamic = "force-dynamic";

/**
 * GET /api/visit-passes?clientId=X&visitId=N&classId=N
 *
 * T242: the client's own passes the "Pay and check in" dialog offers for
 * this one visit: their current passes with a class left, less guest
 * passes and passes from another program than the class's
 * (src/lib/visitpasses.ts). READS ONLY: nothing here is write-shaped.
 *
 * A signed-in teacher, like the write routes, because this decides what a
 * teacher is offered to write; and the visit must be this client's on
 * this class, or it is refused. The assignment itself is the teacher's
 * tap, through `/api/visit-payment` under their own token, and Mindbody's
 * refusal of it is the backstop for any rule this list does not see.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const params = new URL(request.url).searchParams;
  const clientId = params.get("clientId")?.trim() ?? "";
  const visitId = Number(params.get("visitId"));
  const classId = Number(params.get("classId"));
  if (clientId.length === 0) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  if (!Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json(
      { error: "visitId (integer) is required" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(classId) || classId <= 0) {
    return NextResponse.json(
      { error: "classId (integer) is required" },
      { status: 400 },
    );
  }
  try {
    const answer = await usablePassesForVisit({ clientId, visitId, classId });
    if (!answer.ok) {
      return NextResponse.json({ error: answer.error }, { status: answer.status });
    }
    return NextResponse.json(answer);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
