import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import { currentShelfConfig, rawCatalog } from "@/lib/catalog";
import {
  dbAvailable,
  dbConfigured,
  getSetting,
  setSetting,
  storageMode,
} from "@/lib/db";
import {
  itemKey,
  SHELF_SETTING_KEY,
  validateShelfConfig,
  type ShelfItemType,
} from "@/lib/shelfconfig";

export const dynamic = "force-dynamic";

/**
 * Shelf admin (T74): the dev drawer's Shelf tab is the whole client.
 *
 * Guarded twice, like /api/admin/bundles: the PIN session first, then
 * the devtools gate, so this 404s on the counter iPad exactly as the
 * devlog does. GET lists the UNFILTERED catalog (every product, pass,
 * package and contract, hidden ones included, because the point is to
 * pick which to hide) from the same cached reads /api/catalog uses; it
 * adds no Mindbody calls. PUT stores the whole config after the same
 * validation the catalog route applies on the way out. With no database
 * the route answers honestly (available: false, 503 on write) and the
 * shelf keeps serving the code default.
 */

function gate(request: Request): NextResponse | null {
  const denied = requireSession(request);
  if (denied) return denied;
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  return null;
}

/** The slice the panel lists: kind, id, name and a display price. */
interface ShelfAdminItem {
  type: ShelfItemType;
  id: string | number;
  key: string;
  name: string;
  price: number;
}

export async function GET(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  try {
    const [{ data }, { config, shelfSource }, available] = await Promise.all([
      rawCatalog(),
      currentShelfConfig(),
      dbAvailable(),
    ]);
    const item = (
      type: ShelfItemType,
      id: string | number,
      name: string,
      price: number,
    ): ShelfAdminItem => ({ type, id, key: itemKey(type, id), name, price });
    const items: ShelfAdminItem[] = [
      ...data.products.map((p) => item("Product", p.id, p.name, p.price)),
      ...data.passes.map((p) => item("Service", p.id, p.name, p.price)),
      ...data.packages.map((p) => item("Package", p.id, p.name, p.price)),
      /* A contract's headline is its recurring charge (what the shelf
       * card shows, T30), else the first payment. */
      ...data.contracts.map((c) =>
        item(
          "Contract",
          c.id,
          c.name,
          c.recurringPaymentTotal ?? c.firstPaymentTotal ?? 0,
        ),
      ),
    ];
    return NextResponse.json({
      storage: storageMode(),
      available,
      configured: dbConfigured(),
      config,
      shelfSource,
      items,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function PUT(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const result = validateShelfConfig(body?.config ?? body);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const saved = await setSetting(SHELF_SETTING_KEY, JSON.stringify(result));
    if (!saved) {
      return NextResponse.json(
        {
          error: "no database configured; the shelf keeps its code default",
          available: false,
        },
        { status: 503 },
      );
    }
    /* Read back what landed, so the panel shows the stored truth. */
    const stored = await getSetting(SHELF_SETTING_KEY);
    return NextResponse.json({
      config: stored === null ? result : JSON.parse(stored),
      available: true,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
