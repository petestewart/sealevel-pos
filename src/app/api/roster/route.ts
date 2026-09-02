import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import {
  classesAroundNow,
  classesForDay,
  classRoster,
  parseRosterAnchor,
} from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * GET /api/roster                  -> classes around now
 * GET /api/roster?classId=1        -> that class plus its roster
 * GET /api/roster?classId=1&summary=0 -> the roster only: the caller has
 *                                     the class summary already (T46, a
 *                                     class on another day, which the
 *                                     around-now lookup could never hit)
 * GET /api/roster?day=1&anchor=ISO -> every class on the studio-local day
 *                                     containing `anchor` (default now).
 *                                     One metered call; the attach
 *                                     quick-pick fetches it lazily and
 *                                     caches per day (T27 round three).
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const classId = params.get("classId");
  const hoursBack = Number(params.get("hoursBack") ?? 2);
  const hoursForward = Number(params.get("hoursForward") ?? 4);
  try {
    if (classId) {
      return NextResponse.json(
        await classRoster(Number(classId), {
          summary: params.get("summary") !== "0",
        }),
      );
    }
    if (params.get("day") === "1") {
      /* The anchor is usually a class's startsAt, which Mindbody serves
       * as a NAIVE studio-local string: parseRosterAnchor reads it in
       * STUDIO_TZ (a bare new Date() on a UTC container shifted any
       * class before 7am into the previous studio day). */
      const raw = params.get("anchor");
      const anchor = (raw ? parseRosterAnchor(raw) : null) ?? new Date();
      return NextResponse.json({ classes: await classesForDay(anchor) });
    }
    return NextResponse.json({
      classes: await classesAroundNow(new Date(), hoursBack, hoursForward),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
