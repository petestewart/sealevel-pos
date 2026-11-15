import type { TypedCard } from "./typedcard";
import { typedCardLastFour } from "./typedcard";

/**
 * T241: a card the STUDENT typed on the customer iPad, held for one
 * charge (Pete: "i dont want teachers to have to do that. a student
 * shouldnt have to hand them their card.").
 *
 * The rule this file exists to keep: card data travels display -> this
 * server's MEMORY -> the teacher's /api/checkout, and nowhere else.
 *
 * - **Memory only.** A Map on globalThis, like the hub. Never a table,
 *   never a payload or result column (the display request's own row is
 *   written through to `display_requests`, which is exactly why the card
 *   is NOT on the request object), never a file. A restart loses every
 *   card, and the student is asked to enter it again.
 * - **Never logged.** Nothing here prints anything but a last four and a
 *   request id. The checkout that spends it sends it through mindbody(),
 *   whose call log strikes CreditCardNumber and CVV in both directions,
 *   exactly as for a card the teacher typed (T93).
 * - **Never sent to a browser.** The teacher's iPad hears a last four;
 *   the display hears nothing back about the card at all.
 * - **One charge.** `claimDisplayCard` hands it to one checkout at a
 *   time, and `settleDisplayCard` spends it when that checkout has
 *   answered, whatever the answer.
 * - **Short-lived and bound.** It lives as long as an approval does
 *   (REQUEST_TTL_MS, passed in by the hub), it is bound to the client the
 *   ticket was for, and it is dropped when its request is cancelled or
 *   expires, when its ticket changes under it, when the display is
 *   unpaired, and when the teacher's tender lets go of it.
 *
 * Nothing in this file calls Mindbody, and nothing in it may.
 */

interface HeldCard {
  card: TypedCard;
  lastFour: string;
  /** The client the ticket was for when the card was typed, "" for a
   *  walk-in on the house client. A checkout for anybody else is
   *  refused: a student's card pays for their own ticket. */
  clientId: string;
  expiresAt: number;
  /** A checkout holds it right now. */
  claimed: boolean;
}

/** A counter holds one ticket at a time; a handful covers a sale that
 *  was asked twice and any stragglers before their TTL. */
const MAX_CARDS = 8;

const G = globalThis as typeof globalThis & {
  __posDisplayCards?: Map<string, HeldCard>;
};
const cards: Map<string, HeldCard> = (G.__posDisplayCards ??= new Map());

function sweep(now: number): void {
  for (const [id, held] of cards) {
    if (now >= held.expiresAt && !held.claimed) cards.delete(id);
  }
}

/** Hold the student's card on `requestId`, replacing any card already
 *  held there. Answers the last four, which is all that leaves. */
export function holdDisplayCard(input: {
  requestId: string;
  card: TypedCard;
  clientId: string;
  ttlMs: number;
  now?: number;
}): { lastFour: string } {
  const now = input.now ?? Date.now();
  sweep(now);
  cards.delete(input.requestId);
  while (cards.size >= MAX_CARDS) {
    const oldest = cards.keys().next();
    if (oldest.done) break;
    cards.delete(oldest.value);
  }
  const lastFour = typedCardLastFour(input.card.number);
  cards.set(input.requestId, {
    card: input.card,
    lastFour,
    clientId: input.clientId,
    expiresAt: now + input.ttlMs,
    claimed: false,
  });
  console.log(
    `[display-card] held for request ${input.requestId}, ending ${lastFour} (memory only)`,
  );
  return { lastFour };
}

/** Let go of the card on `requestId`, if any. Never one a checkout is
 *  holding: that one is settled by the checkout. */
export function dropDisplayCard(requestId: string, why: string): void {
  const held = cards.get(requestId);
  if (held === undefined || held.claimed) return;
  cards.delete(requestId);
  console.log(`[display-card] dropped for request ${requestId} (${why})`);
}

/** Every card, unclaimed (the display was unpaired). */
export function dropAllDisplayCards(why: string): void {
  for (const id of [...cards.keys()]) dropDisplayCard(id, why);
}

/**
 * A checkout takes the card for its one charge. Refused (with the reason
 * in the teacher's words) when there is none, when another checkout has
 * it, or when the ticket is for a different client. A claim must be
 * followed by exactly one `settleDisplayCard`.
 */
export function claimDisplayCard(
  requestId: string,
  clientId: string,
  now = Date.now(),
): { ok: true; card: TypedCard } | { ok: false; error: string } {
  sweep(now);
  const held = cards.get(requestId);
  if (held === undefined) {
    return {
      ok: false,
      error:
        "The card entered on the customer screen is no longer held (it is " +
        "kept for one charge, for 30 minutes, and not across a restart). " +
        "Ask them to enter it again. Nothing was charged.",
    };
  }
  if (held.claimed) {
    return {
      ok: false,
      error:
        "The card entered on the customer screen is already being charged. " +
        "Nothing more was charged.",
    };
  }
  if (held.clientId !== clientId.trim()) {
    return {
      ok: false,
      error:
        "The card entered on the customer screen was for a different " +
        "client's ticket. Ask them to enter it again. Nothing was charged.",
    };
  }
  held.claimed = true;
  return { ok: true, card: held.card };
}

/** The checkout answered. `spend` true is the one charge, done (the
 *  checkout spends on every answer); false hands the card back, for a
 *  caller that knows nothing was sent. */
export function settleDisplayCard(requestId: string, spend: boolean): void {
  const held = cards.get(requestId);
  if (held === undefined) return;
  if (spend) {
    cards.delete(requestId);
    console.log(`[display-card] spent for request ${requestId}`);
    return;
  }
  held.claimed = false;
}
