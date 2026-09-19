import { randomBytes, randomInt } from "node:crypto";

import { safeEqual } from "./auth";
import {
  boundedDb,
  consumeDisplayRequest,
  dbConfigured,
  deleteDisplay,
  findDisplayRequestById,
  findLiveDisplayRequest,
  insertDisplayRequest,
  latestDisplay,
  storageMode,
  sweepDisplayRequests,
  touchDisplay,
  updateDisplayRequest,
  updateDisplayRequestPayload,
  upsertDisplay,
} from "./db";
import type { DisplayRequestRow } from "./db";
import { displayCookieDurable } from "./displayauth";
import { isLiveTicket } from "./displayticket";

/**
 * The customer display's hub (T200, docs/design/customer-display.md).
 *
 * In-process, on globalThis like the call log (a dev recompile must not
 * unpair the counter), holding: which display is paired, the one request
 * in progress, the subscribers of both SSE streams, and a small buffer of
 * recent events per stream so a reconnecting EventSource can be handed
 * what it missed by `Last-Event-ID`.
 *
 * Durability is the same posture as everything else here (T29's charter,
 * T78's staff sessions): with a database, the pairing and the request are
 * written through and reloaded lazily on first use after a restart, so a
 * signature does not evaporate between the student tapping Done and the
 * teacher's iPad consuming it. WITHOUT a database, the hub is memory
 * only, a restart means re-pairing, and the display says so on its own
 * screen. Nothing here throws; every table touch is bounded and its
 * failure is a fallback, never an outage.
 *
 * Railway runs one instance, which is what makes an in-process hub
 * honest. If that ever changes, Postgres LISTEN/NOTIFY slots in behind
 * this same API; not built until needed.
 *
 * NOTHING IN THIS FILE, OR IN ANY /api/display ROUTE, CALLS MINDBODY.
 * The display never writes and the server never writes on its behalf: a
 * completed request is a stored result the teacher's iPad finalises
 * through the write routes that already exist, under the teacher's own
 * token. That is the rule the whole design rests on.
 */

/* --- Shapes ---------------------------------------------------------- */

/** The four scenes. Nothing consumes these yet (items 2 to 6); the union
 *  is here so every later item adds a scene, not a protocol. */
export type DisplayRequestKind = "waiver" | "ticket" | "register" | "contract";

const KINDS: readonly DisplayRequestKind[] = [
  "waiver",
  "ticket",
  "register",
  "contract",
];

export function isDisplayRequestKind(v: unknown): v is DisplayRequestKind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

/** Who put the scene up. `display` is the self-serve sign-up (item 5);
 *  nothing produces it yet. */
export type DisplayInitiator = "teacher" | "display";

export type DisplayRequestStatus =
  | "pending"
  | "completed"
  | "refused"
  | "cancelled";

export interface DisplayRequest {
  id: string;
  displayId: string;
  kind: DisplayRequestKind;
  initiator: DisplayInitiator;
  /** What the display renders. A plain JSON object, size-capped, and
   *  only ever what the student may see anyway. */
  payload: Record<string, unknown>;
  /**
   * T202: what the SERVER knows about this request and the display must
   * never be told: the client id the scene is about, and the sha256 of
   * the waiver text as it was served. It never reaches `sceneFor`, so it
   * cannot travel down the display's stream; the finalising write route
   * reads it back here and checks the browser's claim against it. Stored
   * in the row under a reserved key and split back off on reload.
   */
  private: Record<string, unknown>;
  status: DisplayRequestStatus;
  result: Record<string, unknown> | null;
  /** The reason a refusal gave, as the student's screen worded it. */
  reason: string | null;
  requestedByStaffId: string | null;
  createdAt: number;
  completedAt: number | null;
  consumedAt: number | null;
  expiresAt: number;
}

export interface PairedDisplay {
  id: string;
  name: string | null;
  pairedAt: number;
  lastSeenAt: number | null;
}

export interface HubEvent {
  /** Monotonic per process, and what `Last-Event-ID` names. */
  id: number;
  event: string;
  data: Record<string, unknown>;
}

type Subscriber = (ev: HubEvent) => void;

/* --- Constants ------------------------------------------------------- */

/** A pairing code lives five minutes (design doc). */
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** A request expires after 30 minutes, result and all. */
export const REQUEST_TTL_MS = 30 * 60 * 1000;
/** T201: how long the post-sale summary holds the screen before the hub
 *  itself sends the display back to idle. Server-side deliberately: a
 *  teacher whose tab is closed (or asleep, or reloaded) must not be able
 *  to leave one student's ticket in front of the next one. */
