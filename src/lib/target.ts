/**
 * T89: which studio the counter is pointed at, as a SETTING and not only
 * as an environment variable. Pete: "we also should make it so that it
 * can flip between sandbox and prod with a setting rather than a
 * redeploy", and, once told this relaxes the rail that kept every
 * write-reaching decision out of the drawer: "go".
 *
 * What is relaxed and what is not. The target moves into `app_settings`
 * and is switchable from the dev drawer, behind the device session, a
 * signed-in teacher and the devtools gate, and only when BOTH credential
 * sets are present in the environment. Dry run and the write guard stay
 * exactly where they were, in the server environment where a browser
 * cannot reach them: a panel that could switch dry run off would defeat
 * the point of dry run, and switching target to prod still lands in dry
 * run unless POS_DRY_RUN=false was deployed.
 *
 * Mechanics. `target()` in mindbody.ts stays SYNCHRONOUS -- it is called
 * from isDryRun(), from the catalog cache key and from a dozen reads --
 * so the row is loaded into memory ahead of it: `ensureTarget()` at the
 * top of `mindbody()` reads the row at most once every REFRESH_MS and
 * every Mindbody call goes through mindbody(), so a switch made on one
 * iPad (or in another server process) is picked up within five seconds
 * without a request ever waiting on the database twice. Nothing here
 * throws: no database, no row, an unreadable row or a store that does
 * not answer all mean "the environment decides", which is exactly the
 * pre-T89 behaviour.
 *
 * The override is one string in app_settings, which the T29 charter
 * admits: Mindbody has no home for "which Mindbody is this counter
 * talking to".
 */

import { dbConfigured, getSetting, setSetting } from "./db";
import type { Target } from "./mindbody";

/** The app_settings key. */
export const TARGET_SETTING_KEY = "mindbody_target";

/**
 * How long a loaded override is trusted before the row is read again. Five
 * seconds: long enough that a burst of calls behind one screen costs one
 * local read, short enough that a teacher who switches on the drawer sees
 * every other iPad follow within a breath.
 */
const REFRESH_MS = 5_000;

/**
 * How long a read of the row may take before the request gives up on it
 * and uses what it already has. A counter request must never hang on a
 * dead database (the T62 review measured 5s for the connect timeout
 * alone), and this one sits in front of EVERY Mindbody call.
 */
const READ_WAIT_MS = 1_500;

/** How long after a switch the sign-in gate explains itself. */
const NOTICE_MS = 10 * 60 * 1000;

interface TargetState {
  /** The loaded override, or null for "the environment decides". */
  override: Target | null;
  /** When the row was last read, 0 for never. */
  loadedAt: number;
  /** The in-flight read, so a burst shares one. */
  reading: Promise<void> | null;
  /** T89: what the sign-in gate says after a switch, and until when. */
  notice: { text: string; until: number } | null;
}

/* On globalThis like the call log and the staff sessions: a dev recompile
 * must not silently drop the override back to the environment. */
const G = globalThis as typeof globalThis & { __posTarget?: TargetState };
const state: TargetState = (G.__posTarget ??= {
  override: null,
  loadedAt: 0,
  reading: null,
  notice: null,
});

function parseTarget(raw: string | null): Target | null {
  if (raw === "sandbox" || raw === "prod") return raw;
  return null;
}

/** The loaded override, synchronously. Null means the environment. */
export function targetOverride(): Target | null {
  return state.override;
}

/** What /api/config reports as `targetSource`. */
export function targetSource(): "env" | "setting" {
  return state.override === null ? "env" : "setting";
}

/**
 * Loads the row into memory, at most once every REFRESH_MS and at most
 * once at a time. Never throws and never rejects: every failure leaves
 * the override as it was, so a database that stops answering does not
 * flip a live counter back to the environment's target mid-shift, and one
 * that was never configured leaves the environment in charge.
 */
export async function ensureTarget(now = Date.now()): Promise<void> {
  if (!dbConfigured()) {
    /* No database, no override, ever. Cheapest and most honest path. */
    state.override = null;
    return;
  }
  if (state.reading) return state.reading;
  if (now - state.loadedAt < REFRESH_MS) return;
  const read = (async () => {
    const raw = await Promise.race([
      getSetting(TARGET_SETTING_KEY),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), READ_WAIT_MS),
      ),
    ]).catch(() => null);
    /* A null is "unset, unavailable or too slow" and getSetting cannot
     * tell those apart either, so every null reads as "no override" and
     * the environment decides -- the T29 fallback rule, applied here in
     * the safe direction: the environment's own default is sandbox, so a
     * database that stops answering can only ever move this counter
     * AWAY from the real studio, never towards it. A row that says
     * anything but sandbox or prod is no override either. */
    state.override = parseTarget(raw);
    state.loadedAt = Date.now();
  })().catch(() => undefined);
  state.reading = read.finally(() => {
    state.reading = null;
  });
  return state.reading;
}

/**
 * Writes the row and the memory together, and records the notice the
 * sign-in gate shows. False means the store refused it, in which case
 * nothing changed: the caller must not report a switch.
 */
export async function setTargetOverride(next: Target): Promise<boolean> {
  const wrote = await setSetting(TARGET_SETTING_KEY, next);
  if (!wrote) return false;
  state.override = next;
  state.loadedAt = Date.now();
  state.notice = {
    text: `The studio target changed to ${next}. Sign in again.`,
    until: Date.now() + NOTICE_MS,
  };
  return true;
}

/**
 * The line the sign-in gate shows for a while after a switch, so a
 * teacher whose session just ended under them reads why rather than
 * guessing. Null once it has expired, and cleared by the next sign-in.
 */
export function targetSwitchNotice(now = Date.now()): string | null {
  const notice = state.notice;
  if (notice === null) return null;
  if (now >= notice.until) {
    state.notice = null;
    return null;
  }
  return notice.text;
}

/** Called when a teacher signs in: the switch has been explained. */
export function clearTargetSwitchNotice(): void {
  state.notice = null;
}
