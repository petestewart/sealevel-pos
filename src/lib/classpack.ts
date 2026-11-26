/**
 * T303: which passes get T26's "Last session used. Sell the next pack?"
 * dialog. Pete, 2026-11-26: "The sell the next pack modal is opening way
 * too often. That should only come up when someone is at the end of their
 * class pack. No other passes."
 *
 * T26 opened it for ANY pass with `Remaining: 1` before this visit that
 * was not a fake-unlimited counter, which is every Drop In (Count 1, so
 * Remaining 1 on the visit it pays for), every guest pass, and every
 * intro special or workshop pass on its last use. A class pack is a
 * multi-class Series pass: Count 2 to 99, Mindbody's `Type` "Series" when
 * the catalog knows the option, not an intro offer, not a guest/buddy,
 * workshop, training or event pass.
 *
 * Pure, no I/O, so page.tsx and anything else can share the one rule.
 */

import { isGuestPass } from "./guestpass";

/** Names that are passes but never a class pack, whatever their count. */
const NOT_A_PACK = /guest|buddy|workshop|training|event|intro/i;

/** What a roster row knows about the pass paying for its visit. */
export interface VisitPassFacts {
  paid: boolean;
  pricingOption: string | null;
  passRemaining: number | null;
  passCount: number | null;
}

/** What the catalog knows about that pass's pricing option, when it is
 *  still on the shelf (matched by ProductId). */
export interface CatalogPassFacts {
  name: string;
  count: number | null;
  serviceType?: string | null;
  isIntroOffer?: boolean | null;
}

/** A real multi-class count: more than one session (a Drop In is 1) and
 *  under the fake-unlimited counters (99999, 1000; T14's >= 100 rule). */
function packCount(count: number | null): boolean {
  return count !== null && count >= 2 && count < 100;
}

/**
 * The synchronous gate, from the row alone: a paid visit on the LAST
 * session of what may be a class pack. Since 2026-09-14 passRemaining
 * counts BEFORE this visit (roster.ts beforeThisVisit), so 1 means this
 * class is the last one. A null count cannot rule a pack out (the catalog
 * may know it), so it passes here and `isClassPack` decides.
 */
export function mayBeLastClassOfPack(entry: VisitPassFacts): boolean {
  if (!entry.paid || entry.passRemaining !== 1) return false;
  if (entry.passCount !== null && !packCount(entry.passCount)) return false;
  const name = entry.pricingOption ?? "";
  if (isGuestPass(name) || NOT_A_PACK.test(name)) return false;
  return true;
}

/**
 * The full rule, once the catalog is to hand. `option` is the pass's own
 * pricing option from the catalog, or null when it is not there (hidden
 * from the shelf, retired, no ProductId, catalog failed): the row's own
 * facts then decide, and an unknown count is NOT a pack, because the
 * dialog is the thing that must not open too often.
 */
export function isClassPack(
  entry: VisitPassFacts,
  option: CatalogPassFacts | null,
): boolean {
  if (!mayBeLastClassOfPack(entry)) return false;
  const count = entry.passCount ?? option?.count ?? null;
  if (!packCount(count)) return false;
  if (option === null) return true;
  if (option.isIntroOffer === true) return false;
  if (isGuestPass(option.name) || NOT_A_PACK.test(option.name)) return false;
  const type = (option.serviceType ?? "").trim().toLowerCase();
  /* Site 471 serves DropIn | Series | Unlimited (T76). A missing type
   * cannot rule a pack out; the count already has. */
  return type === "" || type === "series";
}
