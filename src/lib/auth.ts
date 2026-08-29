import {
  createHash,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { NextResponse } from "next/server";

/**
 * Shared-PIN auth (T21). One PIN for the studio, per the service-account
 * decision (P1); per-teacher identity waits on payroll.
 *
 * POS_PIN unset or empty means auth is DISABLED entirely: every route
 * answers without a session, which is the dev convenience and the behavior
 * the app had before T21. Production must set it; .env.example says so.
 *
 * A correct PIN sets an httpOnly cookie holding an HMAC-signed token. The
 * HMAC key is derived DETERMINISTICALLY from the PIN (scrypt with a fixed
 * app salt), never from per-process randomness: a deploy restart must keep
 * the iPad's session valid mid-shift, while changing the PIN invalidates
 * every outstanding session at once, which is exactly the revocation story
 * a shared PIN can offer.
 */

const COOKIE_NAME = "pos_session";
/** Fixed 30 days. No refresh-on-activity: the iPad unlocks at most once a
 *  month, and a fixed window is easier to reason about than a sliding one. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** App-fixed scrypt salt. Not a secret: its job is domain separation (this
 *  key is for sealevel-pos sessions, nothing else), not defending the PIN
 *  against an attacker who already has the server environment. */
const KEY_SALT = "sealevel-pos/session-key/v1";
const TOKEN_PREFIX = "v1";

/** The PIN as configured right now. Read per call, not cached at import:
 *  tests and dev restarts should see the current environment. */
function configuredPin(): string {
  return (process.env.POS_PIN ?? "").trim();
}

/** Whether the lock exists at all. */
export function authRequired(): boolean {
  return configuredPin().length > 0;
}

/** scrypt is deliberately slow, so the derived key is cached per PIN.
 *  Keyed by the PIN itself so an env change mid-process rotates the key. */
let cachedKey: { pin: string; key: Buffer } | null = null;

function sessionKey(): Buffer {
  /* Optional pepper (T21 review). The key is otherwise derived from the
   * PIN alone with a public salt, so one captured cookie lets an attacker
   * brute-force a 4-6 digit PIN offline in minutes (10k scrypts). A
   * random POS_SESSION_SECRET in the server env makes that offline attack
   * impossible without also having the environment, while keeping both
   * revocation stories: changing the PIN (or the pepper) still
   * invalidates every session. Unset keeps the original derivation. */
  const pepper = (process.env.POS_SESSION_SECRET ?? "").trim();
  const pin = configuredPin();
  const input = pepper.length > 0 ? `${pin}\n${pepper}` : pin;
  if (cachedKey && cachedKey.pin === input) return cachedKey.key;
  const key = scryptSync(input, KEY_SALT, 32);
  cachedKey = { pin: input, key };
  return key;
}

/** Constant-time string equality for secrets. Hashing both sides first
 *  makes the buffers equal-length, which timingSafeEqual requires, and
 *  keeps the comparison length-independent. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Whether an entered PIN is the configured one. Constant-time. */
export function pinMatches(entered: string): boolean {
  const pin = configuredPin();
  if (pin.length === 0) return false;
  return safeEqual(entered, pin);
}

function sign(payload: string): string {
  return createHmac("sha256", sessionKey()).update(payload).digest("hex");
}

/** A fresh session token: `v1.<issued-at ms>.<hmac>`. */
export function issueToken(now = Date.now()): string {
  const payload = `${TOKEN_PREFIX}.${now}`;
  return `${payload}.${sign(payload)}`;
}

/** Whether a presented token is validly signed and inside its 30 days. */
export function verifyToken(token: string, now = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [prefix, issuedAtRaw, sig] = parts;
  if (prefix !== TOKEN_PREFIX || !issuedAtRaw || !sig) return false;
  if (!/^\d{1,15}$/.test(issuedAtRaw)) return false;
  const issuedAt = Number(issuedAtRaw);
  /* Signature first, constant-time; a forged issued-at must not be able to
   * learn anything from expiry short-circuits. */
  if (!safeEqual(sig, sign(`${TOKEN_PREFIX}.${issuedAtRaw}`))) return false;
  if (issuedAt > now + 60_000) return false; /* future-dated: not ours */
  return now - issuedAt < SESSION_TTL_MS;
}

/** Reads the session cookie off a request. */
function tokenFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

/** Whether this request carries a valid session (or auth is disabled). */
export function isAuthenticated(request: Request): boolean {
  if (!authRequired()) return true;
  const token = tokenFromRequest(request);
  return token !== null && verifyToken(token);
}

/**
 * The one guard every API route calls first. Returns null when the request
 * may proceed (valid session, or auth disabled), otherwise the 401 to
 * return as-is. Centralized so a future route cannot get the check subtly
 * wrong; forgetting to CALL it is the remaining risk, and the grep in the
 * ticket review is the answer to that.
 */
export function requireSession(request: Request): NextResponse | null {
  if (isAuthenticated(request)) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** Set-Cookie value that establishes a session. Secure only in production:
 *  the dev/LAN case is http://<lan-ip>:3000, where a Secure cookie would
 *  never be stored and the lock could never open. */
export function sessionSetCookie(token: string): string {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

/** Set-Cookie value that clears the session. */
export function sessionClearCookie(): string {
  const attrs = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

/* --- Login rate limit ------------------------------------------------
 * Modest and in-memory, per process: after 5 straight failures, 30s of
 * lockout. A shared studio PIN is not defending state secrets; the limit
 * exists so a guessing loop is slow and obvious, not to survive restarts
 * or coordinate across instances. */

const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;

const loginState = { failures: 0, lockedUntil: 0 };

/** Milliseconds of lockout remaining, 0 when attempts are allowed. */
export function lockoutRemainingMs(now = Date.now()): number {
  return Math.max(0, loginState.lockedUntil - now);
}

/** Record a failed attempt; starts the lockout on the fifth. */
export function recordLoginFailure(now = Date.now()): void {
  loginState.failures += 1;
  if (loginState.failures >= MAX_FAILURES) {
    loginState.failures = 0;
    loginState.lockedUntil = now + LOCKOUT_MS;
  }
}

/** A success clears the counter. */
export function recordLoginSuccess(): void {
  loginState.failures = 0;
  loginState.lockedUntil = 0;
}

/**
 * Claims one attempt slot, SYNCHRONOUSLY, before the handler does any
 * async work. Returns the lockout remaining (0 = proceed). The claim
 * counts as a failure up front and a success clears it: checking at the
 * top and recording only after `await request.json()` let every
 * concurrently in-flight request pass the check before any of them
 * counted, so a parallel burst got N guesses per window instead of 5.
 */
export function claimLoginAttempt(now = Date.now()): number {
  const remaining = lockoutRemainingMs(now);
  if (remaining > 0) return remaining;
  recordLoginFailure(now);
  return 0;
}
