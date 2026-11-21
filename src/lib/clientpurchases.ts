import {
  CLIENT_ID_READ_LIMIT,
  logClientPick,
  mismatchClientMessage,
  pickClientRecord,
} from "./clientrecord";
import { mindbody } from "./mindbody";
import { studioWall } from "./roster";

/**
 * T257: a student's recent sales, for the profile's "Recent purchases"
 * (Pete, 2026-11-18: see a student's recent sales, "with a way to void
 * one"). READS ONLY. The API cannot void a sale (T256: `/sale/returnsale`
 * returns comp sales only and refunds a credit sale to the account), so
 * the void happens in Mindbody's own UI and this only says which page:
 * `clients.mindbodyonline.com/app/clients/<UniqueId>/account-details/
 * void-edit?saleno=<SaleId>`. The number in that path is the client's
 * UniqueId, not the editable `Id` (verified 2026-11-18: `.../clients/
 * 100037835/account-details` opened the student whose Id is 10814).
 *
 * Two reads, in parallel, both on the service account:
 *
 * - `/client/clients` for the id, to pick the record (T114) and learn
 *   its UniqueId, preferring the one the screen already holds.
 * - `/client/clientpurchases` (client.yml:969) over a studio-local window
 *   (`studioWall`, never `toISOString()`), paged by limit and offset. Each
 *   element is ONE purchased line with its whole `Sale` embedded, so the
 *   lines are grouped by `Sale.Id`. Read live on prod 2026-11-18 (dummy
 *   client 100042041, sale 428528): `Sale.SaleDateTime`
 *   "2026-11-14T16:44:30Z", whose digits are SaleDate + SaleTime, read as
 *   studio wall-clock like every Mindbody datetime (T40); `Payments`
 *   `[{Type: "Cash", Amount: 21, Method, Notes, TransactionId}]`; the
 *   record's `Description`, `Price` 49, `AmountPaid` 21, `Discount` 28,
 *   `Returned` false, `Quantity` 1. A voided sale no longer appears.
 *
 * Nothing stored (T29), and no card data: a payment is passed on as its
 * `Type` word and `Amount` only, never `Notes` or any id, and any long
 * digit run in a word is struck in case a type ever carries one.
 *
 * The void link is offered only when the record is certain: one record
 * under the id (a shared id could put the other record's sales in this
 * answer, and nothing on a purchase line says which), its UniqueId known,
 * and the sale's own `ClientId` this id. Otherwise the sale is listed
 * with the reason and no link.
 */

export const PURCHASE_DAYS_DEFAULT = 30;
export const PURCHASE_DAYS_MAX = 90;
/** Mindbody's own default page. */
const PAGE = 100;
/** Pages read at most: 500 lines in 90 days is far past any student. */
const MAX_PAGES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurchaseLine {
  description: string;
  quantity: number | null;
  /** What was paid for this line, after discount and with tax. */
  amountPaid: number | null;
  /** Price before discount, when Mindbody gave one. */
  price: number | null;
  discount: number | null;
  returned: boolean;
}

export interface PurchasePayment {
  /** Mindbody's payment type word ("Cash", ...), digits struck. */
  type: string;
  amount: number | null;
}

export interface PurchaseSale {
  saleId: number;
  /** Studio wall-clock, "2026-11-14T16:44:30" (no offset). */
  at: string | null;
  lines: PurchaseLine[];
  payments: PurchasePayment[];
  /** Sum of the lines' amountPaid. */
  totalPaid: number;
  /** Every line returned. */
  returned: boolean;
  /** Some line returned (and not all). */
  partlyReturned: boolean;
  /** The Mindbody void page, or null with `noVoidWhy`. */
  voidUrl: string | null;
  noVoidWhy: string | null;
}

