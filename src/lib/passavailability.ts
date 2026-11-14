/**
 * T221: which passes the attached client cannot buy, asked of Mindbody
 * before the teacher taps one.
 *
 * Pete, 2026-11-14, after 581 was refused for a client who already held
 * it ("Client has hit the purchase count for this intro series."): "is
 * there any way to make it greyed out with a UNAVAILABLE indicator so i
 * cannot even put it in the cart to begin with?", and then "can items be
 * restricted to only certain types of members as well?"
 *
 * Mindbody refuses a pass for a CLIENT on its own business rules (T112):
 * an intro offer the client has used up or is not new enough for, and a
 * pass restricted to members the client is not. Those rules live in
 * Mindbody and are not rebuilt here. Instead the passes that CAN be
 * refused per client are each priced alone with `Test: true` for that
 * client, in parallel, and the ones Mindbody refuses are reported with
 * Mindbody's own sentence. Which passes those are is read off the live
 * catalog, never a list in the code: `IsIntroOffer` (any IntroOfferType;
 * T220 found `NewAndExistingClients` is still once per client) and a
 * non-empty `RestrictToMembershipIds`. On site 471 that is four passes.
 *
 * Only a 4xx answer is a refusal. A suppressed pricing (dry run, the
 * write guard), a 5xx or a dead transport says nothing about the client,
 * so the pass is left AVAILABLE: a check that cannot answer must never
 * hide a pass the client may buy. The cart's own pricing (T100's refused
 * line) stays the backstop for anything this misses.
 *
 * The answer is cached per target and client for two minutes, so
 * attaching, detaching and attaching the same student again asks once.
 * `fresh` skips the cache, which the screen asks for after a sale, since
 * a sale is what changes the answer.
 */
import { mindbodyHttpStatus } from "./mindbody";
import { target } from "./mindbody";
import { plainRefusal, priceCart, type CatalogItem, type CartLine } from "./sale";

export interface UnavailablePass {
  /** The pass's catalog id as a string (CartLine.metadataId). */
  metadataId: string;
  /** Mindbody's own sentence, cleaned by plainRefusal. */
  reason: string;
}

export interface PassAvailability {
  /** How many passes were asked about. */
  checked: number;
  unavailable: UnavailablePass[];
  /** Passes whose check settled nothing (suppressed, 5xx, transport):
   *  left available. */
  unknown: number;
  /** True when every check was suppressed by dry run or the write guard,
   *  so the screen knows the absence of refusals means nothing. */
  suppressed: boolean;
}

export const AVAILABILITY_TTL_MS = 2 * 60 * 1000;
const MAX_CACHED = 200;

const cache = new Map<string, { at: number; value: PassAvailability }>();

/** The passes worth asking about for one client: an intro offer, or a
 *  pass restricted to members. */
export function passesToCheck(passes: readonly CatalogItem[]): CatalogItem[] {
  return passes.filter(
    (p) =>
      p.type === "Service" &&
      (p.isIntroOffer === true ||
        (Array.isArray(p.restrictToMembershipIds) &&
          p.restrictToMembershipIds.length > 0)),
  );
}

export async function passAvailability(
  clientId: string,
  passes: readonly CatalogItem[],
  opts: { fresh?: boolean; now?: number } = {},
): Promise<PassAvailability & { cached: boolean }> {
  const now = opts.now ?? Date.now();
  const key = `${target()}:${clientId}`;
  const held = cache.get(key);
  if (!opts.fresh && held && now - held.at < AVAILABILITY_TTL_MS) {
    return { ...held.value, cached: true };
  }
  const asked = passesToCheck(passes);
  const outcomes = await Promise.all(
    asked.map(async (p) => {
      const line: CartLine = {
        type: "Service",
        metadataId: p.id,
        quantity: 1,
        price: p.price,
        taxExempt: p.taxExempt,
        taxRate: p.taxRate,
      };
      try {
        const priced = await priceCart([line], clientId, null, null, null);
        return priced.suppressed ? ("suppressed" as const) : ("ok" as const);
      } catch (err) {
        const status = mindbodyHttpStatus(err);
        if (status !== null && status < 500) {
          return {
            metadataId: String(p.id),
            reason: plainRefusal(err instanceof Error ? err.message : String(err)),
          };
        }
        return "unknown" as const;
      }
    }),
  );
  const unavailable = outcomes.filter(
    (o): o is UnavailablePass => typeof o === "object",
  );
  const suppressedCount = outcomes.filter((o) => o === "suppressed").length;
  const value: PassAvailability = {
    checked: asked.length,
    unavailable,
    unknown: outcomes.filter((o) => o === "unknown" || o === "suppressed").length,
    suppressed: asked.length > 0 && suppressedCount === asked.length,
  };
  console.log(
    `[availability] client ${clientId}: checked ${value.checked}, ` +
      `unavailable [${unavailable.map((u) => u.metadataId).join(", ")}]` +
      (value.unknown > 0 ? `, unknown ${value.unknown}` : ""),
  );
  /* A check that settled nothing is not worth remembering: the next
   * attach asks again rather than trusting a blank answer for two
   * minutes. */
  if (value.unknown === 0) {
    if (cache.size >= MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: now, value });
  }
  return { ...value, cached: false };
}
