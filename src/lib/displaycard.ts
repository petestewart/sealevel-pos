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
 *   answered (or hands it back for a refusal that provably asked
 *   Mindbody to write nothing). A claimed card is never replaced, never
 *   evicted and never dropped from under its checkout.
 * - **Whose it is.** The client the ticket was for, the teacher who put
 *   the ticket up (staff id) and the tab they put it up from (presenter
 *   id). A checkout for anybody else, by anybody else or from another
 *   tab is refused: two iPads on one counter cannot charge each other's
 *   student (T241 review).
 * - **Short-lived.** It lives as long as an approval does
 *   (REQUEST_TTL_MS, passed in by the hub), swept by a timer of its own
 *   so a closed tab cannot leave a card in memory past that, and it is
 *   dropped when its request is cancelled, refused by the student or
 *   expires, when its ticket changes under it, when the display is
 *   unpaired, and when the teacher's tender lets go of it.
 *
 * Nothing in this file calls Mindbody, and nothing in it may.
 */

interface HeldCard {
  card: TypedCard;
  lastFour: string;
  /** The client the ticket was for when the card was typed, "" for a
   *  walk-in on the house client. */
  clientId: string;
  /** The teacher who put the ticket up, and the tab they did it from. */
  staffId: string;
  presenter: string;
  expiresAt: number;
  /** A checkout holds it right now. */
  claimed: boolean;
}

/** A counter holds one ticket at a time; a handful covers a sale that
 *  was asked twice and any stragglers before their TTL. */
const MAX_CARDS = 8;
/** How often the timer sweeps out expired cards. */
const SWEEP_EVERY_MS = 30 * 1000;

const G = globalThis as typeof globalThis & {
  __posDisplayCards?: Map<string, HeldCard>;
  __posDisplayCardSweep?: ReturnType<typeof setInterval>;
};
const cards: Map<string, HeldCard> = (G.__posDisplayCards ??= new Map());

/** Drop every expired, unclaimed card. Run by the timer, on every hold
 *  and claim, and by the hub on every present. */
export function sweepDisplayCards(now = Date.now()): void {
  for (const [id, held] of cards) {
    if (now >= held.expiresAt && !held.claimed) {
      cards.delete(id);
      console.log(`[display-card] dropped for request ${id} (expired)`);
    }
  }
}

/* The sweep that does not wait for a request: a teacher's tab closed
 * with a card held must not leave a number and a CVV in memory past the
 * card's TTL. Unref'd, so it never holds a shutdown open; one per
 * process, however often a dev build reloads this module. */
if (G.__posDisplayCardSweep === undefined) {
  const timer = setInterval(() => sweepDisplayCards(), SWEEP_EVERY_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  G.__posDisplayCardSweep = timer;
}

/** Hold the student's card on `requestId`, replacing an unclaimed card
 *  already held there. Refused while a checkout is charging the one
 *  there. Answers the last four, which is all that leaves. */
export function holdDisplayCard(input: {
  requestId: string;
  card: TypedCard;
  clientId: string;
  staffId: string;
  presenter: string;
  ttlMs: number;
  now?: number;
}): { ok: true; lastFour: string } | { ok: false; error: string } {
  const now = input.now ?? Date.now();
  sweepDisplayCards(now);
  if (cards.get(input.requestId)?.claimed === true) {
    return {
      ok: false,
      error: "The front desk is finishing the sale. Please wait a moment.",
    };
  }
  cards.delete(input.requestId);
  /* Room for one more, never by evicting a card a checkout holds. */
  while (cards.size >= MAX_CARDS) {
    const oldest = [...cards.entries()].find(([, h]) => !h.claimed);
    if (oldest === undefined) {
      return {
        ok: false,
        error: "The front desk is busy. Please wait a moment.",
      };
    }
    cards.delete(oldest[0]);
  }
  const lastFour = typedCardLastFour(input.card.number);
  cards.set(input.requestId, {
    card: input.card,
    lastFour,
    clientId: input.clientId,
    staffId: input.staffId,
    presenter: input.presenter,
    expiresAt: now + input.ttlMs,
    claimed: false,
  });
  console.log(
    `[display-card] held for request ${input.requestId}, ending ${lastFour} (memory only)`,
  );
  return { ok: true, lastFour };
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

const GONE =
  "The customer's card is no longer held (it is kept for one charge, for " +
  "30 minutes, and not across a restart). Ask them to enter it again. " +
  "Nothing was charged.";

/**
 * A checkout takes the card for its one charge. Refused (with the reason
 * in the teacher's words) when there is none, when another checkout has
 * it, or when the client, the teacher or the tab is not the one the card
 * was typed for. A claim must be followed by exactly one
 * `settleDisplayCard`.
 */
export function claimDisplayCard(
  requestId: string,
  who: { clientId: string; staffId: string; presenter: string },
  now = Date.now(),
): { ok: true; card: TypedCard } | { ok: false; error: string } {
  sweepDisplayCards(now);
  const held = cards.get(requestId);
  if (held === undefined) return { ok: false, error: GONE };
  if (held.claimed) {
    return {
      ok: false,
      error:
        "The customer's card is already being charged. Nothing more was " +
        "charged.",
    };
  }
  if (held.clientId !== who.clientId.trim()) {
    return {
      ok: false,
      error:
        "The customer's card was entered for a different client's ticket. " +
        "Ask them to enter it again. Nothing was charged.",
    };
  }
  if (held.staffId !== who.staffId || held.presenter !== who.presenter) {
    return {
      ok: false,
      error:
        "The customer's card was entered for a ticket on another iPad. " +
        "Nothing was charged.",
    };
  }
  held.claimed = true;
  return { ok: true, card: held.card };
}

/** The checkout answered. `spend` true is the one charge, done; false
 *  hands the card back, for a refusal that asked Mindbody nothing. */
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
