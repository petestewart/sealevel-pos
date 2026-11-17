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
  listSelfServeSignups,
  storageMode,
  sweepDisplayRequests,
  touchDisplay,
  updateDisplayRequest,
  updateDisplayRequestPayload,
  upsertDisplay,
} from "./db";
import type { DisplayRequestRow } from "./db";
import { displayCookieDurable } from "./displayauth";
import {
  dropAllDisplayCards,
  dropDisplayCard,
  holdDisplayCard,
  sweepDisplayCards,
} from "./displaycard";
import {
  isApproveTicket,
  isLiveTicket,
  isTenderChoice,
  offerOf,
  type TenderChoice,
} from "./displayticket";
import type { TypedCard } from "./typedcard";
import type { PassPick } from "./displaypasses";

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
export type DisplayRequestKind =
  | "waiver"
  | "ticket"
  | "register"
  | "contract"
  /* T242: "Your passes", the student's own passes for an unpaid visit. */
  | "passes";

const KINDS: readonly DisplayRequestKind[] = [
  "waiver",
  "ticket",
  "register",
  "contract",
  "passes",
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
  /**
   * T241: the student's last choice of how to pay on this ticket, and
   * whether a choice may be made now. MEMORY ONLY: neither is written to
   * the request's row (the payload column is the scene, the private half
   * is the server's, and neither carries this), so a restart forgets an
   * unanswered pick, which costs the student one more tap. `pickOpen`
   * is set by every present of this ticket and cleared by a pick, so one
   * offer buys one pick: the teacher's iPad answers it by presenting the
   * ticket again, with the new tender and a new offer.
   */
  pickOpen?: boolean;
  pick?: TenderPick | null;
  /** T241 review: bumped by every present of this request, including an
   *  in-place replace, and carried to the display with the scene, so an
   *  Approve tapped on one version of a ticket cannot complete the next.
   *  Memory only; a request reloaded after a restart is version 1. */
  version?: number;
  /** T241 review: whether an approve ticket has been replaced in place
   *  as an approve ticket (a pick answered), which is when an Approve
   *  that names no version can no longer be trusted to be for it. */
  approveReplaced?: boolean;
  /** T241 review: when this request was last presented, so a live
   *  ticket a closed tab left behind can be taken over by another iPad
   *  after a while rather than blocking its mirror for 30 minutes. */
  presentedAt?: number;
  /** T242: the student's pick of one of their own passes on a `passes`
   *  scene. Memory only, like the tender pick. */
  passPick?: (PassPick & { at: number }) | null;
}

/** T241: what the teacher's iPad is told about a pick. A key from the
 *  fixed list, and for a card the student typed its last four (never
 *  sent to the display) and whether they asked to save it. */
export interface TenderPick {
  pickId: string;
  requestId: string;
  choice: TenderChoice;
  lastFour?: string;
  keep?: boolean;
  /** T241 review: the tab that presented the ticket, so a teacher's iPad
   *  acts only on picks made on its own ticket. */
  presenter?: string;
  at: number;
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
/** T204: a self-serve sign-up the teacher has not created yet. The
 *  design's number: four hours, after which an unconsumed result is
 *  deleted with everything in it (the student did not come back). It is
 *  longer than every other request because it is the only one a teacher
 *  meets in a tray at a moment of their own choosing. It has the same
 *  test-only knob the abandon window has (POS_DISPLAY_SIGNUP_TTL_MS),
 *  read only when it is set. */
export const SIGNUP_TTL_MS = 4 * 60 * 60 * 1000;
/** T242: a "Your passes" offer holds the screen at most five minutes
 *  with no new present, short enough that a tab closed without taking
 *  it down does not leave one student's passes for the next, and inside
 *  armExpiry's timer window, so it leaves with nobody asking. */
export const PASSES_TTL_MS = 5 * 60 * 1000;
/** T242: and "One moment" (a pass chosen, the writes running) a minute. */
export const PASSES_WORKING_TTL_MS = 60 * 1000;
/** T204: two minutes with no touch and a sign-up in progress returns the
 *  screen to idle and discards the partial form, so a student who
 *  wandered off cannot hold the screen against the next sale and the
 *  next student never sees the last one's email. */
export const SIGNUP_ABANDON_MS = 2 * 60 * 1000;

/** The two windows, each with a test-only knob read ONLY when it is
 *  set, and only to shorten a wait in a driver; unset (production,
 *  always) they are the design's four hours and two minutes. */
export function signupTtlMs(): number {
  const raw = process.env.POS_DISPLAY_SIGNUP_TTL_MS;
  if (raw === undefined || raw.trim() === "") return SIGNUP_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SIGNUP_TTL_MS;
}

export function signupAbandonMs(): number {
  const raw = process.env.POS_DISPLAY_ABANDON_MS;
  if (raw === undefined || raw.trim() === "") return SIGNUP_ABANDON_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SIGNUP_ABANDON_MS;
}
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
  /** T206: how many of the display's SSE streams are open right now.
   *  Pete, first drive: "closed safari on ipad, display mark looks the
   *  same until i refresh". The 45 second window alone cannot notice a
   *  tab closing, and the edge was only ever looked for when a teacher
   *  read the state. A stream teardown is the event, so the count is
   *  kept here: a reload OVERLAPS two streams, so only zero open means
   *  gone. */
  streamOpen: number;
  /** When the last stream closed, or null while one is open or none has
   *  ever opened in this process. It is what makes `displayConnected`
   *  false at once rather than 45 seconds later. */
  lastClosedAt: number | null;
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
  /** T204: completed self-serve sign-ups this process knows about, by
   *  request id. `current` holds ONE scene and a later scene replaces
   *  it, so the tray needs its own place to keep a result that is
   *  waiting for a teacher; the table is read beside it when there is
   *  one, and this is all there is without one. */
  signups: Map<string, DisplayRequest>;
  /** T208: request ids this PROCESS has spent (consumed or cleared),
   *  kept after the object itself has gone from `current` and
   *  `signups`. Spending is memory-first on purpose (T202 review), so a
   *  table write that missed must not make a handle spendable again,
   *  and a cleared row must not come back on the next poll. Bounded:
   *  the oldest id goes when it is full, and the row it named is
   *  already marked in the table by then. */
  spent: Set<string>;
  /** T204: when the student last touched the sign-up on the screen, and
   *  the timer that ends it when they stop. */
  lastTouch: number;
  abandonTimer: ReturnType<typeof setTimeout> | null;
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
  streamOpen: 0,
  lastClosedAt: null,
  expiryTimer: null,
  finalising: new Set<string>(),
  signups: new Map<string, DisplayRequest>(),
  spent: new Set<string>(),
  lastTouch: 0,
  abandonTimer: null,
});

