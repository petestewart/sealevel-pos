import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { staffSessionFrom } from "@/lib/staffsession";
import { hasTeacherPin, teacherPinLength } from "@/lib/teacherpins";

export const dynamic = "force-dynamic";

/**
 * GET /api/teacher -- who is signed in at this browser (T49):
 * `{ teacher: { id, name } | null, hasPin }`. Null is the normal state
 * of a counter with nobody signed in, not an error; the header control
 * reads "Sign in" on it.
 *
 * T80: `hasPin` says whether that teacher has a comp PIN -- true,
 * false, or null for "PINs are unavailable here" (no database), which
 * is what the account modal reads to offer "Set up PIN" or "Change
 * PIN" and to offer neither when there is nowhere to keep one. It is
 * the existence of a PIN and nothing about its value. Behind the device session. Nothing else about the
 * session leaves the server: not the token, not the cookie's id.
 *
 * (T44's route of this name carried the phone-derived teacher and T48
 * deleted it; this is the staff session's, a different thing.)
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const session = await staffSessionFrom(request);
  return NextResponse.json({
    teacher: session ? { id: session.staffId, name: session.name } : null,
    hasPin: session ? await hasTeacherPin(session.staffId) : null,
    /* The PIN's digit count, so the discount dialog can submit on the
     * last digit; null when unknown. Never the digits. */
    pinLength: session ? await teacherPinLength(session.staffId) : null,
  });
}
