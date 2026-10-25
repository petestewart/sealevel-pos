/**
 * The one way the Mindbody target moves (T89's switch, shared since T212).
 *
 * Two doors lead here and both need a NAMED ADMIN (`POS_ADMIN_STAFF_IDS`)
 * who proved it with a Mindbody password:
 *
 * - the drawer's Settings tab (`PUT /api/admin/target`), for an admin
 *   already signed in to the studio the counter is on;
 * - the sign-in gate's studio choice (`POST /api/teacher/signin` with a
 *   `target`), for an admin signing in to the OTHER studio. Pete: "you
 *   cannot get to the settings to change between prod and sandbox
 *   without being logged in". A staff login belongs to one site, so a
 *   counter on the studio you cannot sign in to had no way back but an
 *   edit to the environment and a restart. Signing in to the destination
 *   is the same proof the drawer asks for, made where it can be made.
 *
 * Either way the switch itself is this function and nothing else, so the
 * order below (sessions ended while the old credentials are current, then
 * the row, then every cache of the other studio) cannot drift between
 * the two. Dry run and the write guard are not touched by either.
 */

import { clearRawCatalog } from "./catalog";
import { clearRequiredFieldsCache } from "./clients";
import { dbAvailable, dbConfigured } from "./db";
import { clearGiftCardProducts } from "./giftcardsale";
import { missingCredentials, target, type Target } from "./mindbody";
import { endAllStaffSessions } from "./staffsession";
import { setTargetOverride } from "./target";

/**
 * Why the counter cannot be switched to `next` from here, as a sentence
 * and a status, or null when it can. Checked BEFORE anything moves: a
 * missing credential set is named by variable, never by value, and no
 * database means MINDBODY_TARGET decides.
 */
export async function switchBlocker(
  next: Target,
): Promise<{ status: number; error: string; missing?: string[] } | null> {
  const missing = missingCredentials(next);
  if (missing.length > 0) {
    return {
      status: 409,
      error:
        `Cannot switch to ${next}: the server environment is missing ` +
        `${missing.join(", ")}. Set ${missing.length > 1 ? "them" : "it"} ` +
        "and redeploy, then switch.",
      missing,
    };
  }
  if (!dbConfigured() || !(await dbAvailable())) {
    return {
      status: 503,
      error:
        "No database to store the target in, so MINDBODY_TARGET in the " +
        "server environment decides. Set DATABASE_URL to switch from here.",
    };
  }
  return null;
}

/**
 * Moves the counter to `next`. The caller has already checked the admin
 * and `switchBlocker`. Ends every staff session FIRST, while the old
 * target's credentials are still current, so each token is revoked
 * against the site that issued it; only then is the row written. A
 * failed write after that has signed everyone out of a counter that did
 * not move, which costs a sign-in and is the cheap side of the trade.
 */
export async function switchTarget(
  next: Target,
  staffId: number,
  via: "drawer" | "sign-in",
): Promise<
  | {
      ok: true;
      previous: Target;
      sessionsEnded: number;
      sessionsTableCleared: boolean;
    }
  | { ok: false; status: number; error: string }
> {
  const previous = target();
  const sessions = await endAllStaffSessions();
  const wrote = await setTargetOverride(next);
  if (!wrote) {
    return {
      ok: false,
      status: 503,
      error:
        "The database refused the target setting, so nothing was " +
        "switched. Everyone has been signed out; sign in again.",
    };
  }
  clearRawCatalog();
  /* T95: and the gift card products, which are a cached read of the same
   * kind and must never be served from the other studio. */
  clearGiftCardProducts();
  clearRequiredFieldsCache();
  /* The one log line, and no token or credential in it. */
  console.log(
    `[target] ${previous} -> ${next} by staff=${staffId} via ${via} ` +
      `(sessions ended: ${sessions.ended}${sessions.tableCleared ? "" : ", table did not answer"})`,
  );
  return {
    ok: true,
    previous,
    sessionsEnded: sessions.ended,
    sessionsTableCleared: sessions.tableCleared,
  };
}
