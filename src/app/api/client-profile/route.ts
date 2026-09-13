import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { clientProfile } from "@/lib/clientprofile";

export const dynamic = "force-dynamic";

/**
 * GET /api/client-profile?clientId=...
 *
 * T41: what the Buy header's profile icon opens: the same basic facts
 * Mindbody's client-info page shows (phone, email, visits and join date,
 * client id, waiver and its date, last visit, status, passes with what
 * is left on each). Three reads at most, in parallel, each optional;
 * see src/lib/clientprofile.ts.
 *
 * A read, so it goes out even under dry run; guarded by requireSession
 * because it names a client's contact details and alerts. 502 when the
 * whole read fails, like /api/stored-card; a single failed sub-read
 * still answers 200 with that section null and named in `errors`.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const clientId = new URL(request.url).searchParams.get("clientId")?.trim();
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  try {
    const profile = await clientProfile(clientId);
    return NextResponse.json(profile);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
