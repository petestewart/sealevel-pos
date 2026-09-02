import { NextResponse } from "next/server";

import { requireSession, requireTeacher } from "@/lib/auth";

import { setVisitService } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * Change which pass pays for a visit: Mindbody's "Change how the client is
 * paying". Same endpoint family as check-in (`/client/updateclientvisit`),
 * same guard plumbing, and like check-in it moves no money -- it reassigns
 * a session from one already-purchased pricing option to another, and
 * doing it again with the old id reverses it.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const gate = requireTeacher(request);
  if (!gate.ok) return gate.denied;
  try {
    const { visitId, clientServiceId, clientId } = await request.json();
    if (typeof visitId !== "number") {
      return NextResponse.json(
        { error: "visitId (number) is required" },
        { status: 400 },
      );
    }
    if (typeof clientServiceId !== "number") {
      return NextResponse.json(
        { error: "clientServiceId (number) is required" },
        { status: 400 },
      );
    }
    const result = await setVisitService(
      visitId,
      clientServiceId,
      typeof clientId === "string" ? clientId : undefined,
    );
    return NextResponse.json({ ok: true, suppressed: result.suppressed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
