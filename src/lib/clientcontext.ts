import { mindbody } from "./mindbody";
import { sessionless, studioWall } from "./roster";

/**
 * Per-client reads that cannot ride the roster's one batched lookup:
 *
 * - The client's current pass list, fetched ON DEMAND when a teacher opens
 *   the payment-change dropdown on a row (the roster itself carries only
 *   the one pass paying for the visit, from `Visit.Service`).
 * - The recent-visit window behind the row's one-line history, fetched by
 *   the roster's background sweep after the roster has rendered.
 * - T56: what explains the M chip, read when the Membership modal opens:
 *   the client's contracts and their passes INCLUDING used-up ones.
 *
 * Both are metered calls per client, which is why neither runs per roster
 * render: the dropdown fetch waits for the tap, and the history sweep runs
 * behind the roster with its answers cached per client for the session.
 *
 * Every request goes through mindbody() so the dev drawer records it.
 * Reads only: nothing in this file writes.
 *
 * This file used to assemble a five-call context bundle for the expandable
 * row (balance, habitual add-ons, notes and red alert alongside the two
 * fetches above). T14 removed the expando, so the bundle went with it:
 * notes and the red alert now ride the roster's batched `/client/clients`
 * lookup, balance already did, and the habit prompt retired with the panel.
 *
 * Spec notes that shaped the queries (docs/mindbody-openapi/client.yml):
 *
 * - `/client/clientservices` defaults BOTH StartDate and EndDate to today,
 *   which filters to passes purchased today, i.e. almost always nothing.
 *   StartDate is sent explicitly, two years back.
 * - `/client/clientvisits` defaults EndDate to today and StartDate to the
 *   END date, so the unqualified call returns one day. StartDate is sent
 *   explicitly.
 */

export interface PassInfo {
  /** The purchase-instance id of the pass (`ClientService.Id`), which is
   *  what `POST /client/updateclientvisit` takes as `ClientServiceId` to
   *  change which pass pays for a visit. null when Mindbody omitted it,
   *  in which case the pass cannot be picked as payment. */
  id: number | null;
  /** The pricing option's own id (`ClientService.ProductId`, "not specific
   *  to any client's purchase of it", client.yml:4151), matching
   *  CatalogItem.productId from /sale/services. What T25 uses to find the
   *  just-purchased instance of a chosen option after a checkout. */
  productId: number | null;
  name: string;
  /** Classes left on the pass. null when Mindbody omits it (memberships). */
  remaining: number | null;
  /** Classes the pass held when purchased. */
  count: number | null;
  /** ISO date the pass expires, if it does. */
  expires: string | null;
}

export interface VisitInfo {
  /** ISO start time of the visited class. */
  at: string;
  name: string | null;
  signedIn: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * T56: a pass as the Membership modal lists it. The picker's PassInfo plus
 * `usedUp`: unexpired, but with nothing left on it. Mindbody's
 * `ShowActiveOnly=true` drops those, which is how Pete's Devin (one Drop
 * In, 0 remaining, still an M) opened an empty modal.
 */
export interface MembershipPass extends PassInfo {
  usedUp: boolean;
}

/**
 * T56: a contract from `/client/clientcontracts`, the autopay agreement
 * that Mindbody's membership flag can rest on with no pass in sight.
 */
export interface ContractInfo {
  /** `ClientContract.Id`, the sale of the contract. */
  id: number | null;
  name: string;
  /** `AutopayStatus` as Mindbody spells it: Active, Inactive, Suspended
   *  (the spec's enum, client.yml AutopayStatusEnum). null when omitted. */
  status: string | null;
  autoRenewing: boolean | null;
  /** ISO dates, site-local like every Mindbody datetime. */
  agreementDate: string | null;
  startDate: string | null;
  endDate: string | null;
}

/**
 * One `/client/clientservices` read, scoped to the client. Shared by the
 * picker's `fetchPasses` (active only, unchanged since T15/T18) and the
 * Membership modal's `fetchMembershipPasses` (everything, T56).
 */
async function readClientServices(
  clientId: string,
  now: Date,
  activeOnly: boolean,
): Promise<any[]> {
  const start = new Date(now.getTime() - 2 * 365 * DAY_MS);
  const body = await mindbody(
    `/client/clientservices?ClientId=${encodeURIComponent(clientId)}` +
      `&StartDate=${encodeURIComponent(start.toISOString())}` +
      `&EndDate=${encodeURIComponent(now.toISOString())}` +
      (activeOnly ? `&ShowActiveOnly=true` : ""),
  );
  const all: any[] = body?.ClientServices ?? [];
  /* Mindbody quirk, seen live: when ClientId does not resolve (inactive or
   * unknown client), clientservices does not 400 like its sibling endpoints.
   * It IGNORES the filter and returns pricing options site-wide -- observed
   * as ~90 strangers' memberships on one row. Each item carries its own
   * ClientID (confirmed live on every row), so scope the response ourselves
   * and treat "entries came back but none are this client's" as the lookup
   * failure it is. Items with no ClientID at all are kept only when nothing
   * indicates a site-wide spill (every spilled item observed carried a
   * foreign id). */
  const scoped = all.filter((s: any) => {
    const owner = s?.ClientID ?? s?.ClientId;
    return owner === undefined || owner === null
      ? true
      : String(owner) === clientId;
  });
  if (all.length > 0 && scoped.length === 0) {
    throw new Error(
      "Mindbody returned pricing options, but none belong to this client. " +
        "The client id may be inactive or unknown, and Mindbody ignores the " +
        "filter instead of failing.",
    );
  }
  return scoped;
}

