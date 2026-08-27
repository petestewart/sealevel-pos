import { NextResponse } from "next/server";

import { clear, devtoolsEnabled, recent } from "@/lib/calllog";

export const dynamic = "force-dynamic";

/**
 * Recent Mindbody traffic, for the dev drawer. 404s when devtools are off:
 * these records carry client names and booking details, so this must not be
 * reachable on the counter iPad.
 */
export async function GET(request: Request) {
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
  return NextResponse.json({ calls: recent(Number.isFinite(since) ? since : 0) });
}

export async function DELETE() {
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  clear();
  return NextResponse.json({ ok: true });
}
