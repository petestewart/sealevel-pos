import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import {
  endStaffSession,
  staffClearCookie,
  staffSessionFrom,
} from "@/lib/staffsession";

export const dynamic = "force-dynamic";

/**
 * POST /api/teacher/signout -- end the staff session (T49): the entry
 * goes, the Mindbody token is revoked (best effort, bounded by
 * revokeStaffToken's own timeout) and the cookie is cleared. Always
 * 200: signing out with no session is already signed out.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const session = staffSessionFrom(request);
  if (session) {
    await endStaffSession(session.id);
    console.log(`[staff] signed out staff=${session.staffId}`);
  }
  return NextResponse.json(
    { ok: true },
    { headers: { "set-cookie": staffClearCookie() } },
  );
}