export const SUMMARY_TTL_MS = 8 * 1000;
/** Silence past this and the display counts as gone: the POS header's
 *  mark goes amber, and a teacher knows before sending a waiver to a
 *  dead screen. Three heartbeats. */
export const CONNECTED_WINDOW_MS = 45 * 1000;
/** How often the heartbeat's `last_seen_at` reaches the TABLE. Memory is
 *  stamped every beat; the row is not worth a write every 15s. */
const TOUCH_WRITE_EVERY_MS = 60 * 1000;
/** How long any table touch here may take before the hub uses what it
 *  has. A counter request must never hang on a dead database. */
const TABLE_WAIT_MS = 1_500;
/** How many unissued pairing codes may be alive at once. /api/display/
 *  state mints one for any browser that asks, with no session of any
 *  kind, which is what an unpaired display needs; the cap is what stops
 *  that being a way to grow the server's memory (or to fill the six-digit
 *  space) from outside. The oldest goes first, and a display whose code
 *  was evicted simply takes another on its next poll. */
const MAX_LIVE_CODES = 64;
/** Events kept per stream for `Last-Event-ID` replay. A reconnect that
 *  was away longer than this replays nothing and gets the current state
 *  on connect instead, which is what `idle`/`present` on connect is for. */
const EVENT_BUFFER = 50;
/** Caps. A payload is a ticket or a waiver's text; a result is a
 *  signature PNG at 10 to 30KB. Both are bounded so a paired browser
 *  cannot fill the server's memory or a jsonb column. */
export const PAYLOAD_LIMIT_BYTES = 64 * 1024;
export const RESULT_LIMIT_BYTES = 512 * 1024;
/** T202: where the server-only half of a request lives inside the stored
 *  payload column. Split off on the way in and on the way out, so a
 *  scene the display receives can never carry it. */
const PRIVATE_KEY = "__private";

/* --- State ----------------------------------------------------------- */

interface PendingCode {
  secret: string;
  createdAt: number;
  /** Set when a teacher has paired this code; the display's next poll
   *  presents the secret and takes the cookie. */
  displayId: string | null;
  name: string | null;
}

interface HubState {
  paired: PairedDisplay | null;
  current: DisplayRequest | null;
  codes: Map<string, PendingCode>;
  displaySubs: Set<Subscriber>;
  teacherSubs: Set<Subscriber>;
  displayEvents: HubEvent[];
  teacherEvents: HubEvent[];
  nextEventId: number;
  /** The lazy reload after a restart: done once per process. */
  loaded: boolean;
  loading: Promise<void> | null;
  lastTouchWrite: number;
  /** Whether the display was counted as connected at the last check, so
   *  connected/disconnected is an edge and not a per-request answer. */
  wasConnected: boolean;
  /** T201: the timer that takes a short-lived scene (the post-sale
   *  summary) down on its own. `expireIfDue` is lazy and only runs when
   *  something asks the hub a question; a summary has to clear itself
   *  with nobody asking. One timer at a time, replaced on every present
   *  and cleared on every cancel. */
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /** T202 review: request ids a write route is finalising RIGHT NOW.
   *  `consumeRequest` runs last, after the release and the upload, so
   *  without this two finalisations of one signature (the `completed`
   *  event replayed on an SSE reconnect, beside the pending check on
   *  dialog open) would both pass their checks and both write. Taken
   *  and released synchronously, so there is no await between the
   *  check and the mark. */
  finalising: Set<string>;
}

const G = globalThis as typeof globalThis & { __posDisplay?: HubState };
const state: HubState = (G.__posDisplay ??= {
  paired: null,
  current: null,
  codes: new Map(),
  displaySubs: new Set(),
  teacherSubs: new Set(),
  displayEvents: [],
  teacherEvents: [],
  nextEventId: 1,
  loaded: false,
  loading: null,
  lastTouchWrite: 0,
  wasConnected: false,
  expiryTimer: null,
  finalising: new Set<string>(),
});

/* --- Validation ------------------------------------------------------ */

/** A plain JSON object, within its cap. Anything else (an array, a
 *  string, a cycle, something too big) is refused at the route with a
 *  plain sentence rather than stored. */
