import { createHash, randomUUID } from "node:crypto";

import { scrubSecrets } from "./calllog";
import { boundedDb, DB_MARKER_WAIT_MS, upsertSaleLog, type SaleLogRow } from "./db";
import { allowedWriteClientIds, currentSiteId, dryRunState, target } from "./mindbody";

/**
 * T274: every money tap gets a row (Pete, 2026-11-21: "for a queue, we
 * will need a DB to store records of what needs to be processed in MB
 * anyway. so we should just log every transaction to the DB. that gives
 * us observability and insight to verify MB is recording what we want it
 * to, and identify and fix bugs more easily.").
 *
 * The routes: /api/checkout (every shape: cart, split, T90, gift card,
 * account credit, no-charge credit), /api/purchase-contract's LIVE
 * purchase (never its Test: true rehearsal) and /api/guest's $0 comp.
 * Each calls `startSaleLog` after its own gates (a replayed T113 key is
 * NOT a new tap and gets no row) and `finish` with whatever it answers.
 *
 * - **Written ahead**: the `started` row goes to the table before the
 *   route asks Mindbody anything, bounded at DB_MARKER_WAIT_MS so a slow
 *   database cannot hold a sale. A row still `started` long after is
 *   itself evidence (the process died mid-charge).
 * - **One console line per step, always and first** (`[sale-log]`), the
 *   client_writes way, so a dead database still leaves the record in the
 *   server log; a write that did not land logs `NOT STORED`.
 * - **Never a card**: the request is WHITELISTED field by field (ids,
 *   quantities, prices, methods, amounts, last fours), and the answer has
 *   every key that could carry a number, a token, a PIN or a signature
 *   dropped and every string scrubbed of card-shaped digits and CVVs.
 * - **Never in the way**: nothing here throws into a route, and a
 *   database that does not answer never blocks or fails a sale.
 */

export type SaleLogRoute = "/api/checkout" | "/api/purchase-contract" | "/api/guest";

export type SaleLogOutcome =
  | "started"
  | "stood"
  | "suppressed"
  | "refused"
  | "held"
  | "ambiguous"
  | "sold-nothing"
  | "partial";

export interface SaleLogHandle {
  id: string;
  /** Records the route's answer (or a throw, as `null`). Never throws. */
  finish: (res: Response | null) => Promise<void>;
}

/* --- Request summaries: a whitelist, never the body ------------------ */

function str(v: unknown, max = 120): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : scrubSecrets(t.slice(0, max));
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function lastFourOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function pick(obj: unknown, keys: string[]): Record<string, unknown> | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = str(v, 200);
  }
  return out;
}

/** What a checkout ASKED for, from the raw body. Card numbers, CVVs,
 *  expiries, gift card numbers, tokens and PINs are never read. */
export function summarizeCheckoutRequest(payload: any): Record<string, unknown> {
  const items = Array.isArray(payload?.items)
    ? payload.items.slice(0, 60).map((l: any) => ({
        type: str(l?.type, 20),
        id: str(l?.metadataId ?? l?.id, 40),
        quantity: num(l?.quantity),
        price: num(l?.price),
        name: str(l?.name, 80),
        forClientId: str(l?.forClientId, 40),
      }))
    : [];
  const giftCards = Array.isArray(payload?.giftCards)
    ? payload.giftCards.slice(0, 20).map((g: any) => ({
        productId: num(g?.productId),
        quantity: num(g?.quantity),
        amount: num(g?.amount),
      }))
    : [];
  const legs = Array.isArray(payload?.split?.legs)
    ? payload.split.legs.slice(0, 8).map((l: any) => ({
        method: str(l?.method, 20),
        amount: num(l?.amount),
        ...(lastFourOf(l?.typedCard?.number) !== null
          ? { cardLastFour: lastFourOf(l?.typedCard?.number) }
          : {}),
      }))
    : null;
  const credit = payload?.accountCredit;
  return {
    clientId: str(payload?.clientId, 40),
    clientName: str(payload?.clientName, 80),
    items,
    ...(giftCards.length > 0 ? { giftCards } : {}),
    method: str(payload?.method, 20),
    ...(legs !== null ? { split: legs } : {}),
    ...(num(payload?.cashTendered) !== null
      ? { cashTendered: num(payload.cashTendered) }
      : {}),
    ...(payload?.discount !== undefined
      ? { discount: pick(payload.discount, ["mode", "value"]) }
      : {}),
    ...(payload?.compReason !== undefined
      ? { compReason: pick(payload.compReason, ["kind", "detail"]) }
      : {}),
    ...(str(payload?.promotionCode, 40) !== null
      ? { promotionCode: str(payload.promotionCode, 40) }
      : {}),
    ...(credit !== undefined && credit !== null && typeof credit === "object"
      ? {
          accountCredit: {
            amount: num(credit.amount),
            noCharge: credit.noCharge !== undefined && credit.noCharge !== null,
            ...(str(credit?.noCharge?.reason, 200) !== null
              ? { reason: str(credit.noCharge.reason, 200) }
              : {}),
          },
        }
      : {}),
    ...(lastFourOf(payload?.typedCard?.number) !== null
      ? { typedCardLastFour: lastFourOf(payload.typedCard.number) }
      : {}),
    ...(lastFourOf(payload?.giftCard?.number) !== null
      ? { giftCardLastFour: lastFourOf(payload.giftCard.number) }
      : {}),
    ...(payload?.displayCard !== undefined ? { displayCard: true } : {}),
    ...(payload?.override !== undefined
      ? { override: pick(payload.override, ["mode", "metadataId", "pass"]) }
      : {}),
    ...(payload?.overdraftToken !== undefined ? { overdraft: true } : {}),
    ...(payload?.teacherToken !== undefined ? { pinUsed: true } : {}),
    ...(payload?.displayApprovalId !== undefined ? { customerApproved: true } : {}),
    ...(payload?.approvalOverride !== undefined ? { approvalOverride: true } : {}),
    ...(payload?.sendEmail === true ? { sendEmail: true } : {}),
  };
}

