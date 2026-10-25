import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import {
  SIGNUP_ENV_VAR,
  SIGNUP_SETTING_KEY,
  readSignupMode,
  signupMode,
} from "@/lib/approval";
import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { dbAvailable, dbConfigured, setSetting, storageMode } from "@/lib/db";
import { isTargetAdmin } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T207: whether a completed self-serve sign-up is created AUTOMATICALLY
 * by the teacher's iPad, or waits in the tray for a teacher's tap
 * (Pete, 2026-09-20: "make automatic the default with a setting that can
 * be set to review").
 *
 * Guarded exactly as /api/admin/customer-confirms and
 * /api/admin/contract-signature are, and for the plainer reason that a
 * studio-wide policy should be somebody's and logged: the device
 * session, the devtools gate, a signed-in teacher, that teacher being a
 * named admin (POS_ADMIN_STAFF_IDS), and a database that answers.
 *
 * Unlike those two this setting is NOT a write rail. Automatic and
 * review make the same three writes -- /api/client-create, /api/book,
 * /api/checkin -- under the same guards, from the same browser, under
 * the same teacher's token; the setting decides only whether a human
 * taps first. Nothing on the server reads it to refuse anything.
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
  const setting = await signupMode();
  return {
    signupMode: setting.mode,
    signupModeSource: setting.source,
    envVar: SIGNUP_ENV_VAR,
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

  let raw: unknown;
  try {
    raw = (await request.json())?.mode;
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const mode = readSignupMode(raw);
  if (mode === null) {
    return NextResponse.json(
      { error: 'mode must be "automatic" or "review"' },
      { status: 400 },
    );
  }

  const before = await signupMode();
  if (!dbConfigured() || !(await dbAvailable())) {
    return NextResponse.json(
      {
        error:
          `No database to store this setting in, so ${SIGNUP_ENV_VAR} in ` +
          "the server environment decides. Set DATABASE_URL to change it " +
          "from here.",
        ...(await state()),
        changed: false,
      },
      { status: 503 },
    );
  }
  const wrote = await setSetting(SIGNUP_SETTING_KEY, mode);
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
    `[signup-mode] ${before.mode} -> ${mode} by staff=${admin.staffId}`,
  );
  return NextResponse.json({
    ...(await state()),
    changed: before.mode !== mode,
    previous: before.mode,
  });
}
