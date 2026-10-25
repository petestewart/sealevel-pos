import { createHmac, randomBytes } from "node:crypto";

import { cookieValue, safeEqual } from "./auth";
import {
  boundedDb,
  dbConfigured,
  deleteAllStaffSessions,
  deleteStaffSession,
  findServiceStaffSession,
  findStaffSession,
  insertStaffSession,
  sweepStaffSessions,
} from "./db";
import { currentSiteId, revokeStaffToken, type Actor } from "./mindbody";
import {
  clearTargetSwitchNotice,
  ensureTarget,
  setSignInNotice,
} from "./target";
import {
  STAFF_COOKIE_KEY_LABEL,
  STAFF_TOKEN_KEY_LABEL,
  decryptStaffToken,
  deriveStaffKey,
  encryptStaffToken,
} from "./staffcrypto";

export type { Actor };

/**
 * The staff session (T49). Pete: "Mindbody sign-in might be the right
 * move then. today that's what they already do, and this probably makes
 * observability better, assuming MB tracks who made sales, etc."
 *
 * A teacher signs in with their own Mindbody login once per shift, and
 * from then on every write this app makes runs UNDER THEIR TOKEN, so
 * Mindbody's own records name them: check-ins, bookings, pass changes,
 * the waiver, sales, the comp's Formula Note. The comp PIN gate (T48)
 * stays on top as deliberate friction; nothing else asks anything.
 *
 * What lives where, and why:
 *
 * - The Mindbody AccessToken lives in server memory, the Map below, and
 *   since T78 ALSO in the staff_sessions table, encrypted under a key
 *   derived from POS_SESSION_SECRET (src/lib/staffcrypto.ts), so a
 *   deploy restart no longer signs every teacher out (T77 was the
 *   symptom; Pete: "sessions should survive restarts by living in the
 *   database like the PINs do"). The Map is the hot cache and the
 *   table is the record: a sign-in writes through, a lookup that
 *   misses the Map reads the row back, an end deletes it. Never in the
 *   call log (readable from the dev drawer), never in an answer to the
 *   browser, never in a log line, never in the clear in a row. With no
 *   POS_SESSION_SECRET, no DATABASE_URL, or a database that does not
 *   answer, sessions are memory only exactly as before T78 and a
 *   restart costs one sign-in; a dead database is never an outage (the
 *   T29 charter).
 * - The browser holds `pos_staff`, an opaque random id signed with the
 *   staff cookie key: HttpOnly, SameSite=Strict, Secure on https, two
 *   hours. The id names a Map entry (or its row) and nothing else;
 *   knowing it without the key is worthless. With POS_SESSION_SECRET
 *   set the key is derived from it, so a cookie signed before a restart
 *   still names its persisted row afterwards; without the secret the
 *   key is random per process, since the sessions it would name are
 *   per process too. The device session (T21) is a separate cookie and
 *   a separate question: the device says the iPad is the studio's,
 *   this says which teacher is at it.
 * - Two hours from sign-in (T64), not sliding: a login left on the iPad
 *   should not still be acting for the next teacher's class. Expiry
 *   drops the entry and the row and revokes the token, best effort,
 *   like sign-out.
 *
 * The Map lives on globalThis like the call log (ddcface): a dev
 * recompile must not sign every teacher out.
 */

export interface StaffSession {
  /** The opaque session id, the Map key and the row's id. Never the token. */
  id: string;
  staffId: number;
  name: string;
  /** The Mindbody staff user token issued for this teacher. */
  token: string;
  issuedAt: number;
  /** Opened with the SERVICE ACCOUNT's own login (the sandbox's only
   *  login; Pete testing on the counter). Its token may be borrowed for
   *  the app's reads when Mindbody refuses to issue a second one. */
  isService: boolean;
  /**
   * T210: the Mindbody site id this token was issued for, read from the
   * target at the moment of the sign-in and never from the target as it
   * is now. A staff token belongs to the site that issued it: used
   * against the other one, Mindbody answers "Delegated staff does not
   * belong to the subscriber." and every write under it is refused.
   * Null is UNKNOWN (a row written before migration 16, or a session
   * seeded by a test harness); unknown is never borrowed as the service
   * token and never restored from a row.
   */
  siteId: string | null;
}

