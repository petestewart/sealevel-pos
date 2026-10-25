import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { currentSiteId } from "@/lib/mindbody";
import { staffSessionFrom } from "@/lib/staffsession";
import { ensureTarget, targetSwitchNotice } from "@/lib/target";
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
  /* T210: the stored target decides which site this counter is on, and
   * this route reports it, so it is loaded first. Bounded, never
   * throws, a no-op without a database. */
  await ensureTarget();
  const session = await staffSessionFrom(request);
  return NextResponse.json({
    teacher: session ? { id: session.staffId, name: session.name } : null,
    /* T210: the site that issued this teacher's token, and the site
     * this counter is on. Equal in every ordinary state; when they are
     * not, every write under the token is refused by Mindbody
     * ("Delegated staff does not belong to the subscriber.") and the
     * drawer's line says so. Null means nobody is signed in, or the
     * environment names no site at all. */
    siteId: session?.siteId ?? null,
    targetSiteId: currentSiteId(),
    /* T210: why the gate is about to show, when the server has a reason
     * to give. The 401 on a refused WRITE has always carried one (T89's
     * target switch, and since T210 a sign-in that belongs to another
     * site); this is the same line for the teacher who simply walks up
     * to an iPad after a restart, who makes no write and would
     * otherwise meet a gate that explains nothing. Only when nobody is
     * signed in, and never a session detail. */
    notice: session ? null : targetSwitchNotice(),
    hasPin: session ? await hasTeacherPin(session.staffId) : null,
    /* The PIN's digit count, so the discount dialog can submit on the
     * last digit; null when unknown. Never the digits. */
    pinLength: session ? await teacherPinLength(session.staffId) : null,
  });
}
