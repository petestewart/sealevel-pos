import { createHmac, randomBytes } from "node:crypto";

import { cookieValue, safeEqual } from "./auth";
import { revokeStaffToken, type Actor } from "./mindbody";

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
 * - The Mindbody AccessToken lives HERE, in server memory, and nowhere
 *   else: not in the database (the charter, and a token is a credential),
 *   not in the call log (which is readable from the dev drawer), never in
 *   an answer to the browser. A restart forgets every session, and the
 *   cost of that is one sign-in, which the header control offers.
 * - The browser holds `pos_staff`, an opaque random id signed with a
 *   per-process key: HttpOnly, SameSite=Strict, Secure on https, twelve
 *   hours. The id names a Map entry and nothing else; knowing it without
 *   the process's key is worthless, and knowing it WITH the key names an
 *   entry that may already be gone. The device session (T21) is a
 *   separate cookie and a separate question: the device says the iPad is
 *   the studio's, this says which teacher is at it.
 * - Twelve hours from sign-in, not sliding: a shift is not twelve hours,
 *   and a token left signed in overnight should not still be acting the
 *   next morning. Expiry drops the entry and revokes the token, best
 *   effort, like sign-out.
 *
 * The Map lives on globalThis like the call log (ddcface): a dev
 * recompile must not sign every teacher out.
 */

export interface StaffSession {
  /** The opaque session id, the Map key. Never the token. */
  id: string;
  staffId: number;
  name: string;
  /** The Mindbody staff user token issued for this teacher. */
  token: string;
  issuedAt: number;
}

const COOKIE_NAME = "pos_staff";
const STAFF_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_PREFIX = "s1";

interface StaffState {
  sessions: Map<string, StaffSession>;
  /** The per-process cookie signing key. Random on purpose: sessions
   *  are per-process anyway, so a key that survived a restart would
   *  sign cookies for entries that did not. */
  key: Buffer;
}
const G = globalThis as typeof globalThis & { __posStaff?: StaffState };
const state: StaffState = (G.__posStaff ??= {
  sessions: new Map(),
  key: randomBytes(32),
});

function sign(id: string): string {
  return createHmac("sha256", state.key).update(id).digest("hex");
}

/** Drops every session past its twelve hours, revoking each token in
 *  the background. Called on every lookup; the Map holds at most a
 *  studio's worth of teachers, so the sweep is nothing. */
function sweep(now: number): void {
  for (const [id, s] of state.sessions) {
    if (now - s.issuedAt >= STAFF_TTL_MS) {
      state.sessions.delete(id);
      void revokeStaffToken(s.token);
    }
  }
}

/** Starts a session for a teacher whose Mindbody sign-in just succeeded.
 *  Answers the cookie VALUE (`s1.<id>.<hmac>`); the route wraps it in
 *  Set-Cookie. */
export function createStaffSession(
  staff: { id: number; name: string },
  token: string,
  now = Date.now(),
): string {
  sweep(now);
  const id = randomBytes(24).toString("base64url");
  state.sessions.set(id, {
    id,
    staffId: staff.id,
    name: staff.name,
    token,
    issuedAt: now,
  });
  return `${COOKIE_PREFIX}.${id}.${sign(id)}`;
}

/** The session a request's `pos_staff` cookie names, when the cookie is
 *  validly signed (constant-time) and the entry is still here and inside
 *  its twelve hours; else null. Null is the normal, working state of a
 *  counter with nobody signed in: every write then runs as the service
 *  account exactly as before T49. */
export function staffSessionFrom(
  request: Request,
  now = Date.now(),
): StaffSession | null {
  const raw = cookieValue(request, COOKIE_NAME);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [prefix, id, sig] = parts;
  if (prefix !== COOKIE_PREFIX || !id || !sig) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!safeEqual(sig, sign(id))) return null;
  sweep(now);
  return state.sessions.get(id) ?? null;
}

/** Ends a session: the entry goes, the token is revoked best effort
 *  (bounded inside revokeStaffToken; a token nobody holds expires on its
 *  own). Sign-out, and the route-level reaction to Mindbody refusing
 *  the token as no longer valid. */
export async function endStaffSession(id: string): Promise<void> {
  const s = state.sessions.get(id);
  if (!s) return;
  state.sessions.delete(id);
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
