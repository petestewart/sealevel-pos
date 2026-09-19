/**
 * T113: the server's memory of what it did with each idempotency key, so
 * one tap that reaches /api/checkout twice charges once.
 *
 * Why this exists. The protection against a double charge was T22's
 * single flight and T95's partial lock, and BOTH live in the browser. A
 * request that reaches the server twice therefore charged twice, with no
 * foolishness required: an iPad's radio drops between the request and the
 * response and the browser retries at the transport level; a teacher
 * reloads mid-charge; a proxy or a service worker replays; two iPads are
 * pointed at one ticket. The money invariants say a charge happens on an
 * explicit fresh tap and is never retried, and until now only the browser
 * could tell a fresh tap from the same tap arriving twice.
 *
 * This is ONE GATE IN FRONT OF AN UNCHANGED PATH. It does not touch the
 * single flight, the partial lock, the rehearsal, T75's total assertion,
 * T103's basket assertion, the gift card sequence or any refusal.
 *
 * The four answers:
 *  - a key never seen        the checkout runs exactly as before, and its
 *                            answer is remembered.
 *  - the same key again      the FIRST answer comes back verbatim and
 *                            nothing reaches Mindbody. That includes the
 *                            suppressed, partial and sold-nothing
 *                            outcomes: the screen says what it said the
 *                            first time rather than inventing a second
 *                            story.
 *  - the same key, still in
 *    flight                  the second request WAITS for the first and
 *                            answers with it. It does not start a second
 *                            charge and it does not refuse: a refusal
 *                            here would tell a teacher "that did not go
 *                            through" about a charge that is at that
 *                            moment going through, which is the one thing
 *                            the money rails forbid. Only if the wait
 *                            runs out (IDEM_WAIT_MS) does it answer, and
 *                            then as AMBIGUOUS, in the words that tell a
 *                            teacher with a queue to check rather than
 *                            tap again.
 *  - the same key, a
 *    DIFFERENT ticket        refused in words, with nothing sent. This is
 *                            a stale key reused for a new sale, and it is
 *                            the dangerous case: replaying the old answer
 *                            would report a sale that never happened and
 *                            leave the new one unsold. The two are told
 *                            apart by a fingerprint of the ticket (see
 *                            fingerprint below), never by the key alone.
 *
 * It must never become a way to LOSE a sale. A key the server cannot
 * remember -- the store switched off, at capacity with nothing evictable
 * -- charges as today, unprotected, with a log line saying so. Refusing a
 * real sale at the counter is worse than the risk this gate reduces, so
 * every failure of this file falls through to charging.
 *
 * Where the record lives: IN MEMORY, in this module. That is the honest
 * first version and it covers every shape above on one server. A SECOND
 * SERVER INSTANCE DEFEATS IT: two Next processes behind one hostname hold
 * two Maps, and a replay that lands on the other instance charges again.
 * The studio runs one Railway service with one instance, so this is a
 * real limit and not a present bug. It is deliberately NOT in Postgres:
 * the T29 charter would allow it (state Mindbody has no home for), but a
 * database write in front of the money path is a new way for the money
 * path to fail, and a dead database would have to degrade to today's
 * behaviour anyway.
 */

import { createHash } from "node:crypto";

import { IDEMPOTENCY_HEADER, IDEMPOTENCY_KEY_MAX } from "@/lib/idemkey";

/** How many keys are remembered at once. The counter does a few hundred
 *  sales a day, so a couple of hundred keys is hours of history for a few
 *  kilobytes. `POS_IDEM_MAX=0` switches the store off entirely, which is
 *  the "dead store" state: every request charges, as it did before T113. */
function maxEntries(): number {
  const raw = process.env.POS_IDEM_MAX;
  if (raw === undefined || raw.trim() === "") return 200;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200;
}

/** How long a key is remembered. Long enough to cover a reload and a
 *  second look at the screen, short enough that the store is bounded in
 *  AGE as well as size. */
function ttlMs(): number {
  const raw = process.env.POS_IDEM_TTL_MS;
  if (raw === undefined || raw.trim() === "") return 15 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15 * 60 * 1000;
}

/** How long a second request waits for the first one's answer. A checkout
 *  can legitimately take some seconds (a rehearsal, a credit purchase, a
 *  charge and T49's sale lookup), so the wait has to outlast the slowest
 *  honest sale; past that the first flight is presumed lost. */
const IDEM_WAIT_MS = 30_000;

/** A finished answer, kept exactly as it was sent: status, body bytes and
 *  headers. Nothing is re-serialized, so a replay cannot differ from the
 *  first answer by a rounding or a key order. */
