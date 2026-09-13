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

import { MAX_LINE_QUANTITY } from "./sale";

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

/**
 * T29: bundles can also live in the database (created in the dev drawer's
 * Bundles tab, served by /api/catalog when the table has rows). This is
 * the shape gate on the way IN, and it enforces THE SAME rules the client
 * resolver applies at render (SaleScreen's resolvedBundles): a line is
 * {type: "Product"|"Service", id, quantity} with a whole quantity from 1
 * to MAX_LINE_QUANTITY, because anything else would put a line in the
 * cart that /api/price-cart refuses on every call. Whether an id resolves
 * against the loaded catalog stays the CLIENT's check, as it is for the
 * code config above: ids are per site, and a bundle created against the
 * sandbox catalog must fail visibly at render on prod, not be rejected
 * from storage.
 *
 * Server-only (it imports sale.ts); client code re-declares the shapes it
 * needs, as SaleScreen already does.
 */
export type BundleLinesValidation =
  | { ok: true; lines: BundleLine[] }
  | { ok: false; error: string };

export function validateBundleLines(input: unknown): BundleLinesValidation {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "lines must be a non-empty array" };
  }
  const lines: BundleLine[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "every line must be an object" };
    }
    const { type, id, quantity } = raw as Record<string, unknown>;
    if (type !== "Product" && type !== "Service") {
      return {
        ok: false,
        error: `line type must be "Product" or "Service", got ${JSON.stringify(type)}`,
      };
    }
    const idOk =
      (typeof id === "string" && id.trim().length > 0) ||
      (typeof id === "number" && Number.isFinite(id));
    if (!idOk) {
      return {
        ok: false,
        error: "every line needs an id (non-empty string or number)",
      };
    }
    if (
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_LINE_QUANTITY
    ) {
      return {
        ok: false,
        error: `every line needs a whole quantity from 1 to ${MAX_LINE_QUANTITY}`,
      };
    }
    lines.push({ type, id: id as string | number, quantity });
  }
  return { ok: true, lines };
}

/** The name rule the create form and the API share. */
export function validateBundleName(
  input: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: "name must be a non-empty string" };
  }
  const name = input.trim();
  if (name.length > 60) {
    return { ok: false, error: "name must be 60 characters or fewer" };
  }
  return { ok: true, name };
}
