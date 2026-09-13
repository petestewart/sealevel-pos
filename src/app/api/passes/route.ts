import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { fetchPasses } from "@/lib/clientcontext";

export const dynamic = "force-dynamic";

/**
 * GET /api/passes?clientId=X
 *
 * The client's current passes, for the row's payment-change dropdown.
 * Fetched on demand at the dropdown's first open, never per roster: it is
 * a metered call per client, and the roster row already carries the one
 * pass paying for the visit without it. The browser caches the answer per
 * client for the session. Reads only.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ passes: await fetchPasses(clientId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
