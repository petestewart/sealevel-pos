import { NextResponse } from "next/server";

import { classesAroundNow, classRoster } from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * GET /api/roster            -> classes around now
 * GET /api/roster?classId=1  -> that class plus its roster
 */
export async function GET(request: Request) {
  const classId = new URL(request.url).searchParams.get("classId");
  try {
    if (classId) {
      return NextResponse.json(await classRoster(Number(classId)));
    }
    return NextResponse.json({ classes: await classesAroundNow() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