export function readJsonObject(
  value: unknown,
  limit: number,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return { ok: false, error: "expected a JSON object" };
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { ok: false, error: "expected plain JSON" };
  }
  if (typeof text !== "string") return { ok: false, error: "expected plain JSON" };
  if (Buffer.byteLength(text, "utf8") > limit) {
    return { ok: false, error: `too large (over ${limit} bytes)` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/* --- Loading after a restart ----------------------------------------- */

/**
 * Reads the paired display and any live request back into memory, once
 * per process, on first use. Never throws: with no database, a database
 * that does not answer, or no rows, the hub simply knows what it knows,
 * which after a restart is nothing, and the display's own screen says a
 * re-pair is needed.
 */
/**
 * One stored row, as the hub holds it. Shared by the restart reload and
 * T202's by-id lookup, so the two cannot read the same row differently.
 * The payload column carries the server-only half under PRIVATE_KEY and
 * it is split back off here, which is the only place it is ever read.
 */
function fromRow(row: DisplayRequestRow): DisplayRequest | null {
  if (!isDisplayRequestKind(row.kind)) return null;
  const stored = readJsonObject(row.payload, PAYLOAD_LIMIT_BYTES);
  const result = readJsonObject(row.result, RESULT_LIMIT_BYTES);
  const all = stored.ok ? { ...stored.value } : {};
  const rawPrivate = all[PRIVATE_KEY];
  delete all[PRIVATE_KEY];
  return {
    id: row.id,
    displayId: row.displayId,
    kind: row.kind,
    initiator: row.initiator === "display" ? "display" : "teacher",
    payload: all,
    private:
      rawPrivate !== null &&
      typeof rawPrivate === "object" &&
      !Array.isArray(rawPrivate)
        ? (rawPrivate as Record<string, unknown>)
        : {},
    status:
      row.status === "completed" ||
      row.status === "refused" ||
      row.status === "cancelled"
        ? row.status
        : "pending",
    result: result.ok ? result.value : null,
    reason: null,
    requestedByStaffId: row.requestedByStaffId,
    createdAt: row.createdAt.getTime(),
    completedAt: row.completedAt === null ? null : row.completedAt.getTime(),
    consumedAt: row.consumedAt === null ? null : row.consumedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

export async function ensureDisplayLoaded(): Promise<void> {
  if (state.loaded) return;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      if (!dbConfigured()) return;
      const row = await boundedDb(latestDisplay(), TABLE_WAIT_MS, null);
      if (!row) return;
      state.paired = {
        id: row.id,
        name: row.name,
        pairedAt: row.pairedAt.getTime(),
        lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.getTime(),
      };
      const live = await boundedDb(
        findLiveDisplayRequest(row.id),
        TABLE_WAIT_MS,
        null,
      );
      if (live && isDisplayRequestKind(live.kind)) {
        state.current = fromRow(live);
      }
    } catch {
      /* Memory only, then. Never an outage. */
    } finally {
      state.loaded = true;
      state.loading = null;
    }
  })();
  return state.loading;
}

/* --- Events ---------------------------------------------------------- */

function emit(
  channel: "display" | "teacher",
  event: string,
  data: Record<string, unknown>,
): void {
  const ev: HubEvent = { id: state.nextEventId++, event, data };
  const buffer = channel === "display" ? state.displayEvents : state.teacherEvents;
  buffer.push(ev);
  while (buffer.length > EVENT_BUFFER) buffer.shift();
  const subs = channel === "display" ? state.displaySubs : state.teacherSubs;
  for (const sub of subs) {
    try {
      sub(ev);
    } catch {
      /* A subscriber whose stream is already closed is dropped on its
       * own abort; one that throws must not take the others with it. */
    }
  }
}

/** Events after `lastEventId` still in the buffer, for a reconnect. */
export function eventsSince(
  channel: "display" | "teacher",
  lastEventId: number,
): HubEvent[] {
  const buffer = channel === "display" ? state.displayEvents : state.teacherEvents;
  return buffer.filter((e) => e.id > lastEventId);
}

export function subscribeDisplay(sub: Subscriber): () => void {
  state.displaySubs.add(sub);
  return () => {
    state.displaySubs.delete(sub);
  };
}

export function subscribeTeacher(sub: Subscriber): () => void {
  state.teacherSubs.add(sub);
  return () => {
    state.teacherSubs.delete(sub);
  };
}

/* --- Pairing --------------------------------------------------------- */

function pruneCodes(now: number): void {
  for (const [code, entry] of state.codes) {
    if (now - entry.createdAt >= PAIR_CODE_TTL_MS) state.codes.delete(code);
  }
}

/**
 * A fresh six-digit code for an unpaired display, plus the SECRET that
 * display keeps in its own memory. The code is what a teacher reads off
 * the screen and types; the secret is what proves the browser asking for
 * the cookie is the browser that displayed the code. Neither alone is
 * enough, which is why a shoulder-surfed code cannot be turned into a
 * cookie by anybody else.
 */
export function newPairingCode(now = Date.now()): {
  code: string;
  secret: string;
  expiresAt: number;
} {
  pruneCodes(now);
  /* Oldest first, so an unauthenticated flood evicts itself rather than
   * the map growing without bound. Map keeps insertion order. */
  while (state.codes.size >= MAX_LIVE_CODES) {
    /* An unclaimed code goes before one a teacher has already paired, so
     * a flood cannot take a legitimate pairing away from the display
     * that is about to collect it. */
    let victim: string | null = null;
    for (const [c, entry] of state.codes) {
      if (entry.displayId === null) {
        victim = c;
        break;
      }
      if (victim === null) victim = c;
    }
    if (victim === null) break;
    state.codes.delete(victim);
  }
  let code = "";
  /* Bounded: with the cap above a collision is vanishingly unlikely, and
   * an unbounded retry is a hang waiting for a full map. */
  for (let i = 0; i < 20; i += 1) {
    code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!state.codes.has(code)) break;
  }
  const secret = randomBytes(24).toString("base64url");
  state.codes.set(code, { secret, createdAt: now, displayId: null, name: null });
  return { code, secret, expiresAt: now + PAIR_CODE_TTL_MS };
}

