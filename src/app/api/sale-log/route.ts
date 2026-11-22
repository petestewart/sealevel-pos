import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { countSaleLogProblems, dbConfigured, listSaleLog } from "@/lib/db";
import { shiftDay, studioMidnight, studioToday } from "@/lib/salecheck";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T274: the admin Sales sheet's read. GET ?day=YYYY-MM-DD (studio-local,
 * default today) lists that day's sale_log rows, newest first; GET
 * ?problems=1 answers only how many rows of the last seven days the check
 * found differing or missing, for the header count.
 *
 * Behind the device session AND a signed-in teacher whose staff id is in
 * POS_ADMIN_STAFF_IDS, NOT the devtools gate: the dev drawer is off on the
 * deployed counter, and this sheet is for the counter's own admin. The
 * rows carry client ids, ticket lines and amounts, never card data
 * (src/lib/salelog.ts strips that before it is stored).
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  if (!isTargetAdmin(actor.session.staffId)) {
    return NextResponse.json({ error: "Not an admin" }, { status: 403 });
  }
  const url = new URL(request.url);
  if (url.searchParams.get("problems") === "1") {
    const since = studioMidnight(shiftDay(studioToday(), -6));
    const n = await countSaleLogProblems(since);
    return NextResponse.json({ problems: n, available: n !== null });
  }
  const dayParam = url.searchParams.get("day") ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : studioToday();
  const from = studioMidnight(day);
  const to = studioMidnight(shiftDay(day, 1));
  const rows = await listSaleLog(from, to, 500);
  return NextResponse.json({
    day,
    configured: dbConfigured(),
    available: rows !== null,
    rows: rows ?? [],
  });
}
