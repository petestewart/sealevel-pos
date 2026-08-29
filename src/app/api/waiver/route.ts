import { NextResponse } from "next/server";

import { getWaiver } from "@/lib/waiver";

export const dynamic = "force-dynamic";

/**
 * The studio's liability waiver text, for the counter signing dialog
 * (T18), plus a sha256 of the EXACT text served, so the dialog and the
 * receipt (the structured log line and the Notes append in
 * /api/waiver-agree) agree on what was shown. Mindbody stores no waiver
 * content or version, so this hash is the only record of which wording a
 * student accepted (design doc, "Waiver status").
 *
 * The fetch, the hash, and the per-site process-lifetime cache live in
 * src/lib/waiver.ts, shared with /api/waiver-agree: the agree route
 * verifies the hash the browser echoes back against the same server-side
 * value, so a tampered or stale hash can never label a receipt.
 */
export async function GET() {
  try {
    const { text, sha256 } = await getWaiver();
    return NextResponse.json({ text, sha256 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
