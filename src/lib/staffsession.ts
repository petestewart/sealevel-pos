import { createHmac, randomBytes } from "node:crypto";

import { cookieValue, safeEqual } from "./auth";
import {
  boundedDb,
  dbConfigured,
  deleteStaffSession,
  findStaffSession,
  insertStaffSession,
  sweepStaffSessions,
} from "./db";
import { revokeStaffToken, type Actor } from "./mindbody";
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
  lastTableSweep: number;
}
const G = globalThis as typeof globalThis & { __posStaff?: StaffState };
const state: StaffState = (G.__posStaff ??= {
  sessions: new Map(),
  processKey: randomBytes(32),
  modeLogged: false,
  insertFailLogged: false,
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
  for (const [id, s] of state.sessions) {
    if (now - s.issuedAt >= STAFF_TTL_MS) {
      state.sessions.delete(id);
      void revokeStaffToken(s.token);
      if (p.mode === "postgres") void deleteStaffSession(id);
    }
  }
  if (p.mode !== "postgres") return;
  if (now - state.lastTableSweep < TABLE_SWEEP_EVERY_MS) return;
  state.lastTableSweep = now;
  void sweepStaffSessions(new Date(now)).then((encs) => {
    for (const enc of encs ?? []) {
      const token = decryptStaffToken(enc, p.tokenKey);
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
): Promise<string> {
  logModeOnce();
  const p = persistence();
  sweep(now, p);
  const id = randomBytes(24).toString("base64url");
  state.sessions.set(id, {
    id,
    staffId: staff.id,
    name: staff.name,
    token,
    issuedAt: now,
  });
  if (p.mode === "postgres") {
    const landed = await insertStaffSession({
      id,
      staffId: String(staff.id),
      name: staff.name,
      tokenEnc: encryptStaffToken(token, p.tokenKey),
      issuedAt: new Date(now),
      expiresAt: new Date(now + STAFF_TTL_MS),
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
  const hit = state.sessions.get(id);
  if (hit) return hit;
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
  if (token === null) return null;
  const staffId = Number(row.staffId);
  if (!Number.isInteger(staffId) || staffId <= 0) return null;
  const session: StaffSession = {
    id,
    staffId,
    name: row.name,
    token,
    issuedAt,
  };
  state.sessions.set(id, session);
  return session;
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