/* T206: the hub lives on globalThis so a dev recompile does not unpair
 * the counter, which means a state object created before these two
 * fields existed can outlive the build that adds them. Normalized once,
 * here, rather than guarded at every read. */
state.streamOpen ??= 0;
state.lastClosedAt ??= null;
state.spent ??= new Set<string>();
/* T241 second review: ticket requests this process has closed
 * (cancelled, refused, retired, expired), so a checkout can refuse a
 * student's card whose ticket is over even in a race with its drop. */
const G2 = globalThis as typeof globalThis & { __posClosedTickets?: Set<string> };
const closedTickets: Set<string> = (G2.__posClosedTickets ??= new Set<string>());
function markClosed(requestId: string): void {
  closedTickets.add(requestId);
  while (closedTickets.size > MAX_SPENT_IDS) {
    const oldest = closedTickets.values().next();
    if (oldest.done) break;
    closedTickets.delete(oldest.value);
  }
}
/** Whether this process closed `requestId` (cancelled, refused, retired
 *  or expired). A card typed on it must not be charged. */
export function displayRequestClosed(requestId: string): boolean {
  return closedTickets.has(requestId);
}

/** How many spent ids are remembered. A sign-up lives four hours and a
 *  counter takes a few dozen a day, so this covers a day of them; past
 *  it the table's own `consumed_at` is the record. */
const MAX_SPENT_IDS = 500;

/** T208: this id is spent in this process, whatever any store says. */
function markSpent(requestId: string): void {
  state.spent.add(requestId);
  while (state.spent.size > MAX_SPENT_IDS) {
    const oldest = state.spent.values().next();
    if (oldest.done) break;
    state.spent.delete(oldest.value);
  }
}

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
  clearAbandonTimer();
  await boundedDb(
    upsertDisplay({ id, name, pairedAt: new Date(now) }),
    TABLE_WAIT_MS,
    false,
  );
  if (previous && previous.id !== id) {
    void boundedDb(deleteDisplay(previous.id), TABLE_WAIT_MS, false);
  }
  state.wasConnected = false;
  /* A new pairing owns no stream: whatever the last display left behind
   * is not this one's. */
  state.streamOpen = 0;
  state.lastClosedAt = null;
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

/**
 * Whether the display is there. A stream open says yes at once and a
 * stream closed says no at once (T206); the 45 second silence window is
 * the FALLBACK, for a stream that died without the abort ever reaching
 * this process.
 */
export function displayConnected(now = Date.now()): boolean {
  const p = state.paired;
  if (p === null || p.lastSeenAt === null) return false;
  if (state.streamOpen > 0) return true;
  /* Closed since the last beat: gone, with no waiting. */
  if (state.lastClosedAt !== null && state.lastClosedAt >= p.lastSeenAt) {
    return false;
  }
  return now - p.lastSeenAt < CONNECTED_WINDOW_MS;
}

/**
 * T206: the display's stream opened. Counted, because a reload overlaps
 * the new stream with the old one and the teacher's mark must not flap
 * between them. `touchDisplaySeen` is what emits `connected`; this only
 * records that somebody is holding the line.
 */
export function markDisplayStreamOpen(id: string, now = Date.now()): void {
  const p = state.paired;
  if (p === null || p.id !== id) return;
  state.streamOpen += 1;
  state.lastClosedAt = null;
  /* A freshly paired display has no heartbeat yet, and displayConnected()
   * reads null as never seen; the stream opening IS the first sighting,
   * so it stamps one rather than reading red until the first beat. */
  if (p.lastSeenAt === null) p.lastSeenAt = now;
  /* Review: the teardown below is immediate, so the open has to be too.
   * A reload does not always overlap (Safari tears the old EventSource
   * down before the new page asks for one), and without this the mark
   * went red on the close and stayed red until the first heartbeat up
   * to 15 seconds later, with the contract dialog reading that live
   * answer and offering the PIN for a screen that was right there.
   * `noteConnectionState` only speaks on an EDGE, so an open while the
   * mark is already green says nothing. */
  noteConnectionState(now);
}

/**
 * T206: the display's stream tore down, which is what a closed Safari
 * tab looks like from here. Pete, first drive on real hardware: "closed
 * safari on ipad, display mark looks the same until i refresh".
 *
 * Only the LAST stream closing means gone, so a reload (two streams for
 * a moment) is not a disconnect. When it is the last, the moment is
 * recorded, which makes `displayConnected` false immediately, and
 * `noteConnectionState` sends `disconnected` down the teacher's stream
 * at once rather than up to 75 seconds later.
 */
export function markDisplayGone(id: string, now = Date.now()): void {
  const p = state.paired;
  if (p === null || p.id !== id) return;
  state.streamOpen = Math.max(0, state.streamOpen - 1);
  if (state.streamOpen > 0) return;
  state.lastClosedAt = now;
  noteConnectionState(now);
}