export interface ClientPurchases {
  clientId: string;
  /** The record's UniqueId the void links use, when certain. */
  uniqueId: number | null;
  days: number;
  /** Studio wall-clock bounds sent to Mindbody. */
  from: string;
  to: string;
  sales: PurchaseSale[];
  /** True when the read stopped at the page cap with more to read. */
  truncated: boolean;
  /** A sentence when no sale can be linked to its void page: a shared
   *  client id (T114), or a record whose UniqueId is unknown. */
  linkWarning: string | null;
}

/** Thrown for an answer that must not be shown at all (T114 mismatch,
 *  no record). The route answers it 409 with the sentence. */
export class PurchasesRefusal extends Error {}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
const cents = (n: number): number => Math.round(n * 100) / 100;

/** A payment type word, with any run of 4+ digits struck. */
function safeWord(v: unknown): string {
  const s = str(v) ?? "Payment";
  return s.replace(/\d{4,}/g, "****").slice(0, 60);
}

/** A Mindbody datetime as naive wall-clock: the offset is dropped, never
 *  applied (T40). */
export function wallOf(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?/.exec(s);
  if (!m) return null;
  return m[2] ? `${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}` : `${m[1]}T00:00:00`;
}

/** The Mindbody page that voids `saleId` for the client `uniqueId`, built
 *  from digits only; null for anything that is not. */
export function voidUrlFor(uniqueId: unknown, saleId: unknown): string | null {
  const u = String(uniqueId ?? "");
  const s = String(saleId ?? "");
  if (!/^\d{1,12}$/.test(u) || !/^\d{1,12}$/.test(s)) return null;
  return (
    `https://clients.mindbodyonline.com/app/clients/${u}` +
    `/account-details/void-edit?saleno=${s}`
  );
}

export function clampDays(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PURCHASE_DAYS_DEFAULT;
  return Math.min(PURCHASE_DAYS_MAX, Math.max(1, Math.floor(n)));
}

async function readRecord(
  clientId: string,
  uniqueId: number | null,
): Promise<{ uniqueId: number | null; records: number; warning: string | null }> {
  const body = await mindbody(
    `/client/clients?clientIds=${encodeURIComponent(clientId)}` +
      `&limit=${CLIENT_ID_READ_LIMIT}`,
  );
  const pick = pickClientRecord<any>(
    body?.Clients ?? [],
    clientId,
    uniqueId,
    num(body?.PaginationResponse?.TotalResults),
  );
  logClientPick("client purchases", clientId, uniqueId, pick);
  if (pick.outcome === "none") {
    throw new PurchasesRefusal("Mindbody returned no client record for this id.");
  }
  if (pick.outcome === "mismatch" && uniqueId !== null) {
    throw new PurchasesRefusal(mismatchClientMessage(clientId, uniqueId));
  }
  if (pick.outcome === "ambiguous" || pick.records > 1) {
    /* Even with the record picked by UniqueId, the purchases are read by
     * the shared id, and a purchase line does not say which record it
     * belongs to: list them, link none. */
    return {
      uniqueId: null,
      records: pick.records,
      warning:
        `Mindbody has ${pick.records} client records under client id ` +
        `${clientId}, and a purchase does not say which record it belongs ` +
        `to, so these sales may be either's. No void link is offered: void ` +
        `in Mindbody directly, and merge the records there.`,
    };
  }
  const u = num(pick.row?.UniqueId);
  return {
    uniqueId: u,
    records: pick.records,
    warning:
      u === null
        ? "Mindbody did not say this client's Mindbody id, so no void link is offered."
        : null,
  };
}

async function readPurchases(
  clientId: string,
  from: string,
  to: string,
): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await mindbody(
      `/client/clientpurchases?request.clientId=${encodeURIComponent(clientId)}` +
        `&request.startDate=${encodeURIComponent(from)}` +
        `&request.endDate=${encodeURIComponent(to)}` +
        `&request.limit=${PAGE}&request.offset=${page * PAGE}`,
    );
    const got: any[] = Array.isArray(body?.Purchases) ? body.Purchases : [];
    rows.push(...got);
    const total = num(body?.PaginationResponse?.TotalResults);
    const done =
      got.length < PAGE || (total !== null && rows.length >= total);
    if (done) return { rows, truncated: false };
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows, truncated };
}

