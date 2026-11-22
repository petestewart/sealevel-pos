import { listSaleLog, setSaleLogCheck, type SaleLogRow } from "./db";
import { mindbody } from "./mindbody";
import { studioWall } from "./roster";
import { houseClientId } from "./sale";

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
 * A sale not found inside the grace is left unchecked and asked again.
 */

const MISSING_GRACE_MS = 15 * 60 * 1000;
const MAX_PER_RUN = 60;

export type CheckState = "ok" | "differs" | "missing" | "unverified";

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
    for (const want of items) {
      const matches = sold.filter((g) => lineMatches(want, g));
      const wantQty = typeof want?.quantity === "number" ? want.quantity : 1;
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
      r.outcome === "stood" &&
      (r.checkState === null || r.checkState === "missing"),
  );
  let checked = 0;
  let waiting = 0;
  for (const row of due.slice(0, MAX_PER_RUN)) {
    const verdict = await checkRow(row, now);
    if (verdict === null) {
      waiting += 1;
      continue;
    }
    await setSaleLogCheck(row.id, verdict.state, verdict.detail);
    if (verdict.state !== "ok") {
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
