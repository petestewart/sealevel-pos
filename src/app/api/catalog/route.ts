import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { counterBundles } from "@/lib/bundles";
import { counterCategories } from "@/lib/categories";
import { target } from "@/lib/mindbody";
import { catalogFor, pricingOptions, type CatalogItem } from "@/lib/sale";

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
  /** Static config riding the same response the categories do: the client
   *  resolves each bundle against the products/passes below at render, so
   *  no extra call and no extra cache entry. */
  bundles: typeof counterBundles;
  products: CatalogItem[];
  passes: CatalogItem[];
}

/** Keyed by MINDBODY_TARGET for the same reason the staff-token cache is
 *  keyed by site id: a process that switches target must never serve the
 *  sandbox's catalog as the studio's shelf, or vice versa. */
let cache: { key: string; at: number; data: CatalogPayload } | null = null;

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const key = target();
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...cache.data, cached: true });
  }
  try {
    const categoryIds = counterCategories.flatMap((c) => c.categoryIds);
    const [products, passes] = await Promise.all([
      catalogFor(categoryIds),
      pricingOptions(),
    ]);
    const data: CatalogPayload = {
      categories: counterCategories,
      bundles: counterBundles,
      products,
      passes,
    };
    cache = { key, at: Date.now(), data };
    return NextResponse.json({ ...data, cached: false });
  } catch (err) {
    /* A failure is never cached: the next request retries Mindbody. */
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
