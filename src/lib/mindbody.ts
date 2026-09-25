/**
 * Mindbody Public API v6 client.
 *
 * Adapted from ai-manager's packages/core/src/campaigns/mindbody.ts, which
 * this deliberately does not import: the two repos share an API, not a
 * codebase, and a published package for ~150 lines of HTTP would cost more
 * than it saves.
 *
 * Auth is Api-Key + SiteId on every call, plus a staff user token for
 * anything that writes. The token is cached, because reissuing it costs
 * ~400ms and the counter cannot afford that on a check-in.
 */

import { cookies } from "next/headers";

import { record, redactRequest, scrubSecrets } from "./calllog";
import { ensureTarget, targetOverride, targetSettling } from "./target";

export interface MindbodyEnv {
  apiKey: string;
  siteId: string;
  username: string;
  password: string;
  baseUrl: string;
}

export type Target = "sandbox" | "prod";

/**
 * Which studio the app is pointed at.
 *
 * Defaults to sandbox. Mindbody's site -99 works given credentials issued
 * for it -- the studio's own staff login is not one, since staff accounts
 * belong to a site -- so the safe default is also a usable one. Reaching
 * the real studio's classes and students stays a deliberate act.
 *
 * T89: the stored setting wins when one is loaded (src/lib/target.ts),
 * else MINDBODY_TARGET. Still synchronous, because isDryRun(), the
 * catalog cache key and every read call this: the row is loaded into
 * memory by `ensureTarget()` at the top of mindbody() below, so no
 * caller had to become async. No database, no row and no reachable
 * store all mean the environment decides, exactly as before T89.
 */
export function target(): Target {
  const stored = targetOverride();
  if (stored !== null) return stored;
  return process.env["MINDBODY_TARGET"] === "prod" ? "prod" : "sandbox";
}

/**
 * Two credential sets, selected by MINDBODY_TARGET.
 *
 * PROD_* falls back to the unprefixed MINDBODY_* names, so an existing
 * .env keeps working. SANDBOX_* needs credentials issued for site -99;
 * the studio's own staff login will not authenticate there.
 */
export function mindbodyEnv(): MindbodyEnv {
  const t = target();
  const resolved = resolveEnv(t);
  if (resolved.env === null) {
    const prefix = t === "sandbox" ? "MINDBODY_SANDBOX_" : "MINDBODY_PROD_";
    throw new Error(
      `Mindbody is not configured for target "${t}": set ${prefix}API_KEY, ` +
        `${prefix}SITE_ID, ${prefix}STAFF_USERNAME and ${prefix}STAFF_PASSWORD ` +
        "(or the unprefixed MINDBODY_* names, which serve as the fallback).",
    );
  }
  return resolved.env;
}

/**
 * The credential set for a target, resolved the way mindbodyEnv() resolves
 * the current one, plus the NAMES of whatever is missing. Split out for
 * T89: the target switch must refuse before it flips anything when the
 * set it would switch to is incomplete, and say which variable to set.
 * Names only, never a value: this answer reaches a browser.
 */
function resolveEnv(t: Target): { env: MindbodyEnv | null; missing: string[] } {
  const sandbox = t === "sandbox";
  const prefix = sandbox ? "MINDBODY_SANDBOX_" : "MINDBODY_PROD_";
  const pick = (name: string, fallback = ""): string =>
    (sandbox
      ? process.env[`MINDBODY_SANDBOX_${name}`]
      : (process.env[`MINDBODY_PROD_${name}`] ??
        process.env[`MINDBODY_${name}`])) ??
    fallback;

  const apiKey = pick("API_KEY", process.env["MINDBODY_API_KEY"] ?? "");
  const siteId = pick("SITE_ID", sandbox ? "-99" : "");
  const username = pick(
    "STAFF_USERNAME",
    sandbox ? (process.env["MINDBODY_STAFF_USERNAME"] ?? "") : "",
  );
  const password = pick(
    "STAFF_PASSWORD",
    sandbox ? (process.env["MINDBODY_STAFF_PASSWORD"] ?? "") : "",
  );

  const missing: string[] = [];
  if (!apiKey) missing.push(`${prefix}API_KEY`);
  if (!siteId) missing.push(`${prefix}SITE_ID`);
  if (!username) missing.push(`${prefix}STAFF_USERNAME`);
  if (!password) missing.push(`${prefix}STAFF_PASSWORD`);
  if (missing.length > 0) return { env: null, missing };
  return {
    env: {
      apiKey,
      siteId,
      username,
      password,
      baseUrl:
        process.env["MINDBODY_API_BASE_URL"] ||
        "https://api.mindbodyonline.com/public/v6",
    },
    missing,
  };
}

