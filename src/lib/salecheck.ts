import { isCardFeeProduct } from "./cardfee";
import { listSaleLog, setSaleLogCheck, type SaleLogRow } from "./db";
import { mindbody } from "./mindbody";
import { studioWall } from "./roster";
import { cardFeeBarcodes, cardFeeFamily, houseClientId } from "./sale";

/**
 * T274's check: every sale the log says STOOD is read back from Mindbody
 * by its sale id and compared with what we asked for. This is T103's and
 * T254's lesson made routine (Pete: "verify MB is recording what we want
 * it to"): what the route believed and what Mindbody kept are compared
 * every day, not only when a teacher notices.
 *
 * READS ONLY. Nothing here writes to Mindbody, repairs anything or touches
 * a hold; a difference becomes a row on the admin Sales sheet for a person
 * to look at. Each sale is one metered `/sale/sales` read, bracketed by
 * date because Mindbody answers nothing for a sale outside its default
 * window without one (T256 review).
 *
 * States written to `check_state`:
 *   ok          every sale was found and agreed with what was asked
 *   differs     found, but something did not agree (`problems` says what)
 *   missing     a sale id the route answered that Mindbody does not list,
 *               looked for after MISSING_GRACE_MS
 *   unverified  nothing to compare (no sale id: a membership, say), or
 *               the read failed; recorded so the sheet says so
 *   found       T288: an uncertain tap that Mindbody shows a sale for
 *   not-sold    T288: an uncertain tap Mindbody shows no sale for, looked
 *               for after MISSING_GRACE_MS (Pete, a $2.99 test left on
 *               the log as "May have gone through" with no way to close)
 * A sale not found inside the grace is left unchecked and asked again.
 */

const MISSING_GRACE_MS = 15 * 60 * 1000;
const MAX_PER_RUN = 60;

export type CheckState =
  | "ok"
  | "differs"
  | "missing"
  | "unverified"
  /** T288: an UNCERTAIN tap (ambiguous, or no answer recorded) that
   *  Mindbody shows a sale for: it went through. */
  | "found"
  /** T288: an uncertain tap with no matching sale in Mindbody, looked
   *  for after MISSING_GRACE_MS: nothing went through. */
  | "not-sold";

/** T288: outcomes where the counter could not say whether it sold. */
const UNCERTAIN = new Set(["ambiguous", "started"]);

interface SaleRead {
  id: string;
  found: boolean;
  error?: string;
  clientId: string | null;
  items: { id: string; barcodeId: string | null; isService: boolean | null; quantity: number | null; description: string | null; total: number | null }[];
  payments: { type: string; amount: number | null }[];
}

/** UTC milliseconds of studio-local midnight starting `day` (YYYY-MM-DD). */
export function studioMidnight(day: string): number {
  const noon = Date.parse(`${day}T12:00:00Z`);
  const offset = Date.parse(`${studioWall(new Date(noon))}Z`) - noon;
  return Date.parse(`${day}T00:00:00Z`) - offset;
}

/** Today's date at the studio, YYYY-MM-DD. */
export function studioToday(now = Date.now()): string {
  return studioWall(new Date(now)).slice(0, 10);
}

