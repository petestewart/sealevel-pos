import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import {
  DISPLAY_CARD_ENV_VAR,
  DISPLAY_CARD_SETTING_KEY,
  displayTypedCardAllowed,
} from "@/lib/approval";
import { dropAllDisplayCards } from "@/lib/displaycard";
import { withdrawTypedCardOffer } from "@/lib/display";
import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { dbAvailable, dbConfigured, setSetting, storageMode } from "@/lib/db";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T241 (Pete: "let's hide it behind a flag so i can turn it off if it
 * becomes annoying"): whether a student may type a card on the customer
 * screen, edited from the drawer's Settings tab and guarded exactly as
 * T205's /api/admin/contract-signature is, line for line: the device
 * session, the devtools gate, a signed-in teacher who is a NAMED ADMIN
 * (`POS_ADMIN_STAFF_IDS`), and a database that answers. With none,
 * `POS_DISPLAY_TYPED_CARD` in the server environment decides (unset is
 * on).
 *
 * Turning it OFF removes a way to pay and drops every card a student has
 * already typed (each teacher's line for one then finds it gone at
 * Finalize, and says so, as for any released card). Turning it on
 * offers "A different card" again. Neither direction lets anything
 * reach Mindbody that the teacher's own checkout does not send.
 *
 * Meant to be removed once Phase 4's card reader exists.
 *
 * THIS ROUTE CALLS MINDBODY NOWHERE.
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
  const setting = await displayTypedCardAllowed();
  return {
    displayTypedCard: setting.on,
    displayTypedCardSource: setting.source,
    envVar: DISPLAY_CARD_ENV_VAR,
    storage: storageMode(),
    configured: dbConfigured(),
    available: await dbAvailable(),
  };
}

async function requireAdmin(
  request: Request,
): Promise<
  { denied: NextResponse; staffId: null } | { denied: null; staffId: number }
> {
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

  const before = await displayTypedCardAllowed();
  if (!dbConfigured() || !(await dbAvailable())) {
    return NextResponse.json(
      {
        error:
          `No database to store this setting in, so ${DISPLAY_CARD_ENV_VAR} in ` +
          "the server environment decides. Set DATABASE_URL to change it " +
          "from here.",
        ...(await state()),
        changed: false,
      },
      { status: 503 },
    );
  }
  const wrote = await setSetting(DISPLAY_CARD_SETTING_KEY, on ? "true" : "false");
  if (!wrote) {
    return NextResponse.json(
      {
        error: "The database refused the setting, so nothing changed.",
        ...(await state()),
        changed: false,
      },
      { status: 503 },
    );
  }
  /* The one log line, with who: no token, no PIN, nothing else. */
  console.log(
    `[display-typed-card] ${before.on ? "on" : "off"} -> ${on ? "on" : "off"} ` +
      `by staff=${admin.staffId}`,
  );
  /* Off: no card a student typed survives the switch. */
  if (!on) {
    dropAllDisplayCards("students may no longer type a card");
    withdrawTypedCardOffer();
  }
  return NextResponse.json({
    ...(await state()),
    changed: before.on !== on,
    previous: before.on,
  });
}
