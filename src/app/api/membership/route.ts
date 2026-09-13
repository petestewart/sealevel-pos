import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { fetchContracts, fetchMembershipPasses } from "@/lib/clientcontext";

export const dynamic = "force-dynamic";

/**
 * GET /api/membership?clientId=X
 *
 * T56: what the Membership modal behind a roster row's M chip lists.
 * Pete: "i want to understand what indicates the M status. when i click
 * on it for devin for instance, i see No current memberships or passes
 * on file." The M is Mindbody's own flag, which can rest on an autopay
 * contract or on a pricing option within its dates with nothing left on
 * it, and /api/passes (active only, no contracts) showed neither.
 *
 * Two metered reads, contracts and the unfiltered pass list, spent only
 * when the M is tapped; never on the roster sweep, which is the path that
 * multiplies by row count. Either failing is an error, not an empty list:
 * an empty modal is exactly the wrong answer this exists to fix. Reads
 * only, on the service account.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  try {
    const [contracts, passes] = await Promise.all([
      fetchContracts(clientId),
      fetchMembershipPasses(clientId),
    ]);
    return NextResponse.json({ contracts, passes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
