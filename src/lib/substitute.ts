/**
 * T112: the substitute pass, resolved against the LIVE catalog.
 *
 * Pete, 2026-09-19, after asking for an Override on a pass Mindbody's own
 * rules refuse: "if that doesn't work then we can use the 'Returning
 * Student 2-week unlimited' item and discount it to be at the standard
 * 2-week special price behind the scenes".
 *
 * The mapping is configuration (shelfconfig.ts `PassSubstitute`, edited
 * in the drawer's shelf tab); this module is the only place the two
 * FIGURES come from, and they come from `GET /sale/services` every time.
 * Never a stored price, never a price from the browser: the discount is
 * the difference between what Mindbody says the substitute costs today
 * and what it says the refused pass costs today, computed here and
 * recomputed on the server at checkout. A ticket that showed one figure
 * and charged another is exactly what T75's assertion exists to stop, and
 * a substitution priced off a stale number would walk straight into it.
 *
 * Both halves must resolve or there is NO offer: a mapping naming a pass
 * the site has stopped selling, or a pass whose price Mindbody did not
 * answer with, is dropped loudly and the screen shows the refusal with
 * one offer fewer. Guessing either figure would sell the wrong thing for
 * the wrong money.
 */

import { currentShelfConfig } from "./catalog";
import { pricingOptions, roundToCents, type CatalogItem } from "./sale";

export interface ResolvedSubstitute {
  /** The substitute pass as a cart line needs it. */
  metadataId: string;
  name: string;
  /** The substitute's own live price, in dollars: what the ticket row
   *  and the receipt will say, because that is the product being sold. */
  price: number;
  taxRate: number | null;
  taxExempt: boolean;
  /** What the customer pays for it, before tax: the refused pass's own
   *  live price when the mapping matches prices, else the substitute's. */
  sellAt: number;
  /** The discount that makes up the difference, in dollars, 0 when the
   *  two already cost the same or the mapping does not match prices. */
  discount: number;
  /** The refused pass, for the sentence the screen shows and the record
   *  filed on the client. */
  refusedId: string;
  refusedName: string;
  refusedPrice: number;
}

/** The catalog entry for one Service id, by the id a cart line carries
 *  (`CatalogItem.id`, which is the ProductId for a pass). */
function findPass(options: readonly CatalogItem[], id: string): CatalogItem | null {
  return options.find((o) => String(o.id) === id) ?? null;
}

/**
 * The substitution configured for a refused pass, priced live, or null
 * when there is no honest offer to make. `options` may be passed in by a
 * caller that has already read the catalog, so one request does not read
 * `/sale/services` twice.
 */
export async function resolveSubstitute(
  refusedId: string,
  options?: readonly CatalogItem[],
): Promise<ResolvedSubstitute | null> {
  const { config } = await currentShelfConfig();
  const mapping = (config.substitutes ?? []).find(
    (s) => s.refusedId === String(refusedId),
  );
  if (!mapping) return null;
  const live = options ?? (await pricingOptions());
  const refused = findPass(live, String(refusedId));
  const sub = findPass(live, mapping.substituteId);
  /* Loudly, not silently: a mapping that has gone stale is a thing Pete
   * has to fix in the drawer, and a counter that quietly stops offering
   * the substitution would never tell him. */
  if (refused === null || sub === null) {
    console.warn(
      `[substitute] mapping ${mapping.refusedId} -> ${mapping.substituteId} ignored: ` +
        `${refused === null ? `pass ${mapping.refusedId} ` : ""}` +
        `${sub === null ? `pass ${mapping.substituteId} ` : ""}` +
        "is not in the live catalog",
    );
    return null;
  }
  if (!(sub.price > 0) || !(refused.price > 0)) {
    console.warn(
      `[substitute] mapping ${mapping.refusedId} -> ${mapping.substituteId} ignored: ` +
        "Mindbody gave no price for one of the two passes",
    );
    return null;
  }
  /* Matching prices can only ever bring the price DOWN. A substitute
   * that already costs the same or less is sold at its own price: the
   * mapping is not a licence to charge more than the shelf says. */
  const sellAt = mapping.matchPrice
    ? Math.min(sub.price, refused.price)
    : sub.price;
  return {
    metadataId: String(sub.id),
    name: sub.name,
    price: sub.price,
    taxRate: sub.taxRate,
    taxExempt: sub.taxExempt,
    sellAt,
    discount: roundToCents(sub.price - sellAt),
    refusedId: String(refusedId),
    refusedName: refused.name,
    refusedPrice: refused.price,
  };
}

/**
 * The sentence the teacher reads before they tap, and the one the record
 * repeats. "Behind the scenes" is about the CUSTOMER's experience, not
 * the teacher's: the ticket row, the pay screen and the receipt will all
 * say the substitute's name, so a teacher who only found that out from
 * the receipt would never trust the screen again.
 */
export function substituteSentence(s: ResolvedSubstitute): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const at =
    s.discount > 0
      ? `${usd(s.price)} discounted by ${usd(s.discount)} to ${usd(s.sellAt)}`
      : `${usd(s.sellAt)}`;
  return (
    `The ticket, the receipt and Mindbody will all say ` +
    `"${s.name}", at ${at}, not "${s.refusedName}".`
  );
}
