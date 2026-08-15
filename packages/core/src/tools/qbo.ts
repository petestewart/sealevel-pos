/**
 * QuickBooks Online client (SEA-104, automation plan §7b step 4): the
 * minimal surface payroll.push needs, nothing more. OAuth2 refresh-token
 * flow, sandbox first (QBO_ENV=sandbox is the default; "production"
 * switches hosts). Env, worker only, NEVER the console (the Gmail gate
 * split): QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REFRESH_TOKEN,
 * QBO_REALM_ID, optional QBO_ENV and QBO_EXPENSE_ACCOUNT_ID.
 *
 * Teacher pay is accounts payable, so the artifact is a BILL against a
 * Vendor (policy §10) with DocNumber <period>-<mb_staff_id>, the
 * outermost QBO-side idempotency reference. Vendors are looked up by
 * DisplayName and NEVER auto-created: whether missing teachers get
 * vendor records is an open bookkeeper question (policy §10), and a
 * payee appearing in QBO should be a decision, not a side effect.
 */

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  realmId: string;
  env: "sandbox" | "production";
  /** Expense account for Bill lines; unset = QBO's default account
   * resolution (an open bookkeeper question, policy §10). */
  expenseAccountId?: string;
}

/** Whether the QBO connection is configured in the environment. */
export function qboConfigured(): boolean {
  return Boolean(
    process.env["QBO_CLIENT_ID"] &&
      process.env["QBO_CLIENT_SECRET"] &&
      process.env["QBO_REFRESH_TOKEN"] &&
      process.env["QBO_REALM_ID"],
  );
}

export function qboConfig(): QboConfig {
  if (!qboConfigured()) {
    throw new Error(
      "QBO is not configured (QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REFRESH_TOKEN / QBO_REALM_ID)",
    );
  }
  const env = process.env["QBO_ENV"] === "production" ? "production" : "sandbox";
  return {
    clientId: process.env["QBO_CLIENT_ID"] ?? "",
    clientSecret: process.env["QBO_CLIENT_SECRET"] ?? "",
    refreshToken: process.env["QBO_REFRESH_TOKEN"] ?? "",
    realmId: process.env["QBO_REALM_ID"] ?? "",
    env,
    ...(process.env["QBO_EXPENSE_ACCOUNT_ID"]
      ? { expenseAccountId: process.env["QBO_EXPENSE_ACCOUNT_ID"] }
      : {}),
  };
}

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function apiBase(env: QboConfig["env"]): string {
  return env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

/** One line on the Bill payroll.push writes. */
export interface QboBillLine {
  description: string;
  amountCents: number;
}

export interface QboBillResult {
  /** QBO's Bill Id, stored as payroll_invoices.qbo_ref. */
  billId: string;
  docNumber: string;
}

export class QboError extends Error {
  constructor(
    message: string,
    /** True for failures a retry may fix (network, 5xx, expired token
     * refresh hiccup); false for semantic rejections (missing vendor,
     * duplicate DocNumber) that need a human. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Minimal QBO API client. Access tokens are fetched per client instance
 * and cached until near expiry; QBO access tokens live one hour, and a
 * push run is seconds, so one refresh per run is typical, and the
 * refresh path re-runs automatically as expiry approaches.
 */
export class QboClient {
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: QboConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const basic = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.config.refreshToken,
      }).toString(),
    });
    if (!res.ok) {
      throw new QboError(
        `QBO token refresh failed: HTTP ${res.status}`,
        res.status >= 500,
      );
    }
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new QboError("QBO token refresh returned no access_token", false);
    }
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt =
      Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async api(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.token();
    const url = `${apiBase(this.config.env)}/v3/company/${this.config.realmId}${path}${path.includes("?") ? "&" : "?"}minorversion=75`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new QboError(
        `QBO ${method} ${path} failed: HTTP ${res.status}: ${text.slice(0, 300)}`,
        res.status >= 500 || res.status === 429,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new QboError(
        `QBO ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`,
        false,
      );
    }
  }

  /** Vendor id by exact DisplayName, or null. Never creates one. */
  async findVendor(displayName: string): Promise<string | null> {
    const query = `select Id from Vendor where DisplayName = '${displayName.replace(/'/g, "\\'")}'`;
    const data = (await this.api(
      "GET",
      `/query?query=${encodeURIComponent(query)}`,
    )) as { QueryResponse?: { Vendor?: Array<{ Id?: string }> } };
    const id = data.QueryResponse?.Vendor?.[0]?.Id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  /** Any Bill already carrying this DocNumber (the QBO-side idempotency
   * check payroll.push runs before writing). */
  async findBillByDocNumber(docNumber: string): Promise<string | null> {
    const query = `select Id from Bill where DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
    const data = (await this.api(
      "GET",
      `/query?query=${encodeURIComponent(query)}`,
    )) as { QueryResponse?: { Bill?: Array<{ Id?: string }> } };
    const id = data.QueryResponse?.Bill?.[0]?.Id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  /** Write one Bill. The caller has already checked findBillByDocNumber. */
  async createBill(input: {
    vendorId: string;
    docNumber: string;
    txnDate: string;
    lines: QboBillLine[];
    memo?: string;
  }): Promise<QboBillResult> {
    const body = {
      VendorRef: { value: input.vendorId },
      DocNumber: input.docNumber,
      TxnDate: input.txnDate,
      ...(input.memo ? { PrivateNote: input.memo } : {}),
      Line: input.lines.map((line) => ({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: line.amountCents / 100,
        Description: line.description,
        AccountBasedExpenseLineDetail: this.config.expenseAccountId
          ? { AccountRef: { value: this.config.expenseAccountId } }
          : {},
      })),
    };
    const data = (await this.api("POST", "/bill", body)) as {
      Bill?: { Id?: string; DocNumber?: string };
    };
    const billId = data.Bill?.Id;
    if (typeof billId !== "string" || billId.length === 0) {
      throw new QboError("QBO createBill returned no Bill.Id", false);
    }
    return { billId, docNumber: data.Bill?.DocNumber ?? input.docNumber };
  }
}

let sharedClient: QboClient | undefined;
let sharedClientKey: string | undefined;

/** Keyed-singleton client, same idiom as tools/kb.ts and analytics. */
export function qboClient(): QboClient {
  const config = qboConfig();
  const key = `${config.clientId}\n${config.realmId}\n${config.env}`;
  if (!sharedClient || sharedClientKey !== key) {
    sharedClient = new QboClient(config);
    sharedClientKey = key;
  }
  return sharedClient;
}
