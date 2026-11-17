import { NextResponse } from "next/server";

import { buildVersion } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * T246: the build this server runs, for the customer display. It lives
 * under /api/display/ because that is the only prefix the display's
 * cookie opens; it needs no cookie at all, since it names a commit and
 * nothing else. The display compares it with the version it loaded with
 * and reloads itself once it is back on its idle screen, never in front
 * of a student. No Mindbody call.
 */
export function GET() {
  return NextResponse.json(
    { version: buildVersion() },
    { headers: { "cache-control": "no-store" } },
  );
}
