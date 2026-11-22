import { randomUUID } from "node:crypto";

import {
  findReaderPayment,
  insertReaderPayment,
  readerPaymentsIn,
  transitionReaderPayment,
  type ReaderPaymentRow,
} from "./db";
import { readerEnv, readerMode, type ReaderEnv } from "./cardreader";
import { currentSiteId, target } from "./mindbody";
import {
  square,
  squareAmbiguous,
  squareKey,
  SquareError,
  type SquareCheckout,
  type SquarePayment,
} from "./square";

/**
 * Phase 4 (T224, T225): one Square Terminal attempt, from the tap on
 * "Charge on reader" to a hold the checkout can sell against, or to
 * nothing taken.
 *
 *   created -> collecting -> authorized -> (T226: selling -> sold -> captured)
 *   any open state -> cancelling -> cancelled
 *   and two ends a person must look at: unresolved (money may have moved
 *   in a way this code cannot settle) and uncollected (sold in Mindbody,
 *   the card NOT charged; T226).
 *
 * Every move is a compare-and-set on the row (db.ts
 * transitionReaderPayment), so a poll, a cancel, a second iPad and the
 * sweep can race and only one of them makes each move.
 *
 * What Square's docs taught this file (2026-11-22, PLAN Phase 4):
 * - with `autocomplete: false` the CHECKOUT reads COMPLETED while its
 *   PAYMENT is APPROVED, so a hold is known from the payment, never the
 *   checkout's status;
 * - a cancel can lose the race to a tap, and a timed-out checkout can turn
 *   COMPLETED after reading CANCELED, so every cancel is followed by a read
 *   of the checkout's payments, and the sweep looks again at recently
 *   cancelled attempts and voids any approved payment it finds;
 * - CompletePayment takes no amount, and Dismiss "attempts to capture",
 *   so Dismiss is never called here.
 *
 * Holds the app forgets about are released by Square itself after
 * HOLD_DURATION (`delay_action` CANCEL, Square's default), the backstop for
 * a server that died holding one.
 */

/** How long Square keeps an uncompleted payment before cancelling it
 *  itself. Well under Square's 36 hour ceiling; long enough for the
 *  "Mindbody did not answer" decision a person makes. */
const HOLD_DURATION = "PT12H";
/** How long the Terminal waits for a card before the app cancels. */
export const COLLECT_TIMEOUT_MS = 90_000;
/** How long an approved hold waits for its sale before it is released. */
export const AUTHORIZED_TIMEOUT_MS = 3 * 60_000;
/** How long after a cancel the sweep keeps looking for a late approval. */
const LATE_APPROVAL_WINDOW_MS = 10 * 60_000;

export const OPEN_STATES = ["created", "collecting", "authorized", "cancelling"];

/* --- What the screens are told ------------------------------------------ */

export interface AttemptView {
  id: string;
  state: string;
  amountCents: number;
  cardBrand: string | null;
  lastFour: string | null;
  /** One sentence for the panel. */
  words: string;
  /** Whether this attempt can still be cancelled from the iPad. */
  cancellable: boolean;
}

export function viewOf(row: ReaderPaymentRow): AttemptView {
  const dollars = `$${(row.amountCents / 100).toFixed(2)}`;
  const words: Record<string, string> = {
    created: `Starting the card reader for ${dollars}.`,
    collecting: `Ready for card. ${dollars}`,
    authorized: "Card approved. Finishing the sale.",
    cancelling: "Cancelling on the reader.",
    cancelled: row.failure ?? "Cancelled. Nothing was charged.",
    selling: "Card approved. Finishing the sale.",
    sold: "Sold. Taking the payment.",
    captured: "Paid.",
    unresolved:
      row.failure ??
      "The card is on hold and has NOT been charged. Do not run the card again.",
    uncollected:
      row.failure ?? "Sold in Mindbody, but the card was NOT charged.",
  };
  return {
    id: row.id,
    state: row.state,
    amountCents: row.amountCents,
    cardBrand: row.cardBrand,
    lastFour: row.lastFour,
    words: words[row.state] ?? row.state,
    cancellable: ["created", "collecting", "authorized"].includes(row.state),
  };
}

