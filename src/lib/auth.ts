import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { NextResponse } from "next/server";

/**
 * Shared-PIN auth (T21). One PIN for the studio, per the service-account
 * decision (P1). The comp token (T48) sits further down this file: the
 * device session says the iPad is the studio's, the comp token says which
 * teacher just typed their PIN to give a sale away.
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
export function safeEqual(a: string, b: string): boolean {
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
  return cookieValue(request, COOKIE_NAME);
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
 * or coordinate across instances. One counter per door (T44, T48): the
 * device PIN, the comp PIN check and PIN enrollment each have their own,
 * so a teacher fumbling digits in the comp dialog cannot lock the device
 * door, and the reverse. */

const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;

interface AttemptLimiter {
  /** Milliseconds of lockout remaining, 0 when attempts are allowed. */
  remaining(now?: number): number;
  /**
   * Claims one attempt slot, SYNCHRONOUSLY, before the handler does any
   * async work. Returns the lockout remaining (0 = proceed). The claim
   * counts as a failure up front and a success clears it: checking at
   * the top and recording only after `await request.json()` let every
   * concurrently in-flight request pass the check before any of them
   * counted, so a parallel burst got N guesses per window instead of 5.
   */
  claim(now?: number): number;
  /** A success clears the counter. */
  success(): void;
}

function makeLimiter(): AttemptLimiter {
  const state = { failures: 0, lockedUntil: 0 };
  const remaining = (now = Date.now()) => Math.max(0, state.lockedUntil - now);
  return {
    remaining,
    claim(now = Date.now()) {
      const left = remaining(now);
      if (left > 0) return left;
      state.failures += 1;
      if (state.failures >= MAX_FAILURES) {
        state.failures = 0;
        state.lockedUntil = now + LOCKOUT_MS;
      }
      return 0;
    },
    success() {
      state.failures = 0;
      state.lockedUntil = 0;
    },
  };
}

const deviceLimiter = makeLimiter();
const verifyLimiter = makeLimiter();
const enrollLimiter = makeLimiter();

/** Milliseconds of device-login lockout remaining, 0 when allowed. */
export function lockoutRemainingMs(now = Date.now()): number {
  return deviceLimiter.remaining(now);
}

/** A correct device PIN clears the counter. */
export function recordLoginSuccess(): void {
  deviceLimiter.success();
}

/** Claims one device-login attempt; see AttemptLimiter.claim. */
export function claimLoginAttempt(now = Date.now()): number {
  return deviceLimiter.claim(now);
}

/** The comp PIN check's counter (/api/teacher/verify), same rules,
 *  separate state. */
export function claimVerifyAttempt(now = Date.now()): number {
  return verifyLimiter.claim(now);
}

export function recordVerifySuccess(): void {
  verifyLimiter.success();
}

/** PIN enrollment's counter (/api/teacher/enroll): a Mindbody sign-in is
 *  tried per attempt, so a guessing loop here is a guessing loop against
 *  a teacher's Mindbody password and gets the same five-then-30s. */
export function claimEnrollAttempt(now = Date.now()): number {
  return enrollLimiter.claim(now);
}

export function recordEnrollSuccess(): void {
  enrollLimiter.success();
}

/* --- The comp token (T48) ---------------------------------------------
 * T44 named the teacher for a whole shift, from a cookie set at the start
 * of it, and Pete's live test found the gap: with no POS_PIN the prompt
 * could be skipped, and a real comp went to Mindbody with teacher=none.
 * T48 turns it around. Nothing routine asks who is at the counter; a COMP
 * asks, every time, in the dialog itself, and the answer is this token:
 * a one-shot value the verify route signs for the teacher whose PIN
 * matched, which the browser hands straight back on the charge. Ten
 * minutes, enough to finish the dialog and tap Comp, not enough to keep
 * around. /api/checkout refuses a comp without a valid one in every
 * configuration; there is no auth-disabled bypass here, because that
 * bypass is exactly what let the $2 comp through.
 *
 * `c1.<staff id>.<name, base64url>.<issued-at ms>.<hmac>`, the T44 token
 * shape with a new prefix. Nothing in it is secret; the signature is what
 * makes it trustworthy, and the PIN a teacher typed never enters it. */

