import { record } from "./calllog";
import { readerEnv, type ReaderEnv } from "./cardreader";

/**
 * Phase 4 (T223): the Square client. Plain `fetch`, JSON, no Square SDK,
 * nothing imported from ai-manager, so the call log shows exactly what was
 * sent and the proxy can inject the token.
 *
 * ONLY src/lib/readerpayment.ts (the state machine) and the pairing route
 * may import this; sale.ts never does (PLAN Phase 4, Architecture).
 *
 * Every call is recorded in the dev drawer's call log with `service:
 * "square"`. The token is never recorded. A Terminal answer carries a
 * card's brand and last four at most; the call log's card scrub runs over
 * it all the same.
 */

/** Pinned so an upgrade on Square's side cannot change an answer's shape
 *  under us (Square's docs, 2026-11-22: optional, current 2026-11-18). */
export const SQUARE_VERSION = "2026-11-18";

export class SquareError extends Error {
  status: number | null;
  codes: string[];
  constructor(message: string, status: number | null, codes: string[] = []) {
    super(message);
    this.name = "SquareError";
    this.status = status;
    this.codes = codes;
  }
}

/** Whether an error leaves the outcome of a WRITE unknown: the transport
 *  died, or Square answered a 5xx. Only a 4xx is a definite refusal. */
export function squareAmbiguous(err: unknown): boolean {
  if (err instanceof SquareError) return err.status === null || err.status >= 500;
  return true;
}

const TIMEOUT_MS = 15_000;

/**
 * One Square call. Throws SquareError on anything but a 2xx, with
 * Square's own `errors[].detail` as the message. `env` is passed by
 * callers that already resolved it; otherwise it is read here and a
 * missing credential throws (by variable NAME).
 */
export async function square<T = any>(
  path: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {},
  givenEnv?: ReaderEnv,
): Promise<T> {
  const resolved = givenEnv ?? readerEnv();
  if ("missing" in resolved) {
    throw new SquareError(
      `The card reader is not set up: missing ${resolved.missing.join(", ")} in the server environment.`,
      null,
    );
  }
  const method = init.method ?? "GET";
  const started = Date.now();
  let status: number | null = null;
  let text = "";
  try {
    const res = await fetch(`${resolved.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        "Square-Version": SQUARE_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    record({
      method,
      path: `square:${path}`,
      status: null,
      ms: Date.now() - started,
      outcome: "sent",
      actor: null,
      actorToken: null,
      service: "square",
      requestBody: init.body ?? null,
      responseBody: String(err),
    });
    throw new SquareError(
      `Square did not answer: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }
  record({
    method,
    path: `square:${path}`,
    status,
    ms: Date.now() - started,
    outcome: "sent",
    actor: null,
    actorToken: null,
    service: "square",
    requestBody: init.body ?? null,
    responseBody: text,
  });
  let body: any = null;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    body = null;
  }
  if (status < 200 || status >= 300) {
    const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
    const detail =
      errors.map((e) => e?.detail ?? e?.code).filter(Boolean).join("; ") ||
      `HTTP ${status}`;
    throw new SquareError(
      `Square refused: ${detail}`,
      status,
      errors.map((e) => String(e?.code ?? "")).filter(Boolean),
    );
  }
  if (body === null) {
    throw new SquareError(`Square answered ${status} with no readable body.`, status);
  }
  return body as T;
}

/* --- The few shapes this app reads -------------------------------------- */

export interface SquareMoney {
  amount: number;
  currency: string;
}

export interface SquareCheckout {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "CANCEL_REQUESTED" | "CANCELED" | "COMPLETED" | string;
  payment_ids?: string[];
  cancel_reason?: string;
  amount_money?: SquareMoney;
  reference_id?: string;
}

export interface SquarePayment {
  id: string;
  status: "APPROVED" | "PENDING" | "COMPLETED" | "CANCELED" | "FAILED" | string;
  amount_money?: SquareMoney;
  location_id?: string;
  reference_id?: string;
  card_details?: { card?: { card_brand?: string; last_4?: string } };
}

export interface SquareDeviceCode {
  id: string;
  code: string;
  status: "UNKNOWN" | "UNPAIRED" | "PAIRED" | "EXPIRED" | string;
  device_id?: string;
  pair_by?: string;
  location_id?: string;
}

/** Dollars to the integer cents Square takes, refusing anything that is
 *  not whole cents. */
export function toCents(dollars: number): number {
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || Math.abs(dollars * 100 - cents) > 1e-6) {
    throw new Error(`not a whole number of cents: ${dollars}`);
  }
  return cents;
}

/** An idempotency key that fits every Square endpoint's limit (45 on an
 *  update or a refund, the tightest), derived from our own ids. */
export function squareKey(...parts: string[]): string {
  return parts.join(":").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 45);
}