interface Answer {
  status: number;
  body: string;
  headers: [string, string][];
  cookies: string[];
}

interface Entry {
  /** SHA-256 of the canonical ticket. The body itself is NEVER kept: it
   *  carries card numbers, CVVs and one-shot teacher tokens. */
  fingerprint: string;
  /** When the slot was taken, for the age bound. */
  at: number;
  /** The answer, or null while the first request is still running. */
  answer: Answer | null;
  /** Resolves when `answer` is set, so a second request can wait on the
   *  first rather than starting a second charge. */
  settled: Promise<void>;
  resolve: () => void;
}

const store = new Map<string, Entry>();

/** An entry's answer, read fresh. A function so the reading is not
 *  narrowed by whatever the caller knew before it waited. */
function answerOf(entry: Entry): Answer | null {
  return entry.answer;
}

/** Drop everything past its age bound. An entry still in flight past the
 *  bound has leaked (the request died without recording); dropping it is
 *  the same as never having seen the key, which is today's behaviour. */
function sweep(now: number, ttl: number): void {
  for (const [key, entry] of store) {
    if (now - entry.at > ttl) store.delete(key);
  }
}

/** Make room for one more, oldest finished entry first. An in-flight
 *  entry is never evicted: its waiter would then be answered by nobody.
 *  Returns false when the store is full of in-flight entries, and the
 *  caller then charges WITHOUT a record rather than refusing a sale. */
function evictFor(max: number): boolean {
  if (store.size < max) return true;
  for (const [key, entry] of store) {
    if (entry.answer !== null) {
      store.delete(key);
      if (store.size < max) return true;
    }
  }
  return store.size < max;
}

/**
 * The canonical form of a ticket: JSON with every object's keys sorted,
 * so two requests that mean the same sale fingerprint the same however
 * the browser happened to order them. The actor's staff id goes in too:
 * one key may only ever mean one teacher's sale.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

/** The fingerprint kept for a key. A DIGEST, never the ticket: a stored
 *  copy of a checkout body would be a stored card number. */
function fingerprint(payload: unknown, actorId: string): string {
  return createHash("sha256")
    .update(`${actorId}\u0000${canonical(payload)}`)
    .digest("hex");
}

/** The key off the request, or null when there is none. A key is NOT
 *  required: see `begin`. */
function keyOf(request: Request): string | null {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (key === "" || key.length > IDEMPOTENCY_KEY_MAX) return null;
  return key;
}

async function capture(res: Response): Promise<Answer> {
  const clone = res.clone();
  const headers: [string, string][] = [];
  clone.headers.forEach((v, k) => {
    if (k.toLowerCase() !== "set-cookie") headers.push([k, v]);
  });
  const getSetCookie = (
    clone.headers as unknown as { getSetCookie?: () => string[] }
  ).getSetCookie;
  const cookies =
    typeof getSetCookie === "function" ? getSetCookie.call(clone.headers) : [];
  return { status: clone.status, body: await clone.text(), headers, cookies };
}

function replayOf(answer: Answer, note: string): Response {
  const headers = new Headers(answer.headers);
  for (const c of answer.cookies) headers.append("set-cookie", c);
  /* Not part of the answer: a marker, so the dev drawer and a driver can
   * see that the gate caught a replay rather than a charge running. */
  headers.set("x-idempotent-replay", note);
  return new Response(answer.body, { status: answer.status, headers });
}

/** The sentence a teacher reads when a key arrives with a different
 *  ticket. It names the fix (start the sale again) and does not invite a
 *  retry of the request that was refused. */
export const IDEM_CONFLICT_ERROR =
  "This charge arrived with the tap id of a different sale, so it was " +
  "not sent. Nothing was charged. Close this and start the sale again.";

/** And when the first flight never answered. Ambiguous on purpose: that
 *  charge may be completing right now, so the one wrong move is a second
 *  tap. */
export const IDEM_INFLIGHT_ERROR =
  "This sale is already being charged and has not answered yet. It MAY " +
  "have gone through. Do not charge again: check the dev drawer or " +
  "Mindbody first.";

export interface IdemGate {
  /** Send this instead of running the checkout, when it is not null. */
  replay: Response | null;
  /** Called with whatever the checkout answered; returns the response to
   *  send. Records the answer when there is a slot for it. */
  record: (res: Response) => Promise<Response>;
  /** Called when the checkout THREW, with the error. Returns the answer
   *  to send: an ambiguous 502, which is also what a replay of this key
   *  will read, so the first caller and the replay read one sentence. */
  recordThrow: (err: unknown) => Response;
}

