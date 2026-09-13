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
 * throws. No database, no row and a row that names neither studio all
 * mean "the environment decides", which is exactly the pre-T89
 * behaviour; a store that does not ANSWER is different and keeps what is
 * loaded, because "the database is down" is not a switch (see
 * ensureTarget), and a stored target whose credentials this environment
 * does not carry is ignored with a loud line (see usableTarget).
 *
 * The override is one string in app_settings, which the T29 charter
 * admits: Mindbody has no home for "which Mindbody is this counter
 * talking to".
 */

import { dbConfigured, readSetting, setSetting } from "./db";
import { missingCredentials, type Target } from "./mindbody";

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
 * once at a time. Never throws and never rejects: a store that does not
 * answer (no pool, an error, or slower than READ_WAIT_MS) leaves the
 * override as it was, so a database that stops answering cannot flip a
 * live counter to the environment's target mid-shift, and one that was
 * never configured leaves the environment in charge. Only a read the
 * store ANSWERED changes anything.
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
    const answer = await Promise.race([
      readSetting(TARGET_SETTING_KEY),
      new Promise<{ answered: false; value: null }>((resolve) =>
        setTimeout(() => resolve({ answered: false, value: null }), READ_WAIT_MS),
      ),
    ]).catch(() => ({ answered: false as const, value: null }));
    /* The row is retried on the next call either way, so the clock is
     * stamped before anything else: a store that has stopped answering
     * must cost one bounded wait every REFRESH_MS and not one per call. */
    state.loadedAt = Date.now();
    if (!answer.answered) {
      /* T89 review: a read that did not ANSWER is not "no override".
       * Treating it as one flips the counter to whatever MINDBODY_TARGET
       * names, and on the deployed service that is prod: a database blip
       * would have moved a counter deliberately switched to the sandbox
       * onto the real studio, mid-shift, with the banner following it
       * rather than warning about it. Keep what is loaded and say so. */
      if (state.override !== null) warnUnread(state.override);
      return;
    }
    /* An answered read is the truth: no row, or a row that says anything
     * but sandbox or prod, means the environment decides -- the T29
     * fallback rule, and the only way back off a stored target. */
    state.override = usableTarget(parseTarget(answer.value));
  })().catch(() => undefined);
  state.reading = read.finally(() => {
    state.reading = null;
  });
  return state.reading;
}

/* Complained about at most once a minute: a counter whose database has
 * gone quiet must say so in the log without filling it. */
let warnedUnreadAt = 0;

function warnUnread(keeping: Target): void {
  const now = Date.now();
  if (now - warnedUnreadAt < 60_000) return;
  warnedUnreadAt = now;
  console.warn(
    `[target] the stored target could not be read; staying on ${keeping}. ` +
      "The environment's MINDBODY_TARGET is NOT taking over: a store that " +
      "does not answer is not a switch.",
  );
}

/* Likewise for a stored target the environment cannot serve. */
let warnedUnusable: Target | null = null;

/**
 * T89 review: a stored target whose credential set is not in this
 * environment (the row says prod on a deployment that only carries the
 * sandbox variables, or a sandbox row after the sandbox key was removed)
 * is ignored, loudly, and the environment decides. Honouring it instead
 * makes every Mindbody call throw "Mindbody is not configured for
 * target", which is a counter that cannot check anyone in at all; and
 * the other direction -- quietly running the environment's target -- is
 * what the log line is for. Names only, never a value.
 */
function usableTarget(stored: Target | null): Target | null {
  if (stored === null) {
    warnedUnusable = null;
    return null;
  }
  const missing = missingCredentials(stored);
  if (missing.length === 0) {
    warnedUnusable = null;
    return stored;
  }
  if (warnedUnusable !== stored) {
    warnedUnusable = stored;
    console.error(
      `[target] the stored target "${stored}" is IGNORED: the server ` +
        `environment is missing ${missing.join(", ")}. MINDBODY_TARGET ` +
        "decides until they are set.",
    );
  }
  return null;
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

/**
 * Who may switch the target (Pete, after the design: only named admin
 * staff, and for everybody else the switch does not exist).
 *
 * `POS_ADMIN_STAFF_IDS` is a comma-separated list of Mindbody staff ids,
 * in the server environment where a browser cannot reach it. EMPTY MEANS
 * NOBODY: an unset variable is not "everyone is an admin", because the
 * one thing worse than a switch nobody can reach is a switch every
 * teacher can. The drawer hides the block for anyone not on the list and
 * the route refuses them, so the guard is not the hiding.
 */
export function adminStaffIds(): Set<string> {
  return new Set(
    (process.env["POS_ADMIN_STAFF_IDS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Whether a staff id may switch the target. False for null (nobody
 *  signed in) and false when the list is empty. */
export function isTargetAdmin(staffId: number | string | null): boolean {
  if (staffId === null) return false;
  return adminStaffIds().has(String(staffId));
}
