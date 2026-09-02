import { mindbody } from "./mindbody";
import { sessionless } from "./roster";

/**
 * Per-client reads that cannot ride the roster's one batched lookup:
 *
 * - The client's current pass list, fetched ON DEMAND when a teacher opens
 *   the payment-change dropdown on a row (the roster itself carries only
 *   the one pass paying for the visit, from `Visit.Service`).
 * - The recent-visit window behind the row's one-line history, fetched by
 *   the roster's background sweep after the roster has rendered.
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

export async function fetchPasses(
  clientId: string,
  now = new Date(),
): Promise<PassInfo[]> {
  const start = new Date(now.getTime() - 2 * 365 * DAY_MS);
  const body = await mindbody(
    `/client/clientservices?ClientId=${encodeURIComponent(clientId)}` +
      `&StartDate=${encodeURIComponent(start.toISOString())}` +
      `&EndDate=${encodeURIComponent(now.toISOString())}` +
      `&ShowActiveOnly=true`,
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
  return scoped
    .filter((s: any) => s?.Current !== false)
    .map(
      (s: any): PassInfo => ({
        id: num(s?.Id),
        productId: num(s?.ProductId),
        name: str(s?.Name) ?? "Pass",
        /* ClassPass and its kin carry no real session count (roster.ts
         * `sessionless`): show the expiry, never "0 remaining". */
        remaining: sessionless(s?.Name) ? null : num(s?.Remaining),
        count: sessionless(s?.Name) ? null : num(s?.Count),
        expires: str(s?.ExpirationDate),
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
