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
 * Both live in sessionStorage: the tab's, so they survive a reload, an
 * eviction and a sign-out in the same tab. Neither holds card data: a
 * client id, a visit id, a name the roster shows, a stage, the route's
 * sentence (long digit runs struck) and a time.
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
}

/** What a standing record says, for the roster dialog to show in place of
 *  Charge. `source` says which screen wrote it, and so whose Understood
 *  clears it. */
export interface HeldCharge {
  source: "roster" | "cart";
  stage: RosterHeldStage;
  message: string | null;
  at: number | null;
  samePage: boolean;
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