const COOKIE_NAME = "pos_staff";
/* T64 (Pete, 2026-09-04): two hours, down from twelve. Long enough for
 * a class and its counter time, short enough that a login left on the
 * iPad does not act for the next teacher. A schedule-timed expiry may
 * replace the fixed number later. */
const STAFF_TTL_MS = 2 * 60 * 60 * 1000;
const COOKIE_PREFIX = "s1";
/** How often the TABLE is swept for expired rows (the Map is swept on
 *  every lookup, which costs nothing). Rows the Map knows are deleted
 *  as their entries expire; this catches the ones written before a
 *  restart. */
const TABLE_SWEEP_EVERY_MS = 60 * 1000;
/** How long a lookup or an end waits for the TABLE (T78 review). A Map
 *  hit never touches it; a miss does, and requireActor sits on every
 *  write route, so a black-holed database (the T62 review measured 5s
 *  for the connect timeout alone, once per 30s cooldown) must not hold
 *  a check-in for that. Past this the row reads as absent (a sign-in
 *  again, which then lives in memory) and the attempt runs on, so a
 *  slow store still sets the cooldown and a slow delete still lands. */
const TABLE_WAIT_MS = 2_000;

interface StaffState {
  sessions: Map<string, StaffSession>;
  /** The per-process cookie signing key, used when there is no
   *  POS_SESSION_SECRET to derive one from. */
  processKey: Buffer;
  /** The mode line has been logged this process. */
  modeLogged: boolean;
  /** "Row not written" has been logged this process. */
  insertFailLogged: boolean;
  /** T210: "a session for another site was skipped" has been logged this
   *  process, so a counter whose rows all belong elsewhere says so once
   *  rather than on every request. */
  foreignSiteLogged: boolean;
  /** T210 review: session ids already refused as another site's, so a
   *  browser polling with a stale cookie re-arms the gate notice ONCE
   *  and not after every later sign-in cleared it. Bounded. */
  foreignRefused: Set<string>;
  lastTableSweep: number;
}
const G = globalThis as typeof globalThis & { __posStaff?: StaffState };
const state: StaffState = (G.__posStaff ??= {
  sessions: new Map(),
  processKey: randomBytes(32),
  modeLogged: false,
  insertFailLogged: false,
  foreignSiteLogged: false,
  foreignRefused: new Set<string>(),
  lastTableSweep: 0,
});

/* --- Keys and mode --------------------------------------------------- */

function sessionSecret(): string {
  return (process.env.POS_SESSION_SECRET ?? "").trim();
}

/** Derived keys, cached per secret so an env change mid-process (dev)
 *  rotates them. */
let derived: { secret: string; cookie: Buffer; token: Buffer } | null = null;
function derivedKeys(secret: string): { cookie: Buffer; token: Buffer } {
  if (derived && derived.secret === secret) return derived;
  derived = {
    secret,
    cookie: deriveStaffKey(secret, STAFF_COOKIE_KEY_LABEL),
    token: deriveStaffKey(secret, STAFF_TOKEN_KEY_LABEL),
  };
  return derived;
}

function cookieKey(): Buffer {
  const secret = sessionSecret();
  return secret.length > 0 ? derivedKeys(secret).cookie : state.processKey;
}

type Persistence =
  | { mode: "postgres"; tokenKey: Buffer }
  | { mode: "memory"; reason: string };

/** Whether sessions are written through to the table. Configuration
 *  only: whether the database ANSWERS is found out per call, and a
 *  failure there is memory-only for that session, logged once. */