/** The heartbeat. Memory every beat, the table at most once a minute. */
export function touchDisplaySeen(id: string, now = Date.now()): void {
  const p = state.paired;
  if (p === null || p.id !== id) return;
  const wasConnected = state.wasConnected;
  p.lastSeenAt = now;
  /* T206: a beat is later than any close this process has seen, so the
   *  close no longer decides. */
  state.lastClosedAt = null;
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
  clearAbandonTimer();
  /* T241: a card typed on a screen that is no longer paired is nobody's. */
  dropAllDisplayCards("display unpaired");
  state.wasConnected = false;
  state.streamOpen = 0;
  state.lastClosedAt = null;
  await boundedDb(deleteDisplay(p.id), TABLE_WAIT_MS, false);
  emit("display", "idle", {});
  emit("teacher", "disconnected", { paired: false, connected: false });
  console.log(`[display] unpaired ${p.id}`);
  return true;
}

/* --- Requests -------------------------------------------------------- */

/** T204: whether a request is a student's own sign-up, which is what
 *  makes the screen's busy answer word itself differently. */
export function isSelfServeSignup(r: DisplayRequest | null): boolean {
  return r !== null && r.kind === "register" && r.initiator === "display";
}

function clearAbandonTimer(): void {
  if (state.abandonTimer !== null) {
    clearTimeout(state.abandonTimer);
    state.abandonTimer = null;
  }
}

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
    markClosed(c.id);
    dropDisplayCard(c.id, "request expired");
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
      /* T241 review: which version of this request the screen is
       * showing, for an approve ticket's answer to name. */
      version: request.version ?? 1,
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
  /** T241: the id of the APPROVE ticket this present replaces in place.
   *  The student picked another way to pay on it, the teacher's iPad
   *  moved the tender, and the approval is asked again with the new one
   *  without the screen blinking to idle (and without letting go of a
   *  card the student typed on it). Only a pending approve ticket with
   *  exactly this id is replaced; anything else is the ordinary rule. */
  replaces?: string;
  now?: number;
}): Promise<
  | { ok: true; request: DisplayRequest; replaced: boolean }
  | {
      ok: false;
      status: number;
      error: string;
      reason: "unpaired" | "disconnected" | "busy" | "gone";
      /** T204: true when what holds the screen is a student's own
       *  self-serve sign-up, which is the one case the teacher's screen
       *  words differently ("Someone is signing up on the customer
       *  screen") and offers Take over for. */
      holdingSignup?: boolean;
    }
