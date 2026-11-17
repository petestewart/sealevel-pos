/**
 * T252: the records of a charge that may have moved money, read where the
 * roster can see them.
 *
 * Two writers, one rule: never invite a second charge before the teacher
 * has acknowledged an outcome that may have moved money.
 *
 * - The Cart screen's record (T249, `pos_uncertain_charge`, written by
 *   `SaleScreen.tsx`'s PaymentPanel). It was read only when that panel
 *   mounted, so after a reload, an evicted tab or the app unmounting
 *   behind the sign-in gate, the roster's "Pay and check in" could charge
 *   the same student before anybody opened the Cart screen. It now names
 *   the clients its ticket was for (`clientIds`), and the roster reads it
 *   here.
 * - The roster dialog's own (`pos_roster_uncertain_charge`). The dialog
 *   kept its outcome in state, Close wiped it, and reopening the row
 *   offered a fresh Charge after an unknown or sold-nothing answer (the
 *   T242 visit read catches an attached pass, not an unknown charge). It
 *   is written at the Charge tap as "charging", removed on a definite
 *   answer, replaced by an outcome that may have moved money, and kept
 *   until that outcome's own Understood. One per client.
 *
 * Both live in sessionStorage: ONE tab's, so they survive a reload and a
 * sign-out in that tab and nothing else (not a second iPad, a second tab,
 * a closed tab or a Home Screen relaunch, which starts with an empty
 * sessionStorage). T253 made the SERVER the authority
 * (src/lib/chargehold.ts: /api/checkout refuses a held client from any
 * iPad); these stay as the instant local copy, and the helpers below ask
 * the server and acknowledge its holds. Neither holds card data: a
 * client id, a visit id, a name the roster shows, a stage, the route's
 * sentence (long digit runs struck), hold ids and a time.
 */

export const CART_HELD_KEY = "pos_uncertain_charge";
export const ROSTER_HELD_KEY = "pos_roster_uncertain_charge";

/** This page load, so a record can tell a dialog reopened in the same page
 *  from one restored after a reload. */
export const ROSTER_PAGE_ID = Math.random().toString(36).slice(2);

export type RosterHeldStage =
  | "charging"
  | "ambiguous"
  | "sold-nothing"
  | "attach-failed";

export interface RosterHeld {
  v: 1;
  clientId: string;
  visitId: number | null;
  name: string;
  stage: RosterHeldStage;
  message: string | null;
  at: number;
  page: string;
  /** T253: the server's holds this outcome made, when its answer named
   *  them. A record whose holds the server no longer has (acknowledged on
   *  another iPad) is released; one that never reached the server stays
   *  until its own Understood. */
  serverHoldIds?: string[];
}

/** What a standing record says, for the roster dialog to show in place of
 *  Charge. `source` says which screen wrote it, and so whose Understood
 *  clears it. */
export interface HeldCharge {
  source: "roster" | "cart" | "server";
  stage: RosterHeldStage;
  message: string | null;
  at: number | null;
  samePage: boolean;
  /** The sale it names, when known (T103's sale id). */
  saleId?: string | null;
  /** T103's own summary line, from the Cart screen's record. */
  summary?: string | null;
  /** The server holds behind it: the hold itself for "server", the ones
   *  the outcome made for a local record. */
  serverHoldIds?: string[];
}

/* ---------- T253: the server's holds ---------------------------------- */

/** One hold as GET /api/charge-holds answers it. */
export interface ServerHold {
  id: string;
  clientId: string;
  kind: "ambiguous" | "sold-nothing" | "partial";
  message: string | null;
  saleId: string | null;
  createdAt: number;
}

export function serverHoldsFrom(raw: unknown): ServerHold[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (h: any) =>
        h !== null &&
        typeof h === "object" &&
        typeof h.id === "string" &&
        typeof h.clientId === "string",
    )
    .map((h: any) => ({
      id: h.id,
      clientId: h.clientId,
      kind:
        h.kind === "sold-nothing" || h.kind === "partial" ? h.kind : "ambiguous",
      message: typeof h.message === "string" ? h.message : null,
      saleId: typeof h.saleId === "string" ? h.saleId : null,
      createdAt: typeof h.createdAt === "number" ? h.createdAt : Date.now(),
    }));
}

/** The standing holds for these clients, or null when the server did not
 *  answer (the local records then decide alone). */