function persistence(): Persistence {
  const secret = sessionSecret();
  if (secret.length === 0) {
    return { mode: "memory", reason: "no POS_SESSION_SECRET" };
  }
  if (!dbConfigured()) return { mode: "memory", reason: "no DATABASE_URL" };
  return { mode: "postgres", tokenKey: derivedKeys(secret).token };
}

/** What /api/config reports as `staffSessions`. */
export function staffSessionStorage(): string {
  const p = persistence();
  return p.mode === "postgres" ? "postgres" : `memory (${p.reason})`;
}

/** The mode, once per process, at first use. Never a token. */
function logModeOnce(): void {
  if (state.modeLogged) return;
  state.modeLogged = true;
  const p = persistence();
  console.log(
    p.mode === "postgres"
      ? "[staff-session] persisting to postgres"
      : `[staff-session] memory only: ${p.reason}`,
  );
}

function sign(id: string): string {
  return createHmac("sha256", cookieKey()).update(id).digest("hex");
}

/* --- Expiry ---------------------------------------------------------- */

/** Drops every Map entry past its two hours, revoking each token and
 *  deleting its row in the background. Called on every lookup; the Map
 *  holds at most a studio's worth of teachers, so the sweep is nothing.
 *  Every TABLE_SWEEP_EVERY_MS the table is swept too, for rows written
 *  before a restart that no Map entry stands for; their tokens are
 *  revoked as well, best effort. */
function sweep(now: number, p: Persistence): void {
  const deletes: Promise<boolean>[] = [];
  for (const [id, s] of state.sessions) {
    if (now - s.issuedAt >= STAFF_TTL_MS) {
      state.sessions.delete(id);
      void revokeStaffToken(s.token);
      if (p.mode === "postgres") deletes.push(deleteStaffSession(id));
    }
  }
  if (p.mode !== "postgres") return;
  if (now - state.lastTableSweep < TABLE_SWEEP_EVERY_MS) return;
  state.lastTableSweep = now;
  /* After the Map loop's deletes have settled (T78 review): run at the
   * same time, the table's DELETE RETURNING could hand back a row the
   * loop had just revoked, and revoke it twice. Each swept token is
   * revoked once. */
  const tokenKey = p.tokenKey;
  void Promise.allSettled(deletes)
    .then(() => sweepStaffSessions(new Date(now)))
    .then((encs) => {
      for (const enc of encs ?? []) {
        const token = decryptStaffToken(enc, tokenKey);
        if (token !== null) void revokeStaffToken(token);
      }
    });
}

/* --- The session ----------------------------------------------------- */

/** Starts a session for a teacher whose Mindbody sign-in just succeeded.
 *  The entry goes in the Map, and the row (token encrypted) is written
 *  through when persistence is on: best effort, awaited so the row is
 *  there by the time the browser holds the cookie, and a failed insert
 *  leaves the session in memory only, logged once. Answers the cookie
 *  VALUE (`s1.<id>.<hmac>`); the route wraps it in Set-Cookie. */
export async function createStaffSession(
  staff: { id: number; name: string },
  token: string,
  now = Date.now(),
  isService = false,
  /* T210: the site the token was issued FOR, which the sign-in route
   * takes from the same env it signed in against rather than from
   * target() as it reads now. Null only where the site is genuinely
   * unknown (an unconfigured environment), which is never borrowed and
   * never restored. */
  siteId: string | null,
): Promise<string> {
  logModeOnce();
  /* T89: somebody has signed in, so the "the target changed, sign in
   * again" line on the gate has done its job. */
  clearTargetSwitchNotice();
  const p = persistence();
  sweep(now, p);
  const id = randomBytes(24).toString("base64url");
  state.sessions.set(id, {
    id,
    staffId: staff.id,
    name: staff.name,
    token,
    issuedAt: now,
    isService,
    siteId,
  });
  if (p.mode === "postgres") {
    const landed = await insertStaffSession({
      id,
      staffId: String(staff.id),
      name: staff.name,
      tokenEnc: encryptStaffToken(token, p.tokenKey),
      issuedAt: new Date(now),
      expiresAt: new Date(now + STAFF_TTL_MS),
      isService,
      siteId,
    });
    if (!landed && !state.insertFailLogged) {
      state.insertFailLogged = true;
      console.warn(
        "[staff-session] row not written (see the [db] line); this session is memory only",
      );
    }
  }
  return `${COOKIE_PREFIX}.${id}.${sign(id)}`;
}