/**
 * T89: which environment variables a target is missing, by name, empty
 * when its set is complete. The unprefixed MINDBODY_* fallback counts as
 * present, as it does everywhere else; a sandbox falls back to site -99
 * and to the unprefixed staff login, so a complete-looking sandbox set
 * can still be credentials issued for the studio rather than for -99,
 * which Mindbody answers with "Site is deactivated" or "Staff identity
 * authentication failed" (see CLAUDE.md). This checks that the variables
 * are SET, which is all an environment can be checked for without
 * spending a call.
 */
export function missingCredentials(t: Target): string[] {
  return resolveEnv(t).missing;
}

/**
 * T212: the credential set for a NAMED target, which need not be the
 * current one. Throws like mindbodyEnv() when the set is incomplete, so
 * a caller checks missingCredentials() first.
 */
export function envFor(t: Target): MindbodyEnv {
  const resolved = resolveEnv(t);
  if (resolved.env === null) {
    throw new Error(
      `Mindbody is not configured for target "${t}": missing ${resolved.missing.join(", ")}.`,
    );
  }
  return resolved.env;
}

/** The site id a target would use, or null when its set is incomplete.
 *  Not a secret: /api/config already reports the current one. */
export function siteIdFor(t: Target): string | null {
  return resolveEnv(t).env?.siteId ?? null;
}

/**
 * T210: the site id this process is talking to RIGHT NOW, or null when
 * Mindbody is not configured for the current target. Never throws,
 * because the callers (a staff session lookup, the sign-in, /api/config)
 * must keep working on a counter whose credentials are half set: a null
 * site decides nothing.
 */
export function currentSiteId(): string | null {
  return siteIdFor(target());
}

/**
 * Mindbody does not document the staff token's lifetime, so this refreshes
 * an hour ahead of any plausible expiry rather than waiting to be told the
 * token is stale mid-transaction.
 */
const TOKEN_TTL_MS = 60 * 60 * 1000;
/**
 * One slot per site, not one slot total: switching MINDBODY_TARGET to
 * prod and back used to evict the sandbox's still-valid token (a prod
 * token must never be reused against -99, so the miss forced a reissue
 * at exactly the moment issuing might be down). Each site keeps its own.
 */
const cachedTokens = new Map<
  string,
  /** `borrowed`: the T206 borrow put it here from a signed-in service
   *  session rather than an issue of this process's own. Only such a
   *  token can turn out to belong to another site (T210 review). */
  { value: string; issuedAt: number; borrowed?: boolean }
>();

