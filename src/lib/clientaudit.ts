import { AsyncLocalStorage } from "node:async_hooks";

import { scrubSecrets } from "./calllog";
import {
  CLIENT_ID_READ_LIMIT,
  logClientPick,
  pickClientRecord,
} from "./clientrecord";
import {
  boundedDb,
  dbConfigured,
  insertClientWrite,
  listClientWrites,
  type ClientWriteRow,
} from "./db";
import {
  mindbody,
  mindbodyEnv,
  mindbodyHttpStatus,
  target,
  type Actor,
} from "./mindbody";

/**
 * T116: a durable record of every write this app makes to a client
 * record.
 *
 * Pete, 2026-09-25: a student's notes and alert were found blank in
 * Mindbody. The dev drawer's call log is in memory and a deploy restart
 * had wiped it, and a successful notes or alert save left no line in the
 * server log, so nobody could say whether the app had done it. He
 * believes it was Mindbody, not us; this is what makes that answerable
 * next time instead of a matter of belief.
 *
 * Every `POST /client/updateclient` goes through `updateClientAudited`
 * below (notes, the two alerts, the email opt-ins, a card, a waiver
 * release, the T62 notes append and the waiver receipt append), and each
 * one produces:
 *
 * - ONE `[client-write]` line on the server console, always, a single
 *   line of JSON, written BEFORE anything touches the database. Railway
 *   keeps the console, and a database that is down must not be able to
 *   take the record with it.
 * - ONE row in `client_writes` when DATABASE_URL is set (db.ts, the T29
 *   charter: this is our own audit of our own actions, which Mindbody
 *   has no home for). A dead or absent database never blocks or fails
 *   the write; a row that did not land says so on the console, every
 *   time, not once per process.
 *
 * The record holds when, which teacher (staff id and name), whose token
 * carried the call, the client's Id and its UniqueId when the read before
 * the write could say, which fields, the value BEFORE and AFTER for text
 * and flag fields, and the outcome: sent, dry-run, write-guard, refused
 * (Mindbody answered 4xx) or error. It never holds more of the client
 * record than the fields the write changed: not the name, not the rest of
 * the record, no copy of anything Mindbody is the home for.
 *
 * A card is the one field with no before and no value: the record says
 * "card replaced, last four 1234" and the number never reaches this
 * module (the caller builds that sentence; see clientcard.ts).
 */

/** What kind of write this was, in our own words. */
export type ClientWriteKind =
  /** The info view's editor: Notes, RedAlert or YellowAlert (T20/T58). */
  | "field"
  /** T53's email opt-ins. */
  | "consent"
  /** T84/T93's card on file. */
  | "card"
  /** T18's LiabilityRelease. */
  | "waiver-release"
  /** The waiver receipt appended to Notes after a release. */
  | "waiver-receipt"
  /** T62's signed Notes entry, the Formula Note fallback. */
  | "notes-append";

export type ClientWriteOutcome =
  | "sent"
  | "dry-run"
  | "write-guard"
  | "refused"
  | "error";

/** One field the write changed. `before` is null with `beforeUnknown`
 *  saying why when the read before the write could not say; a card has
 *  neither, only its sentence as `after`. */
export interface ClientWriteChange {
  field: string;
  before: string | boolean | null;
  after: string | boolean | null;
  beforeUnknown?: string;
}

export interface ClientWriteEntry {
  at: string;
  clientId: string;
  uniqueId: number | null;
  kind: ClientWriteKind;
  changes: ClientWriteChange[];
  outcome: ClientWriteOutcome;
  httpStatus: number | null;
  error: string | null;
  /** The teacher the write was FOR: the signed-in session, even when the
   *  call itself ran as the studio account after T49's fallback. */
  teacherId: number | null;
  teacherName: string | null;
  /** Whose token carried the call: the teacher's staff id, or null for
   *  the studio's service account. */
  actorId: number | null;
  route: string | null;
  target: string;
  siteId: string | null;
  /** Anything else the reader will need, in words (a stale screen). */
  note: string | null;
}

/* --- Who the write is for ----------------------------------------------
 *
 * The lib functions that write take an `actor`, which is null after a
 * T49 fallback (the call ran as the studio account). The teacher who
 * asked is still the one to name, so runAsActor (actor.ts) runs both
 * attempts inside this context, and a write outside it (the waiver
 * receipt, which picks its own actor) enters it with `asTeacher`.
 */

interface WriteContext {
  staffId: number;
  name: string;
  route: string;
}

const writeContext = new AsyncLocalStorage<WriteContext>();

export function asTeacher<T>(
  who: { staffId: number; name: string } | null,
  route: string,
  run: () => Promise<T>,
): Promise<T> {
  if (who === null) return run();
  return writeContext.run(
    { staffId: who.staffId, name: who.name, route },
    run,
  );
}

/* --- The read before the write -------------------------------------- */

/** The fields a read before a write may report, and only these: never
 *  more of the record than a write here can change. */
