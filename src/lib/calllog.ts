/**
 * A ring buffer of recent Mindbody calls, for the dev drawer.
 *
 * This records on the SERVER, where the calls actually happen, so it shows
 * the real request body and the real response rather than what our own API
 * routes chose to pass on. That distinction is the whole point: most of the
 * time lost on this project went to guessing what Mindbody received and
 * what it said back.
 *
 * Off unless explicitly enabled. The entries contain client names, visit
 * ids and booking details, which is fine on a developer's laptop and not
 * fine sitting behind an unauthenticated endpoint at the counter.
 */

export interface CallRecord {
  id: number;
  at: string;
  method: string;
  path: string;
  /** HTTP status, or null when the call was suppressed before being sent. */
  status: number | null;
  ms: number;
  /** "sent", "dry-run", or "write-guard". */
  outcome: string;
  /** T49: the staff id whose token the call went out under, when a
   *  signed-in teacher's rather than the service account's; null for
   *  the service account and for suppressed calls. Never the token. */
  actor: number | null;
  requestBody: string | null;
  responseBody: string | null;
}

export function devtoolsEnabled(): boolean {
  return (
    process.env["POS_DEVTOOLS"] === "true" ||
    process.env.NODE_ENV === "development"
  );
}

/* 60 was too few to diagnose anything after the fact: by the time a
 * teacher reaches the drawer, the call that misbehaved has usually been
 * pushed out by the roster refreshes since (Pete, fifth live test, on a
 * search that rendered every row nameless and could not be chased). At
 * the clip below this is a few MB in the worst case and far less in
 * practice, on a dev-only buffer. */
const LIMIT = 300;
/** Bodies are truncated: a full client page is 200 records of JSON and
 *  nobody reads that in a drawer. */
const BODY_LIMIT = 6000;

/* The buffer lives on globalThis, not in module scope (Pete, 2026-09-02:
 * the drawer emptied after a browser refresh with no restart). In `next
 * dev` a route is compiled lazily on first hit and a recompile can
 * instantiate this module afresh, so a module-level array is a NEW empty
 * array for the next route that imports it. The global survives every
 * recompile for the life of the process, which is the lifetime the
 * drawer promises. Production bundles once and sees no difference. */
interface CallLogState {
  entries: CallRecord[];
  nextId: number;
}
const G = globalThis as typeof globalThis & { __posCallLog?: CallLogState };
const state: CallLogState = (G.__posCallLog ??= { entries: [], nextId: 1 });

function clip(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > BODY_LIMIT
    ? `${text.slice(0, BODY_LIMIT)}\n... [${text.length - BODY_LIMIT} more chars]`
    : text;
}

/** Bodies arrive as objects or text; clip() renders whichever. */
export interface CallInput extends Omit<CallRecord, "id" | "at" | "requestBody" | "responseBody"> {
  requestBody?: unknown;
  responseBody?: unknown;
}

export function record(entry: CallInput): void {
  if (!devtoolsEnabled()) return;
  state.entries.unshift({
    ...entry,
    id: state.nextId++,
    at: new Date().toISOString(),
    requestBody: clip(entry.requestBody),
    responseBody: clip(entry.responseBody),
  });
  if (state.entries.length > LIMIT) state.entries = state.entries.slice(0, LIMIT);
}

/** Records newer than `since`, newest first. */
export function recent(since = 0): CallRecord[] {
  return state.entries.filter((e) => e.id > since);
}

export function clear(): void {
  state.entries = [];
}