export async function staffToken(env = mindbodyEnv()): Promise<string> {
  /** Keyed by site: a token issued for the sandbox must never be reused
   *  against production, or vice versa. */
  const cached = cachedTokens.get(env.siteId);
  if (cached && Date.now() - cached.issuedAt < TOKEN_TTL_MS) {
    return cached.value;
  }
  const res = await fetch(`${env.baseUrl}/usertoken/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Api-Key": env.apiKey,
      SiteId: env.siteId,
    },
    body: JSON.stringify({ Username: env.username, Password: env.password }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  const token = body?.AccessToken;
  if (!res.ok || typeof token !== "string") {
    /**
     * Seen live (2026-08-29): the sandbox refused to ISSUE tokens (403
     * "Staff identity authentication failed", for every credential set)
     * while still ACCEPTING tokens issued earlier. Our hourly refresh is
     * a guess at a lifetime Mindbody does not document, so an expired-
     * by-our-clock token is not known bad: keep riding it and let
     * Mindbody itself be the judge. A genuine rejection comes back as
     * 401 on the actual call, which forgets the token and reissues --
     * and if issuing is still down, THAT failure surfaces properly.
     */
    if (cached) {
      console.warn(
        `[token] reissue failed (HTTP ${res.status}); riding the cached token until Mindbody rejects it`,
      );
      cached.issuedAt = Date.now(); /* back off: retry issue in an hour, not per call */
      return cached.value;
    }
    /* No cached token and Mindbody will not issue one. A teacher signed
     * in AS the service account holds one (the sandbox's only login,
     * 2026-09-20): borrow it. A dynamic import, because staffsession
     * imports this module. */
    const borrowed = await (
      await import("./staffsession")
    )
      /* T210: for THIS site, and no other. The borrow used to take the
       * newest service session whatever site issued it and cache it
       * under env.siteId below, which is a token of the other studio
       * sitting in this studio's slot: every call under it comes back
       * "Delegated staff does not belong to the subscriber." Null here
       * leaves the refusal to surface as it did before the borrow
       * existed. */
      .serviceSessionToken(env.siteId)
      .catch(() => null);
    if (borrowed) {
      console.warn(
        `[token] issue refused (HTTP ${res.status}); borrowing the signed-in service account's own token for site ${env.siteId}`,
      );
      cachedTokens.set(env.siteId, {
        value: borrowed,
        issuedAt: Date.now(),
        borrowed: true,
      });
      return borrowed;
    }
    throw new Error(
      `Mindbody usertoken/issue failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  cachedTokens.set(env.siteId, { value: token, issuedAt: Date.now() });
  return token;
}

/**
 * A teacher who signed in AS THE SERVICE ACCOUNT ITSELF (the studio's own
 * API login, which is also the only login the sandbox has) already holds
 * a token this process can use for its reads. Adopt it as the cached
 * service token so the next read does not ask Mindbody to issue a second
 * token for the same user seconds later: the sandbox refuses that
 * ("Staff identity authentication failed", Pete, 2026-09-20, with the
 * typed sign-in accepted a second earlier). Only when the username is the
 * service account's; anybody else's token is never the service token.
 * Returns whether it was adopted.
 */
export function adoptServiceToken(
  username: string,
  token: string,
  /* T210: the site the token was ISSUED for, from the env the sign-in
   * ran against, not from the target as it reads a moment later. */
  siteId: string,
): boolean {
  const env = mindbodyEnv();
  if (username.trim().toLowerCase() !== env.username.trim().toLowerCase()) {
    return false;
  }
  if (siteId !== env.siteId) {
    /* T210: the one thing this function must never do is put another
     * site's token in this site's slot. It is called at sign-in with
     * the site that sign-in used, so this fires only when the target
     * moved underneath it, and then the cache is left alone and the
     * next read issues its own token. */
    console.warn(
      `[token] NOT adopting a service token issued for site ${siteId}: ` +
        `this counter is on site ${env.siteId}.`,
    );
    return false;
  }
  cachedTokens.set(env.siteId, { value: token, issuedAt: Date.now() });
  return true;
}

/**
 * A staff sign-in with SOMEONE ELSE'S credentials (T48): a teacher
 * enrolling a comp PIN proves who they are by signing in to Mindbody once,
 * and this is that one call. Deliberately not staffToken(): the token is
 * never cached (it is revoked below as soon as the id has been read), the
 * body is never logged and the call is never recorded in the dev call log,
 * because the request carries a teacher's password and the answer carries
 * a token that could act as them. Answers the user Mindbody named, or the
 * HTTP status it refused with; throws only on transport failure.
 */
export async function signInAsStaff(
  username: string,
  password: string,
  /* T212: the studio to sign in to, when it is not the one the counter
   * is on: the sign-in gate's studio choice proves an admin against the
   * site they are switching TO. Omitted means the current target. */
  at?: Target,
): Promise<
  | {
      ok: true;
      token: string;
      user: { id: number; firstName: string; lastName: string; type: string };
      /** T210: the site this token was issued for, so the caller records
       *  it with the session rather than reading the target again a
       *  moment later, when it may have moved. */
      siteId: string;
    }
  | { ok: false; status: number; siteId: string }
> {
  /* T89: a sign-in must reach the site the counter is pointed at NOW,
   * not the one the environment names, so the override is loaded here
   * too; this is the one Mindbody call that deliberately does not go
   * through mindbody(). */
  await ensureTarget();
  const env = at === undefined ? mindbodyEnv() : envFor(at);
  const res = await fetch(`${env.baseUrl}/usertoken/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Api-Key": env.apiKey,
      SiteId: env.siteId,
    },
    body: JSON.stringify({ Username: username, Password: password }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  const token = body?.AccessToken;
  if (!res.ok || typeof token !== "string") {
    return { ok: false, status: res.status, siteId: env.siteId };
  }
  const user = body?.User ?? {};
  return {
    ok: true,
    token,
    siteId: env.siteId,
    user: {
      id: typeof user.Id === "number" ? user.Id : Number(user.Id ?? NaN),
      firstName: typeof user.FirstName === "string" ? user.FirstName : "",
      lastName: typeof user.LastName === "string" ? user.LastName : "",
      type: typeof user.Type === "string" ? user.Type : "",
    },
  };
}

