import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { waitlistFor } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * GET /api/waitlist?classId=1 -> the waiting list for that class, in queue
 * order. A read, but a metered one: the UI only asks for a class that is
 * at capacity, because a class with room cannot have a queue.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const classId = new URL(request.url).searchParams.get("classId");
  if (!classId) {
    return NextResponse.json(
      { error: "classId is required" },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({ entries: await waitlistFor(Number(classId)) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
