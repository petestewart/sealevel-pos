/**
 * T114: which client record an id means.
 *
 * A Mindbody client's `Id` (the "ClientId" every endpoint takes, the
 * studio's editable RSSID) is NOT unique on a site. `UniqueId` is. Pete's
 * live roster (2026-09-25) carried a visit with `ClientId: "10814"` and
 * `ClientUniqueId: 100037835`, and `GET /client/clients?clientIds=10814`
 * answered `TotalResults: 2`: Stacia Sander (UniqueId 100037835) and a
 * second record, Kati Robison, under the same Id. The roster's batched
 * lookup keyed its map on `Id`, the second record overwrote the first,
 * and Stacia's row read "Kati Robison" over Stacia's phone, alerts,
 * visits and card.
 *
 * So every read that goes from an Id to ONE record comes through here,
 * and the choice is made on purpose:
 *
 * - When the caller holds the UniqueId (a visit's `ClientUniqueId`, a
 *   search row's `UniqueId`), that record and only that record is the
 *   client. A record under the same Id with another UniqueId is somebody
 *   else, even when it is the only one Mindbody returned.
 * - Without one, a single record under the Id is the client, exactly as
 *   before. Two or more is AMBIGUOUS and nothing is picked: which record
 *   came first in Mindbody's answer is not a reason.
 *
 * Every ambiguity is logged server side, once per process per place, id
 * and outcome, since a roster reloads all day and one line is enough to
 * act on. The fix is Mindbody's (merge the two records); the app's job
 * is never to show the wrong person.
 */

export type ClientPickOutcome =
  /** One record under the id and no UniqueId said otherwise. */
  | "only"
  /** Picked by the caller's UniqueId. */
  | "unique"
  /** Two or more records under the id and no UniqueId to choose by. */
  | "ambiguous"
  /** Records under the id, but none carries the caller's UniqueId. */
  | "mismatch"
  /** No record under the id at all. */
  | "none";

export interface ClientPick<T> {
  row: T | null;
  outcome: ClientPickOutcome;
  /** How many records Mindbody holds under this id, as far as the answer
   *  shows: the rows returned, or the page's TotalResults when a
   *  single-id read reported more than it returned. 1 is ordinary. */
  records: number;
  /** The UniqueIds of the records under the id that the answer carried. */
  uniqueIds: number[];
  /** Of those, the ones whose record says `Active: false`. Pete's case
   *  had an inactive record from 2010 on a current member's id; the log
   *  names it so the merge is easy to decide. Never used to choose. */
  inactive: number[];
}

/** How many records a single-id read asks for. One would let Mindbody
 *  choose between two records sharing the id, and the exact-Id filter
 *  after it could not tell (T114); ten sees any real duplicate. */
export const CLIENT_ID_READ_LIMIT = 10;

function uniqueIdOf(row: unknown): number | null {
  const u = (row as { UniqueId?: unknown } | null)?.UniqueId;
  return typeof u === "number" && Number.isFinite(u) ? u : null;
}

/**
 * Pick the record `clientId` means from the rows of a `/client/clients`
 * answer. `uniqueId` is the caller's authoritative handle, or null when
 * it has none. `total` is the answer's `PaginationResponse.TotalResults`
 * for a read that asked for this ONE id, so a truncated page still
 * counts as shared; pass null for a batched read, whose total covers
 * every id in it.
 */
