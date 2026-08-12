import { createHmac, timingSafeEqual } from "node:crypto";

import {
  appendConsentEventOnce,
  upsertSuppression,
} from "../db/campaignEvents.js";
import { findUnsubscribeRecipient } from "../db/campaignSend.js";
import { getPool } from "../db/client.js";

/**
 * One-click unsubscribe (SEA-84). Ships WITH the send, non-negotiable:
 * CAN-SPAM requires a working opt-out in every commercial message, and
 * inbox providers require RFC 8058 one-click at any volume. Pure code,
 * framework-free like resendWebhook.ts: processUnsubscribe takes method +
 * token and returns status/body, so the worker's Express routes are
 * two-line adapters and the offline smoke exercises every branch.
 *
 * Token design: NOT enumerable. The link carries
 *   <campaignId>.<contactId>.<base64url(HMAC-SHA256(secret, cid US kid))>
 * so guessing a valid token requires forging the HMAC; sequential ids
 * alone buy an attacker nothing. Verification is timing-safe. The token
 * is deliberately NOT single-use: a replayed click (mail scanners
 * prefetch links, people click twice) must land on the same idempotent
 * writes, never an error -- an unsubscribe that errors on the second
 * click is an unsubscribe some humans believe failed.
 *
 * What one click does, in crash-safe order (each write independently
 * idempotent, same posture as the webhook ingest):
 *   1. suppressions upsert, keyed on the ADDRESS actually mailed
 *      (0011 design point 3), reason 'unsubscribe';
 *   2. consent_events append (state unsubscribed, source
 *      unsubscribe_link), deduped on the token's identity embedded in
 *      detail so a replay never double-appends.
 * No login, no preference maze: the GET response is a tiny confirmation
 * page, the POST (RFC 8058 List-Unsubscribe-Post) is a bare 200.
 *
 * Config gate: UNSUBSCRIBE_TOKEN_SECRET unset = endpoint answers 404,
 * indistinguishable from a route that does not exist (the repo's
 * unset-secret = disabled pattern). The SEND side enforces the flip side:
 * with the secret unset, links cannot be generated, so campaigns.send
 * refuses to fire at all -- never send without a working unsubscribe.
 */

/** Env var holding the HMAC secret unsubscribe tokens are signed with. */
export const UNSUBSCRIBE_TOKEN_SECRET_VAR = "UNSUBSCRIBE_TOKEN_SECRET";

/** Env var holding the public base URL unsubscribe links point at (the
 * worker's public host, e.g. https://worker.sealevelhotyoga.com). */
export const UNSUBSCRIBE_BASE_URL_VAR = "UNSUBSCRIBE_BASE_URL";

/** The configured signing secret, or null = disabled. */
export function unsubscribeSecret(): string | null {
  const value = process.env[UNSUBSCRIBE_TOKEN_SECRET_VAR]?.trim();
  return value ? value : null;
}

