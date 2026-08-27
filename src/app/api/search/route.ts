import { NextResponse } from "next/server";

import { search, warmIndex } from "@/lib/clients";

export const dynamic = "force-dynamic";

/**
 * Kick the warm-up on module load, so the index is building from the moment
 * the server starts rather than from the first person who types a name.
 */
warmIndex();

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    return NextResponse.json(await search(q));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
