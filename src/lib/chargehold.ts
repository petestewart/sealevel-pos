import { randomUUID } from "node:crypto";

import {
  acknowledgeChargeHoldRow,
  boundedDb,
  dbConfigured,
  openChargeHolds,
  upsertChargeHold,
  type ChargeHoldRow,
} from "./db";
import { currentSiteId, target } from "./mindbody";
import { houseClientId } from "./sale";
import { ensureTarget } from "./target";

/**
 * T253: the SERVER's record that a charge for a client is in flight or may
 * have moved money, and the rule that no new charge for that client runs
 * until it has answered and a teacher has acknowledged what it left.
 *
 * Why the server. T249 and T252 kept this in the browser's sessionStorage,
 * which belongs to ONE tab: a second iPad, a second tab, a closed tab and
 * the Home Screen web app after it is swiped away (iOS starts a standalone
 * web app with a fresh sessionStorage on each launch) all saw no hold. The
 * browser's records stay as the instant local copy; this is the authority.
 *
 * The life of a hold (one per client on the ticket: the payer and every
 * T90 recipient, never the house client):
 *
 *   pending      written AHEAD of the charge (the review of 1bbe146: a
 *                hold written only after the answer let a relaunched app
 *                or a second iPad charge the same client while Mindbody
 *                was still slow). Refuses with "started at ... and has
 *                not answered yet". It cannot be acknowledged.
 *   cleared      the answer was definite (a sale that stood, a
 *                suppression, a definite refusal): the hold goes.
 *   ambiguous,
 *   sold-nothing,
 *   partial      the answer may have moved money: the pending hold
 *                becomes this, and refuses until a teacher acknowledges
 *                it. A pending hold with no answer after
 *                `PENDING_MAX_MS`, or found with no request in this
 *                process that owns it (a restart mid-charge), becomes
 *                ambiguous, NEVER cleared: a restart mid-charge may have
 *                moved money.
 *
 * Plus `walkin`: a walk-in (house client) ticket that ended unknown,
 * sold-nothing or partial leaves ONE studio-wide notice, keyed to the
 * house client here on the server and never to a browser-sent id. It
 * refuses NOTHING (every walk-in sale rides the one house client, and a
 * blocking hold there would stop the studio selling to anyone who is not
 * a client); the Cart screen shows it whenever a walk-in sale is on it,
 * with its own Understood.
 *
 * Where it lives. This process's memory is the record, always; the
 * `charge_holds` table (migration 19) is its durable copy, written as the
 * whole current state, by id, one write after another per hold, so a slow
 * first write cannot land over a later state. A table that does not answer
 * leaves memory in charge; rows the table has and memory does not (a
 * restart) are read into memory. ONE INSTANCE: a second server process
 * would share the table but not the pending holds' owners, and would turn
 * the other's in-flight charges ambiguous. The studio runs one.
 *
 * Lapse. A settled hold older than `POS_HOLD_LAPSE_MS` (24 hours) no
 * longer refuses, logged once per hold.
 *
 * No card data: client ids, a kind, the route's sentence with any long
 * run of digits struck, a sale id, a staff id and times.
 */

export type ChargeHoldKind =
  | "pending"
  | "ambiguous"
  | "sold-nothing"
  | "partial"
  | "walkin";
/** What an answer can leave: a hold that waits for a teacher, or nothing. */
export type SettledKind = "ambiguous" | "sold-nothing" | "partial";

export interface ChargeHold {
  id: string;
  clientId: string;
  kind: ChargeHoldKind;
  message: string | null;
  saleId: string | null;
  staffId: string | null;
  route: string;
  createdAt: number;
}

interface Entry {
  row: ChargeHoldRow;
  /** A request in THIS process is still running the charge. */
  owned: boolean;
  /** The table writes for this hold, one after another. */
  chain: Promise<unknown>;
}

const DEFAULT_LAPSE_MS = 24 * 60 * 60 * 1000;
export const PENDING_MAX_MS = 3 * 60 * 1000;
const DB_WAIT_MS = 1_500;
/** The client id a walk-in notice is kept under when no house client is
 *  configured (a walk-in sale is then refused anyway). */
const WALKIN_KEY = "walk-in";

function lapseMs(): number {
  const raw = Number(process.env.POS_HOLD_LAPSE_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LAPSE_MS;
}

const memory = new Map<string, Entry>();
const lapsedLogged = new Set<string>();

async function siteKey(): Promise<string> {
  await ensureTarget().catch(() => undefined);
  return currentSiteId() ?? target();
}

/** Long digit runs struck: no card number belongs in a hold. */
export function holdSentence(text: unknown): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  return text.replace(/\d[\d -]{11,}\d/g, "[number]").slice(0, 1000);
}