function cancelWords(reason: string | undefined | null): string {
  if (reason === "BUYER_CANCELED") return "Cancelled on the reader. Nothing was charged.";
  if (reason === "TIMED_OUT") return "The reader timed out with no card. Nothing was charged.";
  return "Cancelled. Nothing was charged.";
}

/* --- Square, in the few shapes used here --------------------------------- */

async function getCheckout(env: ReaderEnv, id: string): Promise<SquareCheckout> {
  const r = await square<{ checkout: SquareCheckout }>(
    `/v2/terminals/checkouts/${encodeURIComponent(id)}`,
    {},
    env,
  );
  return r.checkout;
}

async function getPayment(env: ReaderEnv, id: string): Promise<SquarePayment> {
  const r = await square<{ payment: SquarePayment }>(
    `/v2/payments/${encodeURIComponent(id)}`,
    {},
    env,
  );
  return r.payment;
}

async function voidPayment(env: ReaderEnv, id: string): Promise<SquarePayment> {
  const r = await square<{ payment: SquarePayment }>(
    `/v2/payments/${encodeURIComponent(id)}/cancel`,
    { method: "POST", body: {} },
    env,
  );
  return r.payment;
}

/** Looks for the checkout a create may have made before its answer was
 *  lost, by our reference id on that device in the last ten minutes. */
async function findCheckoutByReference(
  env: ReaderEnv,
  deviceId: string,
  referenceId: string,
): Promise<SquareCheckout | null> {
  const r = await square<{ checkouts?: SquareCheckout[] }>(
    "/v2/terminals/checkouts/search",
    {
      method: "POST",
      body: {
        query: {
          filter: {
            device_id: deviceId,
            created_at: { start_at: new Date(Date.now() - 10 * 60_000).toISOString() },
          },
          sort: { sort_order: "DESC" },
        },
        limit: 50,
      },
    },
    env,
  );
  return (r.checkouts ?? []).find((c) => c.reference_id === referenceId) ?? null;
}

/* --- Start --------------------------------------------------------------- */

export type StartResult =
  | { ok: true; attempt: AttemptView }
  | { ok: false; status: number; error: string; reason: string };

/**
 * Opens an attempt and puts the amount on the Terminal. The amount is the
 * caller's (the rehearsal's GrandTotal); this function never prices
 * anything. A create whose answer was lost is retried with the SAME
 * idempotency key (Square returns the same checkout) and then looked for
 * by reference; only when neither finds it does the attempt end cancelled,
 * and the sweep still voids a payment that turns up for it.
 */
