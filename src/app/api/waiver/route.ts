import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { mindbody, mindbodyEnv } from "@/lib/mindbody";

export const dynamic = "force-dynamic";

/**
 * The studio's liability waiver text, for the counter signing dialog
 * (T18): `GET /site/liabilitywaiver` returns `{LiabilityWaiver: string}`
 * per the vendored spec (docs/mindbody-openapi/site.yml,
 * `GetLiabilityWaiverResponse` -- one property, `LiabilityWaiver`).
 *
 * The response carries the text plus a sha256 of the EXACT text served,
 * computed here so the dialog and the receipt (the structured log line and
 * the Notes append in /api/waiver-agree) agree on what was shown. Mindbody
 * stores no waiver content or version, so this hash is the only record of
 * which wording a student accepted (design doc, "Waiver status").
 *
 * Cached for the process lifetime, keyed by site id so a target switch
 * cannot serve the sandbox's waiver as production's: the text changes
 * roughly never, and the alternative is a metered call every time the
 * dialog opens. Nothing else is precomputed.
 */
let cached: { siteId: string; text: string; sha256: string } | null = null;

export async function GET() {
  try {
    const siteId = mindbodyEnv().siteId;
    if (!cached || cached.siteId !== siteId) {
      const body = await mindbody("/site/liabilitywaiver");
      const text = body?.LiabilityWaiver;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("Mindbody returned no waiver text.");
      }
      cached = {
        siteId,
        text,
        sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      };
    }
    return NextResponse.json({ text: cached.text, sha256: cached.sha256 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
