import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { staffSessionFrom } from "@/lib/staffsession";

export const dynamic = "force-dynamic";

/**
 * GET /api/teacher -- who is signed in at this browser (T49):
 * `{ teacher: { id, name } | null }`. Null is the normal state of a
 * counter with nobody signed in, not an error; the header control reads
 * "Sign in" on it. Behind the device session. Nothing else about the
 * session leaves the server: not the token, not the cookie's id.
 *
 * (T44's route of this name carried the phone-derived teacher and T48
 * deleted it; this is the staff session's, a different thing.)
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const session = staffSessionFrom(request);
  return NextResponse.json({
    teacher: session ? { id: session.staffId, name: session.name } : null,
  });
}
