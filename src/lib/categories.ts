/**
 * The counter's category config, hardcoded on purpose (PLAN 1.8).
 *
 * `GET /site/categories` exists, so not fetching is a choice: the live
 * response returns 51 categories of which eighteen are literal placeholders
 * ("Service Category3" ... "Service Category20") and many others are
 * inactive or accounting artifacts (Tip, Fees, Shipping & Handling) a
 * teacher never sells. The counter needs about five, in an order Mindbody's
 * response cannot express, at no metered cost and with no way to be empty at
 * boot. See the "Categories" section of docs/design/front-desk-pos.md.
 *
 * Ordered by how often a teacher reaches for each at the counter. Everything
 * not listed here belongs behind a "more" control.
 *
 * Consumed by: GET /api/catalog (T22), which filters /sale/products by the
 * ids here and fills the "Passes" entry from /sale/services, minus any
 * option whose RevenueCategory routes it to a button here (T41). The sale
 * screen's rail (T23, T39.2) hides a button whose shelf is empty. Do not
 * wire it into Phase 1 screens.
 */

/** One button on the eventual sale screen. */
export interface CounterCategory {
  /** Label as the counter should show it, not necessarily Mindbody's name. */
  label: string;
  /**
   * Mindbody category ids this button covers. Usually one; empty means the
   * entry is not backed by category ids at all (see `passes` below).
   * Sign does not encode the service/retail split: the design doc's live
   * dump has "Classes 1" as a Service:true category with a positive id, so
   * the `Service` flag on each record is the real discriminator.
   */
  categoryIds: number[];
  /**
   * T41: `RevenueCategory` names (sale.yml:5270) whose pricing options
   * belong on this button instead of Passes. Towel and Mat (-14) is a
   * `Service: true` category, and a service category never matches a
   * retail product: `/sale/products?categoryIds=-14` is empty by
   * construction, which is why Pete's first live pass found the button
   * blank. Rentals are pricing options, and the Service model carries no
   * category id at all (its fields are ProgramId, RevenueCategory and
   * MembershipId; checked against the vendored spec), so the NAME is the
   * only handle. Matched case-insensitively by /api/catalog. Unverified
   * live: if the studio's rental options carry a different revenue
   * category, the dev drawer's /sale/services body shows which, and the
   * button hides itself until then (an empty category never renders).
   */
  revenueCategories?: string[];
}

/**
 * The five entries a teacher actually reaches for, most frequent first.
 *
 * "Passes" has no single Mindbody category id. The design doc's live
 * category dump puts pass-like items across several Service:true categories
 * (ClassPass -12, Vinyasa -15, Classes 1, Course -11, ...), and passes are
 * services sold via pricing options rather than retail products, so this
 * entry will be populated from /sale/services rather than by filtering
 * /sale/products on a category id. Its `categoryIds` is deliberately empty.
 */
export const counterCategories: readonly CounterCategory[] = [
  {
    label: "Towel and Mat",
    categoryIds: [-14],
    revenueCategories: ["Towel and Mat"],
  },
  { label: "Food/Drink", categoryIds: [36] },
  { label: "Passes", categoryIds: [] },
  { label: "Accessories", categoryIds: [32] },
  { label: "Clothing", categoryIds: [26] },
];

/**
 * Label for the control that reveals everything else (Skin/Body 27, Books
 * 29, Jewelry 28, Music 31, Videos/Instructional 30, Other Products 49, and
 * whatever the studio adds later). What "more" shows is Phase 2's problem;
 * that the five above are NOT everything is recorded here.
 */
export const moreLabel = "more";