/**
 * The teacher's half: the code they typed is marked paired and a display
 * id minted. The display's next poll (code + secret) takes the cookie.
 * The newest pairing is the display, so this replaces whatever was
 * paired before, and the request in progress goes with it.
 */
export async function pairCode(
  code: string,
  name: string | null,
  now = Date.now(),
): Promise<
  | { ok: true; display: PairedDisplay }
  | { ok: false; error: string }
> {
  await ensureDisplayLoaded();
  pruneCodes(now);
  const entry = state.codes.get(code);
  if (!entry) {
    return {
      ok: false,
      error:
        "That code is not one this server is showing. Check the screen and " +
        "try again; a code lasts five minutes.",
    };
  }
  if (entry.displayId !== null) {
    return { ok: false, error: "That code has already been paired." };
  }
  const id = randomBytes(12).toString("base64url");
  entry.displayId = id;
  entry.name = name;
  const display: PairedDisplay = {
    id,
    name,
    pairedAt: now,
    lastSeenAt: null,
  };
  const previous = state.paired;
  state.paired = display;
  state.current = null;
  clearExpiryTimer();
  await boundedDb(
    upsertDisplay({ id, name, pairedAt: new Date(now) }),
    TABLE_WAIT_MS,
    false,
  );
  if (previous && previous.id !== id) {
    void boundedDb(deleteDisplay(previous.id), TABLE_WAIT_MS, false);
  }
  state.wasConnected = false;
  emit("display", "idle", {});
  emit("teacher", "disconnected", { paired: true, connected: false });
  console.log(`[display] paired ${id}${name ? ` (${name})` : ""}`);
  return { ok: true, display };
}

/**
 * The display's half of the exchange, polled every couple of seconds.
 * It reports four things and not one, because the rate limiter must
 * count a WRONG code or a wrong secret and must not count a right one
 * that no teacher has typed yet: a display polling its own valid code
 * would otherwise lock the pairing door in ten seconds.
 *
 * A right code with a wrong secret is `denied`: the code alone is not
 * enough, which is what stops anybody who read it over the counter from
 * taking the cookie instead of the screen that showed it.
 */
export function pollPairing(
  code: string,
  secret: string,
  now = Date.now(),
):
  | { status: "unknown" }
  | { status: "denied" }
  | { status: "waiting" }
  | { status: "paired"; id: string; name: string | null } {
  pruneCodes(now);
  const entry = state.codes.get(code);
  if (!entry) return { status: "unknown" };
  if (!safeEqual(entry.secret, secret)) return { status: "denied" };
  if (entry.displayId === null) return { status: "waiting" };
  const id = entry.displayId;
  const name = entry.name;
  /* One code, one cookie. */
  state.codes.delete(code);
  return { status: "paired", id, name };
}

