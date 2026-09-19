import { createHmac, randomBytes } from "node:crypto";

import { cookieValue, safeEqual } from "./auth";

/**
 * The customer display's cookie (T113, docs/design/customer-display.md).
 *
 * A student holds this iPad, so it does NOT hold the device session: a
 * cookie that opens the POS must not be on a device somebody could walk
 * off with. `pos_display` carries ONE thing, the display id, signed the
 * way the device token is signed, and it opens exactly `/api/display/*`.
 * `requireSession` never looks at it, so a browser holding only this
 * cookie is refused by every real route, which is the whole point and is
 * what the T113 driver asserts route by route.
 *
 * The key follows the staff cookie's posture (T78): derived from
 * POS_SESSION_SECRET when it is set, so a pairing survives a restart
 * alongside its `displays` row; random per process otherwise, in which
 * case a restart means re-pairing and the display says so on its own
 * screen rather than sitting there looking paired.
 *
 * Nothing here reads or writes Mindbody, and nothing in the display path
 * ever will: the display adds zero write paths (design doc, "Security,
 * plainly").
 */

const COOKIE_NAME = "pos_display";
const COOKIE_PREFIX = "d1";
/** A year. The pairing is the lifetime that matters, and it is revoked by
 *  unpairing, by a restart without a secret, or by a new pairing; a short
 *  cookie would only log a counter iPad out mid-shift for nothing. */
const COOKIE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const KEY_LABEL = "sealevel-pos/display-cookie/v1";

interface DisplayAuthState {
  processKey: Buffer;
}
const G = globalThis as typeof globalThis & {
  __posDisplayAuth?: DisplayAuthState;
};
const state: DisplayAuthState = (G.__posDisplayAuth ??= {
  processKey: randomBytes(32),
});

let derived: { secret: string; key: Buffer } | null = null;

function cookieKey(): Buffer {
  const secret = (process.env.POS_SESSION_SECRET ?? "").trim();
  if (secret.length === 0) return state.processKey;
  if (derived && derived.secret === secret) return derived.key;
  const key = createHmac("sha256", secret).update(KEY_LABEL).digest();
  derived = { secret, key };
  return key;
}

/** Whether a pairing can outlive a restart at all. The idle screen says
 *  so in one line, because "paired" that quietly stops meaning it after
 *  a deploy is the kind of thing a teacher should not discover at 6pm. */
export function displayCookieDurable(): boolean {
  return (process.env.POS_SESSION_SECRET ?? "").trim().length > 0;
}

function sign(id: string): string {
  return createHmac("sha256", cookieKey()).update(id).digest("hex");
}

/** The cookie VALUE for a display id: `d1.<id>.<hmac>`. */
export function displayCookieValue(id: string): string {
  return `${COOKIE_PREFIX}.${id}.${sign(id)}`;
}

/** The display id a request's cookie names, when validly signed
 *  (constant-time); null otherwise. Says nothing about whether that
 *  display is still the paired one, which the hub answers. */
export function displayIdFrom(request: Request): string | null {
  const raw = cookieValue(request, COOKIE_NAME);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [prefix, id, sig] = parts;
  if (prefix !== COOKIE_PREFIX || !id || !sig) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!safeEqual(sig, sign(id))) return null;
  return id;
}

/** Set-Cookie that pairs this browser. SameSite=Lax because the display
 *  and the POS are the same origin and nothing legitimately arrives here
 *  from elsewhere; Secure only in production, for the same
 *  http://<lan-ip>:3000 reason as the device cookie. */
export function displaySetCookie(value: string): string {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

/** Set-Cookie that unpairs this browser. */
export function displayClearCookie(): string {
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