export type AuditedField =
  | "Notes"
  | "RedAlert"
  | "YellowAlert"
  | "SendAccountEmails"
  | "SendPromotionalEmails"
  | "SendScheduleEmails"
  | "LiabilityRelease";

export type ClientBefore =
  | {
      ok: true;
      uniqueId: number | null;
      values: Partial<Record<AuditedField, string | boolean | null>>;
    }
  | { ok: false; reason: string };

/** A before-read waits this long at most when it GATES a write: the
 *  blank check in /api/client-field, which asks on unknown, so a longer
 *  wait there buys fewer needless questions. */
export const BEFORE_READ_MS = 4_000;

/** T116 review: and this long when it is only a courtesy to the record
 *  (every other write, and a save that is not a clear). Measured against
 *  a read that hangs, the 4s bound put 4s on every consent toggle and
 *  waiver release, which a teacher at the counter feels; Mindbody answers
 *  a read by id in 400 to 900ms, so this cuts only the tail, and a read
 *  that misses it records "unknown" and the write goes out. */
export const COURTESY_READ_MS = 1_500;

function valueOf(row: any, field: AuditedField): string | boolean | null {
  if (field === "LiabilityRelease") {
    const v = row?.Liability?.IsReleased;
    return typeof v === "boolean" ? v : null;
  }
  const v = row?.[field];
  if (typeof v === "string" || typeof v === "boolean") return v;
  return null;
}

/**
 * A fresh read of the fields a write is about to change, on the service
 * account like every read. T114's rule applies: a shared id with no
 * UniqueId to choose by is NOT resolved, and the answer says so rather
 * than reporting one record's values as the client's. Never throws.
 */