/** Whether a cookie's display id is the display. A cookie from an older
 *  pairing (or from before a restart with no database) names nobody. */
export function isPairedDisplay(id: string | null): boolean {
  return id !== null && state.paired !== null && state.paired.id === id;
}

export function pairedDisplay(): PairedDisplay | null {
  return state.paired;
}

/** Seen within 45 seconds. */
export function displayConnected(now = Date.now()): boolean {
  const p = state.paired;
  if (p === null || p.lastSeenAt === null) return false;
  return now - p.lastSeenAt < CONNECTED_WINDOW_MS;
}

/** The heartbeat. Memory every beat, the table at most once a minute. */
export function touchDisplaySeen(id: string, now = Date.now()): void {
  const p = state.paired;
  if (p === null || p.id !== id) return;
  const wasConnected = state.wasConnected;
  p.lastSeenAt = now;
  state.wasConnected = true;
  if (!wasConnected) {
    emit("teacher", "connected", { paired: true, connected: true });
  }
  if (now - state.lastTouchWrite < TOUCH_WRITE_EVERY_MS) return;
  state.lastTouchWrite = now;
  void boundedDb(touchDisplay(id, new Date(now)), TABLE_WAIT_MS, false);
}

/** Called by the teacher-facing state reads: a display that has gone
 *  quiet tells the teacher's iPad once, rather than on every poll. */
export function noteConnectionState(now = Date.now()): void {
  const connected = displayConnected(now);
  if (connected === state.wasConnected) return;
  state.wasConnected = connected;
  emit("teacher", connected ? "connected" : "disconnected", {
    paired: state.paired !== null,
    connected,
  });
}

/** Unpair: the row, the request and the pairing all go. The cookie on
 *  the display then names nobody, which is what makes it powerless. */
export async function unpairDisplay(): Promise<boolean> {
  await ensureDisplayLoaded();
  const p = state.paired;
  if (p === null) return false;
  state.paired = null;
  state.current = null;
  clearExpiryTimer();
  state.wasConnected = false;
  await boundedDb(deleteDisplay(p.id), TABLE_WAIT_MS, false);
  emit("display", "idle", {});
  emit("teacher", "disconnected", { paired: false, connected: false });
  console.log(`[display] unpaired ${p.id}`);
  return true;
}

/* --- Requests -------------------------------------------------------- */

function clearExpiryTimer(): void {
  if (state.expiryTimer !== null) {
    clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
  }
}

/** T201: arm the hub's own clock for a scene that ends by itself (the
 *  post-sale summary). Lazy expiry is enough for a 30 minute request
 *  nobody is watching; a summary has to leave the screen with nobody
 *  asking the hub anything at all. */
function armExpiry(request: DisplayRequest, now: number): void {
  clearExpiryTimer();
  const wait = request.expiresAt - now;
  /* Only short-lived scenes get a timer: a 30 minute one would be a
   * process-lifetime handle for no gain, and `expireIfDue` covers it. */
  if (wait <= 0 || wait > 5 * 60 * 1000) return;
  const timer = setTimeout(() => {
    state.expiryTimer = null;
    expireIfDue(Date.now());
  }, wait);
  /* A pending summary must never hold a shutdown open. */
  (timer as unknown as { unref?: () => void }).unref?.();
  state.expiryTimer = timer;
}

function expireIfDue(now: number): void {
  const c = state.current;
  if (c !== null && now >= c.expiresAt) {
    state.current = null;
    clearExpiryTimer();
    emit("display", "idle", {});
  }
}

/** The request in progress, or null. */
export function currentRequest(now = Date.now()): DisplayRequest | null {
  expireIfDue(now);
  return state.current;
}

/** What the display's stream replays on connect, and what `present` and
 *  `cancel` push. Only what the student may see. */
export function sceneFor(request: DisplayRequest | null): {
  event: string;
  data: Record<string, unknown>;
} {
  if (request === null || request.status !== "pending") {
    return { event: "idle", data: {} };
  }
  return {
    event: "present",
    data: {
      requestId: request.id,
      kind: request.kind,
      initiator: request.initiator,
      payload: request.payload,
    },
  };
}

/**
 * A teacher puts a scene up. Refused when nothing is paired, when the
 * display is not connected (a scene sent to a dead screen is a teacher
 * waiting on nothing), and when a request is already in progress: only
 * one thing holds the screen at a time, which is the guard that keeps
 * two flows from both believing they own the display.
 */