export async function startAttempt(input: {
  staffId: string;
  clientId: string | null;
  cartSha: string;
  amountCents: number;
  deviceId: string;
  tapKeySha: string | null;
  note: string;
}): Promise<StartResult> {
  const env = readerEnv();
  if ("missing" in env) {
    return {
      ok: false,
      status: 503,
      reason: "not-set-up",
      error: `The card reader is not set up: missing ${env.missing.join(", ")}.`,
    };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, status: 400, reason: "amount", error: "There is nothing to charge." };
  }
  void sweepSoon();
  const id = randomUUID();
  const row = await insertReaderPayment({
    id,
    tapKeySha: input.tapKeySha,
    mode: readerMode(),
    target: target(),
    site: currentSiteId(),
    staffId: input.staffId,
    deviceId: input.deviceId,
    clientId: input.clientId,
    cartSha: input.cartSha,
    amountCents: input.amountCents,
  });
  if (row === "busy") {
    return {
      ok: false,
      status: 409,
      reason: "busy",
      error: "The reader is busy with another sale. Nothing was charged.",
    };
  }
  if (row === null) {
    return {
      ok: false,
      status: 503,
      reason: "database",
      error:
        "The card reader needs the database to start a sale, and it did not answer. Nothing was charged. Use another way to pay.",
    };
  }
  const key = squareKey("rpc", id);
  const body = {
    idempotency_key: key,
    checkout: {
      amount_money: { amount: input.amountCents, currency: "USD" },
      reference_id: id.slice(0, 40),
      note: input.note.slice(0, 500),
      device_options: {
        device_id: input.deviceId,
        skip_receipt_screen: false,
        tip_settings: { allow_tipping: false },
      },
      payment_options: {
        autocomplete: false,
        delay_duration: HOLD_DURATION,
        delay_action: "CANCEL",
        accept_partial_authorization: false,
      },
    },
  };
  let checkout: SquareCheckout | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3 && checkout === null; attempt++) {
    try {
      checkout = (
        await square<{ checkout: SquareCheckout }>(
          "/v2/terminals/checkouts",
          { method: "POST", body },
          env,
        )
      ).checkout;
    } catch (err) {
      lastErr = err;
      if (!squareAmbiguous(err)) break;
    }
  }
  if (checkout === null && lastErr !== null && squareAmbiguous(lastErr)) {
    checkout = await findCheckoutByReference(env, input.deviceId, id.slice(0, 40)).catch(
      () => null,
    );
  }
  if (checkout === null) {
    const definite = lastErr !== null && !squareAmbiguous(lastErr);
    const msg = lastErr instanceof Error ? lastErr.message : "no answer";
    await transitionReaderPayment(id, ["created"], "cancelled", {
      failure: definite
        ? `The reader refused the sale: ${msg} Nothing was charged.`
        : "The reader did not answer. Nothing was charged; if the reader shows the amount, cancel it there.",
    });
    console.warn(`[reader] ${id} create failed (${definite ? "refused" : "unknown"}): ${msg}`);
    const after = await findReaderPayment(id);
    return {
      ok: false,
      status: definite ? 409 : 502,
      reason: definite ? "refused" : "no-answer",
      error:
        typeof after === "object" && after !== null && after.failure
          ? after.failure
          : msg,
    };
  }
  const moved = await transitionReaderPayment(id, ["created"], "collecting", {
    checkoutId: checkout.id,
  });
  console.log(`[reader] ${id} collecting checkout=${checkout.id} amount=${input.amountCents}`);
  const now = moved !== null && moved !== "unavailable" ? moved : row;
  return { ok: true, attempt: viewOf({ ...now, state: "collecting", checkoutId: checkout.id }) };
}

/* --- Refresh ------------------------------------------------------------- */

/**
 * Reads Square for one attempt and moves the row to match: the poll each
 * second from the iPad, and the sweep. Answers the row as it now stands.
 */