/** Group purchase lines into sales, newest first. A sale cut by the page
 *  cap (500 lines, far past any student in 90 days) may show only some
 *  of its lines; `truncated` says the cap was met. */
export function groupSales(
  rows: readonly any[],
  clientId: string,
  uniqueId: number | null,
  linkWarning: string | null,
): PurchaseSale[] {
  const bySale = new Map<number, { sale: any; lines: PurchaseLine[] }>();
  for (const r of rows) {
    const saleId = num(r?.Sale?.Id);
    if (saleId === null) continue;
    let entry = bySale.get(saleId);
    if (!entry) {
      entry = { sale: r.Sale, lines: [] };
      bySale.set(saleId, entry);
    }
    entry.lines.push({
      description: str(r?.Description) ?? "Item",
      quantity: num(r?.Quantity),
      amountPaid: num(r?.AmountPaid),
      price: num(r?.Price),
      discount: num(r?.Discount),
      returned: r?.Returned === true,
    });
  }
  const out: PurchaseSale[] = [];
  for (const [saleId, { sale, lines }] of bySale) {
    const payments: PurchasePayment[] = (
      Array.isArray(sale?.Payments) ? sale.Payments : []
    ).map((p: any) => ({ type: safeWord(p?.Type), amount: num(p?.Amount) }));
    const returnedCount = lines.filter((l) => l.returned).length;
    const owner = sale?.ClientId == null ? null : String(sale.ClientId);
    let voidUrl: string | null = null;
    let noVoidWhy: string | null = null;
    if (linkWarning !== null || uniqueId === null) {
      noVoidWhy = linkWarning ?? "No void link: this client's Mindbody id is unknown.";
    } else if (owner !== clientId) {
      noVoidWhy =
        owner === null
          ? "Mindbody did not say whose sale this is, so no void link is offered."
          : `Sold to client ${owner}, not this record, so no void link is offered.`;
    } else {
      voidUrl = voidUrlFor(uniqueId, saleId);
      if (voidUrl === null) noVoidWhy = "No void link for this sale number.";
    }
    out.push({
      saleId,
      at: wallOf(sale?.SaleDateTime) ?? wallOf(sale?.SaleDate),
      lines,
      payments,
      totalPaid: cents(lines.reduce((s, l) => s + (l.amountPaid ?? 0), 0)),
      returned: lines.length > 0 && returnedCount === lines.length,
      partlyReturned: returnedCount > 0 && returnedCount < lines.length,
      voidUrl,
      noVoidWhy,
    });
  }
  out.sort((a, b) => {
    const t = (b.at ?? "").localeCompare(a.at ?? "");
    return t !== 0 ? t : b.saleId - a.saleId;
  });
  return out;
}

export async function clientPurchases(
  clientId: string,
  uniqueId: number | null,
  days: number,
  now = new Date(),
): Promise<ClientPurchases> {
  /* Whole studio days: from the start of the day `days` back to the end
   * of today, both as wall-clock strings. */
  const from = `${studioWall(new Date(now.getTime() - days * DAY_MS)).slice(0, 10)}T00:00:00`;
  const to = `${studioWall(now).slice(0, 10)}T23:59:59`;
  const [record, purchases] = await Promise.all([
    readRecord(clientId, uniqueId),
    readPurchases(clientId, from, to),
  ]);
  return {
    clientId,
    uniqueId: record.warning === null ? record.uniqueId : null,
    days,
    from,
    to,
    sales: groupSales(purchases.rows, clientId, record.uniqueId, record.warning),
    truncated: purchases.truncated,
    linkWarning: record.warning,
  };
}
