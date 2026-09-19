/**
 * The waiver scene's payload and its result (T115, Phase 2.5 item 3;
 * design docs/design/customer-display.md "Scene 1").
 *
 * Two shapes and the rules that go with them, in one file for the same
 * reason T114's ticket has one:
 *
 * 1. **The payload is built by the SERVER**, never forwarded from the
 *    teacher's browser: the waiver text as `getWaiver()` served it and
 *    the student's first name, and nothing else. The display is told
 *    neither the client id nor the text's sha256, because it has no use
 *    for either and a screen in a student's hands is the last place to
 *    put an identifier.
 * 2. **The result is a signature and a moment, and both are checked.**
 *    `signaturePng` must decode from base64 to something that actually
 *    starts with PNG's 8-byte signature, within a cap well above a real
 *    signature and well below anything that would bloat a jsonb column;
 *    `agreedAt` must parse and be recent. A result that fails either is
 *    refused at the route with a plain sentence rather than stored and
 *    discovered later by the write that was meant to file it.
 *
 * Nothing in this file calls Mindbody, and nothing in it may. It is
 * imported by the DISPLAY's own components as well as by the routes, so
 * it holds no node-only import (the signature's sha256 is taken in the
 * routes, where `node:crypto` belongs).
 */

/** What the display renders. */
export interface WaiverPayload {
  /** The studio's waiver, as plain text (src/lib/waiver.ts already ran
   *  it through T99's `plainText`). */
  text: string;
  /** For the greeting. Null when the client has no usable first name. */
  clientFirstName: string | null;
}

/** What the student hands back. */
export interface WaiverResult {
  /** Base64 PNG, transparent background, the signature and a typed name
   *  line drawn into the same image. */
  signaturePng: string;
  /** ISO 8601, when the student tapped agree. */
  agreedAt: string;
}

/** A signature PNG is 10 to 30KB. A quarter of a megabyte is generous
 *  for a slow, scribbled one and refuses anything that is not a
 *  signature at all. Under the hub's own 512KB result cap on purpose:
 *  this is the specific limit, that one is the backstop. */
export const SIGNATURE_LIMIT_BYTES = 256 * 1024;
/** How stale an `agreedAt` may be. The student signed seconds ago; an
 *  hour covers a clock that disagrees and a screen left mid-scroll, and
 *  refuses a value replayed from a much older session. */
const AGREED_AT_WINDOW_MS = 60 * 60 * 1000;

/** PNG's first eight bytes. A file that does not start with these is
 *  not a PNG, whatever it was called. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The display's copy of the scene, built field by field. Anything else
 *  a caller put in is dropped rather than forwarded. */
export function readWaiverPayload(
  value: unknown,
): { ok: true; value: WaiverPayload } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text.length === 0) return { ok: false, error: "text is required" };
  const first =
    typeof raw.clientFirstName === "string" && raw.clientFirstName.trim()
      ? raw.clientFirstName.trim().slice(0, 40)
      : null;
  return { ok: true, value: { text, clientFirstName: first } };
}

/**
 * The student's answer, decoded and checked. Returns the PNG's bytes and
 * their sha256 beside the values, so the route that stores it and the
 * route that files it agree on one hash of one artifact.
 */
export function readWaiverResult(
  value: unknown,
  now = Date.now(),
):
  | { ok: true; value: WaiverResult; png: Buffer }
  | { ok: false; status: number; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "expected a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  const b64 = typeof raw.signaturePng === "string" ? raw.signaturePng : "";
  if (b64.length === 0) {
    return { ok: false, status: 400, error: "signaturePng is required" };
  }
  /* Base64 is 4 characters per 3 bytes, so the string length bounds the
   * decode before a quarter-megabyte string is turned into bytes. */
  if (Math.floor((b64.length * 3) / 4) > SIGNATURE_LIMIT_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `signaturePng is too large (over ${SIGNATURE_LIMIT_BYTES} bytes)`,
    };
  }
  const bare = b64.replace(/^data:image\/png;base64,/, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(bare)) {
    return { ok: false, status: 400, error: "signaturePng must be base64" };
  }
  const png = Buffer.from(bare, "base64");
  if (png.byteLength > SIGNATURE_LIMIT_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `signaturePng is too large (over ${SIGNATURE_LIMIT_BYTES} bytes)`,
    };
  }
  if (png.byteLength < PNG_MAGIC.length || !png.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, status: 400, error: "signaturePng is not a PNG" };
  }
  const at = typeof raw.agreedAt === "string" ? raw.agreedAt : "";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) {
    return { ok: false, status: 400, error: "agreedAt must be a date" };
  }
  /* A minute of slack forward for a display whose clock runs fast. */
  if (ms > now + 60_000 || now - ms > AGREED_AT_WINDOW_MS) {
    return {
      ok: false,
      status: 400,
      error: "agreedAt is not from the last hour",
    };
  }
  return {
    ok: true,
    value: { signaturePng: bare, agreedAt: new Date(ms).toISOString() },
    png,
  };
}

/**
 * The document's name on the client's Documents page. Self-describing
 * and sortable: what it is, when it was signed (compact, no colons,
 * which Mindbody's own file naming would not thank us for), and twelve
 * characters of the signature's hash so the file and our receipt row can
 * be matched by eye.
 */
export function waiverDocumentName(
  agreedAtIso: string,
  signatureSha256: string,
): string {
  const compact = agreedAtIso.replace(/[-:]/g, "").replace(/\.\d+Z?$/, "");
  return `waiver-${compact}-${signatureSha256.slice(0, 12)}.png`;
}
