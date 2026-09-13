import { NextResponse } from "next/server";

import { requireActor } from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { clearRawCatalog } from "@/lib/catalog";
import { dbAvailable, dbConfigured, storageMode } from "@/lib/db";
import {
  isDryRun,
  missingCredentials,
  siteIdFor,
  target,
  type Target,
} from "@/lib/mindbody";
import { endAllStaffSessions } from "@/lib/staffsession";
import { ensureTarget, setTargetOverride, targetSource } from "@/lib/target";

export const dynamic = "force-dynamic";

/**
 * T89: the Mindbody target, switchable at the counter instead of by a
 * redeploy. Pete asked for it and, told that it relaxes the rail keeping
 * write-reaching decisions out of the drawer, said "go".
 *
 * What guards it, all four at once:
 *
 * - the device session (requireSession), like every admin route here;
 * - the devtools gate, so this 404s on a counter iPad exactly as
 *   /api/devlog does. A teacher cannot reach it at all;
 * - a signed-in teacher (requireActor), so the switch is somebody's, and
 *   logged as `[target] prod -> sandbox by staff=<id>`;
 * - BOTH credential sets present in the server environment. A switch to
 *   a target whose variables are missing is refused with 409 and the
 *   NAMES of what to set, never a value.
 *
 * What it deliberately does NOT touch: dry run and the write guard. They
 * stay in the server environment, so switching to prod lands in dry run
 * unless POS_DRY_RUN=false was deployed, and the write guard still
 * suppresses writes for anyone not on its list. A panel that could turn
 * dry run off would defeat the point of dry run.
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
  return {
    target: current,
    targetSource: targetSource(),
    siteId: siteIdFor(current),
    dryRun: isDryRun(),
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

export async function GET(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  return NextResponse.json(await state());
}

export async function PUT(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  /* A switch is somebody's: the 401 here is the same `reason: "staff"`
   * every write route answers, so the browser shows the sign-in gate. */
  const actor = await requireActor(request);
  if (actor.denied) return actor.denied;

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
  /* The one log line, and no token or credential in it. */
  console.log(
    `[target] ${current} -> ${next} by staff=${actor.session.staffId} ` +
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