export function shiftDay(day: string, by: number): string {
  const t = Date.parse(`${day}T12:00:00Z`) + by * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function n(v: unknown): number | null {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

async function readSale(saleId: string, near: number): Promise<SaleRead> {
  const DAY = 86_400_000;
  const from = `${studioWall(new Date(near - DAY)).slice(0, 10)}T00:00:00`;
  const to = `${studioWall(new Date(near + 2 * DAY)).slice(0, 10)}T00:00:00`;
  const empty: SaleRead = { id: saleId, found: false, clientId: null, items: [], payments: [] };
  try {
    const body: any = await mindbody(
      `/sale/sales?request.saleId=${encodeURIComponent(saleId)}` +
        `&request.startSaleDateTime=${encodeURIComponent(from)}` +
        `&request.endSaleDateTime=${encodeURIComponent(to)}`,
    );
    const sales: any[] = Array.isArray(body?.Sales) ? body.Sales : [];
    const sale = sales.find((s) => String(s?.Id) === saleId);
    if (!sale) return empty;
    return {
      id: saleId,
      found: true,
      clientId: sale.ClientId == null ? null : String(sale.ClientId),
      items: (Array.isArray(sale.PurchasedItems) ? sale.PurchasedItems : []).map((i: any) => ({
        id: String(i?.Id ?? ""),
        barcodeId: typeof i?.BarcodeId === "string" ? i.BarcodeId : null,
        isService: typeof i?.IsService === "boolean" ? i.IsService : null,
        quantity: n(i?.Quantity),
        description: typeof i?.Description === "string" ? i.Description.slice(0, 80) : null,
        total: n(i?.TotalAmount),
      })),
      payments: (Array.isArray(sale.Payments) ? sale.Payments : []).map((p: any) => ({
        type: String(p?.Type ?? ""),
        amount: n(p?.Amount),
      })),
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

/** Does a sale line answer this requested line? T254's rule: a product
 *  on its exact BarcodeId string (its Id as a fallback), a pricing option
 *  on its Id unless Mindbody says it is not a service. */
function lineMatches(
  want: { type: string | null; id: string | null },
  got: SaleRead["items"][number],
): boolean {
  if (want.id === null) return false;
  if (want.type === "Product") {
    return got.barcodeId === want.id || got.id === want.id;
  }
  if (got.isService === false) return false;
  return got.id === want.id || got.barcodeId === want.id;
}

/**
 * Compares one stood row with Mindbody's record of its sales. Pure apart
 * from the reads; returns what to store.
 */
export async function checkRow(
  row: SaleLogRow,
  now = Date.now(),
): Promise<{ state: CheckState; detail: Record<string, unknown> } | null> {
  if (row.saleIds.length === 0) {
    return {
      state: "unverified",
      detail: { problems: ["The answer named no Mindbody sale id to read back."] },
    };
  }
  const reads: SaleRead[] = [];
  for (const id of row.saleIds) reads.push(await readSale(id, row.startedAt));
  const failed = reads.filter((r) => r.error !== undefined);
  if (failed.length > 0) {
    return {
      state: "unverified",
      detail: {
        problems: failed.map((r) => `Sale ${r.id} could not be read: ${r.error}`),
      },
    };
  }
  const notFound = reads.filter((r) => !r.found);
  if (notFound.length > 0) {
    if (now - row.startedAt < MISSING_GRACE_MS) return null;
    return {
      state: "missing",
      detail: {
        problems: notFound.map(
          (r) => `Mindbody does not list sale ${r.id}, which the counter was told stood.`,
        ),
        sales: reads,
      },
    };
  }

  const problems: string[] = [];
  const req = (row.request ?? {}) as Record<string, any>;

  /* The client: each sale should be for someone on the ticket (or the
   * house client, for a walk-in). */
  const house = houseClientId();
  const allowed = new Set([...row.clientIds, ...(house ? [house] : [])]);
  for (const r of reads) {
    if (r.clientId !== null && allowed.size > 0 && !allowed.has(r.clientId)) {
      problems.push(`Sale ${r.id} is on client ${r.clientId}, who was not on the ticket.`);
    }
  }

  /* The lines, for an ordinary cart ticket. A gift card is sold by its
   * own route and a credit purchase reads back as an "account
   * adjustment", so neither is compared line by line here. */
  const items: any[] = Array.isArray(req.items) ? req.items : [];
  const plainCart =
    items.length > 0 &&
    !Array.isArray(req.giftCards) &&
    req.accountCredit === undefined &&
    !items.some((l) => l?.type === "Package");
  if (plainCart) {
    const sold = reads.flatMap((r) => r.items);
    const isFee = (want: any): boolean =>
      typeof want?.type === "string" &&
      (typeof want?.id === "string" || typeof want?.id === "number") &&
      isCardFeeProduct(want.type, want.id);
    /* T302: the card fee is logged in cents of one product and sold as
     * ONE unit of the product priced at that amount, so any fee product
     * answers to it. A read that fails leaves the ones already known. */
    if (items.some(isFee)) await cardFeeFamily().catch(() => null);
    const feeIds = cardFeeBarcodes();
    for (const want of items) {
      const matches = isFee(want)
        ? sold.filter(
            (g) =>
              lineMatches(want, g) ||
              (g.barcodeId !== null && feeIds.has(g.barcodeId.trim().toLowerCase())),
          )
        : sold.filter((g) => lineMatches(want, g));
      const wantQty = isFee(want)
        ? 1
        : typeof want?.quantity === "number"
          ? want.quantity
          : 1;
      const label = want?.name ? `${want.name} (${want.type} ${want.id})` : `${want?.type} ${want?.id}`;
      if (matches.length === 0) {
        problems.push(`${label} was asked for and is not on the sale.`);
        continue;
      }
      const qtys = matches.map((m) => m.quantity);
      if (qtys.every((q) => q !== null)) {
        const got = (qtys as number[]).reduce((a, b) => a + b, 0);
        if (got < wantQty) {
          problems.push(`${label}: ${wantQty} asked for, ${got} on the sale.`);
        }
      }
    }
  }

  /* The money: what the counter was told was taken against the payments
   * Mindbody recorded, Comp excluded (a comp's payment is not money). */
  if (row.total !== null) {
    const paid = reads
      .flatMap((r) => r.payments)
      .filter((p) => !/^comp/i.test(p.type))
      .reduce((a, p) => a + (p.amount ?? 0), 0);
    if (Math.abs(paid - row.total) > 0.01) {
      problems.push(
        `The counter was told $${row.total.toFixed(2)}; Mindbody records $${paid.toFixed(2)} paid.`,
      );
    }
  }

  return {
    state: problems.length > 0 ? "differs" : "ok",
    detail: { problems, sales: reads },
  };
}

/** T288: one sale from a day's list, with both readings of its time. */
interface ListedSale {
  id: string;
  at: number[];
  clientId: string | null;
  items: SaleRead["items"];
  payments: SaleRead["payments"];
}

/** T288: every sale Mindbody lists from the day before `near` to the day
 *  after, one metered read. `SaleDateTime` has been seen as true UTC on
 *  this endpoint (sale 429494, 10:19 at the studio, "18:19:28Z"), and
 *  other endpoints put wall-clock digits behind a "Z", so both readings
 *  are kept and either may match. */
async function listSalesAround(near: number): Promise<ListedSale[] | string> {
  const DAY = 86_400_000;
  const from = `${studioWall(new Date(near - DAY)).slice(0, 10)}T00:00:00`;
  const to = `${studioWall(new Date(near + 2 * DAY)).slice(0, 10)}T00:00:00`;
  try {
    const out: ListedSale[] = [];
    for (let page = 0; page < 10; page++) {
      const body: any = await mindbody(
        `/sale/sales?request.startSaleDateTime=${encodeURIComponent(from)}` +
          `&request.endSaleDateTime=${encodeURIComponent(to)}` +
          `&request.limit=200&request.offset=${page * 200}`,
      );
      const sales: any[] = Array.isArray(body?.Sales) ? body.Sales : [];
      for (const sale of sales) {
        const raw = String(sale?.SaleDateTime ?? "");
        const naive = raw.replace(/Z$|[+-]\d\d:\d\d$/, "");
        const at = [Date.parse(raw.endsWith("Z") ? raw : `${raw}Z`)];
        const wall = studioMidnight(naive.slice(0, 10)) + (Date.parse(`1970-01-01T${naive.slice(11, 19) || "00:00:00"}Z`) || 0);
        if (Number.isFinite(wall)) at.push(wall);
        out.push({
          id: String(sale?.Id ?? ""),
          at: at.filter((t) => Number.isFinite(t)),
          clientId: sale?.ClientId == null ? null : String(sale.ClientId),
          items: (Array.isArray(sale?.PurchasedItems) ? sale.PurchasedItems : []).map((i: any) => ({
            id: String(i?.Id ?? ""),
            barcodeId: typeof i?.BarcodeId === "string" ? i.BarcodeId : null,
            isService: typeof i?.IsService === "boolean" ? i.IsService : null,
            quantity: n(i?.Quantity),
            description: typeof i?.Description === "string" ? i.Description.slice(0, 80) : null,
            total: n(i?.TotalAmount),
          })),
          payments: (Array.isArray(sale?.Payments) ? sale.Payments : []).map((p: any) => ({
            type: String(p?.Type ?? ""),
            amount: n(p?.Amount),
          })),
        });
      }
      const total = n(body?.PaginationResponse?.TotalResults);
      if (sales.length < 200 || (total !== null && (page + 1) * 200 >= total)) break;
    }
    return out;
  } catch (err) {
    return err instanceof Error ? err.message.slice(0, 200) : String(err);
  }
}

/**
 * T288: whether an uncertain tap sold. A sale counts when it is for
 * someone on the ticket (or the walk-in client), was made from two
 * minutes before the tap to fifteen after it, holds every line the
 * ticket asked for, was paid the total the counter showed when one is
 * known, and is not already claimed by another row's answer. READS ONLY.
 */
export async function lookUpUncertain(
  row: SaleLogRow,
  claimed: ReadonlySet<string>,
  listed: ListedSale[] | string,
  now = Date.now(),
): Promise<{ state: CheckState; detail: Record<string, unknown> } | null> {
  if (now - row.startedAt < MISSING_GRACE_MS) return null;
  const req = (row.request ?? {}) as Record<string, any>;
  const items: any[] = Array.isArray(req.items) ? req.items : [];
  if (items.length === 0 || Array.isArray(req.giftCards) || req.accountCredit !== undefined) {
    return {
      state: "unverified",
      detail: { problems: ["This kind of sale cannot be looked up automatically. Check Mindbody for it."] },
    };
  }
  if (typeof listed === "string") {
    return { state: "unverified", detail: { problems: [`Mindbody's sales could not be read: ${listed}`] } };
  }
  const house = houseClientId();
  const allowed = new Set([...row.clientIds, ...(house ? [house] : [])]);
  const lo = row.startedAt - 2 * 60_000;
  const hi = row.startedAt + MISSING_GRACE_MS;
  const hits = listed.filter((sale) => {
    if (claimed.has(sale.id)) return false;
    if (!sale.at.some((t) => t >= lo && t <= hi)) return false;
    if (sale.clientId !== null && allowed.size > 0 && !allowed.has(sale.clientId)) return false;
    if (!items.every((want) => sale.items.some((g) => lineMatches(want, g)))) return false;
    if (row.total !== null) {
      const paid = sale.payments
        .filter((p) => !/^comp/i.test(p.type))
        .reduce((a, p) => a + (p.amount ?? 0), 0);
      if (Math.abs(paid - row.total) > 0.01) return false;
    }
    return true;
  });
  if (hits.length === 0) {
    return {
      state: "not-sold",
      detail: {
        problems: [],
        note: "Mindbody shows no sale for this tap, so nothing went through.",
      },
    };
  }
  return {
    state: "found",
    detail: {
      problems: [],
      foundSaleIds: hits.map((h) => h.id),
      note:
        hits.length === 1
          ? `Mindbody shows sale ${hits[0]!.id} for this tap: it went through.`
          : `Mindbody shows ${hits.length} sales that could be this tap (${hits.map((h) => h.id).join(", ")}). Check which one it was.`,
    },
  };
}

/**
 * Checks the stood rows started in [from, to) that have no verdict yet
 * (and re-asks `missing` ones, which may simply have been slow). Bounded
 * per run; answers what it did, or null when the store did not answer.
 */
export async function runSaleCheck(
  from: number,
  to: number,
  now = Date.now(),
): Promise<{ checked: number; waiting: number; remaining: number } | null> {
  const rows = await listSaleLog(from, to, 1000);
  if (rows === null) return null;
  const due = rows.filter(
    (r) =>
      (r.outcome === "stood" &&
        (r.checkState === null || r.checkState === "missing")) ||
      (UNCERTAIN.has(r.outcome) && r.checkState === null),
  );
  /* T288: sale ids some row already accounts for, so an uncertain tap is
   * never matched to a sale a later tap (a retry, say) made. */
  const claimed = new Set<string>(rows.flatMap((r) => r.saleIds));
  for (const r of rows) {
    const found = (r.checkDetail as { foundSaleIds?: unknown } | null)?.foundSaleIds;
    if (Array.isArray(found)) for (const id of found) claimed.add(String(id));
  }
  const lists = new Map<string, Promise<ListedSale[] | string>>();
  const listFor = (near: number) => {
    const key = studioWall(new Date(near)).slice(0, 10);
    let p = lists.get(key);
    if (p === undefined) {
      p = listSalesAround(near);
      lists.set(key, p);
    }
    return p;
  };
  let checked = 0;
  let waiting = 0;
  for (const row of due.slice(0, MAX_PER_RUN)) {
    const verdict = UNCERTAIN.has(row.outcome)
      ? now - row.startedAt < MISSING_GRACE_MS
        ? null
        : await lookUpUncertain(row, claimed, await listFor(row.startedAt), now)
      : await checkRow(row, now);
    if (verdict?.state === "found") {
      for (const id of (verdict.detail["foundSaleIds"] as string[]) ?? []) claimed.add(id);
    }
    if (verdict === null) {
      waiting += 1;
      continue;
    }
    await setSaleLogCheck(row.id, verdict.state, verdict.detail);
    if (verdict.state !== "ok" && verdict.state !== "not-sold") {
      console.warn(
        `[sale-check] ${row.id} ${verdict.state}: ${JSON.stringify(verdict.detail["problems"] ?? [])}`,
      );
    }
    checked += 1;
  }
  return { checked, waiting, remaining: Math.max(0, due.length - MAX_PER_RUN) };
}

/** The once-a-day run: yesterday and today so far, at most once per
 *  studio day per process, from the first teacher sign-in of the day
 *  (the app has no worker and gains none). Never throws. */
let lastDailyRun: string | null = null;

export function dailySaleCheckOnce(now = Date.now()): void {
  const today = studioToday(now);
  if (lastDailyRun === today) return;
  lastDailyRun = today;
  const from = studioMidnight(shiftDay(today, -1));
  void runSaleCheck(from, now, now)
    .then((r) => {
      if (r !== null) console.log(`[sale-check] daily run: ${JSON.stringify(r)}`);
    })
    .catch((err) => {
      console.error(`[sale-check] daily run failed: ${String(err)}`);
    });
}
