import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import {
  runSaleCheck,
  shiftDay,
  studioMidnight,
  studioToday,
} from "@/lib/salecheck";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T274: "Check now" on the Sales sheet. POST {day} reads that studio
 * day's unchecked sales back from Mindbody (READS ONLY, one metered
 * `/sale/sales` read per sale, at most sixty per tap) and records each
 * verdict. Admin only, like the sheet.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  if (!isTargetAdmin(actor.session.staffId)) {
    return NextResponse.json({ error: "Not an admin" }, { status: 403 });
  }
  const body: any = await request.json().catch(() => ({}));
  const dayParam = typeof body?.day === "string" ? body.day : "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : studioToday();
  const from = studioMidnight(day);
  const to = Math.min(studioMidnight(shiftDay(day, 1)), Date.now() + 60_000);
  const result = await runSaleCheck(from, to);
  if (result === null) {
    return NextResponse.json(
      { error: "The sales log is not available: no database answered." },
      { status: 503 },
    );
  }
  console.log(
    `[sale-check] run by staff=${actor.session.staffId} day=${day}: ${JSON.stringify(result)}`,
  );
  return NextResponse.json({ day, ...result });
}