export async function readClientBefore(
  clientId: string,
  uniqueId: number | null,
  fields: readonly AuditedField[],
  waitMs: number = BEFORE_READ_MS,
): Promise<ClientBefore> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      mindbody(
        `/client/clients?clientIds=${encodeURIComponent(clientId)}` +
          `&limit=${CLIENT_ID_READ_LIMIT}`,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${waitMs / 1000}s`)),
          waitMs,
        );
      }),
    ]);
    const total = body?.PaginationResponse?.TotalResults;
    const pick = pickClientRecord<any>(
      body?.Clients ?? [],
      clientId,
      uniqueId,
      typeof total === "number" ? total : null,
    );
    logClientPick("client-write before", clientId, uniqueId, pick);
    if (pick.outcome === "ambiguous") {
      return {
        ok: false,
        reason: `client id is held by ${pick.records} Mindbody records`,
      };
    }
    if (pick.outcome === "mismatch") {
      return { ok: false, reason: `no record carries UniqueId ${uniqueId}` };
    }
    if (!pick.row) return { ok: false, reason: "client not found" };
    const values: Partial<Record<AuditedField, string | boolean | null>> = {};
    for (const f of fields) values[f] = valueOf(pick.row, f);
    const u = pick.row?.UniqueId;
    return {
      ok: true,
      uniqueId: typeof u === "number" && Number.isFinite(u) ? u : uniqueId,
      values,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `the read before the write failed: ${
        err instanceof Error ? scrubSecrets(err.message) : String(err)
      }`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* --- The write --------------------------------------------------------- */

const TEXT_OR_FLAG: ReadonlySet<string> = new Set<AuditedField>([
  "Notes",
  "RedAlert",
  "YellowAlert",
  "SendAccountEmails",
  "SendPromotionalEmails",
  "SendScheduleEmails",
  "LiabilityRelease",
]);

/** Text as it goes into the record: a note could hold a card number a
 *  teacher typed, and this record must never hold one (T84's rule). */
function recordable(v: unknown): string | boolean | null {
  if (typeof v === "string") return scrubSecrets(v);
  if (typeof v === "boolean") return v;
  return null;
}

/**
 * `POST /client/updateclient`, recorded. The payload is exactly what the
 * caller built (`{Client: {Id, ...fields}, CrossRegionalUpdate: false}`,
 * the surgical envelope every writer here already used), sent through
 * mindbody() with the client id in the options so dry run and the write
 * guard apply exactly as before. The answer, or the error, is the
 * caller's, unchanged: this only watches.
 *
 * `before`: a read the caller already made (the blank check, the T62
 * append), so it is not made twice. Otherwise the text and flag fields
 * are read here first, bounded, and a failed read records "unknown"
 * rather than holding up the write. A card is never read.
 */
export async function updateClientAudited(opts: {
  kind: ClientWriteKind;
  clientId: string;
  /** The fields to write, beside `Id`. */
  fields: Record<string, unknown>;
  actor?: Actor | null;
  uniqueId?: number | null;
  before?: ClientBefore | null;
  /** What the record says a field became, when the value itself must not
   *  be recorded: `{ClientCreditCard: "card replaced, last four 1234"}`. */
  display?: Record<string, string>;
  note?: string | null;
}): Promise<any> {
  const { kind, clientId, fields, actor } = opts;
  const readable = Object.keys(fields).filter((k) =>
    TEXT_OR_FLAG.has(k),
  ) as AuditedField[];
  let before = opts.before ?? null;
  if (before === null && readable.length > 0) {
    before = await readClientBefore(
      clientId,
      opts.uniqueId ?? null,
      readable,
      COURTESY_READ_MS,
    );
  }

  const changes: ClientWriteChange[] = Object.keys(fields).map((field) => {
    if (!TEXT_OR_FLAG.has(field)) {
      /* A card, or anything not a text or flag field: its value is never
       * read into the record. The caller's sentence, else the field's
       * name alone. */
      return {
        field,
        before: null,
        after: opts.display?.[field] ?? `${field} replaced`,
      };
    }
    const after = recordable(fields[field]);
    if (before === null) {
      return { field, before: null, after, beforeUnknown: "not read" };
    }
    if (!before.ok) {
      return { field, before: null, after, beforeUnknown: before.reason };
    }
    if (!(field in before.values)) {
      return { field, before: null, after, beforeUnknown: "not read" };
    }
    return {
      field,
      before: recordable(before.values[field as AuditedField]),
      after,
    };
  });

  const ctx = writeContext.getStore() ?? null;
  const base = {
    clientId,
    uniqueId:
      before?.ok === true ? before.uniqueId : (opts.uniqueId ?? null),
    kind,
    changes,
    teacherId: ctx?.staffId ?? actor?.staffId ?? null,
    teacherName: ctx?.name ?? actor?.name ?? null,
    actorId: actor?.staffId ?? null,
    route: ctx?.route ?? null,
    target: target(),
    siteId: siteIdNow(),
    note: opts.note ?? null,
  };

  let res: any;
  try {
    res = await mindbody("/client/updateclient", {
      method: "POST",
      body: {
        Client: { Id: clientId, ...fields },
        CrossRegionalUpdate: false,
      },
      clientId,
      audited: true,
      ...(actor ? { actor } : {}),
    });
  } catch (err) {
    const status = mindbodyHttpStatus(err);
    await recordClientWrite({
      ...base,
      at: new Date().toISOString(),
      outcome: status !== null && status < 500 ? "refused" : "error",
      httpStatus: status,
      error: err instanceof Error ? scrubSecrets(err.message) : String(err),
    });
    throw err;
  }
  await recordClientWrite({
    ...base,
    at: new Date().toISOString(),
    outcome: res?.DryRun
      ? "dry-run"
      : res?.WriteSuppressed
        ? "write-guard"
        : "sent",
    httpStatus: null,
    error: null,
  });
  return res;
}

function siteIdNow(): string | null {
  try {
    return mindbodyEnv().siteId;
  } catch {
    return null;
  }
}

/* --- The record ---------------------------------------------------------- */

/** How long the answer to a teacher waits for the row. The insert runs on
 *  past it, so a slow database still lands its row; a dead one costs the
 *  save at most this. */
const RECORD_WAIT_MS = 1_500;

/** The newest entries, for the drawer when there is no database. Lost on
 *  restart, which is the whole reason the table exists; bounded. */
const MEMORY_MAX = 200;
const memory: ClientWriteEntry[] = [];

async function recordClientWrite(entry: ClientWriteEntry): Promise<void> {
  /* The console first and always: Railway keeps it, and nothing after
   * this line can take it back. */
  console.log(`[client-write] ${JSON.stringify(entry)}`);
  memory.unshift(entry);
  if (memory.length > MEMORY_MAX) memory.length = MEMORY_MAX;
  if (!dbConfigured()) return;
  const stored = await boundedDb(
    insertClientWrite(entry).catch(() => false),
    RECORD_WAIT_MS,
    false,
  );
  if (!stored) {
    /* Loud, every time: the brief is a durable record, and a missing row
     * is the one thing about it anybody investigating needs to know. */
    console.warn(
      `[client-write] NOT STORED in the database (unavailable or slower ` +
        `than ${RECORD_WAIT_MS}ms); the line above is the record: ` +
        `client=${entry.clientId} kind=${entry.kind} at=${entry.at}`,
    );
  }
}

/** Recent entries, newest first, for one client or for all: from the
 *  table when it answers, else from this process's memory. */
export async function recentClientWrites(
  clientId: string | null,
  limit = 50,
): Promise<{ source: "database" | "memory"; entries: ClientWriteEntry[] }> {
  const rows: ClientWriteRow[] | null = await listClientWrites(
    clientId,
    limit,
  );
  if (rows !== null) return { source: "database", entries: rows };
  return {
    source: "memory",
    entries: memory
      .filter((e) => clientId === null || e.clientId === clientId)
      .slice(0, limit),
  };
}

/** Whether a text value is empty for the blank check: nothing but
 *  whitespace. */
export function isBlankText(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === "";
}
