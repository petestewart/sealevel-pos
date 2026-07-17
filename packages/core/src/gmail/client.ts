import { gmailConfig, type GmailConfig } from "./config.js";
import type { GmailMessageResource } from "./parse.js";

/**
 * Gmail REST client (GH-95). Dependency-free: a fetch wrapper over the
 * OAuth2 token endpoint and the Gmail v1 API, in the same spirit as the KB
 * client (tools/kb.ts) -- the official googleapis SDK is far heavier than a
 * worker that needs exactly list / get / modify / send. All calls
 * authenticate as the studio mailbox via a cached access token minted from
 * the offline refresh token; the refresh token and access token are never
 * logged.
 *
 * Construct only behind a gmailConfigured() check (gmailClient() does this).
 * Every method throws on a non-2xx response so callers (ingest, send) can
 * degrade or retry deliberately rather than acting on a partial result.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface SentMessage {
  id: string;
  threadId?: string;
}

/**
 * Error from messages.send that carries whether the outcome is AMBIGUOUS:
 * true when the message MAY already have been accepted by Gmail (a network
 * error/timeout after the request left, or a 2xx whose body we could not
 * read), false when it definitely was not (a non-2xx response, or a failure
 * before the request was sent). The send routine uses this to avoid a
 * double-send: an ambiguous failure must NOT be auto-retried, because a
 * retry could deliver a second copy. Gmail send has no idempotency key, so
 * this classification is the only lever.
 */
export class GmailSendError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = "GmailSendError";
  }
}

export class GmailClient {
  private accessToken: string | undefined;
  /** Epoch ms after which the cached access token must be refreshed. */
  private tokenExpiresAt = 0;
  /** Serializes token refresh so concurrent calls mint only one token. */
  private refreshing: Promise<string> | undefined;
  /** Cache of label name -> id, populated lazily. */
  private labelIds = new Map<string, string>();

  constructor(private readonly config: GmailConfig) {}

  /** A valid access token, refreshing when the cached one is near expiry. */
  private async token(): Promise<string> {
    // 60s safety margin so a token never expires mid-request.
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    this.refreshing ??= this.refreshToken().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !json.access_token) {
      // Surface Google's error code (e.g. invalid_grant) but never the token.
      throw new Error(
        `Gmail token refresh failed: HTTP ${res.status}${
          json.error ? ` ${json.error}` : ""
        }`,
      );
    }
    this.accessToken = json.access_token;
    this.tokenExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown; query?: Record<string, string> },
  ): Promise<T> {
    const token = await this.token();
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(init?.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Gmail API ${init?.method ?? "GET"} ${path} failed: HTTP ${res.status}${
          detail ? ` ${detail.slice(0, 300)}` : ""
        }`,
      );
    }
    // 204 (e.g. from modify with no return) has no JSON body.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** List message ids matching the configured (or given) Gmail query. */
  async listMessageIds(query?: string, max?: number): Promise<string[]> {
    const data = await this.request<{
      messages?: Array<{ id?: string }>;
    }>("/messages", {
      query: {
        q: query ?? this.config.ingestQuery,
        maxResults: String(max ?? this.config.ingestMax),
      },
    });
    return (data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
  }

  /** Fetch one full message resource by Gmail id. */
  async getMessage(id: string): Promise<GmailMessageResource> {
    return this.request<GmailMessageResource>(
      `/messages/${encodeURIComponent(id)}`,
      { query: { format: "full" } },
    );
  }

  /** Add/remove labels on a message (e.g. remove UNREAD, add the processed label). */
  async modifyMessage(
    id: string,
    change: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<void> {
    await this.request<unknown>(`/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: {
        addLabelIds: change.addLabelIds ?? [],
        removeLabelIds: change.removeLabelIds ?? [],
      },
    });
  }

  /**
   * Resolve a label name to its id, creating the label if it does not
   * exist. Result cached per client so a poll of N messages resolves the
   * processed label once. Nested names ("AI-Manager/Ingested") create a
   * nested label, which Gmail renders as a hierarchy.
   */
  async ensureLabelId(name: string): Promise<string> {
    const cached = this.labelIds.get(name);
    if (cached) return cached;

    const { labels = [] } = await this.request<{
      labels?: Array<{ id?: string; name?: string }>;
    }>("/labels");
    for (const l of labels) {
      if (l.name && l.id) this.labelIds.set(l.name, l.id);
    }
    const existing = this.labelIds.get(name);
    if (existing) return existing;

    const created = await this.request<{ id?: string; name?: string }>(
      "/labels",
      {
        method: "POST",
        body: {
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      },
    );
    if (!created.id) {
      throw new Error(`Gmail label create returned no id for "${name}"`);
    }
    this.labelIds.set(name, created.id);
    return created.id;
  }

  /**
   * Send a base64url RFC822 message, threaded when a threadId is given.
   * Unlike the other methods this does its own fetch so it can classify the
   * failure as ambiguous or not (GmailSendError.ambiguous): the difference
   * decides whether a retry is safe. A token-refresh failure or a non-2xx
   * response means the message was not accepted (safe to retry); a network
   * error or an unreadable 2xx body means it may have been (do not retry).
   */
  async sendMessage(
    rawBase64Url: string,
    threadId?: string,
  ): Promise<SentMessage> {
    // Token refresh happens before the request leaves; a failure here is
    // definitely pre-send, so it is safe to retry.
    let token: string;
    try {
      token = await this.token();
    } catch (err) {
      throw new GmailSendError(
        `token refresh before send failed: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/messages/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          threadId ? { raw: rawBase64Url, threadId } : { raw: rawBase64Url },
        ),
      });
    } catch (err) {
      // Network error / timeout: the request may have reached Gmail.
      throw new GmailSendError(
        `network error during send: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Gmail returns 2xx only when it accepts the message; a non-2xx means
      // it did not, so retrying is safe.
      throw new GmailSendError(
        `HTTP ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`,
        false,
      );
    }

    let data: { id?: string; threadId?: string };
    try {
      data = (await res.json()) as { id?: string; threadId?: string };
    } catch {
      // A 2xx we cannot read: the message was almost certainly sent.
      throw new GmailSendError("send accepted but response body unreadable", true);
    }
    if (!data.id) {
      // Accepted (2xx) but no id: treat as sent to avoid a double-send.
      throw new GmailSendError("send accepted but returned no message id", true);
    }
    return { id: data.id, threadId: data.threadId };
  }
}

/** Shared client for the process, rebuilt if the configuration changes. */
let shared: GmailClient | undefined;
let sharedKey: string | undefined;

/**
 * The shared Gmail client, or throws if Gmail is not configured. The key
 * folds every credential/field so a config change (e.g. in a test) rebuilds
 * the client; the refresh token is part of the key but the key is never
 * logged.
 */
export function gmailClient(): GmailClient {
  const config = gmailConfig();
  const key = JSON.stringify(config);
  if (!shared || sharedKey !== key) {
    shared = new GmailClient(config);
    sharedKey = key;
  }
  return shared;
}