/** The house client, which a blocking hold must never name. */
export function walkinKey(): string {
  return houseClientId() ?? WALKIN_KEY;
}

function publicHold(r: ChargeHoldRow): ChargeHold {
  return {
    id: r.id,
    clientId: r.clientId,
    kind: (["pending", "ambiguous", "sold-nothing", "partial", "walkin"].includes(
      r.kind,
    )
      ? r.kind
      : "ambiguous") as ChargeHoldKind,
    message: r.message,
    saleId: r.saleId,
    staffId: r.staffId,
    route: r.route,
    createdAt: r.createdAt,
  };
}

/** Queue the hold's current state for the table, after any earlier write
 *  of it, and wait a bounded time. True when that write landed. */
function persist(entry: Entry): Promise<boolean> {
  if (!dbConfigured()) return Promise.resolve(false);
  const snap: ChargeHoldRow = { ...entry.row };
  const write = entry.chain.then(() => upsertChargeHold(snap));
  entry.chain = write.catch(() => false);
  return boundedDb(write.catch(() => false), DB_WAIT_MS, false);
}

function prune(now: number): void {
  const lapse = lapseMs();
  for (const [id, e] of memory) {
    if (!e.owned && now - e.row.createdAt > lapse * 2) memory.delete(id);
  }
}

function standing(e: Entry, now: number): boolean {
  if (e.row.acknowledgedAt !== null || e.row.kind === "cleared") return false;
  if (e.row.kind === "pending") return true;
  if (now - e.row.createdAt <= lapseMs()) return true;
  if (!lapsedLogged.has(e.row.id)) {
    lapsedLogged.add(e.row.id);
    console.warn(
      `[charge-hold] lapsed id=${e.row.id} client=${e.row.clientId} kind=${e.row.kind} after ${Math.round(lapseMs() / 3_600_000)}h unacknowledged: no longer shown`,
    );
  }
  return false;
}

/** A pending hold nobody here is running, or that has waited too long,
 *  is an unknown outcome from now on. */
function convertStalePending(e: Entry, now: number): void {
  if (e.row.kind !== "pending") return;
  const orphan = !e.owned;
  if (!orphan && now - e.row.createdAt <= PENDING_MAX_MS) return;
  e.row.kind = "ambiguous";
  e.row.message = orphan
    ? "The server restarted (or lost track) while this charge was waiting for Mindbody, so it may have gone through."
    : `The charge had not answered after ${Math.round(PENDING_MAX_MS / 60_000)} minutes, so it may have gone through.`;
  console.warn(
    `[charge-hold] pending id=${e.row.id} client=${e.row.clientId} became ambiguous (${orphan ? "no owning request" : "no answer in time"})`,
  );
  void persist(e);
}

/** Read the table's open rows for these clients into memory (a restart's
 *  rows, another write that landed), then answer what memory holds. */
async function load(site: string, clientIds: string[]): Promise<Entry[]> {
  const now = Date.now();
  prune(now);
  if (dbConfigured()) {
    const rows = await boundedDb(
      openChargeHolds(site, clientIds, now - lapseMs() - 60_000),
      DB_WAIT_MS,
      null as ChargeHoldRow[] | null,
    );
    if (rows === null) {
      console.warn(
        `[charge-hold] the table did not answer; memory decides for ${clientIds.join(",")}`,
      );
    } else {
      for (const r of rows) {
        if (memory.has(r.id)) continue;
        memory.set(r.id, { row: r, owned: false, chain: Promise.resolve() });
      }
    }
  }
  const out: Entry[] = [];
  for (const e of memory.values()) {
    if (e.row.site !== site || !clientIds.includes(e.row.clientId)) continue;
    convertStalePending(e, now);
    if (standing(e, now)) out.push(e);
  }
  return out.sort((a, b) => a.row.createdAt - b.row.createdAt);
}

/** The holds that refuse a charge for these clients: every standing one
 *  but a walk-in notice. The house client is never asked about. */
export async function standingChargeHolds(
  clientIds: string[],
): Promise<ChargeHold[]> {
  const house = walkinKey();
  const ids = [
    ...new Set(clientIds.filter((c) => c.trim() !== "" && c !== house)),
  ];
  if (ids.length === 0) return [];
  const site = await siteKey().catch(() => "unknown");
  return (await load(site, ids))
    .filter((e) => e.row.kind !== "walkin")
    .map((e) => publicHold(e.row));
}

/** The studio-wide walk-in notices standing now. They refuse nothing. */
export async function walkinNotices(): Promise<ChargeHold[]> {
  const site = await siteKey().catch(() => "unknown");
  return (await load(site, [walkinKey()]))
    .filter((e) => e.row.kind === "walkin")
    .map((e) => publicHold(e.row));
}