export async function refreshAttempt(id: string): Promise<ReaderPaymentRow | null> {
  const found = await findReaderPayment(id);
  if (found === null || found === "unavailable") return null;
  const row = found;
  const env = readerEnv();
  if ("missing" in env) return row;

  if (row.state === "collecting" && row.checkoutId) {
    let checkout: SquareCheckout;
    try {
      checkout = await getCheckout(env, row.checkoutId);
    } catch {
      return row;
    }
    const paymentId = checkout.payment_ids?.[0];
    if (paymentId) {
      let payment: SquarePayment;
      try {
        payment = await getPayment(env, paymentId);
      } catch {
        return row;
      }
      if (payment.status === "APPROVED") {
        if (payment.amount_money?.amount !== row.amountCents) {
          await cancelAttempt(
            id,
            "The reader approved a different amount, so it was voided. Nothing was charged.",
          );
          return (await reread(id)) ?? row;
        }
        const moved = await transitionReaderPayment(id, ["collecting"], "authorized", {
          paymentId,
          cardBrand: payment.card_details?.card?.card_brand ?? null,
          lastFour: payment.card_details?.card?.last_4 ?? null,
          authorizedAt: Date.now(),
        });
        if (moved !== null && moved !== "unavailable") {
          console.log(`[reader] ${id} authorized payment=${paymentId}`);
          return moved;
        }
        return (await reread(id)) ?? row;
      }
      if (payment.status === "COMPLETED") {
        /* Should never happen with autocomplete off: money was TAKEN at
         * the tap with no sale behind it. A person must refund it. */
        const moved = await transitionReaderPayment(id, ["collecting"], "unresolved", {
          paymentId,
          failure:
            "Square took the payment at the tap, before the sale. Nothing was sold. Refund it in Square.",
        });
        console.error(`[reader] ${id} payment ${paymentId} COMPLETED at the tap`);
        return moved !== null && moved !== "unavailable" ? moved : row;
      }
      if (payment.status === "CANCELED" || payment.status === "FAILED") {
        const moved = await transitionReaderPayment(id, ["collecting"], "cancelled", {
          paymentId,
          failure: "Card declined. Nothing was charged.",
        });
        return moved !== null && moved !== "unavailable" ? moved : row;
      }
      return row;
    }
    if (checkout.status === "CANCELED") {
      const moved = await transitionReaderPayment(id, ["collecting"], "cancelled", {
        failure: cancelWords(checkout.cancel_reason),
      });
      return moved !== null && moved !== "unavailable" ? moved : row;
    }
    if (Date.now() - row.createdAt > COLLECT_TIMEOUT_MS) {
      await cancelAttempt(id, "The reader timed out with no card. Nothing was charged.");
      return (await reread(id)) ?? row;
    }
    return row;
  }

  if (
    row.state === "authorized" &&
    row.authorizedAt !== null &&
    Date.now() - row.authorizedAt > AUTHORIZED_TIMEOUT_MS
  ) {
    await cancelAttempt(
      id,
      "The card was approved but no sale followed, so the hold was released. Nothing was charged.",
    );
    return (await reread(id)) ?? row;
  }
  return row;
}

async function reread(id: string): Promise<ReaderPaymentRow | null> {
  const r = await findReaderPayment(id);
  return r === "unavailable" ? null : r;
}

/* --- Cancel -------------------------------------------------------------- */

/**
 * Cancels an attempt that has not been claimed for a sale: the Terminal's
 * checkout, then EVERY approved payment that checkout produced (a cancel
 * can lose the race to the tap). Only the caller that wins the move to
 * `cancelling` does the work. Ends `cancelled` with `why`, or `unresolved`
 * when a payment was found already COMPLETED or could not be voided.
 */
export async function cancelAttempt(
  id: string,
  why: string,
): Promise<ReaderPaymentRow | null> {
  const env = readerEnv();
  const claimed = await transitionReaderPayment(
    id,
    ["created", "collecting", "authorized"],
    "cancelling",
    { failure: why },
  );
  if (claimed === null || claimed === "unavailable") {
    return reread(id);
  }
  if ("missing" in env) {
    await transitionReaderPayment(id, ["cancelling"], "unresolved", {
      failure: "The card reader's settings are missing, so the hold could not be released. Check Square.",
    });
    return reread(id);
  }
  return finishCancel(env, claimed);
}

