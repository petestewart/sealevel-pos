import { NextResponse } from "next/server";

import { authRequired, isAuthenticated } from "@/lib/auth";
import {
  allowedWriteClientIds,
  isDryRun,
  mindbodyEnv,
  target,
} from "@/lib/mindbody";

export const dynamic = "force-dynamic";

/**
 * What the counter is pointed at. The screen shows this permanently: a
 * teacher must never have to wonder whether the tap they just made was
 * real, and a developer must never find out afterwards.
 *
 * Auth (T21): this route stays reachable without a session because the
 * LOCK SCREEN shows the mode banner too, but the unauthenticated answer is
 * trimmed to exactly what that banner needs: dryRun, target, banner text.
 * siteId, configError and writeClientIds are real configuration detail and
 * wait for a session.
 */
export async function GET(request: Request) {
  const bannerOnly = authRequired() && !isAuthenticated(request);
  if (bannerOnly) {
    const lockBanner = (process.env.POS_BANNER_TEXT ?? "").trim();
    return NextResponse.json({
      dryRun: isDryRun(),
      target: target(),
      siteId: null,
      configError: null,
      writeClientIds: [],
      banner: lockBanner.length > 0 ? lockBanner : null,
    });
  }
  let siteId: string | null = null;
  let configError: string | null = null;
  try {
    siteId = mindbodyEnv().siteId;
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }
  // Studio banner (PLAN 1.7): announcement text an admin sets in the server
  // environment, shown until changed. Deliberately dumb -- no scheduling, no
  // targeting, no storage. Empty or unset means no banner.
  const bannerText = (process.env.POS_BANNER_TEXT ?? "").trim();
  return NextResponse.json({
    dryRun: isDryRun(),
    target: target(),
    siteId,
    configError,
    writeClientIds: [...allowedWriteClientIds()],
    banner: bannerText.length > 0 ? bannerText : null,
  });
}