/** A charge about to run: the holds written ahead of it, to settle. */
export interface ChargeTicket {
  site: string;
  ids: string[];
  walkin: boolean;
  staffId: string | null;
  route: string;
  /** The walk-in notice this ticket left, once it has one. */
  walkinId: string | null;
}

/**
 * Before a charge: refuse it when any of its clients is held, else write a
 * `pending` hold for each, in memory at once (in the same tick as the
 * memory check, so two requests in this process cannot both pass) and in
 * the table (bounded). `walkin` says the ticket rides the house client.
 */
export async function claimCharge(input: {
  clientIds: string[];
  walkin: boolean;
  staffId: string | null;
  route: string;
}): Promise<{ refused: ChargeHold[] } | { ticket: ChargeTicket }> {
  const house = walkinKey();
  const ids = [
    ...new Set(input.clientIds.filter((c) => c.trim() !== "" && c !== house)),
  ];
  const site = await siteKey().catch(() => "unknown");
  const ticket: ChargeTicket = {
    site,
    ids: [],
    walkin: input.walkin,
    staffId: input.staffId,
    route: input.route,
    walkinId: null,
  };
  if (ids.length === 0) return { ticket };
  const loaded = (await load(site, ids)).filter((e) => e.row.kind !== "walkin");
  if (loaded.length > 0) return { refused: loaded.map((e) => publicHold(e.row)) };
  /* Synchronous from here to the last memory.set: the re-check and the
   * claim cannot be split by another request in this process. */
  const now = Date.now();
  const raced = [...memory.values()].filter(
    (e) =>
      e.row.site === site &&
      ids.includes(e.row.clientId) &&
      e.row.kind !== "walkin" &&
      standing(e, now),
  );
  if (raced.length > 0) return { refused: raced.map((e) => publicHold(e.row)) };
  const made: Entry[] = [];
  for (const clientId of ids) {
    const e: Entry = {
      row: {
        id: randomUUID(),
        site,
        clientId,
        kind: "pending",
        message: null,
        saleId: null,
        staffId: input.staffId,
        route: input.route,
        createdAt: now,
        acknowledgedAt: null,
        acknowledgedBy: null,
      },
      owned: true,
      chain: Promise.resolve(),
    };
    memory.set(e.row.id, e);
    made.push(e);
    ticket.ids.push(e.row.id);
  }
  const stored = await Promise.all(made.map((e) => persist(e)));
  console.log(
    `[charge-hold] pending ${made.map((e) => `${e.row.clientId}=${e.row.id}`).join(" ")} ` +
      `route=${input.route} staff=${input.staffId ?? "none"}` +
      (dbConfigured() && stored.some((x) => !x) ? " (memory only: NOT STORED in the database)" : ""),
  );
  return { ticket };
}

/**
 * After a charge: a definite answer clears its pending holds; an answer
 * that may have moved money makes each a hold that waits for a teacher
 * (and a walk-in ticket leaves its studio-wide notice). Callable again
 * with a worse outcome (a throw after a definite answer reopens them as
 * ambiguous). Answers the holds left standing, for the answer to name.
 */
export async function settleCharge(
  ticket: ChargeTicket,
  outcome: { kind: SettledKind | null; message: unknown; saleId: unknown },
): Promise<ChargeHold[]> {
  const now = Date.now();
  const message = holdSentence(outcome.message);
  const saleId =
    typeof outcome.saleId === "string" || typeof outcome.saleId === "number"
      ? String(outcome.saleId)
      : null;
  const left: ChargeHold[] = [];
  const writes: Promise<boolean>[] = [];
  for (const id of ticket.ids) {
    const e = memory.get(id);
    if (e === undefined) continue;
    e.owned = false;
    if (outcome.kind === null) {
      e.row.kind = "cleared";
      e.row.acknowledgedAt = now;
      e.row.acknowledgedBy = "outcome";
    } else {
      e.row.kind = outcome.kind;
      e.row.message = message;
      e.row.saleId = saleId;
      e.row.acknowledgedAt = null;
      e.row.acknowledgedBy = null;
      left.push(publicHold(e.row));
    }
    writes.push(persist(e));
  }
  if (ticket.walkin && outcome.kind !== null) {
    const existing = ticket.walkinId !== null ? memory.get(ticket.walkinId) : undefined;
    const e: Entry = existing ?? {
      row: {
        id: randomUUID(),
        site: ticket.site,
        clientId: walkinKey(),
        kind: "walkin",
        message: null,
        saleId: null,
        staffId: ticket.staffId,
        route: ticket.route,
        createdAt: now,
        acknowledgedAt: null,
        acknowledgedBy: null,
      },
      owned: false,
      chain: Promise.resolve(),
    };
    e.row.message = message;
    e.row.saleId = saleId;
    memory.set(e.row.id, e);
    ticket.walkinId = e.row.id;
    writes.push(persist(e));
    console.warn(`[charge-hold] walk-in notice id=${e.row.id} (${outcome.kind})`);
  }
  const stored = await Promise.all(writes);
  console.log(
    `[charge-hold] settled ${ticket.ids.join(",") || "(no client holds)"} as ` +
      `${outcome.kind ?? "cleared"} sale=${saleId ?? "none"}` +
      (dbConfigured() && stored.some((x) => !x) ? " (memory only: NOT STORED in the database)" : ""),
  );
  return left;
}