> {
  await ensureDisplayLoaded();
  const now = input.now ?? Date.now();
  expireIfDue(now);
  sweepDisplayCards(now);
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
  /* T241 second review (E): `replaces` asks the approval again IN PLACE
   * and nothing else. When it no longer names a pending approve ticket
   * this tab owns (the student cancelled, it was approved, or it went),
   * there is nothing to re-ask, and presenting a fresh approval here
   * would put one up that no teacher tapped for. */
  if (
    input.kind === "ticket" &&
    typeof input.replaces === "string" &&
    !(
      held !== null &&
      held.status === "pending" &&
      held.id === input.replaces &&
      isApproveTicket(held.kind, held.payload) &&
      sameTicketOwner(held, input)
    )
  ) {
    return {
      ok: false,
      status: 409,
      reason: "gone",
      error:
        "The approval ended before it could be asked again. Finalize again to ask the customer.",
    };
  }
  /* T242: a "Your passes" scene moves through its modes (the offer,
   * working, done, help) in place, for the tab that put it up: the
   * student watches their list become "One moment" and then "Done"
   * rather than seeing it blink to Ready between writes. Another tab, or
   * another kind of scene, meets the ordinary rule below ("busy"). */
  if (
    held !== null &&
    held.status === "pending" &&
    input.kind === "passes" &&
    held.kind === "passes" &&
    sameTicketOwner(held, input)
  ) {
    held.payload = input.payload;
    held.private = input.private ?? {};
    /* T242 review: a NEW offer (the teacher's iPad offering the list
     * again, or the next student's on the same tab) is a fresh question:
     * the last pick belongs to the offer it was made on, and left here it
     * would refuse the next tap as "already checking you in". */
    if (input.payload.mode === "offer") held.passPick = null;
    held.version = (held.version ?? 1) + 1;
    held.presentedAt = now;
    held.expiresAt = now + (input.ttlMs ?? PASSES_TTL_MS);
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
    const replacingApproval =
      input.kind === "ticket" &&
      typeof input.replaces === "string" &&
      input.replaces === held.id &&
      isApproveTicket(held.kind, held.payload) &&
      input.payload.mode === "approve";
    /* T241 review: a ticket belongs to the teacher and the TAB that put
     * it up. Two Cart screens on one counter used to replace each
     * other's live ticket in place, sharing one request id, so a
     * student's pick moved both iPads' tenders and a card typed for one
     * could be charged by the other. Another presenter is now "busy",
     * like any other scene, unless the live ticket has gone stale (a
     * closed tab), when it is retired and a new request goes up. */
    const sameOwner = sameTicketOwner(held, input);
    if (
      input.kind === "ticket" &&
      isLiveTicket(held.kind, held.payload) &&
      !sameOwner &&
      now - (held.presentedAt ?? held.createdAt) > LIVE_STALE_MS
    ) {
      retire(held, now, "live ticket left by another iPad");
    } else if (
      input.kind === "ticket" &&
      sameOwner &&
      (isLiveTicket(held.kind, held.payload) || replacingApproval)
    ) {
      /* T241: a card the student typed belongs to THIS ticket. A present
       * that changes what is being bought or for whom lets go of it; one
       * that only changes the tender words or the offer (the pick being
       * answered) keeps it. */
      const before = ticketKey(held.payload, held.private);
      held.payload = input.payload;
      /* T203: the SERVER-ONLY half moves with the payload. An approve
       * ticket replaces a live one in place (the design's rule for every
       * non-live scene that follows a mirror), and its private half
       * carries the cart's sha256 and the client id that /api/checkout
       * checks the approval against. Left behind, the approval would
       * name the ticket that was on the screen before it. */
      held.private = input.private ?? {};
      if (ticketKey(held.payload, held.private) !== before) {
        dropDisplayCard(held.id, "ticket changed");
      }
      held.pickOpen = true;
      held.version = (held.version ?? 1) + 1;
      if (replacingApproval) held.approveReplaced = true;
      held.presentedAt = now;
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
  }
  if (state.current !== null && state.current.status === "pending") {
    const held = state.current;
    const signupHolds = isSelfServeSignup(held);
    return {
      ok: false,
      status: 409,
      reason: "busy",
      holdingSignup: signupHolds,
      error: signupHolds
        ? "Someone is signing up on the customer screen."
        : "The customer display is already showing something.",
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
    pickOpen: true,
    pick: null,
    version: 1,
    presentedAt: now,
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
  opts: {
    takenOver?: boolean;
    abandoned?: boolean;
    /** T241 second review (N3): a cancel from a TEACHER's iPad, which
     *  names its tab. It may not take down a ticket another tab owns,
     *  except a live mirror on an explicit Take over (the mirror is
     *  informational; an approval is a student mid-answer and is never
     *  taken). The hub's own cancels (an abandoned sign-up) pass none. */
    teacher?: { presenter: string | null; requestId?: string };
  } = {},
): Promise<{ cancelled: boolean; foreign?: boolean }> {
  await ensureDisplayLoaded();
  expireIfDue(now);
  const c = state.current;
  if (c === null || c.status !== "pending") {
    /* Nothing up. Still push idle: a display that somehow held a stale
     * scene must end up where the server says it is. */
    emit("display", "idle", {});
    return { cancelled: false };
  }
  if (opts.teacher !== undefined) {
    /* A cancel for one request (the pagehide cancel) touches no other. */
    if (
      opts.teacher.requestId !== undefined &&
      opts.teacher.requestId !== c.id
    ) {
      return { cancelled: false };
    }
    /* T242: a passes scene belongs to its tab the way a ticket does. */
    const owner =
      c.kind === "ticket" || c.kind === "passes" ? c.private.presenter : undefined;
    if (typeof owner === "string" && owner !== opts.teacher.presenter) {
      if (!(opts.takenOver === true && isLiveTicket(c.kind, c.payload))) {
        return { cancelled: false, foreign: true };
      }
      /* Taken over: the owner's mirror is told it is no longer up. */
      emit("teacher", "ticket-retired", { requestId: c.id, presenter: owner });
    }
  }
  c.status = "cancelled";
  c.completedAt = now;
  state.current = null;
  clearExpiryTimer();
  clearAbandonTimer();
  /* T241: the ticket a student's card was typed for is gone. */
  markClosed(c.id);
  dropDisplayCard(c.id, "request cancelled");
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
    /* T204: an abandoned sign-up is not an apology, it is a screen
     * going back to Ready with nothing kept. */
    ...(opts.abandoned === true ? { abandoned: true } : {}),
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
  /** T241 review: the version of the scene the student answered, for an
   *  approve ticket, which can now be replaced in place. */
  version?: unknown,
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
  /* An Approve is for the ticket the student READ. An approve ticket
   * replaced in place since (a pick answered) is a different ticket, so
   * a tap on the old one is refused and the screen already shows the new
   * one. A display page from before versions sends none, which is only
   * accepted while the approval has never been replaced by another. */
  if (isApproveTicket(c.kind, c.payload)) {
    const current = c.version ?? 1;
    const named = typeof version === "number" ? version : null;
    if (named === null ? c.approveReplaced === true : named !== current) {
      return {
        ok: false,
        status: 409,
        error: "The ticket changed. Please check it and approve again.",
      };
    }
  }
  c.status = "completed";
  c.result = result;
  c.completedAt = now;
  /* T204: the student finished, so the abandon clock stops; and a
   * self-serve sign-up goes into the tray's own map, because the next
   * scene will take `current` and the teacher has not met this one
   * yet. */
  clearAbandonTimer();
  if (isSelfServeSignup(c)) {
    state.signups.set(c.id, c);
    emitSignups(now);
  }
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
  clearAbandonTimer();
  /* T241 review: a student who cancels the approval withdraws the card
   * they typed on it; a PIN-approved charge must not still find it. */
  markClosed(c.id);
  dropDisplayCard(c.id, "refused by the customer");
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

/* --- T241: the student chooses how to pay ----------------------------- */

/**
 * What a present's ticket IS, for deciding whether a card typed on it
 * still belongs to it: the lines, the discount, the first name and the
 * client the server recorded. Deliberately NOT the tender words, the
 * offer or the totals (a total goes null while Mindbody reprices).
 */
/** How long one pick holds the offer shut with no new present. */
const PICK_HOLD_MS = 10_000;

/** T241 review: how long another iPad's live ticket must have gone
 *  without a present before this one may retire it. A Cart screen being
 *  used re-presents on every priced change; two minutes of nothing is a
 *  tab that closed without cancelling. */
const LIVE_STALE_MS = 2 * 60 * 1000;

/** T241 review: whether `input` comes from the teacher and the tab that
 *  put `held` up. A request from before presenters existed (no
 *  presenter on its private half) belongs to whoever presents next, as
 *  it always did. */
function sameTicketOwner(
  held: DisplayRequest,
  input: { private?: Record<string, unknown>; requestedByStaffId: string | null },
): boolean {
  const owner = held.private.presenter;
  if (typeof owner === "string" && owner !== input.private?.presenter) {
    return false;
  }
  if (
    held.requestedByStaffId !== null &&
    input.requestedByStaffId !== null &&
    held.requestedByStaffId !== input.requestedByStaffId
  ) {
    return false;
  }
  return true;
}

/** T241 review: retire a stale live ticket so another iPad's can go up.
 *  Quietly: the new present follows at once, so no idle is pushed. */
function retire(held: DisplayRequest, now: number, why: string): void {
  held.status = "cancelled";
  held.completedAt = now;
  state.current = null;
  clearExpiryTimer();
  markClosed(held.id);
  dropDisplayCard(held.id, why);
  /* Second review (N3): not silent to its owner. That tab's mirror is
   * told it is no longer showing, so it says so and stops believing a
   * pick or a card on that request could still be its own. */
  const owner = held.private.presenter;
  emit("teacher", "ticket-retired", {
    requestId: held.id,
    ...(typeof owner === "string" ? { presenter: owner } : {}),
  });
  void boundedDb(
    updateDisplayRequest({
      id: held.id,
      status: "cancelled",
      result: null,
      completedAt: new Date(now),
    }),
    TABLE_WAIT_MS,
    false,
  );
}

function ticketKey(
  payload: Record<string, unknown>,
  priv: Record<string, unknown>,
): string {
  /* Not the discount: it goes null while Mindbody reprices, like the
   * totals. A discount armed or changed on the teacher's iPad clears its
   * tender lines, and the card leaves with its line (the release). */
  return JSON.stringify([
    payload.lines ?? null,
    payload.clientFirstName ?? null,
    priv.clientId ?? null,
  ]);
}

/** The ticket a pick may be made on: this display's current, pending
 *  live or approve ticket, with its offer still open. */
function pickable(
  displayId: string,
  requestId: string,
  now: number,
): { ok: true; request: DisplayRequest } | { ok: false; status: number; error: string } {
  expireIfDue(now);
  const c = state.current;
  if (c === null || c.id !== requestId || c.displayId !== displayId) {
    return { ok: false, status: 409, error: "That is not the current ticket." };
  }
  if (
    c.status !== "pending" ||
    c.kind !== "ticket" ||
    (c.payload.mode !== "live" && c.payload.mode !== "approve")
  ) {
    return {
      ok: false,
      status: 409,
      error: "How you pay cannot be changed now.",
    };
  }
  /* One offer, one pick, while the teacher's iPad answers it. A pick it
   * refused moves nothing and so presents nothing new; after a few
   * seconds the student may try again rather than be stuck. */
  if (c.pickOpen === false && c.pick != null && now - c.pick.at < PICK_HOLD_MS) {
    return {
      ok: false,
      status: 409,
      error: "The front desk is already changing that.",
    };
  }
  return { ok: true, request: c };
}

function recordPick(
  c: DisplayRequest,
  pick: Omit<TenderPick, "pickId" | "requestId" | "at">,
  now: number,
): TenderPick {
  const presenter = c.private.presenter;
  const full: TenderPick = {
    pickId: randomBytes(9).toString("base64url"),
    requestId: c.id,
    at: now,
    ...(typeof presenter === "string" ? { presenter } : {}),
    ...pick,
  };
  c.pick = full;
  c.pickOpen = false;
  /* The teacher's iPad hears it on its events stream, and the approval
   * poll carries it too (`pickFor`), so a dropped stream during an
   * approval does not lose it. A key, a last four and a yes/no: nothing
   * a card could be rebuilt from. */
  emit("teacher", "tender-pick", { ...full });
  return full;
}

/**
 * The student picked a way to pay that needs no card typed on this
 * screen. Refused unless the SERVER's stored offer for this ticket has
 * it. Nothing is written anywhere but memory, and nothing is charged:
 * the teacher's iPad moves its own tender when it hears this.
 */
export async function chooseTender(
  displayId: string,
  requestId: string,
  choice: unknown,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await ensureDisplayLoaded();
  if (!isTenderChoice(choice)) {
    return { ok: false, status: 400, error: "That is not a way to pay." };
  }
  if (choice === "typedcard") {
    return {
      ok: false,
      status: 400,
      error: "A card is entered on its own form.",
    };
  }
  const found = pickable(displayId, requestId, now);
  if (!found.ok) return found;
  if (offerOf(found.request.payload, choice) === null) {
    return {
      ok: false,
      status: 409,
      error: "That way to pay is not offered for this ticket.",
    };
  }
  recordPick(found.request, { choice }, now);
  return { ok: true };
}

/**
 * The student typed a card on this screen ("A different card"). It is
 * validated by the caller with T93's own parser, held in MEMORY on this
 * request for one charge (src/lib/displaycard.ts), and the teacher's
 * iPad is told its last four. The display is told nothing back about it.
 */
export async function chooseTypedCard(
  displayId: string,
  requestId: string,
  card: TypedCard,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await ensureDisplayLoaded();
  const found = pickable(displayId, requestId, now);
  if (!found.ok) return found;
  const offer = offerOf(found.request.payload, "typedcard");
  if (offer === null) {
    return {
      ok: false,
      status: 409,
      error: "That way to pay is not offered for this ticket.",
    };
  }
  /* "Save this card" only where the teacher's iPad said a client is
   * there to keep it for; anything else is used once. */
  const keep = card.keep === true && offer.keep === true;
  const priv = found.request.private;
  /* Bound to the client, the teacher and the tab the ticket belongs to,
   * so no other iPad's checkout can claim it (T241 review). */
  const held = holdDisplayCard({
    requestId: found.request.id,
    card: { ...card, keep },
    clientId: typeof priv.clientId === "string" ? priv.clientId : "",
    staffId: found.request.requestedByStaffId ?? "",
    presenter: typeof priv.presenter === "string" ? priv.presenter : "",
    ttlMs: REQUEST_TTL_MS,
    now,
  });
  if (!held.ok) return { ok: false, status: 409, error: held.error };
  recordPick(
    found.request,
    { choice: "typedcard", lastFour: held.lastFour, keep },
    now,
  );
  return { ok: true };
}

/* --- T242: the student picks one of their own passes ----------------- */

/**
 * The student tapped "Use this pass" on a "Your passes" scene. The key
 * must be one the SERVER stored on this scene's offer (the private half,
 * which the display never sees), the scene must still be offering, and
 * one offer buys one pick: the scene moves to `working` here and now, so
 * a second tap, from either side, cannot pick again. The teacher's iPad
 * is told which ClientService the key stood for and runs the two writes
 * itself, under the teacher's token. NOTHING HERE CALLS MINDBODY.
 */
export async function choosePass(
  displayId: string,
  requestId: string,
  key: unknown,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await ensureDisplayLoaded();
  expireIfDue(now);
  if (typeof key !== "string" || key.length === 0 || key.length > 64) {
    return { ok: false, status: 400, error: "That is not one of your passes." };
  }
  const c = state.current;
  if (c === null || c.id !== requestId || c.displayId !== displayId) {
    return { ok: false, status: 409, error: "That is not the current screen." };
  }
  if (c.status !== "pending" || c.kind !== "passes") {
    return { ok: false, status: 409, error: "That is not the current screen." };
  }
  if (c.payload.mode !== "offer" || c.passPick != null) {
    return {
      ok: false,
      status: 409,
      error: "The front desk is already checking you in.",
    };
  }
  const offer = c.private.offer;
  const clientServiceId =
    offer !== null && typeof offer === "object" && !Array.isArray(offer)
      ? (offer as Record<string, unknown>)[key]
      : undefined;
  if (typeof clientServiceId !== "number" || !Number.isInteger(clientServiceId)) {
    return { ok: false, status: 409, error: "That is not one of your passes." };
  }
  const line = Array.isArray(c.payload.passes)
    ? (c.payload.passes as unknown[]).find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as Record<string, unknown>).key === key,
      )
    : undefined;
  const passName =
    line !== undefined &&
    typeof (line as Record<string, unknown>).name === "string"
      ? ((line as Record<string, unknown>).name as string)
      : null;
  const presenter = c.private.presenter;
  const pick: PassPick & { at: number } = {
    pickId: randomBytes(9).toString("base64url"),
    requestId: c.id,
    clientServiceId,
    ...(typeof presenter === "string" ? { presenter } : {}),
    at: now,
  };
  c.passPick = pick;
  /* The offer closes on the student's screen at once: first tap wins. */
  c.payload = {
    mode: "working",
    clientFirstName: c.payload.clientFirstName ?? null,
    passes: [],
    passName,
  };
  c.version = (c.version ?? 1) + 1;
  /* T242 review: "One moment" holds a minute at most, as the teacher's
   * own `working` present does, so a student is never left on it if the
   * teacher's iPad never hears the pick. */
  c.expiresAt = now + PASSES_WORKING_TTL_MS;
  armExpiry(c, now);
  void boundedDb(
    updateDisplayRequestPayload(
      c.id,
      { ...c.payload, [PRIVATE_KEY]: c.private },
      new Date(c.expiresAt),
    ),
    TABLE_WAIT_MS,
    false,
  );
  const scene = sceneFor(c);
  emit("display", scene.event, scene.data);
  /* The teacher's iPad hears it on its events stream, and its poll of
   * /api/display/passes carries it too, so a dropped stream does not
   * lose it. An id the teacher's own list holds, and nothing else. */
  const { at: _at, ...wire } = pick;
  emit("teacher", "pass-pick", { ...wire });
  return { ok: true };
}

/** T242: the student's pass pick on a passes scene, for the teacher's
 *  poll, while that scene is the current one. */
export function passPickFor(requestId: string): {
  status: DisplayRequestStatus | "gone";
  mode: string | null;
  pick: PassPick | null;
} {
  const c = state.current;
  if (c === null || c.id !== requestId || c.kind !== "passes") {
    return { status: "gone", mode: null, pick: null };
  }
  const held = c.passPick ?? null;
  let pick: PassPick | null = null;
  if (held !== null) {
    const { at: _at, ...wire } = held;
    pick = wire;
  }
  return {
    status: c.status,
    mode: typeof c.payload.mode === "string" ? c.payload.mode : null,
    pick,
  };
}

/** T241: the last pick on a request, for the approval poll. */
export function pickFor(requestId: string): TenderPick | null {
  const c = state.current;
  if (c !== null && c.id === requestId) return c.pick ?? null;
  return null;
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
   * the same on one instance.
   *
   * T208: through `loadRequest`, which is now the ONE resolver. It used
   * to prefer `state.current` outright, so a stale scene left over from
   * an earlier build (the hub survives a recompile on globalThis) made
   * this answer null for a request the tray was listing from the table:
   * the row could not be created and could not be cleared. */
  const c = await loadRequest(requestId, now);
  if (c === null) return null;
  if (c.status !== "completed" || c.consumedAt !== null) return null;
  if (now >= c.expiresAt) return null;
  /* Memory is spent FIRST (T202 review): the release, the receipt and
   * the upload have already happened by the time this runs, so a table
   * that does not answer must not leave the handle spendable for a retry
   * in this process. The row is marked best effort behind it; a miss is
   * logged, and the residual is one restart inside the 30 minutes. */
  c.consumedAt = now;
  markSpent(c.id);
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
  /* T204: spent is spent: it leaves the tray in the same breath. */
  if (state.signups.delete(c.id)) emitSignups(now);
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

/** Whichever memory holds this request: the scene on the screen, or the
 *  tray's own map. Both can hold it, and after T204 they hold the same
 *  object; after a restart or a recompile they can hold different ones. */
function memoryRequest(requestId: string): DisplayRequest | null {
  if (state.current !== null && state.current.id === requestId) {
    return state.current;
  }
  return state.signups.get(requestId) ?? null;
}

/** Still spendable: nobody has consumed it and its clock has not run
 *  out. Status is the caller's business; this is about the handle. */
function usable(r: DisplayRequest, now: number): boolean {
  return r.consumedAt === null && now < r.expiresAt;
}

/**
 * One request by id, from wherever it is freshest (T202, rewritten in
 * T208). Never throws; null is "there is no such request here".
 *
 * Three stores can hold a request -- the scene on the screen, the
 * tray's map and the `display_requests` row -- and Pete's second drive
 * found them disagreeing: the tray listed a sign-up from the table that
 * `/api/client-create` refused as "no longer waiting" and that Clear
 * answered `cleared: false` for, because this read `state.current`
 * first and that object was stale. So the rule is now one rule, and
 * `pendingSignups`, `signupById`, `consumeRequest`, `/api/checkout`'s
 * approval and `/api/display/approval` all come through here:
 *
 * - **A handle this process SPENT is spent**, whatever the table says.
 *   It is consumed in memory first on purpose (T202 review), so a table
 *   write that missed must not hand it back. `state.spent` is the
 *   record of that, and the answer is the CONSUMED copy rather than
 *   null (T208 review), so a caller that has a sentence for "already
 *   used" says it, in this process and after a restart alike.
 * - Otherwise a memory copy that is still USABLE answers at once: it is
 *   the scene on the screen or the tray's own map, and a round trip to
 *   the table would put a database on the checkout path.
 * - Otherwise **the TABLE decides when it answers** (T208 review).
 *   Memory holding a stale or a consumed-looking copy is exactly the
 *   disagreement this rewrite exists for: a hub object left on
 *   globalThis by an earlier build, or a row re-seeded into memory and
 *   since moved on. Memory is the fallback only when there is no
 *   database or it did not answer.
 * - With nothing found anywhere, null.
 */
export async function loadRequest(
  requestId: string,
  now = Date.now(),
): Promise<DisplayRequest | null> {
  await ensureDisplayLoaded();
  const mem = memoryRequest(requestId);
  const spent = state.spent.has(requestId);
  if (!spent && mem !== null && usable(mem, now)) return mem;
  const row = dbConfigured()
    ? await boundedDb(findDisplayRequestById(requestId), TABLE_WAIT_MS, null)
    : null;
  const stored = row === null ? null : fromRow(row);
  const found = stored ?? mem;
  if (found === null) return null;
  if (spent && found.consumedAt === null) {
    /* Spent here, and the store answering has not caught up. Say
     * CONSUMED, on a copy, so nothing in memory is mutated by a read. */
    return { ...found, consumedAt: now };
  }
  return found;
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

/* --- T204: the self-serve sign-up ------------------------------------ */

/** What the tray shows: a name and a moment, and nothing else. The
 *  student's email and phone are on the request and are served only to
 *  the one route a signed-in teacher opens a prefilled form from. */
export interface PendingSignup {
  requestId: string;
  firstName: string;
  lastName: string;
  completedAt: string | null;
}

function nameOf(request: DisplayRequest, key: "firstName" | "lastName"): string {
  const form = request.result?.["form"];
  if (form === null || typeof form !== "object" || Array.isArray(form)) return "";
  const v = (form as Record<string, unknown>)[key];
  return typeof v === "string" ? v.slice(0, 60) : "";
}

function asPendingSignup(request: DisplayRequest): PendingSignup {
  return {
    requestId: request.id,
    firstName: nameOf(request, "firstName"),
    lastName: nameOf(request, "lastName"),
    completedAt:
      request.completedAt === null
        ? null
        : new Date(request.completedAt).toISOString(),
  };
}

/**
 * THE predicate for "a sign-up a teacher may act on" (T208). The tray's
 * list, the by-id lookup and the create all ask it, so the tray can
 * never show a row the routes behind it will refuse.
 */
function liveSignup(r: DisplayRequest, now: number): boolean {
  return (
    isSelfServeSignup(r) &&
    r.status === "completed" &&
    r.consumedAt === null &&
    !state.spent.has(r.id) &&
    now < r.expiresAt
  );
}

/** The teacher's stream hears the count and the names, never a result.
 *  Memory only: this is the immediate half, and the tray's 30 second
 *  poll of /api/display/signups is what makes it right after a restart
 *  or a dropped stream. */
function emitSignups(now: number): void {
  const list = memorySignups(now);
  emit("teacher", "signups", { count: list.length, signups: list });
}

function memorySignups(now: number): PendingSignup[] {
  const out: PendingSignup[] = [];
  for (const [id, r] of state.signups) {
    if (!liveSignup(r, now)) {
      state.signups.delete(id);
      continue;
    }
    out.push(asPendingSignup(r));
  }
  return out.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
}

/**
 * Every sign-up waiting for a teacher: what the tray lists, what the
 * badge counts, and what walk-in search matches a typed name against.
 *
 * Memory first, the table beside it when there is one, merged by id, so
 * a result survives a restart (the one reason `display_requests`
 * exists) and a counter with no database still has its tray for as long
 * as the process lives. Expired ones are excluded here and swept from
 * the table by the ordinary sweep.
 */
export async function pendingSignups(
  now = Date.now(),
): Promise<PendingSignup[]> {
  await ensureDisplayLoaded();
  const byId = new Map<string, PendingSignup>();
  for (const one of memorySignups(now)) byId.set(one.requestId, one);
  if (dbConfigured()) {
    const rows = await boundedDb(
      listSelfServeSignups(new Date(now)),
      TABLE_WAIT_MS,
      [] as DisplayRequestRow[],
    );
    for (const row of rows) {
      if (byId.has(row.id)) continue;
      const r = fromRow(row);
      if (r === null || !liveSignup(r, now)) continue;
      /* Back into memory, so the tray keeps working if the table stops
       * answering a moment later. */
      state.signups.set(r.id, r);
      byId.set(r.id, asPendingSignup(r));
    }
  }
  return [...byId.values()].sort((a, b) =>
    (a.completedAt ?? "").localeCompare(b.completedAt ?? ""),
  );
}

/** One waiting sign-up by id, for the route that prefills the teacher's
 *  form. Null when it is not a completed, unconsumed, unexpired
 *  self-serve sign-up, which is every case a teacher may not open. */
export async function signupById(
  requestId: string,
  now = Date.now(),
): Promise<DisplayRequest | null> {
  /* T208: `loadRequest` is the one resolver and `liveSignup` the one
   * predicate, so this answers for exactly the rows `pendingSignups`
   * lists. It used to read `state.signups` first and fall back to a
   * `loadRequest` that preferred `state.current`, which is how a listed
   * row could answer null here. */
  const held = await loadRequest(requestId, now);
  if (held === null || !liveSignup(held, now)) return null;
  return held;
}

/**
 * The tray's "Clear" (T204, rewritten in T208). Spends the handle
 * UNCONDITIONALLY: the row leaves memory, the id is remembered as
 * spent, and the table row is marked consumed by id even when nothing
 * here could be resolved to a live request.
 *
 * Pete's second drive: "i can't clear the failed one from the previous
 * build." Clear used to consume only what the by-id lookup returned, so
 * a row the list showed and the lookup did not resolve answered
 * `cleared: false` and came back on the next poll, forever. A teacher
 * tapping Clear is telling us nobody is coming; the only honest answer
 * is that it is gone.
 *
 * Nothing here reaches Mindbody: no client is created and no waiver is
 * filed. `marked` says whether the row was marked in the table, for the
 * log.
 */
export async function clearSignup(
  requestId: string,
  now = Date.now(),
): Promise<{ cleared: boolean; marked: boolean; wrongKind: boolean }> {
  await ensureDisplayLoaded();
  /* T208 review: unconditional is about a row nothing can RESOLVE, not
   * about any id at all. A waiver, a ticket approval or a contract
   * signature is a different scene with a different route to finish it,
   * and spending one here would take it off the screen from under the
   * student. So a request that resolves to something other than a
   * self-serve sign-up is refused with nothing spent; only an id no
   * store can account for is spent on the teacher's word. */
  const held = await loadRequest(requestId, now);
  if (held !== null && !isSelfServeSignup(held)) {
    return { cleared: false, marked: false, wrongKind: true };
  }
  markSpent(requestId);
  const mem = memoryRequest(requestId);
  if (mem !== null && mem.consumedAt === null) mem.consumedAt = now;
  state.signups.delete(requestId);
  if (state.current !== null && state.current.id === requestId) {
    state.current = null;
    clearExpiryTimer();
    clearAbandonTimer();
    emit("display", "idle", {});
  }
  const marked = dbConfigured()
    ? await boundedDb(consumeDisplayRequest(requestId), TABLE_WAIT_MS, false)
    : false;
  emitSignups(now);
  return { cleared: true, marked, wrongKind: false };
}

/**
 * The student started it themselves (`POST /api/display/start`). The
 * same request, the same table and the same hub as a scene a teacher
 * puts up; what differs is the initiator, the four hour life of an
 * unconsumed result, and the abandon clock below.
 *
 * Refused when a request is already in progress: only one thing holds
 * the screen at a time, which is the guard that keeps two flows from
 * both believing they own the display.
 */
export async function startSignup(input: {
  displayId: string;
  payload: Record<string, unknown>;
  private?: Record<string, unknown>;
  now?: number;
}): Promise<
  | { ok: true; request: DisplayRequest }
  | { ok: false; status: number; error: string; reason: "unpaired" | "busy" }
> {
  await ensureDisplayLoaded();
  const now = input.now ?? Date.now();
  expireIfDue(now);
  const p = state.paired;
  if (p === null || p.id !== input.displayId) {
    return {
      ok: false,
      status: 401,
      reason: "unpaired",
      error: "This screen is not paired.",
    };
  }
  const held = state.current;
  if (held !== null && held.status === "pending") {
    return {
      ok: false,
      status: 409,
      reason: "busy",
      error: "The front desk is using this screen. Please try again shortly.",
    };
  }
  const request: DisplayRequest = {
    id: randomBytes(12).toString("base64url"),
    displayId: p.id,
    kind: "register",
    initiator: "display",
    payload: input.payload,
    private: input.private ?? {},
    status: "pending",
    result: null,
    reason: null,
    /* Nobody put this up, so nobody's staff id is on it. The teacher who
     * eventually creates the client is named by their own token on the
     * write, which is the attribution that matters. */
    requestedByStaffId: null,
    createdAt: now,
    completedAt: null,
    consumedAt: null,
    expiresAt: now + signupTtlMs(),
  };
  state.current = request;
  clearExpiryTimer();
  armAbandon(now);
  void boundedDb(
    insertDisplayRequest({
      id: request.id,
      displayId: request.displayId,
      kind: request.kind,
      initiator: request.initiator,
      payload:
        Object.keys(request.private).length === 0
          ? request.payload
          : { ...request.payload, [PRIVATE_KEY]: request.private },
      status: request.status,
      result: null,
      requestedByStaffId: null,
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
  console.log(`[display] self-serve sign-up started ${request.id}`);
  return { ok: true, request };
}

/** The abandon clock. Re-armed by every touch; it fires once and, when
 *  the student really has stopped, cancels the sign-up with
 *  `abandoned: true` so the screen goes back to idle with nothing kept. */
function armAbandon(now: number): void {
  clearAbandonTimer();
  state.lastTouch = now;
  const window = signupAbandonMs();
  /* The request this clock belongs to. A timer from an EARLIER sign-up
   * (a dev recompile, a re-pair, anything that replaced `current`
   * without going through cancel) must not be able to end a later one:
   * it checks the id it was armed for and clears only its own handle. */
  const armedFor = state.current?.id ?? "";
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (state.abandonTimer === timer) state.abandonTimer = null;
    const c = state.current;
    if (c === null || c.status !== "pending" || !isSelfServeSignup(c)) return;
    if (c.id !== armedFor) return;
    if (Date.now() - state.lastTouch < window) {
      /* A touch landed while this was in flight; the touch re-arms. */
      return;
    }
    console.log(`[display] self-serve sign-up ${c.id} abandoned`);
    void cancelRequest(Date.now(), { abandoned: true });
  }, window);
  (timer as unknown as { unref?: () => void }).unref?.();
  state.abandonTimer = timer;
}

/** The student is still there (`POST /api/display/touch`). Throttled to
 *  once every 20 seconds by the screen itself; this only re-arms. */
export function touchSignup(
  displayId: string,
  requestId: string,
  now = Date.now(),
): boolean {
  const c = state.current;
  if (
    c === null ||
    c.id !== requestId ||
    c.displayId !== displayId ||
    c.status !== "pending" ||
    !isSelfServeSignup(c)
  ) {
    return false;
  }
  armAbandon(now);
  return true;
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
