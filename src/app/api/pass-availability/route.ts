import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { currentShelfConfig, rawCatalog } from "@/lib/catalog";
import { passAvailability } from "@/lib/passavailability";
import { houseClientId } from "@/lib/sale";
import { itemKey } from "@/lib/shelfconfig";

export const dynamic = "force-dynamic";

/**
 * GET /api/pass-availability?clientId=<id>[&fresh=1]
 *
 * T221: which passes on the shelf the attached client cannot buy, with
 * Mindbody's own sentence for each, so the sale screen can grey them out
 * before a tap rather than take them back off the ticket after one (see
 * src/lib/passavailability.ts for the rule and its limits).
 *
 * Read-shaped and behind the device session like /api/price-cart, which
 * also needs no sign-in: every question it asks is a `Test: true`
 * pricing, which moves nothing. Under dry run or the write guard those
 * are suppressed and the answer says so (`suppressed: true`), with
 * nothing reported unavailable. The house client and a missing client
 * are answered empty with no Mindbody call: a pass is never sold onto
 * the house client (T92), so there is nothing to grey.
 *
 * Only passes the shelf actually shows are asked about: one hidden in the
 * drawer (T74) is never drawn, so asking about it would be a metered call
 * for a tile nobody can tap.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const clientId = (url.searchParams.get("clientId") ?? "").trim();
  const fresh = url.searchParams.get("fresh") === "1";
  const empty = { checked: 0, unavailable: [], unknown: 0, suppressed: false, cached: false };
  if (clientId === "" || clientId.length > 64 || clientId === houseClientId()) {
    return NextResponse.json(empty);
  }
  try {
    const [{ data }, { config }] = await Promise.all([
      rawCatalog(),
      currentShelfConfig(),
    ]);
    const hidden = new Set(config.hidden);
    const shown = data.passes.filter(
      (p) => !hidden.has(itemKey(p.type, p.id)),
    );
    return NextResponse.json(await passAvailability(clientId, shown, { fresh }));
  } catch (err) {
    /* The catalog read failed. Nothing is known, so nothing is greyed:
     * the cart's own pricing still refuses what Mindbody refuses. */
    return NextResponse.json(
      { ...empty, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
