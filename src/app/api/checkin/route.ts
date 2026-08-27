import { NextResponse } from "next/server";

import { checkIn } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * The only write this app performs in Phase 1. It moves no money, and it
 * is idempotent enough at Mindbody's end that a double tap is harmless,
 * which is what lets the UI go green optimistically.
 */
export async function POST(request: Request) {
  try {
    const { clientId, classId } = await request.json();
    if (!clientId || !classId) {
      return NextResponse.json(
        { error: "clientId and classId are required" },
        { status: 400 },
      );
    }
    await checkIn(String(clientId), Number(classId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