/** The session a request's `pos_staff` cookie names, when the cookie is
 *  validly signed (constant-time) and the entry is still here and inside
 *  its two hours; else null. A Map miss with a valid cookie reads the
 *  row (T78): decrypted and inside its two hours it comes back into the
 *  Map, which is how a sign-in outlives a restart; anything else about
 *  the row (missing, expired, undecryptable, store not answering) is
 *  null, the same as no row. Null is the normal, working state of a
 *  counter with nobody signed in: every write route then refuses (T50). */
export async function staffSessionFrom(
  request: Request,
  now = Date.now(),
): Promise<StaffSession | null> {
  const raw = cookieValue(request, COOKIE_NAME);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [prefix, id, sig] = parts;
  if (prefix !== COOKIE_PREFIX || !id || !sig) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!safeEqual(sig, sign(id))) return null;
  logModeOnce();
  const p = persistence();
  sweep(now, p);
  /* T210 review: the site is read from the target, and at the top of a
   * fresh process the STORED target (T89) has not been loaded yet, so
   * target() still answers whatever MINDBODY_TARGET names. A counter
   * switched from the drawer and then restarted would therefore compare
   * every session against the wrong site for the first request that
   * beats /api/config to it, and drop a session that fits the site it
   * was issued for. Bounded, never throws, a no-op without a database,
   * and at most one local read every five seconds -- the same call
   * mindbody() makes before every Mindbody call. */
  await ensureTarget();
  const site = currentSiteId();
  const hit = state.sessions.get(id);
  if (hit) {
    /* T210: a session held in memory from before this process was
     * pointed somewhere else. The drawer's switch ends every session
     * (T89), but MINDBODY_TARGET changing across a restart never ran
     * that, and neither does an env change under a dev server. A token
     * issued for the other site cannot write here, so the session is
     * dropped and the gate says why rather than letting the first write
     * of the shift come back in Mindbody's words. */
    if (!sessionFitsSite(hit, site)) {
      state.sessions.delete(id);
      /* Not revoked: the token is the other site's to expire, and a
       * revoke aimed at this site would be one more call Mindbody
       * refuses for the same reason. */
      return null;
    }
    return hit;
  }
  if (p.mode !== "postgres") return null;
  const row = await boundedDb(
    findStaffSession(id, new Date(now)),
    TABLE_WAIT_MS,
    null,
  );
  if (!row) return null;
  const issuedAt = row.issuedAt.getTime();
  if (now - issuedAt >= STAFF_TTL_MS) return null;
  const token = decryptStaffToken(row.tokenEnc, p.tokenKey);
  const staffId = Number(row.staffId);
  if (token === null || !Number.isInteger(staffId) || staffId <= 0) {
    /* A row this key cannot read, or one naming no staff member, is
     * nothing anyone can sign in from (the cookie verified, so the key
     * is the one that wrote it; the row is damaged). Left alone it
     * would be re-read on every request until it expired (T78
     * review); dropped, the next lookup is a plain miss. Its token
     * cannot be revoked, since it cannot be read; it expires on
     * Mindbody's side. */
    void deleteStaffSession(id);
    return null;
  }
  const session: StaffSession = {
    id,
    staffId,
    name: row.name,
    token,
    issuedAt,
    isService: row.isService,
    siteId: row.siteId,
  };
  /* T210: a restored row whose token was issued for another site is NOT
   * restored, and neither is one that records no site at all -- every
   * row written before migration 16, which is exactly the population
   * that could be either studio's. The row is left alone rather than
   * deleted: it may be a live session of the other counter, and this
   * process simply cannot use it. */
  if (site !== null && (session.siteId === null || session.siteId !== site)) {
    if (!state.foreignSiteLogged) {
      state.foreignSiteLogged = true;
      console.warn(
        `[staff-session] not restoring a session row issued for site ` +
          `${session.siteId ?? "(none recorded)"}: this counter is on site ` +
          `${site}. A staff token belongs to the site that issued it. ` +
          "Sign in again.",
      );
    }
    noteForeignRefusal(id);
    return null;
  }
  state.sessions.set(id, session);
  return session;
}