async function finishCancel(
  env: ReaderEnv,
  row: ReaderPaymentRow,
): Promise<ReaderPaymentRow | null> {
  const id = row.id;
  let checkout: SquareCheckout | null = null;
  if (row.checkoutId) {
    try {
      checkout = (
        await square<{ checkout: SquareCheckout }>(
          `/v2/terminals/checkouts/${encodeURIComponent(row.checkoutId)}/cancel`,
          { method: "POST", body: {} },
          env,
        )
      ).checkout;
    } catch (err) {
      /* A 4xx here is usually "already finished"; read it instead. */
      if (squareAmbiguous(err)) return reread(id);
    }
    try {
      checkout = await getCheckout(env, row.checkoutId);
    } catch {
      return reread(id);
    }
  }
  const paymentIds = new Set<string>([
    ...(checkout?.payment_ids ?? []),
    ...(row.paymentId ? [row.paymentId] : []),
  ]);
  for (const pid of paymentIds) {
    let payment: SquarePayment;
    try {
      payment = await getPayment(env, pid);
    } catch {
      return reread(id);
    }
    if (payment.status === "APPROVED") {
      try {
        await voidPayment(env, pid);
        console.log(`[reader] ${id} voided payment=${pid}`);
      } catch (err) {
        if (squareAmbiguous(err)) return reread(id);
        await transitionReaderPayment(id, ["cancelling"], "unresolved", {
          paymentId: pid,
          failure: `The hold could not be released: ${err instanceof Error ? err.message : String(err)} Check Square.`,
        });
        return reread(id);
      }
    } else if (payment.status === "COMPLETED") {
      await transitionReaderPayment(id, ["cancelling"], "unresolved", {
        paymentId: pid,
        failure:
          "Square took the payment before it could be cancelled. Nothing was sold. Refund it in Square.",
      });
      console.error(`[reader] ${id} payment ${pid} COMPLETED during a cancel`);
      return reread(id);
    }
  }
  const done = await transitionReaderPayment(id, ["cancelling"], "cancelled", {});
  console.log(`[reader] ${id} cancelled: ${row.failure ?? ""}`);
  return done === null || done === "unavailable" ? reread(id) : done;
}

/* --- The sweep ------------------------------------------------------------ */

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/** Starts the in-process sweep on first use (the app has no worker), and
 *  runs one pass now. Never throws. */
export async function sweepSoon(): Promise<void> {
  if (sweepTimer === null) {
    sweepTimer = setInterval(() => void sweepOnce(), 15_000);
    sweepTimer.unref?.();
  }
  await sweepOnce();
}

/**
 * One pass. Square calls only, never a Mindbody write, and it runs whether
 * or not the switch is on: releasing a hold is cleaning up, not selling.
 * - created / collecting: refreshed (timeouts included);
 * - authorized: refreshed (released after AUTHORIZED_TIMEOUT_MS);
 * - cancelling: finished (a cancel that died half way);
 * - cancelled in the last ten minutes: its checkout read again, and any
 *   approved payment that turned up late is voided.
 */
export async function sweepOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const env = readerEnv();
    if ("missing" in env) return;
    const open = await readerPaymentsIn(["created", "collecting", "authorized"]);
    for (const r of open ?? []) {
      if (r.state === "created" && Date.now() - r.createdAt > 60_000) {
        await transitionReaderPayment(r.id, ["created"], "cancelled", {
          failure: "The reader was never reached. Nothing was charged.",
        });
        continue;
      }
      await refreshAttempt(r.id).catch(() => null);
    }
    await sweepSales(env);
    const stuck = await readerPaymentsIn(["cancelling"]);
    for (const r of stuck ?? []) {
      if (Date.now() - r.updatedAt > 20_000) await finishCancel(env, r).catch(() => null);
    }
    const recent = await readerPaymentsIn(["cancelled"], Date.now() - LATE_APPROVAL_WINDOW_MS);
    for (const r of recent ?? []) {
      if (!r.checkoutId) continue;
      try {
        const c = await getCheckout(env, r.checkoutId);
        for (const pid of c.payment_ids ?? []) {
          const p = await getPayment(env, pid);
          if (p.status === "APPROVED") {
            await voidPayment(env, pid);
            console.warn(`[reader] ${r.id} late approval ${pid} voided by the sweep`);
          } else if (p.status === "COMPLETED") {
            await transitionReaderPayment(r.id, ["cancelled"], "unresolved", {
              paymentId: pid,
              failure:
                "Square took a payment after this sale was cancelled. Nothing was sold. Refund it in Square.",
            });
            console.error(`[reader] ${r.id} late COMPLETED payment ${pid}`);
          }
        }
      } catch (err) {
        if (!(err instanceof SquareError)) console.warn(`[reader] sweep: ${String(err)}`);
      }
    }
  } catch (err) {
    console.warn(`[reader] sweep failed: ${String(err)}`);
  } finally {
    sweeping = false;
  }
}

