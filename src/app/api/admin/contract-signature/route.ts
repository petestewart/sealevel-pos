import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import {
  CONTRACT_ENV_VAR,
  CONTRACT_SETTING_KEY,
  contractRequiresSignature,
} from "@/lib/approval";
import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { dbAvailable, dbConfigured, setSetting, storageMode } from "@/lib/db";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T205 (Phase 2.5 item 6): "the customer signs the contract", edited from
 * the drawer's Settings tab, guarded exactly as T203's approval setting
 * and T89's target switch are. Line for line the same route as
 * /api/admin/customer-confirms, deliberately: two studio-wide rules about
 * the same screen should be read, changed and refused identically.
 *
 * All of these at once, and every one of them is a refusal and not a
 * hiding:
 *
 * - the device session (requireSession);
 * - the devtools gate, so this 404s on a counter iPad as /api/devlog
 *   does;
 * - a signed-in teacher (requireActor), so the change is somebody's, and
 *   logged as `[contract-signature] off -> on by staff=<id>`;
 * - that teacher being a NAMED ADMIN (`POS_ADMIN_STAFF_IDS`), because
 *   turning the setting OFF stays admin-only (design doc, Scene 4);
 * - a database that answers, since a studio-wide policy with nowhere to
 *   live is not a policy. With none, `POS_CONTRACT_REQUIRES_SIGNATURE`
 *   in the server environment decides and this route says so. That
 *   fallback defaults ON, unlike the approval setting's: the unsafe
 *   direction here is a membership sold with nobody's signature on it.
 *
 * The rail this does NOT relax: with the setting on,
 * /api/purchase-contract refuses MORE memberships, never fewer. That is what lets a control that
 * decides whether a write reaches Mindbody sit in the drawer at all
 * (CLAUDE.md, "Settings tab"), and it is why turning it off needs an
 * admin while turning it on would have been safe for anyone.
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
  const setting = await contractRequiresSignature();
  return {
    contractRequiresSignature: setting.on,
    contractRequiresSignatureSource: setting.source,
    envVar: CONTRACT_ENV_VAR,
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

  const before = await contractRequiresSignature();
  if (!dbConfigured() || !(await dbAvailable())) {
    return NextResponse.json(
      {
        error:
          `No database to store this setting in, so ${CONTRACT_ENV_VAR} in ` +
          "the server environment decides. Set DATABASE_URL to change it " +
          "from here.",
        ...(await state()),
        changed: false,
      },
      { status: 503 },
    );
  }
  const wrote = await setSetting(CONTRACT_SETTING_KEY, on ? "true" : "false");
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
    `[contract-signature] ${before.on ? "on" : "off"} -> ${on ? "on" : "off"} ` +
      `by staff=${admin.staffId}`,
  );
  return NextResponse.json({
    ...(await state()),
    changed: before.on !== on,
    previous: before.on,
  });
}