export async function presentRequest(input: {
  kind: DisplayRequestKind;
  payload: Record<string, unknown>;
  /** T202: the server-only half (the client id, the waiver's sha256).
   *  Never sent to the display; read back by the write route that
   *  finalises the result. */
  private?: Record<string, unknown>;
  initiator: DisplayInitiator;
  requestedByStaffId: string | null;
  /** T201: how long this scene may hold the screen. The default is the
   *  30 minute request TTL; the post-sale summary passes SUMMARY_TTL_MS
   *  and the hub takes it down itself. */
  ttlMs?: number;
  now?: number;
}): Promise<
  | { ok: true; request: DisplayRequest; replaced: boolean }
  | {
      ok: false;
      status: number;
      error: string;
      reason: "unpaired" | "disconnected" | "busy";
    }
> {
  await ensureDisplayLoaded();
  const now = input.now ?? Date.now();
  expireIfDue(now);
  const p = state.paired;
  if (p === null) {
    return {
      ok: false,
      status: 409,
      reason: "unpaired",
      error: "No customer display is paired. Pair one in Settings first.",
    };
  }
  if (!displayConnected(now)) {
    return {
      ok: false,
      status: 409,
      reason: "disconnected",
      error:
        "The customer display is paired but not connected. Check the iPad " +
        "is awake and on this page.",
    };
  }
  const held = state.current;
  if (held !== null && held.status === "pending") {
    /* T201: the ONE scene that is updated in place rather than completed.
     * A live ticket mirrors a cart the teacher is still building, so a
     * second present of one while a live ticket is up REPLACES it: the
     * display gets one `present` and no `cancel`, and the request keeps
     * its id so nothing downstream sees a new scene per keystroke.
     *
     * The post-sale SUMMARY takes over a live ticket the same way, and
     * for the same reason: it is the end of the ticket that is already on
     * the screen, so the student watches their own ticket become a
     * receipt rather than seeing it vanish and something else arrive.
     *
     * Anything else holding the screen (a waiver, a sign-up, a contract,
     * a summary still thanking the last student) wins, and the mirror is
     * skipped silently: it is informational, and `reason: "busy"` is what
     * lets the sale screen drop it without telling the teacher about a
     * decision they did not make. */
    if (input.kind === "ticket" && isLiveTicket(held.kind, held.payload)) {
      held.payload = input.payload;
      /* T203: the SERVER-ONLY half moves with the payload. An approve
       * ticket replaces a live one in place (the design's rule for every
       * non-live scene that follows a mirror), and its private half
       * carries the cart's sha256 and the client id that /api/checkout
       * checks the approval against. Left behind, the approval would
       * name the ticket that was on the screen before it. */
      held.private = input.private ?? {};
      held.expiresAt = now + (input.ttlMs ?? REQUEST_TTL_MS);
      armExpiry(held, now);
      void boundedDb(
        updateDisplayRequestPayload(
          held.id,
          Object.keys(held.private).length === 0
            ? held.payload
            : { ...held.payload, [PRIVATE_KEY]: held.private },
          new Date(held.expiresAt),
        ),
        TABLE_WAIT_MS,
        false,
      );
      const scene = sceneFor(held);
      emit("display", scene.event, scene.data);
      return { ok: true, request: held, replaced: true };
    }
    return {
      ok: false,
      status: 409,
      reason: "busy",
      error: "The customer display is already showing something.",
    };
  }
  const request: DisplayRequest = {
    id: randomBytes(12).toString("base64url"),
    displayId: p.id,
    kind: input.kind,
    initiator: input.initiator,
    payload: input.payload,
    private: input.private ?? {},
    status: "pending",
    result: null,
    reason: null,
    requestedByStaffId: input.requestedByStaffId,
    createdAt: now,
    completedAt: null,
    consumedAt: null,
    expiresAt: now + (input.ttlMs ?? REQUEST_TTL_MS),
  };
  state.current = request;
  armExpiry(request, now);
  void boundedDb(
    insertDisplayRequest({
      id: request.id,
      displayId: request.displayId,
      kind: request.kind,
      initiator: request.initiator,
      /* The server-only half rides the same column under a reserved key
       * and is split back off on read; it is never in `payload` as the
       * display's stream carries it. */
      payload:
        Object.keys(request.private).length === 0
          ? request.payload
          : { ...request.payload, [PRIVATE_KEY]: request.private },
      status: request.status,
      result: null,
      requestedByStaffId: request.requestedByStaffId,
      createdAt: new Date(request.createdAt),
      completedAt: null,
      consumedAt: null,
      expiresAt: new Date(request.expiresAt),
    }),
    TABLE_WAIT_MS,
    false,
  );
  void boundedDb(sweepDisplayRequests(new Date(now)), TABLE_WAIT_MS, false);
  const scene = sceneFor(request);
  emit("display", scene.event, scene.data);
  return { ok: true, request, replaced: false };
}

