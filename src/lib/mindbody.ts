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

export interface MindbodyEnv {
  apiKey: string;
  siteId: string;
  username: string;
  password: string;
  baseUrl: string;
}

export type Target = "sandbox" | "prod";

/**
 * Which studio the app is pointed at. Defaults to sandbox: reaching the
 * real studio's live classes and real students has to be something someone
 * chose, never something they forgot to prevent.
 */
export function target(): Target {
  return process.env["MINDBODY_TARGET"] === "prod" ? "prod" : "sandbox";
}

/**
 * Two credential sets, selected by MINDBODY_TARGET.
 *
 * Mindbody publishes a sandbox site (id -99, "LastSpot") that a normal
 * developer key can reach, so this needs no second key unless you want
 * one: SANDBOX_* falls back to the same key with the sandbox site id.
 * PROD_* falls back to the unprefixed MINDBODY_* names, so an existing
 * .env keeps working.
 */
export function mindbodyEnv(): MindbodyEnv {
  const sandbox = target() === "sandbox";
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

  if (!apiKey || !siteId || !username || !password) {
    const prefix = sandbox ? "MINDBODY_SANDBOX_" : "MINDBODY_PROD_";
    throw new Error(
      `Mindbody is not configured for target "${target()}": set ${prefix}API_KEY, ` +
        `${prefix}SITE_ID, ${prefix}STAFF_USERNAME and ${prefix}STAFF_PASSWORD ` +
        "(or the unprefixed MINDBODY_* names, which serve as the fallback).",
    );
  }
  return {
    apiKey,
    siteId,
    username,
    password,
    baseUrl:
      process.env["MINDBODY_API_BASE_URL"] ||
      "https://api.mindbodyonline.com/public/v6",
  };
}

/**
 * Mindbody does not document the staff token's lifetime, so this refreshes
 * an hour ahead of any plausible expiry rather than waiting to be told the
 * token is stale mid-transaction.
 */
const TOKEN_TTL_MS = 60 * 60 * 1000;
let cachedToken: { value: string; issuedAt: number; siteId: string } | null =
  null;

export async function staffToken(env = mindbodyEnv()): Promise<string> {
  /** Keyed by site: a token issued for the sandbox must never be reused
   *  against production, or vice versa. */
  if (
    cachedToken &&
    cachedToken.siteId === env.siteId &&
    Date.now() - cachedToken.issuedAt < TOKEN_TTL_MS
  ) {
    return cachedToken.value;
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
    throw new Error(
      `Mindbody usertoken/issue failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  cachedToken = { value: token, issuedAt: Date.now(), siteId: env.siteId };
  return token;
}

/** Drop the cached token; call when Mindbody rejects it as invalid. */
export function forgetToken(): void {
  cachedToken = null;
}

export interface MindbodyCallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Skip the staff token. Only for endpoints that genuinely do not need it. */
  anonymous?: boolean;
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
  return (process.env["POS_DRY_RUN"] ?? "true").toLowerCase() !== "false";
}

/**
 * Which calls dry run has to intercept. Issuing a user token is a POST but
 * changes nothing, and nothing works without it, so it is not a write.
 */
function isWrite(method: string, path: string): boolean {
  return method === "POST" && !path.startsWith("/usertoken/");
}

export async function mindbody<T = any>(
  path: string,
  opts: MindbodyCallOptions = {},
): Promise<T> {
  const env = mindbodyEnv();
  const method = opts.method ?? "GET";

  if (isDryRun() && isWrite(method, path)) {
    console.warn(
      `[dry-run] suppressed ${method} ${path} ${JSON.stringify(opts.body ?? {})}`,
    );
    return { DryRun: true } as T;
  }

  const headers: Record<string, string> = {
    "Api-Key": env.apiKey,
    SiteId: env.siteId,
    "content-type": "application/json",
  };
  if (!opts.anonymous) headers["Authorization"] = await staffToken(env);

  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
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
     */
    if (res.status === 401 && !opts.anonymous) {
      forgetToken();
      const retryHeaders = { ...headers, Authorization: await staffToken(env) };
      const retry = await fetch(`${env.baseUrl}${path}`, {
        method,
        headers: retryHeaders,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if (retry.ok) return (await retry.json()) as T;
    }
    const message =
      body?.Error?.Message ?? (typeof body === "string" ? body.slice(0, 200) : "");
    throw new Error(`Mindbody ${method} ${path}: HTTP ${res.status} ${message}`);
  }
  return body as T;
}
