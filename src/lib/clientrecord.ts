/**
 * T114: which client record an id means.
 *
 * A Mindbody client's `Id` (the "ClientId" every endpoint takes, the
 * studio's editable RSSID) is NOT unique on a site; `UniqueId` is. On
 * site 471, 10814 was both Stacia Sander (100037835) and an inactive Kati
 * Robison (1005543); the roster keyed its lookup on `Id`, the last record
 * won, and Stacia's row read "Kati Robison". Pete's census found that one
 * pair in 64 thousand records and renumbered it, so this is a small rail,
 * not a feature: every read that goes from an id to ONE record comes
 * through here so that the choice is made on purpose.
 *
 * - With the caller's UniqueId (a visit's `ClientUniqueId`, a search
 *   row's `UniqueId`), that record and only that record is the client.
 *   A record under the same Id with another UniqueId is somebody else.
 * - Without one, a lone record is the client, exactly as before. Two or
 *   more is ambiguous and NOTHING is picked: which came first in
 *   Mindbody's answer is not a reason.
 *
 * A shared id is logged server side, once per process per place. There
 * is deliberately no UI for it (see T114, "Proportion").
 */

export type ClientPickOutcome =
  | "only"
  | "unique"
  | "ambiguous"
  | "mismatch"
  | "none";

export interface ClientPick<T> {
  row: T | null;
  outcome: ClientPickOutcome;
  /** Records under this id as far as the answer shows: the rows returned,
   *  or a single-id read's TotalResults when that is larger. 1 is
   *  ordinary. */
  records: number;
}

/** How many records a single-id read asks for. One would let Mindbody
 *  choose between records sharing the id, and the exact-Id filter after
 *  it could not tell (T114). */
export const CLIENT_ID_READ_LIMIT = 10;

function uniqueIdOf(row: unknown): number | null {
  const u = (row as { UniqueId?: unknown } | null)?.UniqueId;
  return typeof u === "number" && Number.isFinite(u) ? u : null;
}

/**
 * Pick the record `clientId` means from a `/client/clients` answer's rows.
 * `total` is `PaginationResponse.TotalResults` for a read that asked for
 * this ONE id (so a truncated page still counts as shared); null for a
 * batched read, whose total covers every id in it.
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
  const lone = same.length === 1 && records <= 1 ? same[0] : undefined;
  if (same.length === 0) return { row: null, outcome: "none", records };
  if (uniqueId !== null) {
    const hit = same.find((r) => uniqueIdOf(r) === uniqueId);
    if (hit !== undefined) return { row: hit, outcome: "unique", records };
    /* A lone record carrying no UniqueId cannot contradict the caller;
     * one carrying a different UniqueId is someone else. */
    if (lone !== undefined && uniqueIdOf(lone) === null) {
      return { row: lone, outcome: "only", records };
    }
    return { row: null, outcome: "mismatch", records };
  }
  if (lone !== undefined) return { row: lone, outcome: "only", records };
  return { row: null, outcome: "ambiguous", records };
}

const logged = new Set<string>();

/**
 * One server log line for a shared id (or a UniqueId that no record
 * carries), once per process per place, id and decision: a roster
 * reloads all day and one line is enough to act on. Silent otherwise.
 */
export function logSharedId(
  where: string,
  clientId: string,
  records: number,
  decision: string,
  /** Log even for a lone record (a UniqueId that record does not carry). */
  always = false,
): void {
  if (records <= 1 && !always) return;
  const key = `${where}|${clientId}|${decision}`;
  if (logged.has(key)) return;
  if (logged.size >= 500) logged.clear();
  logged.add(key);
  console.warn(
    `[client-id] ${where}: client id ${JSON.stringify(clientId)} is held ` +
      `by ${records} Mindbody record(s); ${decision}. Merge shared ids in ` +
      `Mindbody.`,
  );
}

/** `logSharedId` for a `pickClientRecord` result. */
export function logClientPick(
  where: string,
  clientId: string,
  uniqueId: number | null,
  pick: ClientPick<unknown>,
): void {
  const decision =
    pick.outcome === "unique"
      ? `took UniqueId ${uniqueId}, the one the caller named`
      : pick.outcome === "mismatch"
        ? `no record carries UniqueId ${uniqueId}, so none is used`
        : pick.outcome === "ambiguous"
          ? "no UniqueId to choose by, so none is used"
          : "used the only record";
  logSharedId(
    where,
    clientId,
    pick.records,
    decision,
    pick.outcome === "mismatch",
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