/**
 * The teacher takes the scene back down.
 *
 * T203: `takenOver` rides the cancel event to the display. It means the
 * teacher needed the screen for something else (the design's "Take
 * over"), so the display shows "Please start again in a moment" for a few
 * seconds instead of blinking straight back to Ready in front of a
 * student who was half way through something. It changes nothing on the
 * server: the request is cancelled either way.
 */
export async function cancelRequest(
  now = Date.now(),
  opts: { takenOver?: boolean } = {},
): Promise<{ cancelled: boolean }> {
  await ensureDisplayLoaded();
  expireIfDue(now);
  const c = state.current;
  if (c === null || c.status !== "pending") {
    /* Nothing up. Still push idle: a display that somehow held a stale
     * scene must end up where the server says it is. */
    emit("display", "idle", {});
    return { cancelled: false };
  }
  c.status = "cancelled";
  c.completedAt = now;
  state.current = null;
  clearExpiryTimer();
  void boundedDb(
    updateDisplayRequest({
      id: c.id,
      status: "cancelled",
      result: null,
      completedAt: new Date(now),
    }),
    TABLE_WAIT_MS,
    false,
  );
  emit("display", "cancel", {
    requestId: c.id,
    ...(opts.takenOver === true ? { takenOver: true } : {}),
  });
  emit("display", "idle", {});
  return { cancelled: true };
}

/**
 * The student finished. The result is stored and the teacher's iPad is
 * told; nothing is written to Mindbody here, and nothing will be until a
 * teacher's own write route consumes this.
 */
export async function completeRequest(
  displayId: string,
  requestId: string,
  result: Record<string, unknown>,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await ensureDisplayLoaded();
  expireIfDue(now);
  const c = state.current;
  if (c === null || c.id !== requestId || c.displayId !== displayId) {
    return { ok: false, status: 409, error: "That is not the current request." };
  }
  if (c.status !== "pending") {
    return { ok: false, status: 409, error: "That request is already done." };
  }
  c.status = "completed";
  c.result = result;
  c.completedAt = now;
  void boundedDb(
    updateDisplayRequest({
      id: c.id,
      status: "completed",
      result,
      completedAt: new Date(now),
    }),
    TABLE_WAIT_MS,
    false,
  );
  emit("teacher", "completed", {
    requestId: c.id,
    kind: c.kind,
    initiator: c.initiator,
  });
  return { ok: true };
}

/** The student said no. Same shape, opposite outcome. */
export async function refuseRequest(
  displayId: string,
  requestId: string,
  reason: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await ensureDisplayLoaded();
  expireIfDue(now);
  const c = state.current;
  if (c === null || c.id !== requestId || c.displayId !== displayId) {
    return { ok: false, status: 409, error: "That is not the current request." };
  }
  if (c.status !== "pending") {
    return { ok: false, status: 409, error: "That request is already done." };
  }
  c.status = "refused";
  c.reason = reason;
  c.completedAt = now;
  void boundedDb(
    updateDisplayRequest({
      id: c.id,
      status: "refused",
      result: { reason },
      completedAt: new Date(now),
    }),
    TABLE_WAIT_MS,
    false,
  );
  emit("teacher", "refused", { requestId: c.id, kind: c.kind, reason });
  return { ok: true };
}

/**
 * Spends a result: the one finalisation (items 3 to 6 call this from the
 * write routes). Answers the request when it was this display's, is
 * completed, is inside its 30 minutes and had not been consumed;
 * otherwise null, which a write route reads as "there is nothing here to
 * write" rather than as an error to retry. With a database the UPDATE is
 * what decides, so two tabs cannot both spend one signature; without
 * one, memory decides, which is the same answer on one instance.
 */
/**
 * T202 review: claim a request for finalisation, synchronously. True
 * means this caller owns it and must call `releaseFinalisation` when it
 * is done (consumed or not); false means another call is already
 * writing this one and this caller must do nothing at all. A duplicate
 * write is worse than a missed one here: the release already stands.
 */