/**
 * T210: whether a session's token belongs to the site this process is
 * talking to.
 *
 * Three answers, and the middle one is the one worth reading. A session
 * naming THIS site is used. A session naming ANOTHER site is dropped:
 * its token cannot write here, and riding it is what put Mindbody's
 * "Delegated staff does not belong to the subscriber." in front of
 * Pete. A session naming NO site is unknown, and unknown is treated
 * differently in the two places it can come from: a persisted ROW is
 * never restored (see staffSessionFrom, which is what makes the deploy
 * of migration 16 cost one sign-in), while an entry already in MEMORY
 * is let through, because the only way to hold one is a process whose
 * code changed under it (a dev recompile keeps the Map on globalThis)
 * or a test harness that seeded it, and signing a counter out for that
 * buys nothing. Every real sign-in records its site.
 *
 * An environment with no site id at all (Mindbody not configured)
 * decides nothing and lets the session through: refusing there would be
 * a counter that cannot sign anybody in for a reason that has nothing
 * to do with sites.
 */
function sessionFitsSite(
  session: StaffSession,
  site: string | null,
): boolean {
  if (site === null) return true;
  /* `?? null` and not a plain comparison: an entry seeded by a test
   * harness, or one held in memory across a dev recompile that added
   * this field, has no siteId at all, and undefined means the same
   * thing as null here -- nobody recorded it. */
  const recorded = session.siteId ?? null;
  if (recorded === null) return true;
  if (recorded === site) return true;
  if (!state.foreignSiteLogged) {
    state.foreignSiteLogged = true;
    console.warn(
      `[staff-session] dropped a session issued for site ` +
        `${recorded}: this counter is on site ` +
        `${site}. A staff token belongs to the site that issued it, so ` +
        "it is not used here. Sign in again.",
    );
  }
  noteForeignRefusal(session.id);
  return false;
}

/** Arms the gate's sentence the FIRST time a given session is refused
 *  as another site's; a stale cookie that keeps polling does not re-arm
 *  it after a later sign-in cleared it (T210 review). */
function noteForeignRefusal(sessionId: string): void {
  /* The state lives on globalThis across a dev recompile, so an object
   * built before this field existed has no set yet. */
  state.foreignRefused ??= new Set<string>();
  if (state.foreignRefused.has(sessionId)) return;
  if (state.foreignRefused.size >= 200) state.foreignRefused.clear();
  state.foreignRefused.add(sessionId);
  setSignInNotice(FOREIGN_SITE_NOTICE);
}

/** T210: what the sign-in gate says when a session was dropped, or a
 *  write refused, because the token belongs to another Mindbody site.
 *  The same sentence in both places, since it is the same fact. */
export const FOREIGN_SITE_NOTICE =
  "Your sign-in belongs to a different Mindbody site. Sign in again.";

/**
 * The token of a live session opened with the service account's own
 * login, for `staffToken()` to borrow when Mindbody refuses to ISSUE one
 * (the sandbox, which allows a user one outstanding token: the sign-in
 * holds it, so the app's own issue is refused for as long as that
 * teacher is signed in). Memory first, then the table, so a restart
 * finds it too. Null when there is none, which leaves the refusal to
 * surface as before.
 */
