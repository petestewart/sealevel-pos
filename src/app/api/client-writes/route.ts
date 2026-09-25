import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { recentClientWrites } from "@/lib/clientaudit";

export const dynamic = "force-dynamic";

/**
 * T116: the recent record of client writes, read only, for the dev
 * drawer. `?clientId=` narrows it to one client; without it, the newest
 * across everyone. From the `client_writes` table when the database
 * answers, else this process's memory, and `source` says which, since a
 * memory list starts empty at every restart.
 *
 * Gated exactly like /api/devlog: behind the device session and 404
 * unless devtools are on, because the entries carry the text of notes
 * and alerts and must not be reachable from the counter iPad.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  const url = new URL(request.url);
  const clientId = (url.searchParams.get("clientId") ?? "").trim() || null;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const { source, entries } = await recentClientWrites(
    clientId,
    Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
  );
  return NextResponse.json({ source, clientId, entries });
}