const COMP_TOKEN_TTL_MS = 10 * 60 * 1000;
const COMP_TOKEN_PREFIX = "c1";

export interface TeacherIdentity {
  id: number;
  name: string;
}

/** The comp token's signing key. With a device PIN or a pepper configured
 *  it is the session key, so a rotation revokes outstanding comp tokens
 *  along with the sessions. With NEITHER set (local dev, auth disabled)
 *  the session key is scrypt of an empty string and a public salt, which
 *  anyone can derive; a token forged with it would be a comp with no PIN
 *  typed, the T48 bug back again. So that case gets a random per-process
 *  key instead: a restart mid-dialog costs one more PIN entry, which the
 *  dialog handles, and nobody outside the process can sign. */
let processKey: Buffer | null = null;
function compTokenKey(): Buffer {
  const pepper = (process.env.POS_SESSION_SECRET ?? "").trim();
  if (configuredPin().length > 0 || pepper.length > 0) return sessionKey();
  if (processKey === null) processKey = randomBytes(32);
  return processKey;
}

function signComp(payload: string): string {
  return createHmac("sha256", compTokenKey()).update(payload).digest("hex");
}

/** A fresh comp token for a teacher whose PIN just matched. */
export function issueCompToken(
  teacher: TeacherIdentity,
  now = Date.now(),
): string {
  const name = Buffer.from(teacher.name, "utf8").toString("base64url");
  const payload = `${COMP_TOKEN_PREFIX}.${teacher.id}.${name}.${now}`;
  return `${payload}.${signComp(payload)}`;
}

/** The teacher a presented comp token names, when validly signed and
 *  inside its ten minutes; else null. */
export function verifyCompToken(
  token: string,
  now = Date.now(),
): TeacherIdentity | null {
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [prefix, idRaw, nameRaw, issuedAtRaw, sig] = parts;
  if (prefix !== COMP_TOKEN_PREFIX || !idRaw || !issuedAtRaw || !sig) {
    return null;
  }
  if (!/^\d{1,12}$/.test(idRaw) || !/^\d{1,15}$/.test(issuedAtRaw)) return null;
  if (!/^[A-Za-z0-9_-]*$/.test(nameRaw ?? "")) return null;
  /* Signature first, constant-time, as for the device token. */
  const payload = `${COMP_TOKEN_PREFIX}.${idRaw}.${nameRaw}.${issuedAtRaw}`;
  if (!safeEqual(sig, signComp(payload))) return null;
  const issuedAt = Number(issuedAtRaw);
  if (issuedAt > now + 60_000) return null;
  if (now - issuedAt >= COMP_TOKEN_TTL_MS) return null;
  const name = Buffer.from(nameRaw ?? "", "base64url").toString("utf8");
  return { id: Number(idRaw), name };
}

/* One-shot: a token spent on a comp cannot be spent again, whatever
 * happened to the comp. In memory, per process, pruned by the TTL, which
 * is all a ten-minute token needs; a restart forgets the set and also
 * (with no PIN or pepper) the key, and with a key the ten minutes still
 * bound it. Spent AFTER every validation and BEFORE the rehearsal, so a
 * 400 costs no PIN and a refused or ambiguous charge does: the dialog
 * asks again, which is the right price for trying twice. */
const spentCompTokens = new Map<string, number>();

export function spendCompToken(token: string, now = Date.now()): boolean {
  for (const [t, at] of spentCompTokens) {
    if (now - at >= COMP_TOKEN_TTL_MS) spentCompTokens.delete(t);
  }
  if (spentCompTokens.has(token)) return false;
  spentCompTokens.set(token, now);
  return true;
}

/** One cookie's value off a request, or null. */
function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

/** `teacher=<id>` or `teacher=none`, for the comp log line. */
export function teacherLogTag(teacher: TeacherIdentity | null): string {
  return `teacher=${teacher === null ? "none" : teacher.id}`;
}