/** Revokes a token signInAsStaff issued (`DELETE /usertoken/revoke`,
 *  user-token.yml). Best effort: the enrollment is already decided by the
 *  time this runs, and a token nobody holds expires on its own. Not
 *  recorded in the call log, for the same reason as the issue. */
export async function revokeStaffToken(
  token: string,
  /* T212: the studio that issued it, when that is not the current one. */
  at?: Target,
): Promise<void> {
  let env: MindbodyEnv;
  try {
    env = at === undefined ? mindbodyEnv() : envFor(at);
  } catch {
    return;
  }
  try {
    await fetch(`${env.baseUrl}/usertoken/revoke`, {
      method: "DELETE",
      headers: {
        "Api-Key": env.apiKey,
        SiteId: env.siteId,
        Authorization: token,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* Expires on its own. */
  }
}

/** Drop the current site's cached token; call when Mindbody rejects it
 *  as invalid. Other sites' tokens are untouched: a prod 401 says
 *  nothing about the sandbox's token. */
export function forgetToken(): void {
  cachedTokens.delete(mindbodyEnv().siteId);
}

/** T210 review: forget the current site's cached token only when it was
 *  BORROWED. A token this process issued for this site cannot belong to
 *  another site, so the sentence on such a token is about something
 *  else, and dropping it in the sandbox's refused-issue state (T206)
 *  would throw away the only working credential. Returns whether it
 *  forgot anything. */
export function forgetBorrowedToken(): boolean {
  const siteId = mindbodyEnv().siteId;
  const cached = cachedTokens.get(siteId);
  if (!cached || cached.borrowed !== true) return false;
  cachedTokens.delete(siteId);
  return true;
}

/**
 * Who a call runs as (T49). When present, the Authorization header is
 * this teacher's token instead of the service account's, on that call
 * only, so Mindbody attributes the write to them. `staffId` goes in the
 * call log as `actor`, and since T109 the TOKEN goes there too, in full
 * (Pete: "log staff session tokens. keep card numbers, CVVs, teacher
 * PINs redacted."); see CallRecord.actorToken for the trade.
 */
export interface Actor {
  token: string;
  staffId: number;
  name: string;
}

export interface MindbodyCallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Skip the staff token. Only for endpoints that genuinely do not need it. */
  anonymous?: boolean;
  /** Run as this signed-in teacher (T49). Dry run and the write guard
   *  apply exactly as without one; only the header changes. A refusal
   *  under an actor's token is NOT retried here as the service account:
   *  that decision (once, loudly, or never for a comp) belongs to the
   *  route, see src/lib/actor.ts. */
  actor?: Actor;
  /**
   * The client this write is about, for the POS_WRITE_CLIENT_IDS guard,
   * when the Mindbody payload itself does not name one.
   * `/client/updateclientvisit` takes only `{VisitId, SignedIn}`, so without
   * this every check-in would be suppressed under the write guard -- including
   * the allowed dummy client's, which is exactly the write the guard exists
   * to let through. Never merged into the request body: the payload stays
   * spec-shaped.
   */
  clientId?: string;
}

/**
 * Dry run: reads go to Mindbody as normal, writes do not happen.
 *
 * This app checks real students into real classes and will later charge
 * real cards, so "try it and see" is not a safe development posture. With
 * dry run on, every write is logged and answered with success, so the whole
 * flow -- roster, tap, optimistic row, response handling -- can be exercised
 * end to end against live data without touching anyone's account.
 *
 * It defaults to ON. Enabling writes is a deliberate act, never the
 * consequence of forgetting to set something.
 */
export function isDryRun(): boolean {
  /**
   * Never in the sandbox. The whole point of a sandbox is that writes are
   * free, and suppressing them there just hides whether the write works --
   * which is exactly the question the sandbox exists to answer.
   */
  if (target() === "sandbox") return false;
  return (process.env["POS_DRY_RUN"] ?? "true").toLowerCase() !== "false";
}

/**
 * T89: a dry run for ONE browser, on top of the server's.
 *
 * The cookie can only ADD suppression, never remove it: the env flag
 * being on wins and the control in the drawer then shows as forced on,
 * and the sandbox still forces both off for the reason above. That is
 * what makes it safe to hand to anyone with the drawer -- the worst it
 * can do is stop this iPad from writing, which is the direction this
 * whole app errs in anyway. A teacher rehearsing on the counter machine
 * no longer has to redeploy the server to do it, and nobody else's iPad
 * changes.
 *
 * Not HttpOnly, deliberately: the drawer's control sets and clears it in
 * the browser. It carries no authority, so nothing is lost by a script
 * being able to read it, and a cookie is what makes the server side of
 * the decision per REQUEST rather than per process.
 */
export const DRY_RUN_COOKIE = "pos_dry_run";

/** Whether THIS request's browser asked for its own dry run. Outside a
 *  request scope (a module load, a background task) `cookies()` throws
 *  and the answer is simply no. */
async function browserDryRun(): Promise<boolean> {
  if (target() === "sandbox") return false;
  try {
    const jar = await cookies();
    return jar.get(DRY_RUN_COOKIE)?.value === "1";
  } catch {
    return false;
  }
}

/**
 * Whether this write is suppressed and by whom: the server environment
 * ("env", POS_DRY_RUN) or this browser ("browser", the cookie). Env
 * first, so a server in dry run reports itself as the reason and the
 * drawer can show its control as forced.
 */
export async function dryRunState(): Promise<{
  on: boolean;
  source: "env" | "browser" | null;
}> {
  if (isDryRun()) return { on: true, source: "env" };
  if (await browserDryRun()) return { on: true, source: "browser" };
  return { on: false, source: null };
}

/**
 * Which calls dry run has to intercept. Issuing a user token is a POST but
 * changes nothing, and nothing works without it, so it is not a write.
 */
function isWrite(method: string, path: string): boolean {
  return method === "POST" && !path.startsWith("/usertoken/");
}

/**
 * Client ids that writes are allowed to touch, when set.
 *
 * The sandbox covers most testing, but some things can only be checked
 * against the real studio's data. For those, aim writes at a client who is
 * not a real student: create a "Test Test" client in Mindbody, put its id
 * here, and
 * every write for anyone else is suppressed exactly as dry run suppresses
 * it -- even with POS_DRY_RUN=false.
 *
 * Empty (the default in production) means no restriction, so this cannot
 * quietly break the real counter.
 */
export function allowedWriteClientIds(): Set<string> {
  return new Set(
    (process.env["POS_WRITE_CLIENT_IDS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Pull whatever client the request is about out of the body. Arrivals and
 * carts both name one, under Mindbody's usual casing.
 */
function bodyClientId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = b["ClientId"] ?? b["ClientIds"] ?? b["UniqueClientId"];
  if (Array.isArray(id)) return id.length === 1 ? String(id[0]) : null;
  return id === undefined || id === null ? null : String(id);
}

/**
 * The HTTP status Mindbody answered a failed call with, when the failure
 * WAS an answer (thrown by mindbody() below), else null. Money routes need
 * the distinction inside the 5xx range: a 4xx is a refusal that provably
 * did not process, while a 500-class answer to a write may have processed
 * before failing and must be reported as ambiguous, never as "nothing was
 * charged".
 */
export function mindbodyHttpStatus(err: unknown): number | null {
  const status = (err as { httpStatus?: unknown } | null)?.httpStatus;
  return typeof status === "number" ? status : null;
}

/**
 * Whether a failed call was Mindbody refusing the CALLER rather than the
 * request (T49): a 401 or 403 answer, or Mindbody's "You do not have
 * permission" wording (CLAUDE.md: that wording is what a missing cart
 * permission gets too, and it has come back on 400-class statuses). A
 * 4xx only: a 5xx or a dead transport says nothing about permissions,
 * and for a money write must stay ambiguous. This is what decides
 * whether a write under a teacher's token is retried once as the
 * service account.
 */
export function isActorRefusal(err: unknown): boolean {
  const status = mindbodyHttpStatus(err);
  if (status === null || status >= 500) return false;
  if (status === 401 || status === 403) return true;
  /* T210: and the sentence below, whatever 4xx it arrives on. It is a
   * refusal of the CALLER too: the token is fine, for another site. */
  if (isForeignSiteRefusal(err)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /permission/i.test(message);
}

/**
 * T210. Mindbody's answer when a staff token is used with a SiteId it
 * was not issued for: "Delegated staff does not belong to the
 * subscriber." (Pete's third sandbox drive, 2026-09-21, on the review
 * sign-up's Create, with nothing in the modal able to get past it.)
 *
 * It is not a permission problem and not a dead token in the ordinary
 * sense: the token is alive at the site that issued it. For THIS site
 * it is dead, which is why isActorTokenDead takes it -- the session
 * ends, the write is refused rather than retried as the service
 * account (which holds the same borrowed token and fails the same
 * way), and the gate asks for a sign-in against the site the counter
 * is actually on.
 *
 * Matched on the wording, case-insensitively, and only on a 4xx: a 5xx
 * or a dead transport is ambiguous and must never end a session or
 * claim that nothing was written.
 */
export function isForeignSiteRefusal(err: unknown): boolean {
  const status = mindbodyHttpStatus(err);
  if (status === null || status >= 500) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /does not belong to the subscriber/i.test(message);
}

/**
 * Whether a refusal under a teacher's token reads as the TOKEN being
 * dead rather than the teacher lacking a permission: a 401. The service
 * account's own handling above takes a 401 the same way (forget the
 * token, reissue), and Mindbody's permission refusals come back as 403
 * with the "You do not have permission" wording, so a 401 on a token
 * that issued fine is the token no longer being honoured (revoked,
 * expired, the password changed). The route ends the staff session on
 * it. What the live API says for an expired staff token is on the T49
 * probe list; if it turns out to be a 403 with token wording, widen
 * this, not isActorRefusal.
 */
export function isActorTokenDead(err: unknown): boolean {
  if (mindbodyHttpStatus(err) === 401) return true;
  /* T210: a token from the other site is dead HERE, whatever status
   * Mindbody attaches to the sentence. Same consequence as the 401:
   * end the session, refuse the write, never retry as the service
   * account. */
  return isForeignSiteRefusal(err);
}

/** Build the teacher-facing error for a non-ok Mindbody answer, tagging it
 *  with the HTTP status for mindbodyHttpStatus(). The thrown message
 *  reaches teacher-facing surfaces, so it carries Mindbody's human-readable
 *  reason and nothing else; transport detail lives in the call log.
 *
 *  T84 review: Mindbody's reason is free text and it can quote the card
 *  it refused ("The credit card number 4111111111111111 is invalid."),
 *  which would put a PAN in a thrown Error, in a route's error answer and
 *  on the screen. Card-shaped digits are struck out of the reason first;
 *  the sentence still says what is wrong. T83: a gift card number the
 *  same way, since a refusal for an unknown card quotes the number it
 *  could not find and that number spends money on its own. */
function mindbodyHttpError(body: unknown, status: number): Error {
  const raw =
    (body as any)?.Error?.Message ??
    (typeof body === "string" ? body.slice(0, 200) : "");
  const message = typeof raw === "string" ? scrubSecrets(raw) : "";
  const err = new Error(
    message || `Mindbody did not accept the request (HTTP ${status}).`,
  );
  (err as Error & { httpStatus: number }).httpStatus = status;
  return err;
}

export async function mindbody<T = any>(
  path: string,
  opts: MindbodyCallOptions = {},
): Promise<T> {
  /* T89: the stored target, loaded before anything reads target(). At
   * most one local read every five seconds (src/lib/target.ts), bounded,
   * and it never throws: every Mindbody call passes through here, so this
   * is the one place the override has to be fresh, and the one place that
   * can afford to check. */
  await ensureTarget();
  const env = mindbodyEnv();
  const method = opts.method ?? "GET";

  if (isWrite(method, path)) {
    /* T89: the server's dry run, or this browser's own. */
    const dry = await dryRunState();
    if (dry.on) {
      const byBrowser = dry.source === "browser";
      console.warn(
        /* T84: redacted, because a card save's payload would otherwise
         * print a card number into the server log. */
        /* T83: and the path, which can carry a gift card's barcode id. */
        `[dry-run] suppressed ${method} ${scrubSecrets(path)} ${JSON.stringify(redactRequest(opts.body ?? {}))}` +
          (byBrowser ? " (this browser)" : ""),
      );
      record({
        method,
        path,
        status: null,
        ms: 0,
        outcome: "dry-run",
        actor: null,
        actorToken: null,
        requestBody: opts.body ?? null,
        responseBody: byBrowser
          ? "suppressed: dry run is on for this browser"
          : "suppressed: POS_DRY_RUN is on",
      });
      return { DryRun: true } as T;
    }
    const allowed = allowedWriteClientIds();
    const client = bodyClientId(opts.body) ?? opts.clientId ?? null;
    if (allowed.size > 0 && (client === null || !allowed.has(client))) {
      console.warn(
        `[write-guard] suppressed ${method} ${scrubSecrets(path)} for client ${client ?? "(none named)"}; ` +
          `POS_WRITE_CLIENT_IDS allows only ${[...allowed].join(", ")}`,
      );
      record({
        method,
        path,
        status: null,
        ms: 0,
        outcome: "write-guard",
        actor: null,
        actorToken: null,
        requestBody: opts.body ?? null,
        responseBody:
          `suppressed: client ${client ?? "(none named)"} is not in ` +
          `POS_WRITE_CLIENT_IDS (${[...allowed].join(", ")})`,
      });
      return { WriteSuppressed: true } as T;
    }
    /* T89 review: the target moved a moment ago, so this write is not
     * sent at all. A route makes several calls and the override can be
     * refreshed between two of them (this process's own switch, or one
     * read from the row after another process made it); a sale whose
     * rehearsal priced one studio must never post to the other. Refused
     * rather than suppressed: nothing is pretended to have worked. */
    const settling = targetSettling();
    if (settling > 0) {
      console.warn(
        `[target] refused ${method} ${path}: the studio target just changed, ` +
          `settling for ${settling}ms. Sign in again and retry.`,
      );
      record({
        method,
        path,
        status: null,
        ms: 0,
        outcome: "target-switch",
        actor: null,
        actorToken: null,
        requestBody: opts.body ?? null,
        responseBody:
          "refused: the studio target just changed; this write was not sent",
      });
      throw new Error(
        "The studio target just changed, so this write was not sent. " +
          "Sign in again and try it once more.",
      );
    }
  }

  const headers: Record<string, string> = {
    "Api-Key": env.apiKey,
    SiteId: env.siteId,
    "content-type": "application/json",
  };
  /* T49: a signed-in teacher's token, or the service account's. The
   * actor's token is never cached here and never refreshed here; it is
   * whatever the staff session holds, and a rejection of it is the
   * route's business. */
  if (opts.actor) headers["Authorization"] = opts.actor.token;
  else if (!opts.anonymous) headers["Authorization"] = await staffToken(env);

  const started = Date.now();
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  record({
    method,
    path,
    status: res.status,
    ms: Date.now() - started,
    outcome: "sent",
    actor: opts.actor?.staffId ?? null,
    /* T109: the token this call actually authenticated with, when it was
     * a teacher's. It is the same string the Authorization header above
     * carried, so the record and the wire agree. The service account's
     * own token is a different credential and is not named here. */
    actorToken: opts.actor?.token ?? null,
    requestBody: opts.body ?? null,
    responseBody: text,
  });
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error page; keep the text */
  }
  if (!res.ok) {
    /**
     * A rejected token is the one failure worth retrying automatically:
     * it is invisible to the teacher and costs one extra round trip,
     * where the alternative is a check-in that mysteriously fails once.
     *
     * Safe for writes too, money writes included: 401 means the request
     * was refused at the authentication gate, BEFORE any endpoint logic
     * ran, so the first attempt provably did not process (a server that
     * charged a card and then answered 401 does not exist). The retry is
     * one fresh attempt with a fresh token; if IT dies in transport, the
     * timeout/abort propagates and the money routes flag the outcome
     * ambiguous exactly as they would for a first attempt.
     */
    if (res.status === 401 && !opts.anonymous && !opts.actor) {
      forgetToken();
      const retryHeaders = { ...headers, Authorization: await staffToken(env) };
      const retryStarted = Date.now();
      const retry = await fetch(`${env.baseUrl}${path}`, {
        method,
        headers: retryHeaders,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      /* The retry is a real call Mindbody received: it goes in the call
       * log like any other, and its OWN status/body -- not the original
       * 401's -- is what the caller hears about. */
      const retryText = await retry.text();
      record({
        method,
        path,
        status: retry.status,
        ms: Date.now() - retryStarted,
        outcome: "sent",
        actor: null,
        actorToken: null,
        requestBody: opts.body ?? null,
        responseBody: retryText,
      });
      let retryBody: any = retryText;
      try {
        retryBody = JSON.parse(retryText);
      } catch {
        /* non-JSON; keep the text, same as the main path */
      }
      if (retry.ok) return retryBody as T;
      throw mindbodyHttpError(retryBody, retry.status);
    }
    /* The thrown message reaches teacher-facing surfaces (context panel
     * lines, row messages), so it carries Mindbody's human-readable reason
     * and nothing else. The transport detail -- method, full path, status,
     * both bodies -- is already in the call log for the dev drawer; a
     * teacher must not be shown URL-encoded query strings. */
    const failure = mindbodyHttpError(body, res.status);
    /* T210: the service account's own token was refused as belonging to
     * another site. That is exactly the borrowed token this process
     * cached for this site id (the T206 borrow, before it filtered by
     * site), and riding it means every read fails the same way until a
     * restart. Forget it, so the next call issues a token of this
     * site's own; no retry here, because one failing call is cheap and
     * a silent second attempt on a write is not. */
    if (
      !opts.anonymous &&
      !opts.actor &&
      isForeignSiteRefusal(failure) &&
      forgetBorrowedToken()
    ) {
      console.warn(
        `[token] the borrowed service token was refused for site ${env.siteId} ` +
          "(it belongs to another Mindbody site); forgetting it, the next " +
          "call issues a fresh one.",
      );
    }
    throw failure;
  }
  return body as T;
}