export function pickClientRecord<T>(
  rows: readonly T[],
  clientId: string,
  uniqueId: number | null,
  total: number | null = null,
): ClientPick<T> {
  const same = rows.filter(
    (r) => String((r as { Id?: unknown } | null)?.Id ?? "") === clientId,
  );
  const records = Math.max(
    same.length,
    typeof total === "number" && Number.isFinite(total) ? total : 0,
  );
  const uniqueIds = same
    .map(uniqueIdOf)
    .filter((u): u is number => u !== null);
  const inactive = same
    .filter((r) => (r as { Active?: unknown } | null)?.Active === false)
    .map(uniqueIdOf)
    .filter((u): u is number => u !== null);
  const base = { records, uniqueIds, inactive };
  if (same.length === 0) return { ...base, row: null, outcome: "none" };
  if (uniqueId !== null) {
    const hit = same.find((r) => uniqueIdOf(r) === uniqueId);
    if (hit !== undefined) return { ...base, row: hit, outcome: "unique" };
    /* A lone record that carries no UniqueId at all cannot contradict
     * the caller; one that carries a different UniqueId is someone else. */
    const lone = same[0];
    if (
      same.length === 1 &&
      records <= 1 &&
      lone !== undefined &&
      uniqueIdOf(lone) === null
    ) {
      return { ...base, row: lone, outcome: "only" };
    }
    return { ...base, row: null, outcome: "mismatch" };
  }
  const only = same[0];
  if (same.length === 1 && records <= 1 && only !== undefined) {
    return { ...base, row: only, outcome: "only" };
  }
  return { ...base, row: null, outcome: "ambiguous" };
}

const logged = new Set<string>();
const LOGGED_MAX = 500;

/**
 * The server log line for an id that did not resolve plainly, once per
 * process per place, id and outcome. Says what was decided and why, so a
 * duplicate is a recorded decision rather than an accident of ordering.
 * Silent for an ordinary id (one record, or none).
 */
export function logClientPick(
  where: string,
  clientId: string,
  uniqueId: number | null,
  pick: ClientPick<unknown>,
): void {
  if (pick.records <= 1 && pick.outcome !== "mismatch") return;
  const key = `${where}|${clientId}|${uniqueId ?? ""}|${pick.outcome}`;
  if (logged.has(key)) return;
  if (logged.size >= LOGGED_MAX) logged.clear();
  logged.add(key);
  const seen =
    pick.uniqueIds.length > 0
      ? pick.uniqueIds
          .map((u) => (pick.inactive.includes(u) ? `${u} inactive` : `${u}`))
          .join(", ")
      : "none shown";
  const decision =
    pick.outcome === "unique"
      ? `took UniqueId ${uniqueId}, the one this caller named`
      : pick.outcome === "mismatch"
        ? `none is UniqueId ${uniqueId}, the one this caller named, so ` +
          `none is used`
        : pick.outcome === "ambiguous"
          ? "there is no UniqueId to choose by, so none is used"
          : "used the only record returned";
  console.warn(
    `[client-id] ${where}: client id ${JSON.stringify(clientId)} is held ` +
      `by ${pick.records} Mindbody record(s) (UniqueIds: ${seen}); ` +
      `${decision}.` +
      (pick.records > 1
        ? " Two records under one id is a studio data problem: merge " +
          "them in Mindbody."
        : ""),
  );
}

/**
 * The same line for a read that deliberately does NOT choose (the
 * payment profile, which stays on Mindbody's own pick: see sale.ts
 * `clientPaymentProfile`). `decision` says what it did instead.
 */
export function logSharedIdKept(
  where: string,
  clientId: string,
  records: number,
  decision: string,
): void {
  if (records <= 1) return;
  const key = `${where}|${clientId}|kept`;
  if (logged.has(key)) return;
  if (logged.size >= LOGGED_MAX) logged.clear();
  logged.add(key);
  console.warn(
    `[client-id] ${where}: client id ${JSON.stringify(clientId)} is held ` +
      `by ${records} Mindbody records; ${decision}. Two records under one ` +
      `id is a studio data problem: merge them in Mindbody.`,
  );
}

/** The sentence for a caller that cannot tell which record an id means. */
export function ambiguousClientMessage(
  clientId: string,
  records: number,
): string {
  return (
    `Mindbody has ${records} client records under client id ${clientId}, ` +
    `and this screen cannot tell which one this is. Merge them in Mindbody.`
  );
}

/** The sentence for a caller whose UniqueId none of the records carry. */
export function mismatchClientMessage(
  clientId: string,
  uniqueId: number,
): string {
  return (
    `Mindbody returned no record for client id ${clientId} with ` +
    `Mindbody id ${uniqueId}.`
  );
}