/* --- Selling against a hold (T226) -------------------------------------- */

async function completePayment(env: ReaderEnv, id: string): Promise<SquarePayment> {
  const r = await square<{ payment: SquarePayment }>(
    `/v2/payments/${encodeURIComponent(id)}/complete`,
    { method: "POST", body: {} },
    env,
  );
  return r.payment;
}

export type ClaimResult =
  | { ok: true; row: ReaderPaymentRow; mindbodyPaymentId: string }
  | { ok: false; error: string };

/**
 * T226: the checkout's claim on an approved hold, `authorized -> selling`,
 * made only after the row and SQUARE both agree with the sale about to be
 * made: the same teacher, client, cart and Mindbody target, and a payment
 * Square reads as APPROVED for exactly `amountCents`, the fresh
 * rehearsal's total. Anything else refuses before Mindbody is asked, and
 * the hold stays where it is (the teacher can Cancel it, or the sweep
 * releases it). Square is read here, not trusted from the row.
 */
export async function claimHold(input: {
  attemptId: string;
  staffId: string;
  clientId: string;
  cartSha: string;
  amountCents: number;
}): Promise<ClaimResult> {
  const env = readerEnv();
  if ("missing" in env) {
    return { ok: false, error: `The card reader is not set up: missing ${env.missing.join(", ")}.` };
  }
  const found = await findReaderPayment(input.attemptId);
  if (found === "unavailable") {
    return {
      ok: false,
      error: "The database did not answer, so the card reader hold could not be checked. Nothing was charged.",
    };
  }
  if (found === null || found.staffId !== input.staffId) {
    return { ok: false, error: "No card reader hold was found for this sale. Nothing was charged." };
  }
  const row = found;
  if (row.state !== "authorized") {
    return {
      ok: false,
      error:
        row.state === "collecting"
          ? "The reader has not approved a card yet."
          : `This card reader attempt is ${row.state}, so nothing was charged.`,
    };
  }
  if (row.target !== target() || row.mode !== readerMode()) {
    return { ok: false, error: "This hold was taken for another studio or mode. Nothing was charged." };
  }
  if (row.clientId !== input.clientId || row.cartSha !== input.cartSha) {
    return {
      ok: false,
      error: "The ticket changed after the card was tapped. Cancel the reader and start again. Nothing was charged.",
    };
  }
  if (row.amountCents !== input.amountCents) {
    return {
      ok: false,
      error:
        `Mindbody's total is now $${(input.amountCents / 100).toFixed(2)}, but the card was approved for ` +
        `$${(row.amountCents / 100).toFixed(2)}. Cancel the reader and start again. Nothing was charged.`,
    };
  }
  if (!row.paymentId) {
    return { ok: false, error: "The hold has no payment on it. Nothing was charged." };
  }
  let payment: SquarePayment;
  try {
    payment = await getPayment(env, row.paymentId);
  } catch (err) {
    return {
      ok: false,
      error: `Square could not confirm the hold: ${err instanceof Error ? err.message : String(err)} Nothing was charged.`,
    };
  }
  if (payment.status !== "APPROVED" || payment.amount_money?.amount !== input.amountCents) {
    return { ok: false, error: `Square reads the hold as ${payment.status}, so nothing was charged. Start again.` };
  }
  const moved = await transitionReaderPayment(input.attemptId, ["authorized"], "selling");
  if (moved === null || moved === "unavailable") {
    return { ok: false, error: "This card reader hold was taken by another request. Nothing was charged." };
  }
  console.log(`[reader] ${moved.id} selling payment=${moved.paymentId} amount=${moved.amountCents}`);
  return { ok: true, row: moved, mindbodyPaymentId: env.mindbodyPaymentId };
}

