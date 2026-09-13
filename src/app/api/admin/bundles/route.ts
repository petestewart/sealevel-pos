import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import {
  validateBundleLines,
  validateBundleName,
  type BundleLine,
} from "@/lib/bundles";
import { devtoolsEnabled } from "@/lib/calllog";
import {
  createBundle,
  dbConfigured,
  listBundleRows,
  storageMode,
  updateBundle,
  type BundleWriteResult,
} from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Bundle admin (T29): the dev drawer's Bundles tab is the whole client.
 *
 * Guarded twice, like /api/devlog: the PIN session first, then the
 * devtools gate, because the drawer's audience (Pete, a dev build) is the
 * right audience for editing what rings up at the counter -- for now. A
 * proper admin surface outside the dev drawer is recorded future work on
 * T29.
 *
 * No DELETE, deliberately. Disable is the safe verb: a disabled bundle
 * keeps its name and lines, stops rendering on the shelf, and can come
 * back. Everything writes through src/lib/db.ts, which owns the fallback
 * discipline; with no database this route answers honestly (available:
 * false / 503) and the shelf keeps serving src/lib/bundles.ts.
 */

function gate(request: Request): NextResponse | null {
  const denied = requireSession(request);
  if (denied) return denied;
  if (!devtoolsEnabled()) {
    return NextResponse.json({ error: "devtools disabled" }, { status: 404 });
  }
  return null;
}

export async function GET(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  const rows = await listBundleRows();
  return NextResponse.json({
    storage: storageMode(),
    /* Distinguishes "no database" (edit src/lib/bundles.ts instead) from
     * "database, zero rows yet" (create away) for the drawer's copy. */
    available: rows !== null,
    configured: dbConfigured(),
    bundles: rows ?? [],
  });
}

function writeResponse(result: BundleWriteResult): NextResponse {
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ bundle: result.row });
}

export async function POST(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const name = validateBundleName(body?.name);
    if (!name.ok) {
      return NextResponse.json({ error: name.error }, { status: 400 });
    }
    /* The SAME shape/quantity rules SaleScreen's resolver enforces at
     * render; whether each id resolves against the live catalog stays the
     * client's render-time check, since ids are per site. */
    const lines = validateBundleLines(body?.lines);
    if (!lines.ok) {
      return NextResponse.json({ error: lines.error }, { status: 400 });
    }
    return writeResponse(await createBundle(name.name, lines.lines));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function PATCH(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const id = body?.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      return NextResponse.json(
        { error: "id (positive integer) is required" },
        { status: 400 },
      );
    }
    const patch: { name?: string; lines?: BundleLine[]; enabled?: boolean } =
      {};
    if (body.name !== undefined) {
      const name = validateBundleName(body.name);
      if (!name.ok) {
        return NextResponse.json({ error: name.error }, { status: 400 });
      }
      patch.name = name.name;
    }
    if (body.lines !== undefined) {
      const lines = validateBundleLines(body.lines);
      if (!lines.ok) {
        return NextResponse.json({ error: lines.error }, { status: 400 });
      }
      patch.lines = lines.lines;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json(
          { error: "enabled must be a boolean" },
          { status: 400 },
        );
      }
      patch.enabled = body.enabled;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "nothing to change: pass name, lines and/or enabled" },
        { status: 400 },
      );
    }
    return writeResponse(await updateBundle(id, patch));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
