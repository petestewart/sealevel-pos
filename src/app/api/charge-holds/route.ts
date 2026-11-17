import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { standingChargeHolds } from "@/lib/chargehold";

export const dynamic = "force-dynamic";

/**
 * T253: the standing charge holds for one or more clients
 * (`?clientId=1&clientId=2`, or comma separated), for the Cart screen and
 * the roster's Pay and check in to show BEFORE a charge is refused. Behind
 * the device session; reads only. The answer is ids, a kind, the route's
 * sentence (long digit runs struck), a sale id when known and a time: no
 * card data exists in a hold to leak.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const ids = url.searchParams
    .getAll("clientId")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "")
    .slice(0, 20);
  if (ids.length === 0) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  const holds = await standingChargeHolds(ids);
  return NextResponse.json({ holds });
}
