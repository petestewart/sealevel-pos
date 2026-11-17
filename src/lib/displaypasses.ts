/**
 * T242: the "Your passes" scene on the customer display.
 *
 * While the roster's "Pay and check in" dialog is showing the student's
 * own passes, the display shows the same list ("Your passes": names,
 * classes left, expiry) with a 64px "Use this pass" per pass, and the
 * student may pick one. Nobody waits on the student: the teacher's own
 * buttons work the whole time, and the first tap from either side wins.
 *
 * What may reach the display is decided HERE, field by field, the way
 * `readTicketPayload` decides it for a ticket: a first name, and per pass
 * a name, a count and a day. NO ids: a pass is offered under an opaque
 * KEY the server made for this one scene, and the key's ClientService id
 * lives on the request's server-only half (`private.offer`), which never
 * travels down the display's stream. A student's pick names a key; the
 * server checks it against the offer it stored and tells the teacher's
 * iPad which pass that was.
 *
 * Four modes, one scene, replaced in place by the tab that put it up:
 * `offer` (the list), `working` (a pass was chosen, the teacher's iPad is
 * assigning it and checking in), `done` (both writes answered), `help`
 * (they did not: "Please see the front desk", and the teacher's dialog
 * says why). `done` and `help` end by themselves on the hub's clock.
 *
 * Nothing in this file calls Mindbody, and nothing on this scene writes:
 * the two writes are the teacher's iPad's, through `/api/visit-payment`
 * and `/api/checkin`, under the teacher's token.
 */

export type PassesMode = "offer" | "working" | "done" | "help";

export interface PassesLine {
  /** Opaque, per scene. Never an id. */
  key: string;
  name: string;
  /** Classes left before this visit, or null when there is nothing worth
   *  saying (unlimited, a single visit, Mindbody kept no count). */
  remaining: number | null;
  /** The expiry day, YYYY-MM-DD, or null. */
  expires: string | null;
}

export interface PassesPayload {
  mode: PassesMode;
  clientFirstName: string | null;
  /** `offer` only. */
  passes: PassesLine[];
  /** `working` and `done`: the pass being used, by name. */
  passName: string | null;
}

/** A scene lists at most this many passes; a client rarely holds two. */
export const MAX_PASSES = 8;
const MAX_NAME = 120;
export const PASS_KEY_RE = /^[A-Za-z0-9_-]{6,24}$/;

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length === 0 ? null : t.slice(0, max);
}

/** A count worth showing a student: a whole number under 100. Mindbody
 *  fakes "unlimited" with 99999 and friends (T14), so anything from 100
 *  up is not a count and shows nothing. */
function count(v: unknown): number | null {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v < 100
    ? v
    : null;
}

function day(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? (m[1] as string) : null;
}

/** Rebuild a passes scene field by field, or refuse it. */
export function readPassesPayload(
  value: unknown,
): { ok: true; value: PassesPayload } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== "offer" && mode !== "working" && mode !== "done" && mode !== "help") {
    return { ok: false, error: "mode must be offer, working, done or help" };
  }
  const passes: PassesLine[] = [];
  if (mode === "offer") {
    if (!Array.isArray(raw.passes) || raw.passes.length === 0) {
      return { ok: false, error: "an offer needs at least one pass" };
    }
    if (raw.passes.length > MAX_PASSES) {
      return { ok: false, error: `too many passes (over ${MAX_PASSES})` };
    }
    for (const entry of raw.passes) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, error: "each pass must be an object" };
      }
      const p = entry as Record<string, unknown>;
      const key = typeof p.key === "string" && PASS_KEY_RE.test(p.key) ? p.key : null;
      const name = text(p.name, MAX_NAME);
      if (key === null || name === null) {
        return { ok: false, error: "each pass needs a key and a name" };
      }
      passes.push({ key, name, remaining: count(p.remaining), expires: day(p.expires) });
    }
  }
  return {
    ok: true,
    value: {
      mode,
      clientFirstName: text(raw.clientFirstName, 40),
      passes,
      passName: mode === "working" || mode === "done" ? text(raw.passName, MAX_NAME) : null,
    },
  };
}

/** What the teacher's iPad is told about a student's pick of a pass: the
 *  ClientService id the server mapped the key back to. On the TEACHER's
 *  stream and poll only; never on the display's. */
export interface PassPick {
  pickId: string;
  requestId: string;
  clientServiceId: number;
  presenter?: string;
}

/** A pass pick off the wire, or null. Only the fixed keys are read. */
export function readPassPick(value: unknown): PassPick | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.pickId !== "string" ||
    typeof v.requestId !== "string" ||
    typeof v.clientServiceId !== "number" ||
    !Number.isInteger(v.clientServiceId)
  ) {
    return null;
  }
  return {
    pickId: v.pickId,
    requestId: v.requestId,
    clientServiceId: v.clientServiceId,
    ...(typeof v.presenter === "string" ? { presenter: v.presenter } : {}),
  };
}

/** "3 classes left", "1 class left", or null. */
export function classesLeft(remaining: number | null): string | null {
  if (remaining === null) return null;
  return remaining === 1 ? "1 class left" : `${remaining} classes left`;
}
