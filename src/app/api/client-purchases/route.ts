import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import {
  PurchasesRefusal,
  clampDays,
  clientPurchases,
} from "@/lib/clientpurchases";

export const dynamic = "force-dynamic";

/**
 * GET /api/client-purchases?clientId=X[&uniqueId=N][&days=30]
 *
 * T257: the student's recent sales for the profile's "Recent purchases",
 * grouped by sale, newest first, each with the Mindbody page that voids
 * it when the record is certain (src/lib/clientpurchases.ts). READS ONLY,
 * on the service account; nothing stored, no card data.
 *
 * The device session and a signed-in teacher, because it names what a
 * student bought and how they paid, and it hands out the link a teacher
 * follows to void. `days` defaults to 30 and is held to 1..90. 409 with
 * the sentence when the id names no record the screen meant (T114); 502
 * when Mindbody did not answer.
 */
export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const params = new URL(request.url).searchParams;
  const clientId = params.get("clientId")?.trim() ?? "";
  if (clientId.length === 0 || clientId.length > 40) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }
  /* T114: the UniqueId the screen holds, when it has one. Anything that
   * is not a whole number is treated as absent. */
  const rawUnique = params.get("uniqueId")?.trim() ?? "";
  const uniqueId = /^\d{1,12}$/.test(rawUnique) ? Number(rawUnique) : null;
  const days = clampDays(params.get("days"));
  try {
    return NextResponse.json(await clientPurchases(clientId, uniqueId, days));
  } catch (err) {
    if (err instanceof PurchasesRefusal) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