/** The configured public base URL, or null = unset. */
export function unsubscribeBaseUrl(): string | null {
  const value = process.env[UNSUBSCRIBE_BASE_URL_VAR]?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

/** US (U+001F) joins the HMAC inputs -- cannot occur in a bigint's
 * decimal text, so the encoding is injective (the 0011 dedupe_key
 * argument, reused). */
const US = "\u001f";

const ID_RE = /^[0-9]{1,19}$/;

function signPayload(campaignId: string, contactId: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${campaignId}${US}${contactId}`)
    .digest();
}

/** Mint the signed token for one (campaign, contact). */
export function generateUnsubscribeToken(
  campaignId: string,
  contactId: string,
  secret: string,
): string {
  if (!ID_RE.test(campaignId) || !ID_RE.test(contactId)) {
    throw new Error("unsubscribe token ids must be decimal bigints");
  }
  const sig = signPayload(campaignId, contactId, secret).toString("base64url");
  return `${campaignId}.${contactId}.${sig}`;
}

/** The full unsubscribe URL for one (campaign, contact). */
export function unsubscribeUrl(
  baseUrl: string,
  campaignId: string,
  contactId: string,
  secret: string,
): string {
  const token = generateUnsubscribeToken(campaignId, contactId, secret);
  return `${baseUrl.replace(/\/+$/, "")}/unsubscribe?token=${token}`;
}

/**
 * Verify a token: shape, then timing-safe HMAC comparison. Returns the
 * identified (campaign, contact) or null; never throws on garbage.
 */
export function verifyUnsubscribeToken(
  token: string,
  secret: string,
): { campaignId: string; contactId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [campaignId, contactId, sig] = parts as [string, string, string];
  if (!ID_RE.test(campaignId) || !ID_RE.test(contactId)) return null;
  let candidate: Buffer;
  try {
    candidate = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = signPayload(campaignId, contactId, secret);
  if (candidate.length !== expected.length) return null;
  if (!timingSafeEqual(candidate, expected)) return null;
  return { campaignId, contactId };
}

/** The store surface the endpoint needs; injectable for the smoke. */
export interface UnsubscribeStore {
  findUnsubscribeRecipient(
    campaignId: string,
    contactId: string,
  ): Promise<{ contactId: string; email: string } | null>;
  upsertSuppression(email: string, reason: "unsubscribe"): Promise<void>;
  appendConsentEventOnce(event: {
    contactId: string;
    email: string;
    state: "unsubscribed";
    source: "unsubscribe_link";
    detail: string;
  }): Promise<boolean>;
}

export interface UnsubscribeDeps {
  store?: UnsubscribeStore;
  /** Override the env-read secret (null = disabled). For tests. */
  secret?: string | null;
  log?: (message: string) => void;
}

export interface UnsubscribeResponse {
  status: number;
  /** "html" renders body as a page (GET); "json" for API-shaped answers. */
  contentType: "html" | "json";
  body: string;
}

/** Confirmation page. Plain, no login, no preference maze; no em dashes
 * (project copy convention). */
function confirmationHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed</title></head><body style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; color: #222;"><h1 style="font-size: 1.3rem;">You are unsubscribed</h1><p>You will not receive any more marketing email from Sealevel Hot Yoga. If this was a mistake, just reply to any past email from us and we will add you back.</p></body></html>`;
}

function notFound(): UnsubscribeResponse {
  return {
    status: 404,
    contentType: "json",
    body: JSON.stringify({ error: "not found" }),
  };
}

/**
 * Handle one unsubscribe request (GET link click or RFC 8058 POST).
 * Valid token: perform the idempotent writes and confirm. Invalid or
 * tampered token: 404 without revealing whether the ids exist. Replay:
 * identical success (the writes no-op). Only a store (Postgres) failure
 * propagates; the route adapter turns it into a 500 so the client
 * retries.
 */
export async function processUnsubscribe(
  request: { method: "GET" | "POST"; token: string | undefined },
  deps: UnsubscribeDeps = {},
): Promise<UnsubscribeResponse> {
  const secret = deps.secret === undefined ? unsubscribeSecret() : deps.secret;
  if (secret === null) return notFound();
  const log = deps.log ?? ((message: string) => console.log(message));

  if (typeof request.token !== "string" || request.token.length === 0) {
    return notFound();
  }
  const identity = verifyUnsubscribeToken(request.token, secret);
  if (!identity) {
    log(`[unsubscribe] rejected invalid token (${request.method})`);
    return notFound();
  }

  const store = deps.store ?? pgUnsubscribeStore();
  const recipient = await store.findUnsubscribeRecipient(
    identity.campaignId,
    identity.contactId,
  );
  if (!recipient) {
    // Signed token naming a contact that does not exist: either a
    // different environment's data or a deleted-by-hand row. Nothing to
    // suppress; answer like any other bad token.
    log(
      `[unsubscribe] valid token but no recipient (campaign ${identity.campaignId}, contact ${identity.contactId})`,
    );
    return notFound();
  }

  // Crash-safe order, every write idempotent (the webhook ingest's
  // posture): suppress first, then the ledger append. A retry after a
  // crash at any point completes whatever is missing.
  await store.upsertSuppression(recipient.email, "unsubscribe");
  await store.appendConsentEventOnce({
    contactId: recipient.contactId,
    email: recipient.email,
    state: "unsubscribed",
    source: "unsubscribe_link",
    detail: `one-click unsubscribe link (campaign ${identity.campaignId}, contact ${identity.contactId})`,
  });
  log(
    `[unsubscribe] ${recipient.email} unsubscribed via campaign ${identity.campaignId} link (${request.method})`,
  );

  if (request.method === "POST") {
    // RFC 8058 one-click: mail providers POST List-Unsubscribe=One-Click
    // and only need the 200.
    return {
      status: 200,
      contentType: "json",
      body: JSON.stringify({ ok: true }),
    };
  }
  return { status: 200, contentType: "html", body: confirmationHtml() };
}

/** Production store over the shared pool. */
export function pgUnsubscribeStore(): UnsubscribeStore {
  return {
    findUnsubscribeRecipient: (campaignId, contactId) =>
      findUnsubscribeRecipient(getPool(), campaignId, contactId),
    upsertSuppression: (email, reason) =>
      upsertSuppression(getPool(), email, reason),
    appendConsentEventOnce: (event) =>
      appendConsentEventOnce(getPool(), event),
  };
}
