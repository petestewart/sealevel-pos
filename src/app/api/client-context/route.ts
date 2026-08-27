import { NextResponse } from "next/server";

import { clientContext } from "@/lib/clientcontext";

export const dynamic = "force-dynamic";

/**
 * GET /api/client-context?clientId=X
 *
 * Everything a teacher should know about one person, batched server-side:
 * passes and what remains, account credit, recent visits, habitual
 * add-ons, notes and red alert. Reads only. Fetched when a row is opened,
 * never per roster; the client keeps the browser-side caching.
 *
 * Sections fail independently (each carries its own error), so the whole
 * response is a 200 unless the request itself is malformed. A hard 502
 * here would hide the red alert behind a purchases outage.
 */
export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await clientContext(clientId));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
