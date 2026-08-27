import { NextResponse } from "next/server";

import { ensureIndex, indexSize, search } from "@/lib/clients";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    await ensureIndex();
    return NextResponse.json({ results: search(q), indexed: indexSize() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
