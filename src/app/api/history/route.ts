import { NextResponse } from "next/server";

import { fetchVisits } from "@/lib/clientcontext";

export const dynamic = "force-dynamic";

/**
 * GET /api/history?clientId=X
 *
 * The client's recent visit window (last ~35 days), behind the roster
 * row's one-line history. Called by the browser's background sweep AFTER
 * a roster renders, with modest concurrency and a per-client session
 * cache, so a roster never waits on it and a class switch never refetches.
 * Reads only.
 */
export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ visits: await fetchVisits(clientId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