export function summarizeContractRequest(payload: any): Record<string, unknown> {
  return {
    clientId: str(payload?.clientId, 40),
    contractId: str(payload?.contractId, 40),
    startDate: str(payload?.startDate, 40),
    billing: str(payload?.billing, 20),
    expectedFirstTotal: num(payload?.expectedFirstTotal),
    signed: payload?.displayRequestId !== undefined,
    signatureOverride: payload?.signatureOverride !== undefined,
  };
}

export function summarizeGuestRequest(payload: any): Record<string, unknown> {
  return {
    memberClientId: str(payload?.memberClientId, 40),
    guestClientId: str(payload?.guestClientId, 40),
    classId: str(payload?.classId, 40),
    clientServiceId: str(payload?.clientServiceId, 40),
    className: str(payload?.className, 80),
    classStartsAt: str(payload?.classStartsAt, 40),
    waiverOverride: payload?.waiverOverride !== undefined,
  };
}

/* --- The answer: stripped and scrubbed -------------------------------- */

/** Keys whose values are never kept: anything that could be a card or
 *  gift card number, a barcode, a CVV, an expiry, a token, a PIN or a
 *  signature. `lastFour` (any casing) is kept: it is what the screens
 *  show and all a receipt row may carry. */
const DROP_KEY =
  /^(?!.*last ?four).*(number|barcode|cvv|cvc|securitycode|cardcode|exp(month|year|iry)|token|signature|png|secret|password)/i;
/** "pin" as a word of a key (`pin`, `teacherPin`, `pin_hash`), matched
 *  case-sensitively so a key that merely contains the letters
 *  ("shipping", "spinner") is not dropped. */
const PIN_KEY = /^(pin|PIN)([A-Z_]|$)|Pin([A-Z_]|$)|_pin(_|$)/;

const ANSWER_LIMIT = 16_000;

export function sanitizeAnswer(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") return scrubSecrets(value.slice(0, 2000));
  if (Array.isArray(value)) {
    return value.slice(0, 60).map((v) => sanitizeAnswer(v, depth + 1));
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEY.test(k) || PIN_KEY.test(k)) continue;
    out[k] = sanitizeAnswer(v, depth + 1);
  }
  return out;
}

function boundedAnswer(body: unknown): unknown {
  const clean = sanitizeAnswer(body);
  const text = JSON.stringify(clean ?? null);
  return text.length <= ANSWER_LIMIT
    ? clean
    : { clipped: true, length: text.length, head: text.slice(0, ANSWER_LIMIT) };
}

/* --- Outcome ----------------------------------------------------------- */

/** The route's answer in one word. `null` (a throw, or no answer at all)
 *  and anything unreadable that may have moved money are ambiguous; only
 *  a 4xx is a refusal. */
export function classifyAnswer(
  status: number | null,
  body: any,
): Exclude<SaleLogOutcome, "started"> {
  if (status === null) return "ambiguous";
  if (body?.soldNothing === true) return "sold-nothing";
  if (body?.partial === true) return "partial";
  if (body?.ambiguous === true) return "ambiguous";
  if (body?.reason === "held") return "held";
  if (status >= 500) return "ambiguous";
  if (status >= 400) return "refused";
  if (body === null || typeof body !== "object") return "ambiguous";
  if (body.suppressed === true || body.suppressed === "all") return "suppressed";
  if (body.ok === true) return "stood";
  if (body.ok === false) return "suppressed";
  return "ambiguous";
}

