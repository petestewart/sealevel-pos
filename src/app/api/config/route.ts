import { NextResponse } from "next/server";

import { isDryRun, mindbodyEnv, target } from "@/lib/mindbody";

export const dynamic = "force-dynamic";

/**
 * What the counter is pointed at. The screen shows this permanently: a
 * teacher must never have to wonder whether the tap they just made was
 * real, and a developer must never find out afterwards.
 */
export async function GET() {
  let siteId: string | null = null;
  let configError: string | null = null;
  try {
    siteId = mindbodyEnv().siteId;
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }
  return NextResponse.json({
    dryRun: isDryRun(),
    target: target(),
    siteId,
    configError,
  });
}
