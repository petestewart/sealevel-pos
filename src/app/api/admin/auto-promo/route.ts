import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import {
  AUTO_PROMO_ENV_VAR,
  autoPromoRule,
  autoPromoRunsOn,
  parseAutoPromo,
  storeAutoPromo,
  studioToday,
} from "@/lib/autopromo";
import { devtoolsEnabled } from "@/lib/calllog";
import { dbAvailable, dbConfigured } from "@/lib/db";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T298: the automatic promotion code, edited from the drawer's Settings
 * tab by a named admin (the device session, the devtools gate, a
 * signed-in teacher in POS_ADMIN_STAFF_IDS) and stored in app_settings;
 * with no database, POS_AUTO_PROMO decides. GET reads it for anybody
 * with the drawer; PUT sets `{code, from, until}` or clears it with
 * `{clear: true}`, and the log names who.
 *
 * THIS ROUTE CALLS NO MINDBODY ENDPOINT. Whether the code is worth
 * anything is Mindbody's answer on every ticket's own pricing.
 */

function gate(request: Request): NextResponse | null {
  const denied = requireSession(request);
  if (denied) return denied;
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  return null;
}

async function state() {
  const { rule, source } = await autoPromoRule();
  const today = studioToday();
  return {
    rule,
    source,
    today,
    runsToday: rule !== null && autoPromoRunsOn(rule, today),
    envVar: AUTO_PROMO_ENV_VAR,
    configured: dbConfigured(),
    available: await dbAvailable(),
  };
}

export async function GET(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  return NextResponse.json(await state());
}

export async function PUT(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;
  if (!isTargetAdmin(actor.session.staffId)) {
    return NextResponse.json({ error: "Not an admin" }, { status: 403 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const clear = body?.clear === true;
  const parsed = clear ? null : parseAutoPromo(body);
  if (parsed !== null && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  if (!dbConfigured() || !(await dbAvailable())) {
    return NextResponse.json(
      {
        error: `No database to store this in, so ${AUTO_PROMO_ENV_VAR} in the server environment decides.`,
        ...(await state()),
      },
      { status: 503 },
    );
  }
  const before = (await autoPromoRule()).rule;
  if (!(await storeAutoPromo(parsed))) {
    return NextResponse.json(
      { error: "The database refused the setting, so nothing changed.", ...(await state()) },
      { status: 503 },
    );
  }
  const words = (r: typeof before) => (r ? `${r.code} ${r.from}..${r.until}` : "none");
  console.log(`[auto-promo] ${words(before)} -> ${words(parsed)} by staff=${actor.session.staffId}`);
  return NextResponse.json(await state());
}
