import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";

import { counterBundles, type CounterBundle } from "@/lib/bundles";
import { currentShelfConfig, rawCatalog } from "@/lib/catalog";
import { enabledDbBundles } from "@/lib/db";
import { applyShelfConfig } from "@/lib/shelfconfig";

export const dynamic = "force-dynamic";

/**
 * GET /api/catalog
 *
 * The sale screen's shelf: retail products for the hardcoded counter
 * categories plus the pricing options (passes), packages and contracts.
 * Reads only. The raw catalog and its ten-minute cache live in
 * src/lib/catalog.ts (T74 moved them there so the shelf admin route can
 * list every item from the same reads); this route applies what sits
 * OUTSIDE that cache at response time: the bundles (T29) and the shelf
 * config (T74), both local, both read per request.
 */

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

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
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
  try {
    const { data, cached } = await rawCatalog(refresh);
    /* T74: the hide list and the pass groups, applied over the cached
     * raw catalog so hidden items never reach the screen and every pass
     * carries its group label. A bundle whose line names a hidden item
     * fails to resolve on the shelf exactly as a stale id does (it does
     * not render, one console.warn), which is the honest outcome. */
    const { config, shelfSource } = await currentShelfConfig();
    const shelf = applyShelfConfig(data, config);
    return NextResponse.json({
      categories: data.categories,
      ...shelf,
      ...(await currentBundles()),
      shelfSource,
      cached,
    });
  } catch (err) {
    /* A failure is never cached: the next request retries Mindbody. */
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
