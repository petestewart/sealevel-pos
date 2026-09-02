import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { search } from "@/lib/clients";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const limit = Number(params.get("limit") ?? 12);
  /* T42: the page offset for the scroll-loaded list. One metered call per
   * page; a bad value reads as the first page rather than a 400, since
   * the only caller is our own modal. */
  const offset = Number(params.get("offset") ?? 0);
  try {
    return NextResponse.json(
      await search(
        q,
        Number.isFinite(limit) ? limit : 12,
        Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
      ),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
