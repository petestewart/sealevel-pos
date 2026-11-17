import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { usablePassesForVisit } from "@/lib/visitpasses";

export const dynamic = "force-dynamic";

/**
 * GET /api/visit-passes?clientId=X&visitId=N&classId=N
 *
 * T242: the client's own passes that Mindbody would accept for this one
 * visit, for the "Pay and check in" dialog's passes view. The client's
 * current passes, each asked of Mindbody with a `Test: true`
 * `updateclientvisit` on the service account (src/lib/visitpasses.ts).
 * Nothing is committed: a Test call validates and writes nothing, and
 * under dry run or the write guard it is not even sent (and the pass is
 * shown, not hidden). The assignment itself is the teacher's tap,
 * through `/api/visit-payment` under their own token.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const clientId = params.get("clientId")?.trim() ?? "";
  const visitId = Number(params.get("visitId"));
  const rawClass = params.get("classId");
  const classId = rawClass === null ? null : Number(rawClass);
  if (clientId.length === 0) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  if (!Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json(
      { error: "visitId (integer) is required" },
      { status: 400 },
    );
  }
  try {
    const answer = await usablePassesForVisit({
      clientId,
      visitId,
      classId:
        classId !== null && Number.isInteger(classId) && classId > 0
          ? classId
          : null,
    });
    return NextResponse.json(answer);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
