import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { clearRawCatalog } from "@/lib/catalog";
import { clearRequiredFieldsCache } from "@/lib/clients";
import { clearGiftCardProducts } from "@/lib/giftcardsale";
import { dbAvailable, dbConfigured, storageMode } from "@/lib/db";
import {
  dryRunState,
  missingCredentials,
  siteIdFor,
  target,
  type Target,
} from "@/lib/mindbody";
import { endAllStaffSessions } from "@/lib/staffsession";
import {
  ensureTarget,
  isTargetAdmin,
  setTargetOverride,
  targetSource,
} from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T89: the Mindbody target, switchable at the counter instead of by a
 * redeploy. Pete asked for it and, told that it relaxes the rail keeping
 * write-reaching decisions out of the drawer, said "go".
 *
 * What guards it, all of these at once:
 *
 * - the device session (requireSession), like every admin route here;
 * - the devtools gate, so this 404s on a counter iPad exactly as
 *   /api/devlog does. A teacher cannot reach it at all;
 * - a signed-in teacher (requireActor), so the switch is somebody's, and
 *   logged as `[target] prod -> sandbox by staff=<id>`;
 * - that teacher being a NAMED ADMIN (`POS_ADMIN_STAFF_IDS`, Pete: only
 *   named admin staff, and for everybody else the switch does not
 *   exist). Empty means nobody. Both verbs require it, so a teacher can
 *   neither switch the target nor read which variables the other studio
 *   is missing; the drawer hides the block for them as well, but the
 *   refusal here is the guard;
 * - BOTH credential sets present in the server environment. A switch to
 *   a target whose variables are missing is refused with 409 and the
 *   NAMES of what to set, never a value.
 *
 * What it deliberately does NOT touch: the server's dry run and the write
 * guard. They stay in the server environment, so switching to prod lands
 * in dry run unless POS_DRY_RUN=false was deployed, and the write guard
 * still suppresses writes for anyone not on its list. A panel that could
 * turn dry run off would defeat the point of dry run; the drawer's other
 * T89 control can only turn one ON, for one browser.
 *
 * Switching ends every staff session (a token belongs to the site that
 * issued it) and clears the cached catalog, so nothing from the other
 * studio survives the flip. With no database there is nothing to store
 * and the route says so: MINDBODY_TARGET decides, as before T89.
 */

function gate(request: Request): NextResponse | null {
  const denied = requireSession(request);
  if (denied) return denied;
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  return null;
}

const TARGETS: Target[] = ["sandbox", "prod"];

/** The block's whole payload: where the counter points, who decided, and
 *  whether each target could be switched to. Site ids only, never a key
 *  or a password. */
async function state() {
  await ensureTarget();
  const current = target();
  const dry = await dryRunState();
  return {
    target: current,
    targetSource: targetSource(),
    siteId: siteIdFor(current),
    dryRun: dry.on,
    dryRunSource: dry.source,
    storage: storageMode(),
    configured: dbConfigured(),
    available: await dbAvailable(),
    targets: TARGETS.map((t) => ({
      target: t,
      siteId: siteIdFor(t),
      missing: missingCredentials(t),
    })),
  };
}

/** The signed-in teacher, refused unless they are a named admin. */
async function requireAdmin(
  request: Request,
): Promise<
  | { denied: NextResponse; staffId: null }
  | { denied: null; staffId: number }
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
  /* A switch is somebody's, and that somebody has to be a named admin:
   * the 401 is the same `reason: "staff"` every write route answers, so
   * the browser shows the sign-in gate; the 403 is a teacher who is
   * signed in and simply does not do this. */
  const admin = await requireAdmin(request);
  if (admin.denied) return admin.denied;

  let next: unknown;
  try {
    next = (await request.json())?.target;
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  if (next !== "sandbox" && next !== "prod") {
    return NextResponse.json(
      { error: 'target must be "sandbox" or "prod"' },
      { status: 400 },
    );
  }

  await ensureTarget();
  const current = target();
  if (next === current) {
    /* Nothing to do, and saying so beats signing everyone out for a tap
     * that changed nothing. */
    return NextResponse.json({ ...(await state()), switched: false });
  }

  const missing = missingCredentials(next);
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error:
          `Cannot switch to ${next}: the server environment is missing ` +
          `${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} ` +
          "and redeploy, then switch.",
        missing,
        ...(await state()),
        switched: false,
      },
      { status: 409 },
    );
  }
  if (!dbConfigured() || !(await dbAvailable())) {
    return NextResponse.json(
      {
        error:
          "No database to store the target in, so MINDBODY_TARGET in the " +
          "server environment decides. Set DATABASE_URL to switch from here.",
        ...(await state()),
        switched: false,
      },
      { status: 503 },
    );
  }

  /* Order matters. The sessions go FIRST, while the old target's
   * credentials are still current, so each token is revoked against the
   * site that issued it; only then is the row written. A failed write
   * after that has signed everyone out of a counter that did not move,
   * which costs a sign-in and is the cheap side of the trade. */
  const sessions = await endAllStaffSessions();
  const wrote = await setTargetOverride(next);
  if (!wrote) {
    return NextResponse.json(
      {
        error:
          "The database refused the target setting, so nothing was " +
          "switched. Everyone has been signed out; sign in again.",
        ...(await state()),
        switched: false,
      },
      { status: 503 },
    );
  }
  clearRawCatalog();
  /* T95: and the gift card products, which are a cached read of the same
   * kind and must never be served from the other studio. */
  clearGiftCardProducts();
  clearRequiredFieldsCache();
  /* The one log line, and no token or credential in it. */
  console.log(
    `[target] ${current} -> ${next} by staff=${admin.staffId} ` +
      `(sessions ended: ${sessions.ended}${sessions.tableCleared ? "" : ", table did not answer"})`,
  );
  return NextResponse.json({
    ...(await state()),
    switched: true,
    previous: current,
    sessionsEnded: sessions.ended,
    sessionsTableCleared: sessions.tableCleared,
  });
}