/** Every Mindbody sale id an answer names. */
export function saleIdsOf(body: any): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) ids.add(String(v));
    else if (typeof v === "string" && /^\d+$/.test(v.trim())) ids.add(v.trim());
  };
  add(body?.saleId);
  if (Array.isArray(body?.sales)) for (const s of body.sales) add(s?.saleId);
  add(body?.creditSaleId);
  add(body?.accountCredit?.saleId);
  add(body?.step2?.saleId);
  /* /api/guest answers its $0 sale as `sale: { saleId?, cartId }`; a
   * numeric cart id is the sale id there (a GUID is not, and is skipped). */
  add(body?.sale?.saleId);
  add(body?.sale?.cartId);
  return [...ids];
}

function totalOf(body: any): number | null {
  for (const v of [body?.total, body?.charged, body?.amountPaid, body?.accountCredit?.amount]) {
    if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
  }
  return null;
}

/* --- The row ------------------------------------------------------------ */

/** Writes for one id, in order, so a slow `started` insert can never land
 *  over the answer. */
const chains = new Map<string, Promise<unknown>>();

function write(row: SaleLogRow): Promise<boolean> {
  const prev = chains.get(row.id) ?? Promise.resolve();
  const next = prev.then(() => upsertSaleLog(row)).catch(() => false);
  chains.set(row.id, next);
  void next.finally(() => {
    if (chains.get(row.id) === next) chains.delete(row.id);
  });
  return next;
}

function logLine(row: SaleLogRow, stored: boolean | "pending"): void {
  const line = {
    id: row.id,
    route: row.route,
    outcome: row.outcome,
    status: row.httpStatus,
    staff: row.staffId,
    clients: row.clientIds,
    sales: row.saleIds,
    total: row.total,
    dryRun: row.dryRun,
    writeGuard: row.writeGuard,
    message: row.message,
  };
  const tail = stored === false ? " NOT STORED" : "";
  console.log(`[sale-log] ${JSON.stringify(line)}${tail}`);
}

function tapKeySha(request: Request): string | null {
  const key = request.headers.get("idempotency-key");
  if (key === null || key.trim() === "") return null;
  return createHash("sha256").update(key.trim()).digest("hex").slice(0, 32);
}

/**
 * Opens the row for one tap and returns the handle that closes it. Awaits
 * the `started` write for at most DB_MARKER_WAIT_MS, so the row is in the
 * table before Mindbody is asked whenever the database is healthy, and a
 * sick one costs the sale under a second. Never throws.
 */
export async function startSaleLog(input: {
  route: SaleLogRoute;
  request: Request;
  staffId: string | number | null;
  /** The teacher's name as the session holds it, kept beside the summary
   *  so the Sales sheet can say who without another read. */
  staffName?: string | null;
  clientIds: string[];
  summary: Record<string, unknown>;
}): Promise<SaleLogHandle> {
  let row: SaleLogRow;
  try {
    const dry = await dryRunState().catch(() => ({ on: false, source: null }));
    const guard = allowedWriteClientIds();
    row = {
      id: randomUUID(),
      route: input.route,
      tapKeySha: tapKeySha(input.request),
      site: currentSiteId(),
      target: target(),
      staffId: input.staffId === null ? null : String(input.staffId),
      clientIds: [...new Set(input.clientIds.filter((c) => c !== ""))],
      dryRun: dry.on ? dry.source : null,
      writeGuard: guard.size > 0,
      request: {
        ...input.summary,
        ...(str(input.staffName, 80) !== null
          ? { teacherName: str(input.staffName, 80) }
          : {}),
      },
      outcome: "started",
      httpStatus: null,
      message: null,
      saleIds: [],
      total: null,
      answer: null,
      startedAt: Date.now(),
      finishedAt: null,
      checkState: null,
      checkDetail: null,
      checkedAt: null,
    };
  } catch (err) {
    console.error(`[sale-log] could not open a row: ${String(err)}`);
    return { id: "", finish: async () => undefined };
  }
  const started = write(row);
  const landed = await boundedDb(started, DB_MARKER_WAIT_MS, false as boolean);
  logLine(row, landed ? true : "pending");
  if (!landed) {
    void started.then((ok) => {
      if (!ok) console.log(`[sale-log] ${row.id} started NOT STORED`);
    });
  }
  const opened = row;
  return {
    id: opened.id,
    finish: async (res) => {
      try {
        const status = res === null ? null : res.status;
        const body =
          res === null ? null : await res.clone().json().catch(() => null);
        const outcome = classifyAnswer(status, body);
        const message =
          typeof body?.error === "string"
            ? scrubSecrets(body.error.slice(0, 500))
            : typeof body?.message === "string"
              ? scrubSecrets(body.message.slice(0, 500))
              : res === null
                ? "The route threw before it answered."
                : null;
        const done: SaleLogRow = {
          ...opened,
          outcome,
          httpStatus: status,
          message,
          saleIds: saleIdsOf(body),
          total: totalOf(body),
          answer: boundedAnswer(body),
          finishedAt: Date.now(),
        };
        const ok = await write(done);
        logLine(done, ok);
      } catch (err) {
        console.error(`[sale-log] ${opened.id} could not be closed: ${String(err)}`);
      }
    },
  };
}