function passInfo(s: any): PassInfo {
  return {
    id: num(s?.Id),
    productId: num(s?.ProductId),
    name: str(s?.Name) ?? "Pass",
    /* ClassPass and its kin carry no real session count (roster.ts
     * `sessionless`): show the expiry, never "0 remaining". */
    remaining: sessionless(s?.Name) ? null : num(s?.Remaining),
    count: sessionless(s?.Name) ? null : num(s?.Count),
    expires: str(s?.ExpirationDate),
  };
}

export async function fetchPasses(
  clientId: string,
  now = new Date(),
): Promise<PassInfo[]> {
  const scoped = await readClientServices(clientId, now, true);
  return scoped.filter((s: any) => s?.Current !== false).map(passInfo);
}

/**
 * T56: the Membership modal's pass list. The same read WITHOUT
 * `ShowActiveOnly`, so a pass that is unexpired but has nothing left on
 * it comes back too, flagged `usedUp`. Expired passes are dropped here:
 * the modal explains the M, and an expired pass cannot.
 *
 * Why a second call rather than one call without the flag serving both
 * lists: `/api/passes` is what the roster's background sweep spends per
 * ROW, dozens per class, and the picker's list is a live-verified
 * T15/T18 decision that should not drift with a changed query. The
 * modal opens a handful of times a day, so its own read is the cheaper
 * total, and it costs nothing until the M is tapped.
 */
export async function fetchMembershipPasses(
  clientId: string,
  now = new Date(),
): Promise<MembershipPass[]> {
  const scoped = await readClientServices(clientId, now, false);
  /* Mindbody's dates are studio wall-clock (CLAUDE.md), so today is the
   * studio's today, not UTC's; an expiry dated today is still a pass. */
  const today = studioWall(now).slice(0, 10);
  return scoped
    .filter((s: any) => {
      const exp = str(s?.ExpirationDate);
      return !exp || exp.slice(0, 10) >= today;
    })
    .map((s: any): MembershipPass | null => {
      const p = passInfo(s);
      if (s?.Current !== false) return { ...p, usedUp: false };
      /* Not current, unexpired, and Mindbody counts it at zero: used up.
       * Anything else not current (a future activation date, a kind with
       * no count) is left out rather than mislabelled. */
      if (num(s?.Remaining) === 0 && !sessionless(s?.Name)) {
        return { ...p, usedUp: true };
      }
      return null;
    })
    .filter((p): p is MembershipPass => p !== null);
}

/**
 * T56: the client's contracts, `GET /client/clientcontracts`. Read on
 * the service account like every other read. The rows carry
 * `PayerClientId`, which names who PAYS, and a parent paying for a
 * child's contract is a legitimate mismatch, so it is not used to scope
 * the response the way clientservices' ClientID is; a spill from an
 * unresolved client id has not been observed on this endpoint and would
 * need a live look before adding a guard that throws away a family
 * contract.
 */
export async function fetchContracts(clientId: string): Promise<ContractInfo[]> {
  const body = await mindbody(
    `/client/clientcontracts?ClientId=${encodeURIComponent(clientId)}`,
  );
  const rows: any[] = body?.Contracts ?? [];
  return rows.map(
    (c: any): ContractInfo => ({
      id: num(c?.Id),
      name: str(c?.ContractName) ?? "Contract",
      status: str(c?.AutopayStatus),
      autoRenewing: typeof c?.AutoRenewing === "boolean" ? c.AutoRenewing : null,
      agreementDate: str(c?.AgreementDate),
      startDate: str(c?.StartDate),
      endDate: str(c?.EndDate),
    }),
  );
}

/** Attended or booked visits, newest first, last 35 days, nothing future. */
export async function fetchVisits(
  clientId: string,
  now = new Date(),
): Promise<VisitInfo[]> {
  const start = new Date(now.getTime() - 35 * DAY_MS);
  const body = await mindbody(
    `/client/clientvisits?ClientId=${encodeURIComponent(clientId)}` +
      `&StartDate=${encodeURIComponent(start.toISOString())}` +
      `&EndDate=${encodeURIComponent(now.toISOString())}`,
  );
  return (body?.Visits ?? [])
    .filter((v: any) => !v?.Missed && !v?.LateCancelled && str(v?.StartDateTime))
    .map(
      (v: any): VisitInfo => ({
        at: v.StartDateTime as string,
        name: str(v?.Name),
        signedIn: Boolean(v?.SignedIn),
      }),
    )
    .sort((a: VisitInfo, b: VisitInfo) => b.at.localeCompare(a.at));
}
