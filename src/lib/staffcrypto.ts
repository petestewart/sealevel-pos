import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * The staff token at rest (T78). A staff session row in Postgres carries
 * the teacher's Mindbody token so a sign-in survives a server restart,
 * and the token is a credential, so the row never holds it in the clear:
 * AES-256-GCM under a key derived from POS_SESSION_SECRET, a fresh
 * 12-byte IV per row, the tag checked on the way out. Someone with the
 * database and not the server environment holds ciphertext; someone
 * with both already has everything anyway.
 *
 * Key derivation is HKDF-SHA256 (node:crypto's hkdfSync) with no salt
 * and a fixed label per purpose, 32 bytes out. Two labels, two keys,
 * from the one secret: the token key here, and the staff cookie's
 * signing key (src/lib/staffsession.ts), so neither can stand in for
 * the other. The `v1` in the label and in the stored value is the
 * format version: a future change gets `v2` and reads both.
 *
 * Stored shape: `v1.<iv b64url>.<ciphertext b64url>.<tag b64url>`.
 *
 * Pure and dependency-free so a plain node test can exercise it.
 */

export const STAFF_TOKEN_KEY_LABEL = "sealevel-pos staff token v1";
export const STAFF_COOKIE_KEY_LABEL = "sealevel-pos staff cookie v1";

const FORMAT = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A 32-byte key for one purpose from the shared secret. */
export function deriveStaffKey(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", label, 32));
}

/** The stored value for a token. A fresh IV every call, so the same
 *  token stored twice reads as two unrelated values. */
export function encryptStaffToken(token: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/** The token a stored value holds, or null for anything that does not
 *  decrypt cleanly under this key: the wrong secret, a damaged row, an
 *  unknown format. Null reads as "no session"; nothing here throws. */
export function decryptStaffToken(stored: string, key: Buffer): string | null {
  const parts = stored.split(".");
  if (parts.length !== 4) return null;
  const [format, ivRaw, ctRaw, tagRaw] = parts;
  if (format !== FORMAT || !ivRaw || ctRaw === undefined || !tagRaw) {
    return null;
  }
  try {
    const iv = Buffer.from(ivRaw, "base64url");
    const ct = Buffer.from(ctRaw, "base64url");
    const tag = Buffer.from(tagRaw, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}