export async function fetchServerHolds(
  clientIds: string[],
): Promise<ServerHold[] | null> {
  const ids = [...new Set(clientIds.filter((c) => c !== ""))];
  if (ids.length === 0) return [];
  try {
    const res = await fetch(
      `/api/charge-holds?clientId=${ids.map(encodeURIComponent).join(",")}`,
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body === null ? null : serverHoldsFrom(body.holds);
  } catch {
    return null;
  }
}

/** Understood, on the server: one hold, by id. True when it is gone. */
export async function acknowledgeServerHold(id: string): Promise<boolean> {
  try {
    const res = await fetch("/api/charge-holds/acknowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The hold ids a checkout answer named (`chargeHolds`), for one client
 *  or for all. */
export function holdIdsFrom(body: unknown, clientId?: string): string[] {
  const list = (body as { chargeHolds?: unknown } | null)?.chargeHolds;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (h: any) =>
        typeof h?.id === "string" &&
        (clientId === undefined || h?.clientId === clientId),
    )
    .map((h: any) => String(h.id));
}

/** A server hold, as the roster dialog shows a record. */
export function heldFromServer(h: ServerHold): HeldCharge {
  return {
    source: "server",
    stage: h.kind === "ambiguous" ? "ambiguous" : "sold-nothing",
    message:
      h.kind === "partial" && h.message === null
        ? "Part of the ticket was sold and part was not."
        : h.message,
    at: h.createdAt,
    samePage: false,
    saleId: h.saleId,
    serverHoldIds: [h.id],
  };
}

/** A sentence off the server, kept as shown, less any run of digits long
 *  enough to be a card number (none should ever be there). */
export function storableSentence(text: string | null): string | null {
  return text === null ? null : text.replace(/\d[\d -]{11,}\d/g, "[number]");
}

export function readRosterHeld(): RosterHeld[] {
  try {
    const raw = window.sessionStorage.getItem(ROSTER_HELD_KEY);
    if (raw === null) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (r): r is RosterHeld =>
        r !== null &&
        typeof r === "object" &&
        typeof (r as RosterHeld).clientId === "string" &&
        typeof (r as RosterHeld).stage === "string",
    );
  } catch {
    return [];
  }
}

/** Put (or, with null, remove) this client's record. Returns the list as
 *  it now stands, so the page's copy can follow it. */
export function writeRosterHeld(
  clientId: string,
  record: RosterHeld | null,
): RosterHeld[] {
  const next = readRosterHeld().filter((r) => r.clientId !== clientId);
  if (record !== null) next.push(record);
  try {
    if (next.length === 0) window.sessionStorage.removeItem(ROSTER_HELD_KEY);
    else window.sessionStorage.setItem(ROSTER_HELD_KEY, JSON.stringify(next));
  } catch {
    /* No storage: the hold lasts as long as this page's state. */
  }
  return next;
}

/**
 * The Cart screen's record, when it holds an outcome that has not been
 * acknowledged, and for which clients. `clientIds` null means the record
 * does not say (written before T252), which holds EVERY client: after a
 * reload nothing can tell whose ticket it was. An empty list (a house
 * client sale) holds nobody on the roster.
 */
export function readCartHeld(): {
  held: HeldCharge;
  clientIds: string[] | null;
} | null {
  /* T253: with the sale id, T103's summary and the server holds the
   * outcome made, so the roster shows what the Cart screen would have. */
  try {
    const raw = window.sessionStorage.getItem(CART_HELD_KEY);
    if (raw === null) return null;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    /* A record from before T249 carries no stage: it was an unknown. */
    const stage = saved.v === 2 ? saved.stage : "ambiguous";
    if (
      stage !== "charging" &&
      stage !== "ambiguous" &&
      stage !== "sold-nothing" &&
      stage !== "partial"
    ) {
      return null;
    }
    const clientIds = Array.isArray(saved.clientIds)
      ? saved.clientIds.filter((c): c is string => typeof c === "string")
      : null;
    return {
      held: {
        source: "cart",
        /* A partial is money that moved for part of a ticket: the same
         * hold as sold-nothing, in the Cart screen's own words. */
        stage: stage === "partial" ? "sold-nothing" : stage,
        message:
          typeof saved.message === "string" && saved.message.length > 0
            ? saved.message
            : stage === "partial"
              ? "Part of a Cart screen ticket was sold and part was not."
              : null,
        at: typeof saved.at === "number" ? saved.at : null,
        samePage: false,
        saleId: typeof saved.saleId === "string" ? saved.saleId : null,
        summary: typeof saved.summary === "string" ? saved.summary : null,
        serverHoldIds: Array.isArray(saved.serverHoldIds)
          ? saved.serverHoldIds.filter((x): x is string => typeof x === "string")
          : [],
      },
      clientIds,
    };
  } catch {
    return null;
  }
}

/**
 * Acknowledge the Cart screen's outcome from the roster: the stage goes,
 * which is exactly what that result's own Understood does, and a
 * part-sold ticket's lock (which belongs to the Cart screen's ticket)
 * stays for that screen. Only ever called while the Cart screen is closed,
 * so its panel is not mounted to rewrite the record.
 */
export function acknowledgeCartHeld(): void {
  try {
    const raw = window.sessionStorage.getItem(CART_HELD_KEY);
    if (raw === null) return;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    if (typeof saved.lock === "string" && saved.lock.length > 0) {
      window.sessionStorage.setItem(
        CART_HELD_KEY,
        JSON.stringify({ ...saved, v: 2, stage: null, message: null }),
      );
    } else {
      window.sessionStorage.removeItem(CART_HELD_KEY);
    }
  } catch {
    /* Nothing to acknowledge. */
  }
}
