import { counterCategories } from "./categories";
import { getSetting } from "./db";
import { target } from "./mindbody";
import {
  catalogFor,
  contractsFor,
  pricingOptions,
  sellablePackages,
  type CatalogItem,
  type ContractSummary,
} from "./sale";
import {
  parseShelfConfig,
  SHELF_SETTING_KEY,
  type ShelfConfig,
} from "./shelfconfig";

/**
 * The raw catalog and its cache (T22), lifted out of /api/catalog in T74
 * so the shelf admin route can list EVERY item, hidden ones included,
 * from the same cached reads rather than adding Mindbody calls of its
 * own. Nothing about the cache changed: ten minutes per process, keyed
 * by target, a failure never cached, `?refresh=1` the one bypass.
 *
 * Cached per process for 10 minutes. The catalog changes rarely (a studio
 * adds a product a few times a year), and the design doc's no-stale-pricing
 * rule is honored because nothing here IS the price of a sale: the cart's
 * total always comes live from /api/price-cart, and any drift between a
 * cached shelf price and Mindbody's live total is exactly the disagreement
 * priceCart is built to surface, never swallow.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface RawCatalog {
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
let cache: { key: string; at: number; data: RawCatalog } | null = null;

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
  const byPattern: { re: RegExp; id: number }[] = [];
  for (const c of counterCategories) {
    const id = c.categoryIds[0];
    if (id === undefined) continue;
    for (const name of c.revenueCategories ?? []) {
      byName.set(name.trim().toLowerCase(), id);
    }
    /* T41 follow-up: the option's own name is the second handle (see
     * categories.ts `nameMatches`); a revenue-category match wins when
     * both apply. */
    for (const source of c.nameMatches ?? []) {
      byPattern.push({ re: new RegExp(source, "i"), id });
    }
  }
  if (byName.size === 0 && byPattern.length === 0) return passes;
  return passes.map((p) => {
    const routed =
      (p.revenueCategory
        ? byName.get(p.revenueCategory.trim().toLowerCase())
        : undefined) ?? byPattern.find(({ re }) => re.test(p.name))?.id;
    return routed === undefined ? p : { ...p, categoryId: routed };
  });
}

/**
 * The raw catalog, from the cache when it is fresh for the current target,
 * else from the four Mindbody reads. Throws on a failed read, and a
 * failure is never cached: the next request retries Mindbody.
 */
export async function rawCatalog(
  refresh = false,
): Promise<{ data: RawCatalog; cached: boolean }> {
  const key = target();
  if (
    !refresh &&
    cache &&
    cache.key === key &&
    Date.now() - cache.at < CACHE_TTL_MS
  ) {
    return { data: cache.data, cached: true };
  }
  const categoryIds = counterCategories.flatMap((c) => c.categoryIds);
  const [products, passes, packages, contracts] = await Promise.all([
    catalogFor(categoryIds),
    pricingOptions(),
    sellablePackages(),
    contractsFor(),
  ]);
  const data: RawCatalog = {
    categories: counterCategories,
    products,
    passes: routeServices(passes),
    packages,
    contracts,
  };
  cache = { key, at: Date.now(), data };
  return { data, cached: false };
}

/**
 * T74: the shelf config, read per request and never held longer. Like
 * the bundles (T29) it is local, so reading it per request costs nothing
 * metered, and a change saved in the drawer must show on the next load,
 * not up to ten minutes later. `shelfSource` says whether the table
 * answered ("db") or the code default applies ("config": no database,
 * no row, or a row that failed validation). Dev-drawer-payload detail
 * only; nothing teacher-facing shows it.
 *
 * A stored value that is not a valid config falls back to the default
 * and is logged once per process (keys only, so the log never carries
 * the whole blob); the shelf serves everything rather than nothing.
 */
let warnedBadConfig = false;

export async function currentShelfConfig(): Promise<{
  config: ShelfConfig;
  shelfSource: "db" | "config";
}> {
  const raw = await getSetting(SHELF_SETTING_KEY);
  const parsed = parseShelfConfig(raw);
  if (parsed.error !== null && !warnedBadConfig) {
    warnedBadConfig = true;
    console.error(
      `[shelf-config] stored ${SHELF_SETTING_KEY} ignored, using the default: ${parsed.error}`,
    );
  }
  if (parsed.error === null) warnedBadConfig = false;
  return {
    config: parsed.config,
    shelfSource: parsed.stored ? "db" : "config",
  };
}
