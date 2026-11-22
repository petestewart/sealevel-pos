import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import {
  CARD_READER_ENV_VAR,
  cardReaderEnabled,
  readerEnv,
  readerMode,
  setCardReaderEnabled,
} from "@/lib/cardreader";
import { dbAvailable, dbConfigured, storageMode } from "@/lib/db";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T223 (Pete, 2026-11-22: "the square functionality should be behind a
 * flag"): the card reader's switch, DEFAULT OFF, edited from the drawer's
 * Settings tab and guarded the way T241's display-typed-card is: the
 * device session, the devtools gate, a signed-in teacher who is a named
 * admin, and a database that answers. With none, POS_CARD_READER decides
 * (unset is off). It can only add or remove a way to pay; turning it off
 * strands no hold, since the sweep still cleans up.
 *
 * THIS ROUTE CALLS NEITHER SQUARE NOR MINDBODY.
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
  const sw = await cardReaderEnabled();
  const env = readerEnv();
  return {
    cardReader: sw.on,
    cardReaderSource: sw.source,
    envVar: CARD_READER_ENV_VAR,
    mode: readerMode(),
    missing: "missing" in env ? env.missing : [],
    storage: storageMode(),
    configured: dbConfigured(),
    available: await dbAvailable(),
  };
}

async function requireAdmin(
  request: Request,
): Promise<{ denied: NextResponse; staffId: null } | { denied: null; staffId: number }> {
  const actor = await requireActor(request);
  if (actor.denied) return { denied: actor.denied, staffId: null };
  if (!isTargetAdmin(actor.session.staffId)) {
    return {
      denied: NextResponse.json({ error: "Not an admin" }, { status: 403 }),
      staffId: null,
    };
  }
  return { denied: null, staffId: actor.session.staffId };
}

export async function GET(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  const admin = await requireAdmin(request);
  if (admin.denied) return admin.denied;
  return NextResponse.json(await state());
}

export async function PUT(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  const admin = await requireAdmin(request);
  if (admin.denied) return admin.denied;
  let on: unknown;
  try {
    on = (await request.json())?.on;
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  if (on !== true && on !== false) {
    return NextResponse.json({ error: "on must be true or false" }, { status: 400 });
  }
  const before = await cardReaderEnabled();
  if (!dbConfigured() || !(await dbAvailable())) {
    return NextResponse.json(
      {
        error:
          `No database to store this setting in, so ${CARD_READER_ENV_VAR} in ` +
          "the server environment decides.",
        ...(await state()),
        changed: false,
      },
      { status: 503 },
    );
  }
  if (!(await setCardReaderEnabled(on))) {
    return NextResponse.json(
      { error: "The database refused the setting, so nothing changed.", ...(await state()), changed: false },
      { status: 503 },
    );
  }
  console.log(
    `[card-reader] ${before.on ? "on" : "off"} -> ${on ? "on" : "off"} by staff=${admin.staffId}`,
  );
  return NextResponse.json({ ...(await state()), changed: before.on !== on, previous: before.on });
}
