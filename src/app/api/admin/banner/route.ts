import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { devtoolsEnabled } from "@/lib/calllog";
import {
  BANNER_SETTING_KEY,
  dbConfigured,
  getSetting,
  setSetting,
} from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Studio banner admin (T29): the dev drawer's Bundles tab hosts the one
 * field that writes app_settings.banner_text. Same double guard as the
 * bundles route (PIN session, then devtools), same fallback discipline:
 * with no database the banner stays the POS_BANNER_TEXT env var and this
 * route says so instead of pretending to save.
 *
 * Clearing (empty text) DELETES the row rather than storing "", so the
 * env fallback takes over -- design doc option 1 remains the base layer,
 * option 2 (this) sits on top only while a value is set.
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
  const dbText = await getSetting(BANNER_SETTING_KEY);
  const envText = (process.env.POS_BANNER_TEXT ?? "").trim();
  return NextResponse.json({
    available: dbConfigured(),
    /* What the database holds (null = unset there). */
    dbText,
    /* What shows when the database has nothing. */
    envText: envText.length > 0 ? envText : null,
  });
}

export async function PUT(request: Request) {
  const denied = gate(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const text = body?.text;
    if (text !== null && typeof text !== "string") {
      return NextResponse.json(
        { error: "text must be a string, or null to clear" },
        { status: 400 },
      );
    }
    /* One line of announcement, not a document: the banner renders as a
     * single strip on the counter and lock screens, and an accidental
     * paste should bounce here rather than be served on every
     * /api/config until someone notices. */
    if (typeof text === "string" && text.trim().length > 300) {
      return NextResponse.json(
        { error: "banner text must be 300 characters or fewer" },
        { status: 400 },
      );
    }
    const saved = await setSetting(BANNER_SETTING_KEY, text);
    if (!saved) {
      return NextResponse.json(
        { error: "no database configured; set POS_BANNER_TEXT instead" },
        { status: 503 },
      );
    }
    return NextResponse.json({ dbText: await getSetting(BANNER_SETTING_KEY) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
