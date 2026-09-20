import { NextResponse } from "next/server";

import {
  contractRequiresSignature,
  customerConfirmsSale,
  signupMode,
} from "@/lib/approval";
import { authRequired, isAuthenticated } from "@/lib/auth";
import { BANNER_SETTING_KEY, getSetting, storageMode } from "@/lib/db";
import { displayState } from "@/lib/display";
import {
  allowedWriteClientIds,
  dryRunState,
  mindbodyEnv,
  target,
} from "@/lib/mindbody";
import { STUDIO_TAX_RATE, houseClientId } from "@/lib/sale";
import { staffSessionFrom, staffSessionStorage } from "@/lib/staffsession";
import { ensureTarget, isTargetAdmin, targetSource } from "@/lib/target";

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
  /* T89: the target can now be a stored setting, and this route is what
   * the banner and the drawer read it from, so the override is loaded
   * before target() is called. Bounded and never throws; with no
   * database it is a no-op and the environment answers, as before. */
  await ensureTarget();
  /* T89: dry run is now per request, since a browser can ask for its own
   * on top of the server's. */
  const dry = await dryRunState();
  const bannerOnly = authRequired() && !isAuthenticated(request);
  if (bannerOnly) {
    /* The lock screen shows the same banner the counter does, database
     * copy included; storage mode, like siteId, waits for a session. */
    return NextResponse.json({
      dryRun: dry.on,
      /* The lock screen's banner says "on this iPad" for a browser dry
       * run too: it is the same banner and the same question. */
      dryRunSource: dry.source,
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
  /* T89: whether the teacher signed in on THIS browser may switch the
   * target (POS_ADMIN_STAFF_IDS). A boolean, never the list: it decides
   * whether the drawer draws the switch at all, and /api/admin/target
   * refuses anyone else regardless. */
  const session = await staffSessionFrom(request);
  return NextResponse.json({
    dryRun: dry.on,
    dryRunSource: dry.source,
    targetAdmin: isTargetAdmin(session?.staffId ?? null),
    target: target(),
    siteId,
    configError,
    writeClientIds: [...allowedWriteClientIds()],
    banner: await bannerText(),
    /* T29: which store is behind the DB features. "none" is full fallback
     * mode and is normal for local work; the dev drawer's settings tab
     * shows this as one quiet line. Nothing teacher-facing changes. */
    storage: storageMode(),
    /* T78: where staff sessions live. "postgres" means a sign-in
     * survives a server restart; "memory (no POS_SESSION_SECRET)" or
     * "memory (no DATABASE_URL)" means a restart signs everyone out,
     * as before T78. Nothing teacher-facing changes. */
    staffSessions: staffSessionStorage(),
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
    /* T89: whether the target above came from the stored setting
     * (switched from the drawer) or from MINDBODY_TARGET in the server
     * environment. The banner says which STUDIO; this says who decided.
     * Dry run and the write guard have no equivalent: they are env only,
     * always, and that is the rail T89 kept. */
    targetSource: targetSource(),
    /* T200: whether a customer display is paired and awake. Two booleans
     * and no id, because this is what the header's connection mark and
     * the buttons that need a screen read; the drawer's block reads the
     * fuller answer from /api/admin/display. Only on the authenticated
     * answer: the lock screen's banner has no business naming the
     * counter's second iPad. */
    display: await (async () => {
      const d = await displayState();
      return { paired: d.paired, connected: d.connected };
    })(),
    /* T203: whether the customer must approve each sale on that screen,
     * and whether that answer came from the stored setting or from
     * POS_CUSTOMER_CONFIRMS_SALE in the server environment. The browser's
     * copy is for the UI only: /api/checkout reads the setting itself on
     * every charge, so a browser that lies about it is refused. On the
     * authenticated answer only, like the display above. */
    ...(await (async () => {
      const confirm = await customerConfirmsSale();
      return {
        customerConfirmsSale: confirm.on,
        customerConfirmsSaleSource: confirm.source,
      };
    })()),
    /* T205: and whether a membership needs the customer's signature on
     * that screen, with the same two fields and the same meaning. The
     * browser's copy draws the contract dialog's button;
     * /api/purchase-contract reads the setting itself on every purchase,
     * so a browser that lies about it is refused. Unlike the approval
     * setting above, this one defaults ON. */
    ...(await (async () => {
      const rule = await contractRequiresSignature();
      return {
        contractRequiresSignature: rule.on,
        contractRequiresSignatureSource: rule.source,
      };
    })()),
    /* T207: whether a completed self-serve sign-up is created
     * automatically by the teacher's iPad or waits in the tray for a
     * tap, and where that answer came from. Unlike the two above, no
     * server route reads this to refuse anything: it decides what the
     * TEACHER's browser does with a sign-up it is already allowed to
     * create by hand, so the browser's copy is the whole rule. */
    ...(await (async () => {
      const mode = await signupMode();
      return { signupMode: mode.mode, signupModeSource: mode.source };
    })()),
  });
}