export function beginFinalisation(requestId: string): boolean {
  state.finalising ??= new Set<string>();
  if (state.finalising.has(requestId)) return false;
  state.finalising.add(requestId);
  return true;
}

export function releaseFinalisation(requestId: string): void {
  state.finalising?.delete(requestId);
}

export async function consumeRequest(
  requestId: string,
  now = Date.now(),
): Promise<DisplayRequest | null> {
  await ensureDisplayLoaded();
  /* T202 (T200 review): BY ID, not "is it the current one". The teacher's
   * iPad names the request it was told about, and by the time it does,
   * the hub's `current` may be a later scene, or the process may have
   * restarted and hold nothing at all. The row is the reason this table
   * exists, so a completed result is looked up there when memory has
   * lost it; with no database, memory is all there is and the answer is
   * the same on one instance. */
  const c = state.current?.id === requestId ? state.current : await loadRequest(requestId);
  if (c === null) return null;
  if (c.status !== "completed" || c.consumedAt !== null) return null;
  if (now >= c.expiresAt) return null;
  /* Memory is spent FIRST (T202 review): the release, the receipt and
   * the upload have already happened by the time this runs, so a table
   * that does not answer must not leave the handle spendable for a retry
   * in this process. The row is marked best effort behind it; a miss is
   * logged, and the residual is one restart inside the 30 minutes. */
  c.consumedAt = now;
  if (dbConfigured()) {
    const spent = await boundedDb(
      consumeDisplayRequest(requestId),
      TABLE_WAIT_MS,
      false,
    );
    if (!spent) {
      console.warn(
        `[display] request ${requestId} consumed in memory; the row was not marked`,
      );
    }
  }
  /* Only the scene actually on the screen comes down. Finalising a
   * result the hub has already moved past must not blank whatever the
   * display is showing now. */
  if (state.current !== null && state.current.id === c.id) {
    state.current = null;
    clearExpiryTimer();
    emit("display", "idle", {});
  }
  return c;
}

/** One request by id, from memory or from the table (T202). Never
 *  throws; null is "there is nothing here to finalise". */
export async function loadRequest(
  requestId: string,
): Promise<DisplayRequest | null> {
  await ensureDisplayLoaded();
  if (state.current !== null && state.current.id === requestId) {
    return state.current;
  }
  if (!dbConfigured()) return null;
  const row = await boundedDb(
    findDisplayRequestById(requestId),
    TABLE_WAIT_MS,
    null,
  );
  return row === null ? null : fromRow(row);
}

/**
 * T202: a completed, unconsumed request of this kind for this client,
 * whether or not it is still the scene on the screen. This is what the
 * teacher's iPad asks after being asleep through the `completed` event:
 * the result waited in the hub (or the table) and is finalised on wake.
 * The client id is read from the request's SERVER-side half, never from
 * anything a browser sent.
 */
export async function pendingResultFor(
  kind: DisplayRequestKind,
  clientId: string,
  now = Date.now(),
): Promise<DisplayRequest | null> {
  await ensureDisplayLoaded();
  const c = state.current;
  if (
    c !== null &&
    c.kind === kind &&
    c.status === "completed" &&
    c.consumedAt === null &&
    now < c.expiresAt &&
    c.private.clientId === clientId
  ) {
    return c;
  }
  return null;
}

/* --- What the surfaces read ------------------------------------------ */

/** The teacher-facing state: /api/admin/display, /api/config and the
 *  events stream's replay all say the same thing. */
export async function displayState(now = Date.now()): Promise<{
  paired: boolean;
  id: string | null;
  name: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
  connected: boolean;
  busy: boolean;
  storage: string;
  durable: boolean;
}> {
  await ensureDisplayLoaded();
  noteConnectionState(now);
  const p = state.paired;
  const current = currentRequest(now);
  return {
    paired: p !== null,
    id: p?.id ?? null,
    name: p?.name ?? null,
    pairedAt: p === null ? null : new Date(p.pairedAt).toISOString(),
    lastSeenAt:
      p?.lastSeenAt == null ? null : new Date(p.lastSeenAt).toISOString(),
    connected: displayConnected(now),
    busy: current !== null && current.status === "pending",
    storage: storageMode(),
    /* A pairing survives a restart only with BOTH halves: the row
     * (DATABASE_URL) and a cookie key that can be derived again
     * (POS_SESSION_SECRET). Either missing and the drawer and the
     * display both say a restart needs re-pairing. */
    durable: dbConfigured() && displayCookieDurable(),
  };
}