export async function serviceSessionToken(
  siteId: string,
  now = Date.now(),
): Promise<string | null> {
  /* T210: only a session issued FOR THIS SITE. Before this, the newest
   * service session was borrowed whatever site it belonged to and
   * cached under the current target's site id, which is how a counter
   * restarted onto the other studio ended up sending every read and
   * every fallback write under a token that site had never issued
   * ("Delegated staff does not belong to the subscriber."). An unknown
   * site (a row from before migration 16) is not this one. */
  for (const s of state.sessions.values()) {
    if (!s.isService || now - s.issuedAt >= STAFF_TTL_MS) continue;
    if (s.siteId === siteId) return s.token;
  }
  const p = persistence();
  if (p.mode !== "postgres") return null;
  const answer = await boundedDb(
    findServiceStaffSession(siteId, new Date(now)),
    TABLE_WAIT_MS,
    null,
  );
  if (!answer) return null;
  if (answer.skipped.length > 0) {
    console.warn(
      `[staff-session] not borrowing ${answer.skipped.length} service ` +
        `session(s) issued for site ${answer.skipped.join(", ")}: this ` +
        `counter is on site ${siteId}.`,
    );
  }
  const row = answer.row;
  if (!row) return null;
  if (now - row.issuedAt.getTime() >= STAFF_TTL_MS) return null;
  return decryptStaffToken(row.tokenEnc, p.tokenKey);
}

/** Ends a session: the entry and the row go, the token is revoked best
 *  effort (bounded inside revokeStaffToken; a token nobody holds
 *  expires on its own). Sign-out, and the route-level reaction to
 *  Mindbody refusing the token as no longer valid. */
export async function endStaffSession(id: string): Promise<void> {
  const s = state.sessions.get(id);
  if (!s) return;
  state.sessions.delete(id);
  if (persistence().mode === "postgres") {
    await boundedDb(deleteStaffSession(id), TABLE_WAIT_MS, false);
  }
  await revokeStaffToken(s.token);
}

/**
 * Ends EVERY session, everywhere: the Map and the table, revoking each
 * token best effort. T89's target switch is the one caller. A staff
 * token belongs to the site that issued it, so a counter that has just
 * been pointed at the other studio is holding nothing usable; every
 * teacher signs in again, which is also how Mindbody keeps naming the
 * right person for a write.
 *
 * Answers how many sessions this process knew of and whether the table
 * answered, so the route can say so rather than imply a clean sweep.
 * Bounded like every other table touch here: a store that does not
 * answer still leaves this process with nobody signed in.
 */
export async function endAllStaffSessions(): Promise<{
  ended: number;
  tableCleared: boolean;
}> {
  const p = persistence();
  const known = [...state.sessions.values()];
  state.sessions.clear();
  let rows: string[] | null = null;
  if (p.mode === "postgres") {
    rows = await boundedDb(deleteAllStaffSessions(), TABLE_WAIT_MS, null);
  }
  for (const s of known) void revokeStaffToken(s.token);
  /* Rows this process never held an entry for (written before a restart,
   * or by another process): their tokens are revoked too, best effort. */
  if (rows && p.mode === "postgres") {
    const held = new Set(known.map((s) => s.token));
    for (const enc of rows) {
      const token = decryptStaffToken(enc, p.tokenKey);
      if (token !== null && !held.has(token)) void revokeStaffToken(token);
    }
  }
  return {
    ended: known.length,
    tableCleared: p.mode !== "postgres" || rows !== null,
  };
}

/** The Actor a session acts as. */
export function actorOf(session: StaffSession): Actor {
  return { token: session.token, staffId: session.staffId, name: session.name };
}

/** Set-Cookie value for a fresh session. SameSite=Strict, unlike the
 *  device cookie's Lax: nothing legitimately arrives at this app from
 *  another site carrying a teacher's identity. Secure only in production,
 *  for the same http://<lan-ip>:3000 reason as the device cookie. */
export function staffSetCookie(value: string): string {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${Math.floor(STAFF_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

/** Set-Cookie value that clears the staff cookie. */
export function staffClearCookie(): string {
  const attrs = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}
