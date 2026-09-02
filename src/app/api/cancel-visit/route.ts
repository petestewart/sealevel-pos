import { NextResponse } from "next/server";

import { requireSession, requireTeacher } from "@/lib/auth";

import { removeClientFromClass } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * Cancel a booking: `POST /class/removeclientfromclass` with
 * `{ClientId, ClassId, SendEmail: false}` (spec-verified in
 * src/lib/roster.ts). This undoes the BOOKING, where check-out undoes a
 * sign-in; the roster row disappears rather than going grey.
 *
 * The write goes through the mindbody() client, so dry run and the
 * POS_WRITE_CLIENT_IDS guard both apply; a suppressed removal is reported
 * as such rather than pretending the booking is gone.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const gate = requireTeacher(request);
  if (!gate.ok) return gate.denied;
  try {
    const { clientId, classId } = await request.json();
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    if (typeof classId !== "number") {
      return NextResponse.json(
        { error: "classId (number) is required" },
        { status: 400 },
      );
    }
    const result = await removeClientFromClass(clientId, classId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
