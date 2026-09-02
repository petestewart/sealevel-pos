import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { counterBundles, type CounterBundle } from "@/lib/bundles";
import { counterCategories } from "@/lib/categories";
import { enabledDbBundles } from "@/lib/db";
import { target } from "@/lib/mindbody";
import {
  catalogFor,
  contractsFor,
  pricingOptions,
  sellablePackages,
  type CatalogItem,
  type ContractSummary,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * GET /api/catalog
 *
 * The sale screen's shelf: retail products for the hardcoded counter
 * categories plus the pricing options (passes). Reads only.
 *
 * Cached per process for 10 minutes. The catalog changes rarely (a studio
 * adds a product a few times a year), and the design doc's no-stale-pricing
 * rule is honored because nothing here IS the price of a sale: the cart's
 * total always comes live from /api/price-cart, and any drift between a
 * cached shelf price and Mindbody's live total is exactly the disagreement
 * priceCart is built to surface, never swallow.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CatalogPayload {
  categories: typeof counterCategories;
  products: CatalogItem[];
  passes: CatalogItem[];
  /** T30: packages ride the same shelf/cart machinery as products. */
  packages: CatalogItem[];
  /** T30: contracts are NOT cart items; they feed the Memberships chip
   *  and its dedicated purchase dialog. */
  contracts: ContractSummary[];
}

/** Keyed by MINDBODY_TARGET for the same reason the staff-token cache is
 *  keyed by site id: a process that switches target must never serve the
 *  sandbox's catalog as the studio's shelf, or vice versa. */
let cache: { key: string; at: number; data: CatalogPayload } | null = null;

/**
 * Bundles ride the catalog response but sit OUTSIDE its cache: they are
 * local (code config or our own table, never a Mindbody call), so reading
 * them per request costs nothing metered, and an admin who just toggled a
 * bundle in the drawer must see the shelf change on the next load, not up
 * to ten minutes later. The database takes over only when it has rows
 * (see enabledDbBundles); `bundleSource` records which config answered.
 * Dev-drawer-payload detail only -- nothing teacher-facing shows it.
 */
async function currentBundles(): Promise<{
  bundles: readonly CounterBundle[];
  bundleSource: "db" | "config";
}> {
  const fromDb = await enabledDbBundles();
  if (fromDb !== null) return { bundles: fromDb, bundleSource: "db" };
  return { bundles: counterBundles, bundleSource: "config" };
}

/**
 * T41: a pricing option whose `RevenueCategory` names a counter category
 * (categories.ts `revenueCategories`) is stamped with that category's id
 * so the shelf files it there rather than under Passes. Towel and mat
 * rentals are the case: category -14 is a service category, so filtering
 * /sale/products on it can never fill the button. Every pass still rides
 * the same `passes` array with the same shape; only `categoryId` changes
 * from null, and the screen reads null as "Passes".
 */
function routeServices(passes: CatalogItem[]): CatalogItem[] {
  const byName = new Map<string, number>();
  for (const c of counterCategories) {
    const id = c.categoryIds[0];
    if (id === undefined) continue;
    for (const name of c.revenueCategories ?? []) {
      byName.set(name.trim().toLowerCase(), id);
    }
  }
  if (byName.size === 0) return passes;
  return passes.map((p) => {
    const routed = p.revenueCategory
      ? byName.get(p.revenueCategory.trim().toLowerCase())
      : undefined;
    return routed === undefined ? p : { ...p, categoryId: routed };
  });
}

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const key = target();
  /**
   * `?refresh=1` skips the cache and refetches (Pete, fifth live test).
   * A cart whose total disagrees with Mindbody's is most likely a shelf
   * priced from a cached catalog that has since changed, and the teacher
   * needs a way OUT of that state at the counter, not a refusal they can
   * only escape by clearing the cart. This is the one deliberate bypass;
   * it costs the four catalog reads and is only ever reached by an
   * explicit tap. Rate is not a concern: the button that calls it is
   * disabled while it runs, and it changes no state on Mindbody's side.
   */
  const refresh =
    new URL(request.url).searchParams.get("refresh") === "1";
  if (
    !refresh &&
    cache &&
    cache.key === key &&
    Date.now() - cache.at < CACHE_TTL_MS
  ) {
    return NextResponse.json({
      ...cache.data,
      ...(await currentBundles()),
      cached: true,
    });
  }
  try {
    const categoryIds = counterCategories.flatMap((c) => c.categoryIds);
    const [products, passes, packages, contracts] = await Promise.all([
      catalogFor(categoryIds),
      pricingOptions(),
      sellablePackages(),
      contractsFor(),
    ]);
    const data: CatalogPayload = {
      categories: counterCategories,
      products,
      passes: routeServices(passes),
      packages,
      contracts,
    };
    cache = { key, at: Date.now(), data };
    return NextResponse.json({
      ...data,
      ...(await currentBundles()),
      cached: false,
    });
  } catch (err) {
    /* A failure is never cached: the next request retries Mindbody. */
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
