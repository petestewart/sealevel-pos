import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import {
  findTeacherPin,
  upsertTeacherPin,
  type TeacherPinWrite,
} from "./db";
import { isPinShape } from "./comp";
import { target } from "./mindbody";
import { listTeachers } from "./staff";
import type { TeacherIdentity } from "./auth";

/**
 * Teacher PINs (T48). Pete, after T44's last-four-of-a-phone: "we dont
 * have phone #s for everyone", and "if we are going to do PINs we likely
 * need to store them in our own db. even with phone #'s it's not
 * impossible that 2 people could have the same last 4 digits." So a PIN
 * is chosen by the teacher, 4 to 6 digits, stored by us, and unique.
 *
 * Storage (db.ts, migration 5): two values per row and never the PIN.
 * `pin_hash` is scrypt with a random per-row salt, the value a match is
 * finally checked against. `pin_lookup` is an HMAC of the PIN under a
 * server-side key, so a check is one indexed read rather than a scrypt
 * per enrolled teacher, and UNIQUE on it is what refuses a second teacher
 * choosing a PIN already in use. The HMAC key is POS_SESSION_SECRET when
 * set (production, .env.example says so) and an app constant otherwise;
 * it is deliberately NOT the device PIN, so rotating POS_PIN does not
 * silently orphan every teacher's PIN. Changing the secret does, and
 * teachers enroll again.
 *
 * With no database, a dev-only POS_TEACHER_PINS="<staffId>:<pin>,..." in
 * the environment stands in, refused on the production target: a PIN in
 * plain text in a deploy's environment is not a store, and the app on
 * the studio's counter must have the real one or refuse to comp.
 */

export { isPinShape, PIN_MAX, PIN_MIN } from "./comp";

const LOOKUP_KEY_FALLBACK = "sealevel-pos/teacher-pin-lookup/v1";

function lookupKey(): string {
  const pepper = (process.env.POS_SESSION_SECRET ?? "").trim();
  return pepper.length > 0 ? pepper : LOOKUP_KEY_FALLBACK;
}

/** The indexed, keyed lookup value for a PIN. */
export function pinLookup(pin: string): string {
  return createHmac("sha256", lookupKey()).update(pin, "utf8").digest("hex");
}

/** scrypt with a fresh salt: `s1$<salt hex>$<hash hex>`. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `s1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Whether a PIN matches a stored hash. Constant-time on the hash. */
export function pinMatchesHash(pin: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "s1" || !parts[1] || !parts[2]) {
    return false;
  }
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(pin, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* --- The env fallback ------------------------------------------------ */

let envWarned = false;

/** POS_TEACHER_PINS parsed, or null when unset, malformed, or on prod.
 *  A PIN listed for two ids names nobody, since uniqueness is the rule
 *  the table enforces and the fallback must not be looser. */
function envPins(): Map<string, string> | null {
  const raw = (process.env.POS_TEACHER_PINS ?? "").trim();
  if (raw.length === 0) return null;
  if (target() === "prod") {
    if (!envWarned) {
      envWarned = true;
      console.warn(
        "[teacher-pins] POS_TEACHER_PINS is set but MINDBODY_TARGET=prod; " +
          "ignored. Teacher PINs on the studio live in the database.",
      );
    }
    return null;
  }
  const byPin = new Map<string, string>();
  const dupes = new Set<string>();
  for (const entry of raw.split(",")) {
    const [idRaw, pinRaw] = entry.split(":").map((s) => s.trim());
    if (!idRaw || !pinRaw || !/^\d+$/.test(idRaw) || !isPinShape(pinRaw)) {
      continue;
    }
    if (byPin.has(pinRaw)) dupes.add(pinRaw);
    byPin.set(pinRaw, idRaw);
  }
  for (const pin of dupes) byPin.delete(pin);
  return byPin;
}

/* --- Verify and set -------------------------------------------------- */

export type PinCheck =
  | { ok: true; teacher: TeacherIdentity }
  | { ok: false; reason: "wrong" | "unavailable" | "staff" };

/**
 * Whose PIN this is. The database first; with none, the env fallback;
 * with neither, `unavailable`, which the verify route reports as such
 * rather than as a wrong PIN. `wrong` is one answer for every miss, and
 * the scrypt check runs even when the lookup found nothing, so a miss and
 * a hit cost the same.
 */
export async function verifyTeacherPin(pin: string): Promise<PinCheck> {
  const found = await findTeacherPin(pinLookup(pin));
  if (found.available) {
    const row = found.row;
    /* One scrypt either way. */
    const matched = pinMatchesHash(pin, row?.pinHash ?? DUMMY_HASH);
    if (row === null || !matched) return { ok: false, reason: "wrong" };
    return {
      ok: true,
      teacher: { id: Number(row.staffId), name: row.name },
    };
  }
  const env = envPins();
  if (env === null) return { ok: false, reason: "unavailable" };
  /* Constant-time over the whole list, no early exit: the time this
   * takes must not say whether the PIN is in it. */
  let hit: string | null = null;
  for (const [candidate, staffId] of env) {
    if (safeEqualStr(candidate, pin)) hit = staffId;
  }
  if (hit === null) return { ok: false, reason: "wrong" };
  let teachers;
  try {
    teachers = await listTeachers();
  } catch {
    return { ok: false, reason: "staff" };
  }
  const teacher = teachers.find((t) => String(t.id) === hit);
  if (!teacher) return { ok: false, reason: "wrong" };
  return { ok: true, teacher: { id: teacher.id, name: teacher.name } };
}

/** A real hash of a PIN nobody can type (seven digits), so a miss costs
 *  one scrypt like a hit. */
const DUMMY_HASH = hashPin("0000000");

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Store (or replace) a teacher's PIN. `setVia` is who vouched for the
 *  identity: "mindbody-signin" or "admin". */
export async function setTeacherPin(
  teacher: TeacherIdentity,
  pin: string,
  setVia: "mindbody-signin" | "admin",
): Promise<TeacherPinWrite> {
  return upsertTeacherPin({
    staffId: String(teacher.id),
    name: teacher.name,
    pinHash: hashPin(pin),
    pinLookup: pinLookup(pin),
    setVia,
  });
}
