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
 * Ordered as the Buy rail's children read (T76, Pete's list): the rail is
 * a hierarchy, `Favorites | Passes | Retail | Rentals`, and each entry
 * here names the SECTION it belongs to. Passes is its own section, its
 * children the pass sub-categories (src/lib/shelfconfig.ts PASS_GROUPS);
 * Retail's children are the retail entries in this order; Rentals is a
 * leaf. Everything not listed here does not reach the counter at all
 * (Skin/Body 27, Books 29, Jewelry 28, Music 31, Videos/Instructional 30,
 * Other Products 49 and whatever the studio adds later); the T39.2 "more"
 * fold that once promised them a home was retired with T76.
 *
 * Consumed by: GET /api/catalog (T22), which filters /sale/products by the
 * ids here and fills the "Passes" entry from /sale/services, minus any
 * option whose RevenueCategory routes it to a button here (T41). The sale
 * screen's rail (T23, T39.2, T76) hides a cell whose shelf is empty. Do not
 * wire it into Phase 1 screens.
 */

/** The Buy rail's top level, in its fixed order (Favorites, which is not
 *  a category, sits first on the screen). Passes and Retail are sections
 *  with children; Rentals is a leaf. */
export type CounterSection = "Passes" | "Retail" | "Rentals";

/** One button on the eventual sale screen. */
export interface CounterCategory {
  /** Label as the counter should show it, not necessarily Mindbody's name. */
  label: string;
  /** T76: which top-level rail cell this entry lives under. The Passes
   *  entry IS its section's header; a Retail entry is a child cell; the
   *  Rentals entry is the leaf itself. */
  section: CounterSection;
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
  /**
   * Case-insensitive regular-expression sources matched against a pricing
   * option's NAME, the second handle for the same problem. Pete's first
   * live pass had "Towel and Mat" hidden as empty: the rental options'
   * real revenue category was not the guessed name, and nothing in this
   * container can read it. The studio's items (ai-manager's sales table,
   * 2026-08-31) are "Mat Rental", "Towel Rental" and "Mat & Towel
   * COMBO", so the names are a handle that does not depend on how the
   * revenue category was spelled in Mindbody. Either match routes.
   */
  nameMatches?: string[];
}

/**
 * The five entries a teacher actually reaches for, in rail order (T76).
 * The ids and the routing facts are exactly what T41 established; only
 * the labels, the order and the section changed.
 *
 * "Passes" has no single Mindbody category id. The design doc's live
 * category dump puts pass-like items across several Service:true categories
 * (ClassPass -12, Vinyasa -15, Classes 1, Course -11, ...), and passes are
 * services sold via pricing options rather than retail products, so this
 * entry will be populated from /sale/services rather than by filtering
 * /sale/products on a category id. Its `categoryIds` is deliberately empty.
 */
export const counterCategories: readonly CounterCategory[] = [
  { label: "Passes", section: "Passes", categoryIds: [] },
  { label: "Food/Drink", section: "Retail", categoryIds: [36] },
  { label: "Clothing", section: "Retail", categoryIds: [26] },
  { label: "Accessories", section: "Retail", categoryIds: [32] },
  {
    /* Mindbody's "Towel and Mat" (-14), relabelled at Pete's word (T76).
     * The revenue-category and name handles are T41's, unchanged. */
    label: "Rentals",
    section: "Rentals",
    categoryIds: [-14],
    revenueCategories: ["Towel and Mat"],
    nameMatches: ["rental", "towel"],
  },
];