/**
 * T226: the sale did not happen (Mindbody refused, a dry run or the write
 * guard suppressed it, T103 found nothing sold): release the hold, from
 * `selling`, through the same cancel every other release uses. Never
 * throws; answers the row as it ends.
 */
export async function releaseHold(id: string, why: string): Promise<ReaderPaymentRow | null> {
  const env = readerEnv();
  const moved = await transitionReaderPayment(id, ["selling"], "cancelling", { failure: why });
  if (moved === null || moved === "unavailable") return reread(id);
  if ("missing" in env) return reread(id);
  return finishCancel(env, moved).catch(() => reread(id));
}

/**
 * T226: the sale stands in Mindbody: record it and TAKE the money. A
 * complete that does not answer is retried here three times and then by
 * the sweep each pass (a payment completes once; the tap, the card and
 * the sale already decided it). A complete Square definitely refuses
 * ends `uncollected`: sold in Mindbody, the card NOT charged, for a
 * person.
 */
export async function captureHold(
  id: string,
  mbSaleId: string | null,
): Promise<ReaderPaymentRow | null> {
  const env = readerEnv();
  const sold = await transitionReaderPayment(id, ["selling"], "sold", { mbSaleId });
  const row = sold === null || sold === "unavailable" ? await reread(id) : sold;
  if (row === null || row.state !== "sold" || "missing" in env) return row;
  return tryComplete(env, row);
}

async function tryComplete(env: ReaderEnv, row: ReaderPaymentRow): Promise<ReaderPaymentRow | null> {
  if (!row.paymentId) return row;
  for (let i = 0; i < 3; i++) {
    try {
      const p = await completePayment(env, row.paymentId);
      if (p.status === "COMPLETED") {
        const done = await transitionReaderPayment(row.id, ["sold"], "captured");
        console.log(`[reader] ${row.id} captured payment=${row.paymentId} sale=${row.mbSaleId ?? "?"}`);
        return done === null || done === "unavailable" ? reread(row.id) : done;
      }
    } catch (err) {
      if (!squareAmbiguous(err)) {
        /* Completed already by an earlier try whose answer was lost? */
        try {
          const p = await getPayment(env, row.paymentId);
          if (p.status === "COMPLETED") {
            const done = await transitionReaderPayment(row.id, ["sold"], "captured");
            return done === null || done === "unavailable" ? reread(row.id) : done;
          }
        } catch {
          /* fall through to uncollected */
        }
        const out = await transitionReaderPayment(row.id, ["sold"], "uncollected", {
          failure: `Sold in Mindbody, but the card was NOT charged: ${err instanceof Error ? err.message : String(err)}`,
        });
        console.error(`[reader] ${row.id} UNCOLLECTED sale=${row.mbSaleId ?? "?"}`);
        return out === null || out === "unavailable" ? reread(row.id) : out;
      }
    }
  }
  console.warn(`[reader] ${row.id} complete did not answer; the sweep will retry`);
  return row;
}

/** T226: Mindbody did not answer (or the route threw) after the claim:
 *  the hold is KEPT, for a person to settle. */
export async function markUnresolved(id: string, why: string): Promise<void> {
  await transitionReaderPayment(id, ["selling"], "unresolved", { failure: why });
  console.warn(`[reader] ${id} unresolved: ${why}`);
}

/** T226, for the sweep: complete what was sold and not yet taken, and
 *  turn a `selling` row no request still owns into `unresolved`. */
async function sweepSales(env: ReaderEnv): Promise<void> {
  const sold = await readerPaymentsIn(["sold"]);
  for (const r of sold ?? []) await tryComplete(env, r).catch(() => null);
  const selling = await readerPaymentsIn(["selling"]);
  for (const r of selling ?? []) {
    if (Date.now() - r.updatedAt > 5 * 60_000) {
      await markUnresolved(
        r.id,
        "The sale did not finish (the server may have restarted). The card is on hold and has NOT been charged. Check Mindbody for the sale before deciding.",
      );
    }
  }
}
