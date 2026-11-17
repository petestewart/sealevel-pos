import { randomUUID } from "node:crypto";

import {
  acknowledgeChargeHoldRow,
  boundedDb,
  dbConfigured,
  insertChargeHold,
  openChargeHolds,
  type ChargeHoldRow,
} from "./db";
import { currentSiteId, target } from "./mindbody";
import { ensureTarget } from "./target";

/**
 * T253: the SERVER's record that a charge for a client may have moved
 * money, and the rule that no new charge for that client runs until a
 * teacher has acknowledged it.
 *
 * Why the server. T249 and T252 kept this in the browser's sessionStorage,
 * which belongs to ONE tab: a second iPad, a second tab, a closed tab and
 * the Home Screen web app after it is swiped away (iOS starts a standalone
 * web app with a fresh sessionStorage on each launch, and swiping it away
 * is how the counter gets reloaded) all saw no hold, and could charge the
 * same student again on the strength of an answer nobody had checked. The
 * browser's records stay as the instant local copy; this is the authority.
 *
 * What makes a hold: an answer from /api/checkout (or a live
 * /api/purchase-contract) that is ambiguous (a dead transport, a 5xx, a
 * thrown route, an unreadable answer), a T103 sold-nothing, or a T95/T90
 * partial. One hold per affected client: the payer and every T90
 * recipient. A definite success, a suppression and a definite refusal
 * make none.
 *
 * Where it lives. `charge_holds` (migration 19) when the database
 * answers, AND this process's memory always. Memory is the authority when
 * the table does not answer, the fallback with no database at all, and
 * what a refusal reads first, so a database that dies after a hold was
 * made cannot let the next charge through. A row the table has that
 * memory does not (a restart) refuses too. Acknowledged in both. A SECOND
 * SERVER INSTANCE WITH NO DATABASE does not share memory; with the
 * database it does.
 *
 * Lapse. A hold older than `POS_HOLD_LAPSE_MS` (24 hours by default) no
 * longer refuses, logged once per hold: by then the sale has been looked
 * at in Mindbody or the end-of-day reconciliation has found it, and a
 * student must not be unsellable for ever because a teacher went home.
 *
 * Nothing here holds card data: client ids, a kind, the route's sentence
 * with any long run of digits struck, a sale id, a staff id and times.
 */

export type ChargeHoldKind = "ambiguous" | "sold-nothing" | "partial";

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

