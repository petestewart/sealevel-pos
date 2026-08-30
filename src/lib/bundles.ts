/**
 * The counter's bundle config, hardcoded on purpose: the categories.ts
 * precedent (PLAN 1.8). A bundle is one Favorites-shelf card that rings up
 * several catalog lines in a single tap ("mat + towel + water"), matching
 * the "Favorite Products" idea in Mindbody's own POS.
 *
 * IDS ARE PER SITE. The sandbox (site -99) and the studio (site 471) have
 * entirely different catalogs, so an id that resolves in one is meaningless
 * in the other. Fill in PROD ids once the prod catalog is known; sandbox
 * testing can use sandbox ids here temporarily, but they must not ship as
 * if they were the studio's.
 *
 * There is no Mindbody call behind any of this: the Buy screen resolves
 * each line against the ALREADY-LOADED catalog (/api/catalog) at render.
 * A bundle whose every line resolves renders as one card showing the
 * computed total of its lines; a bundle with ANY unresolvable line does
 * not render at all, and logs one console.warn naming it, so a stale id
 * fails visibly rather than ringing up half a bundle.
 *
 * `type` and `id` mean exactly what they mean on a shelf item: "Product"
 * lines match retail products (string barcode ids), "Service" lines match
 * pricing options / passes (numeric ids). Both are compared as strings.
 *
 * Consumed by: GET /api/catalog, which serves it alongside the categories,
 * and SaleScreen's Favorites shelf.
 */

/** One line inside a bundle: a catalog item reference plus how many. */
export interface BundleLine {
  type: "Product" | "Service";
  /** The item's catalog id ON THE TARGET SITE. See the per-site note above. */
  id: string | number;
  quantity: number;
}

/** One Favorites-shelf card that adds all its lines to the cart at once. */
export interface CounterBundle {
  /** Label as the card should show it. */
  name: string;
  lines: BundleLine[];
}

/**
 * Empty by default: bundles only exist once someone has looked up the real
 * ids for the target site and written them here. A worked example, using
 * made-up ids in the two shapes the catalog actually serves:
 *
 *   {
 *     name: "First timer",
 *     lines: [
 *       { type: "Service", id: 1234, quantity: 1 },      // a drop-in pass
 *       { type: "Product", id: "MAT-RENTAL", quantity: 1 },
 *       { type: "Product", id: "TOWEL-1", quantity: 2 },
 *     ],
 *   },
 */
export const counterBundles: readonly CounterBundle[] = [];