/**
 * Acknowledge one hold by id. A pending hold cannot be (its charge is
 * still running). With a database configured the acknowledgement must
 * LAND in the table, or it is undone here and reported, so a restart
 * cannot bring back a hold a teacher was told was cleared, nor clear one
 * the table still holds.
 */
export async function acknowledgeChargeHold(
  id: string,
  staffId: string,
): Promise<
  | { status: "ok"; clientId: string }
  | { status: "gone" }
  | { status: "pending" }
  | { status: "unrecorded" }
> {
  const e = memory.get(id);
  if (e === undefined) {
    if (!dbConfigured()) return { status: "gone" };
    const answer = await boundedDb(
      acknowledgeChargeHoldRow(id, staffId),
      DB_WAIT_MS,
      "unavailable" as const,
    );
    if (answer === "unavailable") return { status: "unrecorded" };
    if (answer === null) return { status: "gone" };
    console.log(`[charge-hold] acknowledged id=${id} client=${answer} by staff=${staffId}`);
    return { status: "ok", clientId: answer };
  }
  if (e.row.kind === "pending") return { status: "pending" };
  if (e.row.acknowledgedAt !== null || e.row.kind === "cleared") {
    return { status: "gone" };
  }
  e.row.acknowledgedAt = Date.now();
  e.row.acknowledgedBy = staffId;
  if (dbConfigured() && !(await persist(e))) {
    /* Not recorded: undone here, and the undone state queued behind the
     * write that did not answer, so the table ends where memory is. */
    e.row.acknowledgedAt = null;
    e.row.acknowledgedBy = null;
    void persist(e);
    console.warn(
      `[charge-hold] acknowledgement of id=${id} by staff=${staffId} NOT RECORDED: the table did not answer; the hold stands`,
    );
    return { status: "unrecorded" };
  }
  console.log(
    `[charge-hold] acknowledged id=${id} client=${e.row.clientId} kind=${e.row.kind} by staff=${staffId}`,
  );
  return { status: "ok", clientId: e.row.clientId };
}

/** The sentence a refused charge carries: when, and what it was. */
export function heldSentence(holds: ChargeHold[]): string {
  const first = holds[0];
  if (first === undefined) return "";
  const when = new Date(first.createdAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
  if (first.kind === "pending") {
    return (
      `A charge for this client started at ${when} and has not answered ` +
      "yet. Wait for it, then look again. Nothing was charged."
    );
  }
  const what =
    first.kind === "sold-nothing"
      ? "took a payment and sold nothing"
      : first.kind === "partial"
        ? "was only partly sold"
        : "may or may not have gone through";
  return (
    `A charge for this client at ${when} ${what}, and nobody has checked it ` +
    "yet. Check it in Mindbody, then tap Understood. Nothing was charged."
  );
}

/**
 * What an answer from a money route leaves, read off a CLONE of it (the
 * answer that goes back is untouched): null for a definite answer, else
 * the hold kind. Ambiguous covers the route's own flag, a 5xx or a 200
 * whose body could not be read, and no answer at all (`res` null, a
 * throw). A 4xx with no readable body is a refusal.
 */
export async function outcomeOf(
  res: Response | null,
): Promise<{ kind: SettledKind | null; body: any }> {
  if (res === null) return { kind: "ambiguous", body: null };
  const body = await res.clone().json().catch(() => null);
  const unreadable = body === null && (res.ok || res.status >= 500);
  const kind: SettledKind | null =
    body?.soldNothing === true
      ? "sold-nothing"
      : body?.partial === true
        ? "partial"
        : unreadable || body?.ambiguous === true
          ? "ambiguous"
          : null;
  return { kind, body };
}

/** For a driver: how many holds this process remembers. */
export function chargeHoldMemorySize(): number {
  return memory.size;
}