interface MemoryHold extends ChargeHold {
  site: string;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

const DEFAULT_LAPSE_MS = 24 * 60 * 60 * 1000;
const DB_WAIT_MS = 1_500;

function lapseMs(): number {
  const raw = Number(process.env.POS_HOLD_LAPSE_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LAPSE_MS;
}

const memory = new Map<string, MemoryHold>();
const lapsedLogged = new Set<string>();

/** The site a hold belongs to: a client id means nothing on another. */
async function siteKey(): Promise<string> {
  await ensureTarget().catch(() => undefined);
  return currentSiteId() ?? target();
}

/** Long digit runs struck: no card number belongs in a hold, and this is
 *  the belt to the route never putting one in a sentence. */
export function holdSentence(text: unknown): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  return text.replace(/\d[\d -]{11,}\d/g, "[number]").slice(0, 1000);
}

function asKind(value: string): ChargeHoldKind {
  return value === "sold-nothing" || value === "partial" ? value : "ambiguous";
}

function prune(now: number): void {
  const lapse = lapseMs();
  for (const [id, hold] of memory) {
    if (now - hold.createdAt > lapse * 2) memory.delete(id);
  }
}

/** Record one hold per client. Never throws: a hold that did not land in
 *  the table is still in memory, and says so in the log. */
export async function recordChargeHolds(input: {
  clientIds: string[];
  kind: ChargeHoldKind;
  message: unknown;
  saleId: unknown;
  staffId: string | null;
  route: string;
}): Promise<ChargeHold[]> {
  const ids = [...new Set(input.clientIds.filter((c) => c.trim() !== ""))];
  if (ids.length === 0) return [];
  const site = await siteKey().catch(() => "unknown");
  const now = Date.now();
  prune(now);
  const message = holdSentence(input.message);
  const saleId =
    typeof input.saleId === "string" || typeof input.saleId === "number"
      ? String(input.saleId)
      : null;
  const made: ChargeHold[] = [];
  for (const clientId of ids) {
    const hold: MemoryHold = {
      id: randomUUID(),
      site,
      clientId,
      kind: input.kind,
      message,
      saleId,
      staffId: input.staffId,
      route: input.route,
      createdAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };
    memory.set(hold.id, hold);
    const stored = dbConfigured()
      ? await boundedDb(insertChargeHold(hold), DB_WAIT_MS, false)
      : false;
    console.warn(
      `[charge-hold] made id=${hold.id} client=${clientId} kind=${input.kind} ` +
        `sale=${saleId ?? "none"} staff=${input.staffId ?? "none"} ` +
        `route=${input.route}${stored ? "" : " (memory only: NOT STORED in the database)"}`,
    );
    made.push(publicHold(hold));
  }
  return made;
}

function publicHold(h: ChargeHold): ChargeHold {
  return {
    id: h.id,
    clientId: h.clientId,
    kind: h.kind,
    message: h.message,
    saleId: h.saleId,
    staffId: h.staffId,
    route: h.route,
    createdAt: h.createdAt,
  };
}

/**
 * Every unacknowledged, unlapsed hold for these clients on this site.
 * Memory first; the table adds what memory does not have (a restart), and
 * a table that does not answer leaves memory in charge. A hold memory has
 * acknowledged is never revived by a row whose update did not land.
 */
export async function standingChargeHolds(
  clientIds: string[],
): Promise<ChargeHold[]> {
  const ids = [...new Set(clientIds.filter((c) => c.trim() !== ""))];
  if (ids.length === 0) return [];
  const site = await siteKey().catch(() => "unknown");
  const now = Date.now();
  const lapse = lapseMs();
  const out = new Map<string, ChargeHold>();
  const lapsed = (h: { id: string; createdAt: number; clientId: string }) => {
    if (now - h.createdAt <= lapse) return false;
    if (!lapsedLogged.has(h.id)) {
      lapsedLogged.add(h.id);
      console.warn(
        `[charge-hold] lapsed id=${h.id} client=${h.clientId} after ${Math.round(lapse / 3_600_000)}h unacknowledged: no longer refusing`,
      );
    }
    return true;
  };
  for (const h of memory.values()) {
    if (h.site !== site || !ids.includes(h.clientId)) continue;
    if (h.acknowledgedAt !== null || lapsed(h)) continue;
    out.set(h.id, publicHold(h));
  }
  if (dbConfigured()) {
    const rows = await boundedDb(
      openChargeHolds(site, ids, now - lapse - 60_000),
      DB_WAIT_MS,
      null as ChargeHoldRow[] | null,
    );
    if (rows === null) {
      if (out.size === 0) {
        console.warn(
          `[charge-hold] the table did not answer; memory decides for ${ids.join(",")}`,
        );
      }
    } else {
      for (const r of rows) {
        const mem = memory.get(r.id);
        if (mem !== undefined && mem.acknowledgedAt !== null) continue;
        if (lapsed(r)) continue;
        out.set(r.id, publicHold({ ...r, kind: asKind(r.kind) }));
      }
    }
  }
  return [...out.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Acknowledge one hold by id, for the staff id that read it. Answers the
 *  client it was for, or null when no open hold has that id. */
export async function acknowledgeChargeHold(
  id: string,
  staffId: string,
): Promise<{ clientId: string; stored: boolean } | null> {
  const now = Date.now();
  const mem = memory.get(id);
  let clientId: string | null = null;
  if (mem !== undefined && mem.acknowledgedAt === null) {
    mem.acknowledgedAt = now;
    mem.acknowledgedBy = staffId;
    clientId = mem.clientId;
  }
  let stored = false;
  if (dbConfigured()) {
    const answer = await boundedDb(
      acknowledgeChargeHoldRow(id, staffId),
      DB_WAIT_MS,
      "unavailable" as const,
    );
    if (typeof answer === "string" && answer !== "unavailable") {
      stored = true;
      clientId = clientId ?? answer;
      if (mem === undefined) {
        /* Remember the acknowledgement here too, so a later read whose
         * update had not landed cannot bring the row back. */
        memory.set(id, {
          id,
          site: await siteKey().catch(() => "unknown"),
          clientId: answer,
          kind: "ambiguous",
          message: null,
          saleId: null,
          staffId: null,
          route: "",
          createdAt: now,
          acknowledgedAt: now,
          acknowledgedBy: staffId,
        });
      }
    }
  }
  if (clientId === null) return null;
  console.log(
    `[charge-hold] acknowledged id=${id} client=${clientId} by staff=${staffId}` +
      (stored || !dbConfigured() ? "" : " (memory only: the table did not answer)"),
  );
  return { clientId, stored };
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

/** For a driver: how many holds this process remembers. */
export function chargeHoldMemorySize(): number {
  return memory.size;
}
