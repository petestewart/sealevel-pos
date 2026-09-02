import { NextResponse } from "next/server";

import { authRequired, isAuthenticated } from "@/lib/auth";
import { BANNER_SETTING_KEY, getSetting, storageMode } from "@/lib/db";
import {
  allowedWriteClientIds,
  isDryRun,
  mindbodyEnv,
  target,
} from "@/lib/mindbody";
import { STUDIO_TAX_RATE, houseClientId } from "@/lib/sale";

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
/**
 * Studio banner (PLAN 1.7, storage per T29): announcement text an admin
 * sets, shown until changed. Deliberately dumb -- no scheduling, no
 * targeting. app_settings.banner_text wins when a database is configured
 * AND holds a value (set in the dev drawer's Bundles tab); otherwise the
 * POS_BANNER_TEXT env var, exactly as before T29. getSetting returns null
 * for unset, unavailable and failed alike, which is the whole fallback.
 */
async function bannerText(): Promise<string | null> {
  const fromDb = await getSetting(BANNER_SETTING_KEY);
  const text = (fromDb ?? process.env.POS_BANNER_TEXT ?? "").trim();
  return text.length > 0 ? text : null;
}

export async function GET(request: Request) {
  const bannerOnly = authRequired() && !isAuthenticated(request);
  if (bannerOnly) {
    /* The lock screen shows the same banner the counter does, database
     * copy included; storage mode, like siteId, waits for a session. */
    return NextResponse.json({
      dryRun: isDryRun(),
      target: target(),
      siteId: null,
      configError: null,
      writeClientIds: [],
      banner: await bannerText(),
      studioTaxRate: null,
    });
  }
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
    writeClientIds: [...allowedWriteClientIds()],
    banner: await bannerText(),
    /* T29: which store is behind the DB features. "none" is full fallback
     * mode and is normal for local work; the dev drawer's settings tab
     * shows this as one quiet line. Nothing teacher-facing changes. */
    storage: storageMode(),
    /* T38: the studio's fallback tax rate, MIRRORED from the server
     * constant so the sale screen's while-pricing estimate can tax a
     * line the catalog carried no rate for the same way expectedTotal
     * does. A read, never a rule: the estimate it feeds is muted,
     * labelled, and never chargeable; Mindbody's rehearsal stays the only
     * number that is. */
    studioTaxRate: STUDIO_TAX_RATE,
    /* T41: whether an anonymous sale is possible at all. A boolean, never
     * the id: the browser only needs to know whether to promise "close to
     * sell anonymously" and whether an unattached cart can reach Pay.
     * The money path still reads houseClientId() itself in /api/checkout
     * and /api/price-cart and refuses without it. */
    houseClient: houseClientId() !== null,
  });
}
