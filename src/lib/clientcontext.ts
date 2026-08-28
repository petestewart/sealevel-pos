import { mindbody } from "./mindbody";

/**
 * Per-client context for the expanded roster row: the pass and what is left
 * on it, account credit, recent visits, habitual add-ons, notes and the
 * red alert. Fetched when a teacher opens ONE row, never for a whole
 * roster -- these are four metered calls per client, and the design doc's
 * "metered calls have a shape" rule is exactly about this.
 *
 * Every request goes through mindbody() so the dev drawer records it.
 * Reads only: nothing in this file writes, and the acknowledgement of a
 * red alert is deliberately UI-state in the browser, never a call.
 *
 * Spec notes that shaped the queries (docs/mindbody-openapi/client.yml):
 *
 * - `/client/clientservices` defaults BOTH StartDate and EndDate to today,
 *   which filters to passes purchased today, i.e. almost always nothing.
 *   StartDate is sent explicitly, two years back.
 * - `/client/clientvisits` defaults EndDate to today and StartDate to the
 *   END date, so the unqualified call returns one day. StartDate is sent
 *   explicitly.
 * - `/client/clientpurchases` defaults StartDate to **now**, same trap.
 * - `/client/clientaccountbalances` takes ClientIds (plural, required) and
 *   returns Client records; the balance is `AccountBalance` on each.
 * - `Notes` and `RedAlert` are plain string fields on the Client record,
 *   so they come from the same `/client/clients?clientIds=` lookup the
 *   roster already uses for missing names. The roster only runs that
 *   lookup when a visit arrives nameless and keeps only the name, so the
 *   row open re-asks for this one client rather than widening the roster
 *   fetch to carry per-client baggage nobody may open.
 */

export interface PassInfo {
  /** The purchase-instance id of the pass (`ClientService.Id`), which is
   *  what `POST /client/updateclientvisit` takes as `ClientServiceId` to
   *  change which pass pays for a visit. null when Mindbody omitted it,
   *  in which case the pass cannot be picked as payment. */
  id: number | null;
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

/** One fetch's worth of context; an error here never blocks the others. */
export interface Section<T> {
  data: T | null;
  error: string | null;
}

export interface ClientContext {
  passes: Section<PassInfo[]>;
  /** Account credit in dollars. */
  balance: Section<number>;
  /** Attended or booked visits, newest first, last 35 days, nothing future. */
  visits: Section<VisitInfo[]>;
  /** Items appearing in at least 3 of the last 5 sales: the mat-rental
   *  habit worth prompting for. Empty means no real pattern, show nothing. */
  habits: Section<string[]>;
  profile: Section<{
    notes: string | null;
    redAlert: string | null;
    active: boolean | null;
  }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function section<T>(work: () => Promise<T>): Promise<Section<T>> {
  try {
    return { data: await work(), error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function fetchPasses(clientId: string, now: Date): Promise<PassInfo[]> {
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
   * as ~90 strangers' memberships on one row, any of which with Remaining: 1
   * fires the last-class banner falsely. Each item carries its own ClientID,
   * so scope the response ourselves and treat "entries came back but none
   * are this client's" as the lookup failure it is. Items with no ClientID
   * at all are kept only when nothing indicates a site-wide spill (every
   * spilled item observed carried a foreign id). */
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
        name: str(s?.Name) ?? "Pass",
        remaining: num(s?.Remaining),
        count: num(s?.Count),
        expires: str(s?.ExpirationDate),
      }),
    );
}

async function fetchBalance(clientId: string): Promise<number> {
  const body = await mindbody(
    `/client/clientaccountbalances?ClientIds=${encodeURIComponent(clientId)}`,
  );
  const row = (body?.Clients ?? []).find(
    (c: any) => String(c?.Id ?? "") === clientId,
  );
  return num(row?.AccountBalance) ?? 0;
}

async function fetchVisits(clientId: string, now: Date): Promise<VisitInfo[]> {
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

/**
 * The habit rule from the design doc, verbatim: a hint needs a real pattern
 * or it is noise, so an item shows only when it appears in at least 3 of
 * the client's last 5 sales. Purchases are grouped into sales first --
 * a sale of "drop-in + mat rental" is one visit's shopping, not two
 * chances for the mat to count.
 */
export function habitsFromPurchases(purchases: unknown[]): string[] {
  const sales = new Map<string, { at: string; items: Set<string> }>();
  for (const raw of purchases) {
    const p = raw as any;
    if (p?.Returned || p?.AccountPayment) continue;
    const item = str(p?.Description);
    if (!item) continue;
    const at = str(p?.Sale?.SaleDateTime) ?? str(p?.Sale?.SaleDate) ?? "";
    const saleId =
      p?.Sale?.Id !== undefined && p?.Sale?.Id !== null
        ? `id:${p.Sale.Id}`
        : `at:${at}:${item}`;
    const sale = sales.get(saleId) ?? { at, items: new Set<string>() };
    sale.items.add(item);
    sales.set(saleId, sale);
  }
  const lastFive = [...sales.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);
  const counts = new Map<string, number>();
  for (const sale of lastFive) {
    for (const item of sale.items) {
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item);
}

async function fetchHabits(clientId: string, now: Date): Promise<string[]> {
  const start = new Date(now.getTime() - 365 * DAY_MS);
  /* Limit defaults to 100 and the spec does not document the sort order,
   * so a regular with three line items a visit overflows the year window
   * and "the last five sales" could be computed from whichever hundred
   * rows Mindbody chose to return. 200 is the API's maximum page. */
  const body = await mindbody(
    `/client/clientpurchases?ClientId=${encodeURIComponent(clientId)}` +
      `&StartDate=${encodeURIComponent(start.toISOString())}` +
      `&EndDate=${encodeURIComponent(now.toISOString())}` +
      `&Limit=200`,
  );
  return habitsFromPurchases(body?.Purchases ?? []);
}

async function fetchProfile(
  clientId: string,
): Promise<{
  notes: string | null;
  redAlert: string | null;
  active: boolean | null;
}> {
  const body = await mindbody(
    `/client/clients?clientIds=${encodeURIComponent(clientId)}&limit=1`,
  );
  const row = (body?.Clients ?? []).find(
    (c: any) => String(c?.Id ?? "") === clientId,
  );
  return {
    notes: str(row?.Notes),
    redAlert: str(row?.RedAlert),
    active: typeof row?.Active === "boolean" ? row.Active : null,
  };
}

/**
 * All five lookups for one client, in parallel, each failing on its own:
 * a purchases timeout must not cost the teacher the red alert.
 */
export async function clientContext(
  clientId: string,
  now = new Date(),
): Promise<ClientContext> {
  const [passes, balance, visits, habits, profile] = await Promise.all([
    section(() => fetchPasses(clientId, now)),
    section(() => fetchBalance(clientId)),
    section(() => fetchVisits(clientId, now)),
    section(() => fetchHabits(clientId, now)),
    section(() => fetchProfile(clientId)),
  ]);
  /* Seen live in the sandbox: for an INACTIVE client, clientaccountbalances
   * and clientpurchases 400 with ClientNotFound, but clientservices ignores
   * the filter and returns pricing options site-wide. The per-item ClientID
   * scope in fetchPasses catches that only when items carry the field, so
   * use the client record itself as the authority: an inactive client's
   * pass list is not trustworthy, whatever came back. */
  if (profile.data?.active === false && passes.error === null) {
    return {
      passes: {
        data: null,
        error:
          "Client is inactive in Mindbody; the pass list cannot be trusted.",
      },
      balance,
      visits,
      habits,
      profile,
    };
  }
  return { passes, balance, visits, habits, profile };
}
