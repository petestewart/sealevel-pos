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

export function mindbodyEnv(): MindbodyEnv {
  const apiKey = process.env["MINDBODY_API_KEY"] ?? "";
  const siteId = process.env["MINDBODY_SITE_ID"] ?? "";
  const username = process.env["MINDBODY_STAFF_USERNAME"] ?? "";
  const password = process.env["MINDBODY_STAFF_PASSWORD"] ?? "";
  if (!apiKey || !siteId || !username || !password) {
    throw new Error(
      "Mindbody is not configured: set MINDBODY_API_KEY, MINDBODY_SITE_ID, " +
        "MINDBODY_STAFF_USERNAME and MINDBODY_STAFF_PASSWORD",
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
let cachedToken: { value: string; issuedAt: number } | null = null;

export async function staffToken(env = mindbodyEnv()): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.issuedAt < TOKEN_TTL_MS) {
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
  cachedToken = { value: token, issuedAt: Date.now() };
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

export async function mindbody<T = any>(
  path: string,
  opts: MindbodyCallOptions = {},
): Promise<T> {
  const env = mindbodyEnv();
  const method = opts.method ?? "GET";
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