/** The answer a thrown checkout gets. Kept here so `record` and
 *  `recordThrow` cannot drift apart. */
function throwAnswer(): Answer {
  return {
    status: 502,
    body: JSON.stringify({
      error: IDEM_INFLIGHT_ERROR,
      stage: "checkout",
      ambiguous: true,
    }),
    headers: [["content-type", "application/json"]],
    cookies: [],
  };
}

function throwResponse(err: unknown): Response {
  console.error(
    `[checkout] the route threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  const answer = throwAnswer();
  return new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
}

const passthrough: IdemGate = {
  replay: null,
  record: async (res) => res,
  recordThrow: (err) => throwResponse(err),
};

/**
 * The gate. Called after the device session, the staff session and the
 * body parse, and before anything is validated or sent to Mindbody.
 *
 * A request with NO key charges exactly as it did before T113, with one
 * log line. The key is deliberately not required: an iPad running a
 * bundle cached from before a deploy would otherwise be unable to sell at
 * all, and rule 4 of this ticket is that the gate must never be a way to
 * lose a sale. The log line is what makes a lapse visible.
 */
export async function beginIdempotent(
  request: Request,
  payload: unknown,
  actorId: string,
): Promise<IdemGate> {
  const key = keyOf(request);
  if (key === null) {
    console.warn(
      "[idem] no key on a checkout: this charge is not replay-protected",
    );
    return passthrough;
  }
  const max = maxEntries();
  if (max === 0) {
    console.warn(`[idem] store off (POS_IDEM_MAX=0), key=${key} charges`);
    return passthrough;
  }
  const ttl = ttlMs();
  const now = Date.now();
  sweep(now, ttl);
  const print = fingerprint(payload, actorId);

  const seen = store.get(key);
  if (seen !== undefined) {
    if (seen.fingerprint !== print) {
      /* The dangerous case: a key the server knows, carrying a ticket it
       * does not. Refused, with nothing sent and nothing replayed. */
      console.warn(`[idem] key=${key} reused with a different ticket: refused`);
      return {
        replay: new Response(
          JSON.stringify({
            error: IDEM_CONFLICT_ERROR,
            stage: "idempotency",
            idempotency: "conflict",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
        record: async (res) => res,
        recordThrow: (err) => throwResponse(err),
      };
    }
    if (seen.answer !== null) {
      console.log(`[idem] key=${key} replayed: HTTP ${seen.answer.status}`);
      return { ...passthrough, replay: replayOf(seen.answer, "stored") };
    }
    /* In flight. Wait for it, do not start a second charge. */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), IDEM_WAIT_MS);
    });
    const outcome = await Promise.race([
      seen.settled.then(() => "settled" as const),
      timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    /* Read the entry again after the wait. Through a function, because
     * the narrowing from the branch above would otherwise still say this
     * is null: it was null when the wait started, which is the point. */
    const joined = answerOf(seen);
    if (outcome === "settled" && joined !== null) {
      console.log(
        `[idem] key=${key} joined the flight in progress: HTTP ${joined.status}`,
      );
      return { ...passthrough, replay: replayOf(joined, "joined") };
    }
    console.warn(`[idem] key=${key} still in flight after the wait: ambiguous`);
    return {
      replay: new Response(
        JSON.stringify({
          error: IDEM_INFLIGHT_ERROR,
          stage: "idempotency",
          idempotency: "in-flight",
          ambiguous: true,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
      record: async (res) => res,
      recordThrow: (err) => throwResponse(err),
    };
  }

  if (!evictFor(max)) {
    /* Nothing evictable: every slot is a charge in progress. Charge
     * anyway, unprotected, and say so. */
    console.warn(
      `[idem] store full of flights in progress, key=${key} charges unrecorded`,
    );
    return passthrough;
  }

  let resolve = () => {};
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  const entry: Entry = { fingerprint: print, at: now, answer: null, settled, resolve };
  store.set(key, entry);
  return {
    replay: null,
    record: async (res) => {
      entry.answer = await capture(res);
      entry.resolve();
      return res;
    },
    recordThrow: (err) => {
      /* A throw escaping the route is an UNKNOWN outcome, so the record
       * kept is an ambiguous one: a replay must not charge again on the
       * strength of a crash. */
      entry.answer = throwAnswer();
      entry.resolve();
      return throwResponse(err);
    },
  };
}

/** For a driver and for the drawer: how many keys are held. Never used by
 *  the money path. */
export function idemSize(): number {
  return store.size;
}
