import { randomBytes, randomInt } from "node:crypto";

import { safeEqual } from "./auth";
import {
  boundedDb,
  consumeDisplayRequest,
  dbConfigured,
  deleteDisplay,
  findLiveDisplayRequest,
  insertDisplayRequest,
  latestDisplay,
  storageMode,
  sweepDisplayRequests,
  touchDisplay,
  updateDisplayRequest,
  upsertDisplay,
} from "./db";
import { displayCookieDurable } from "./displayauth";

/**
 * The customer display's hub (T112, docs/design/customer-display.md).
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
        const payload = readJsonObject(live.payload, PAYLOAD_LIMIT_BYTES);
        const result = readJsonObject(live.result, RESULT_LIMIT_BYTES);
        state.current = {
          id: live.id,
          displayId: live.displayId,
          kind: live.kind,
          initiator: live.initiator === "display" ? "display" : "teacher",
          payload: payload.ok ? payload.value : {},
          status:
            live.status === "completed" ||
            live.status === "refused" ||
            live.status === "cancelled"
              ? live.status
              : "pending",
          result: result.ok ? result.value : null,
          reason: null,
          requestedByStaffId: live.requestedByStaffId,
          createdAt: live.createdAt.getTime(),
          completedAt:
            live.completedAt === null ? null : live.completedAt.getTime(),
          consumedAt:
            live.consumedAt === null ? null : live.consumedAt.getTime(),
          expiresAt: live.expiresAt.getTime(),
        };
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
  state.wasConnected = false;
  await boundedDb(deleteDisplay(p.id), TABLE_WAIT_MS, false);
  emit("display", "idle", {});
  emit("teacher", "disconnected", { paired: false, connected: false });
  console.log(`[display] unpaired ${p.id}`);
  return true;
}

/* --- Requests -------------------------------------------------------- */

function expireIfDue(now: number): void {
  const c = state.current;
  if (c !== null && now >= c.expiresAt) {
    state.current = null;
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
  initiator: DisplayInitiator;
  requestedByStaffId: string | null;
  now?: number;
}): Promise<
  | { ok: true; request: DisplayRequest }
  | { ok: false; status: number; error: string }
> {
  await ensureDisplayLoaded();
  const now = input.now ?? Date.now();
  expireIfDue(now);
  const p = state.paired;
  if (p === null) {
    return {
      ok: false,
      status: 409,
      error: "No customer display is paired. Pair one in Settings first.",
    };
  }
  if (!displayConnected(now)) {
    return {
      ok: false,
      status: 409,
      error:
        "The customer display is paired but not connected. Check the iPad " +
        "is awake and on this page.",
    };
  }
  if (state.current !== null && state.current.status === "pending") {
    return {
      ok: false,
      status: 409,
      error: "The customer display is already showing something.",
    };
  }
  const request: DisplayRequest = {
    id: randomBytes(12).toString("base64url"),
    displayId: p.id,
    kind: input.kind,
    initiator: input.initiator,
    payload: input.payload,
    status: "pending",
    result: null,
    reason: null,
    requestedByStaffId: input.requestedByStaffId,
    createdAt: now,
    completedAt: null,
    consumedAt: null,
    expiresAt: now + REQUEST_TTL_MS,
  };
  state.current = request;
  void boundedDb(
    insertDisplayRequest({
      id: request.id,
      displayId: request.displayId,
      kind: request.kind,
      initiator: request.initiator,
      payload: request.payload,
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
  return { ok: true, request };
}

/** The teacher takes the scene back down. */
export async function cancelRequest(
  now = Date.now(),
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
  emit("display", "cancel", { requestId: c.id });
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
export async function consumeRequest(
  requestId: string,
  now = Date.now(),
): Promise<DisplayRequest | null> {
  await ensureDisplayLoaded();
  const c = state.current;
  if (c === null || c.id !== requestId) return null;
  if (c.status !== "completed" || c.consumedAt !== null) return null;
  if (now >= c.expiresAt) return null;
  if (dbConfigured()) {
    const spent = await boundedDb(
      consumeDisplayRequest(requestId),
      TABLE_WAIT_MS,
      true,
    );
    if (!spent) return null;
  }
  c.consumedAt = now;
  state.current = null;
  emit("display", "idle", {});
  return c;
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
