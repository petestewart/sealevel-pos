import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { clientPaymentProfile } from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * GET /api/stored-card?clientId=...
 *
 * The attached client's payment profile: card on file (last four and
 * expiry, never more; the PAN never leaves Mindbody) plus account
 * balance. The sale screen calls this on attach to decide which method
 * cards light up; /api/checkout re-reads the same data server-side at
 * charge time and never trusts what the browser learned here.
 *
 * A read, so it goes out even under dry run; guarded by requireSession
 * because it names a client's card and balance.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const clientId = new URL(request.url).searchParams.get("clientId")?.trim();
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  try {
    const profile = await clientPaymentProfile(clientId);
    return NextResponse.json(profile);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
