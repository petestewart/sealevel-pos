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
  try {
    return NextResponse.json(
      await search(q, Number.isFinite(limit) ? limit : 12),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
