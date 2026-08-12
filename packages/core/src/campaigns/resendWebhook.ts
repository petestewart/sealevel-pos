import { createHmac, timingSafeEqual } from "node:crypto";

import {
  pgResendEventStore,
  type CampaignEventType,
  type ResendEventStore,
} from "../db/campaignEvents.js";

/**
 * Resend delivery webhook -> campaign_events + bounce/complaint
 * suppression (SEA-85). Pure code, no brain: this is the delivery
 * feedback loop and the list hygiene that keeps the sending domain alive.
 *
 * Framework-free by design: processResendWebhook takes the raw body and
 * the three Svix headers and returns an HTTP status + JSON body, so the
 * worker's Express route is a two-line adapter and the offline smoke
 * exercises every branch without a server or Postgres.
 *
 * Security and correctness posture:
 *  - Config-gated: with RESEND_WEBHOOK_SECRET unset the endpoint answers
 *    404, indistinguishable from a route that does not exist (same
 *    unset-secret = disabled pattern as the Gmail and Mindbody gates).
 *  - Signature-verified: Resend signs via Svix -- HMAC-SHA256 over
 *    "{svix-id}.{svix-timestamp}.{raw body}" with the base64 secret from
 *    the whsec_ value, compared timing-safely; a timestamp outside the
 *    tolerance window is rejected to stop replays of captured deliveries.
 *    Anything unsigned or invalid is a 401 before the body is even parsed.
 *  - Idempotent, write by write: campaign_events dedupes on the svix-id
 *    (delivery-stable across Resend's retries, migration 0014), the
 *    suppression insert is ON CONFLICT DO NOTHING, and the complaint
 *    consent append carries its own WHERE NOT EXISTS guard keyed on the
 *    svix id in its detail. Because EVERY write is independently
 *    idempotent, they can run in crash-safety order (suppress, then
 *    consent, then event) and a retry after a crash at any point simply
 *    completes whatever is missing -- no side effect is gated behind
 *    another write having won, so none can be permanently lost behind
 *    the replay dedupe. Suppressions key on EMAIL, not contact id
 *    (0011 point 3), and are written IMMEDIATELY and synchronously.
 *  - Unknown provider message ids never crash and never discard data:
 *    the event is stored UNCORRELATED (NULL send_id, 0014) with the
 *    verbatim body, a hard bounce/complaint still suppresses the
 *    recipient address taken from the payload (hygiene does not depend
 *    on correlation), and the response is 200 so Resend does not retry
 *    forever.
 */

/** Env var holding the Resend endpoint's Svix signing secret (whsec_...). */
export const RESEND_WEBHOOK_SECRET_VAR = "RESEND_WEBHOOK_SECRET";

/** The configured signing secret, or null = endpoint disabled. */
export function resendWebhookSecret(): string | null {
  const value = process.env[RESEND_WEBHOOK_SECRET_VAR]?.trim();
  return value ? value : null;
}

/** Svix rejects deliveries older/newer than 5 minutes; mirror that. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Resend event type -> campaign_events.type. Unlisted types are ignored
 * (email.sent, email.delivery_delayed, ... are not delivery outcomes we
 * track). */
export const RESEND_EVENT_TYPES: Readonly<Record<string, CampaignEventType>> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

export interface SvixHeaders {
  svixId?: string;
  svixTimestamp?: string;
  svixSignature?: string;
}

/**
 * Verify a Svix-signed delivery: HMAC-SHA256 over
 * "{id}.{timestamp}.{payload}" keyed with the base64 payload of the
 * whsec_ secret, base64-encoded, matched against any v1 entry in the
 * space-delimited svix-signature header. Constant-time comparison via
 * crypto.timingSafeEqual. Returns false (never throws) on any missing or
 * malformed input.
 */
export function verifyResendSignature(options: {
  secret: string;
  headers: SvixHeaders;
  payload: string | Buffer;
  nowMs?: number;
  toleranceMs?: number;
}): boolean {
  const { svixId, svixTimestamp, svixSignature } = options.headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Reject stale or far-future timestamps before any crypto.
  const timestampSec = Number(svixTimestamp);
  if (!Number.isFinite(timestampSec)) return false;
  const nowMs = options.nowMs ?? Date.now();
  const toleranceMs = options.toleranceMs ?? SIGNATURE_TOLERANCE_MS;
  if (Math.abs(nowMs - timestampSec * 1000) > toleranceMs) return false;

  let key: Buffer;
  try {
    key = Buffer.from(options.secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const payload = Buffer.isBuffer(options.payload)
    ? options.payload
    : Buffer.from(options.payload, "utf8");
  const expected = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${svixId}.${svixTimestamp}.`, "utf8"), payload]))
    .digest();

  // The header carries space-delimited "v1,<base64>" entries (older keys
  // stay valid through a secret rotation); any v1 match passes.
  for (const part of svixSignature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma <= 0 || part.slice(0, comma) !== "v1") continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(part.slice(comma + 1), "base64");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

/** Hard bounce = the mailbox is gone (Resend/SES bounce.type "Permanent").
 * Transient/Undetermined bounces (full mailbox, greylisting, ...) are soft:
 * recorded as events, never suppressed. A missing bounce type is treated
 * as soft -- suppression must be evidence-based, not default-on. */
export function isHardBounce(payload: ResendWebhookPayload): boolean {
  const bounceType = (payload.data?.bounce as { type?: unknown } | undefined)
    ?.type;
  return typeof bounceType === "string" && bounceType.toLowerCase() === "permanent";
}

/** The subset of a Resend webhook body this handler reads. */
export interface ResendWebhookPayload {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    bounce?: unknown;
  };
}

export interface ResendWebhookRequest {
  /** The raw, unmodified request body -- the bytes the signature covers. */
  rawBody: string | Buffer;
  headers: SvixHeaders;
}

export interface ResendWebhookDeps {
  store?: ResendEventStore;
  /** Override the env-read secret (null = disabled). For tests. */
  secret?: string | null;
  nowMs?: number;
  log?: (message: string) => void;
}

export interface ResendWebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Recipient addresses from data.to (string or string[]), lowercased. */
function recipientAddresses(payload: ResendWebhookPayload): string[] {
  const to = payload.data?.to;
  const list = typeof to === "string" ? [to] : Array.isArray(to) ? to : [];
  return list
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Event timestamp: the payload's created_at when parseable, else now. */
function eventAt(payload: ResendWebhookPayload, nowMs: number): Date {
  if (typeof payload.created_at === "string") {
    const parsed = new Date(payload.created_at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(nowMs);
}

/**
 * Handle one Resend webhook delivery end to end: gate, verify, map,
 * correlate, record, suppress. Returns the HTTP status + JSON body for
 * the route adapter to send. Never throws on malformed input; only a
 * store (Postgres) failure propagates, which the route turns into a 500
 * so Resend retries the delivery.
 */
export async function processResendWebhook(
  request: ResendWebhookRequest,
  deps: ResendWebhookDeps = {},
): Promise<ResendWebhookResponse> {
  // Config gate: unset secret = endpoint disabled, answering exactly like
  // a route that does not exist.
  const secret = deps.secret === undefined ? resendWebhookSecret() : deps.secret;
  if (secret === null) return { status: 404, body: { error: "not found" } };

  const log = deps.log ?? ((message: string) => console.log(message));
  const nowMs = deps.nowMs ?? Date.now();

  if (
    !verifyResendSignature({
      secret,
      headers: request.headers,
      payload: request.rawBody,
      nowMs,
    })
  ) {
    return { status: 401, body: { error: "invalid signature" } };
  }
  // Present, else verification could not have passed.
  const providerEventId = request.headers.svixId as string;

  const rawJson = Buffer.isBuffer(request.rawBody)
    ? request.rawBody.toString("utf8")
    : request.rawBody;
  let payload: ResendWebhookPayload;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    payload = parsed as ResendWebhookPayload;
  } catch {
    return { status: 400, body: { error: "invalid JSON body" } };
  }

  const resendType = typeof payload.type === "string" ? payload.type : "";
  const eventType = RESEND_EVENT_TYPES[resendType];
  if (!eventType) {
    // Not a delivery outcome we track (email.sent, delivery_delayed, ...).
    return { status: 200, body: { ok: true, outcome: "ignored", type: resendType } };
  }

  const store = deps.store ?? pgResendEventStore();
  const emailId =
    typeof payload.data?.email_id === "string" ? payload.data.email_id : "";
  const send = emailId ? await store.findSendByProviderMessageId(emailId) : null;

  const wantsSuppression =
    eventType === "complained" || (eventType === "bounced" && isHardBounce(payload));
  const suppressionReason = eventType === "complained" ? "complaint" : "hard_bounce";

  if (!send) {
    // Unknown (or missing) provider message id: not one of our campaign
    // sends, or the send row has not landed yet. Never crash -- and never
    // discard: list hygiene still applies (a hard bounce or complaint
    // suppresses the recipient address from the payload even without
    // correlation), and the event itself is STORED uncorrelated (NULL
    // send_id, 0014) so it can be re-correlated or reinterpreted later.
    // No consent ledger row: the contact is not resolvable without a send.
    const suppressed: string[] = [];
    if (wantsSuppression) {
      for (const address of recipientAddresses(payload)) {
        await store.upsertSuppression(address, suppressionReason);
        suppressed.push(address);
      }
    }
    const inserted = await store.insertCampaignEvent({
      sendId: null,
      type: eventType,
      providerEventId,
      at: eventAt(payload, nowMs),
      rawJson,
    });
    log(
      `[resend-webhook] ${resendType} for unknown email_id "${emailId}" (svix ${providerEventId}) ` +
        `stored uncorrelated (${inserted ? "recorded" : "duplicate"})` +
        (suppressed.length > 0 ? `; suppressed ${suppressed.join(", ")}` : ""),
    );
    return {
      status: 200,
      body: {
        ok: true,
        outcome: inserted ? "unknown_message_id" : "duplicate",
        type: eventType,
        suppressed: suppressed.length,
      },
    };
  }

  // Suppress FIRST, before the deduped event insert: if the process dies
  // between the writes, the retry re-runs this (idempotent) instead of
  // losing the suppression behind the replay guard. The suppression keys
  // on the address actually mailed (snapshotted on the send row, 0011).
  if (wantsSuppression) {
    await store.upsertSuppression(send.email, suppressionReason);
  }

  // A complaint is also an opt-out signal: append it to the consent
  // ledger (append-only, source 'complaint') -- the contact is resolvable
  // here via the send row. This append is idempotent IN ITS OWN RIGHT
  // (WHERE NOT EXISTS on contact_id + source + detail, the detail
  // embedding the svix id) and runs BEFORE the deduped event insert, so a
  // crash anywhere in this handler leaves a retry that completes whatever
  // is missing -- never a permanently lost ledger row, never a double
  // append.
  if (eventType === "complained") {
    await store.appendConsentEventOnce({
      contactId: send.contactId,
      email: send.email,
      state: "unsubscribed",
      source: "complaint",
      detail: `Resend complaint webhook (svix ${providerEventId}, email_id ${emailId})`,
    });
  }

  const inserted = await store.insertCampaignEvent({
    sendId: send.id,
    type: eventType,
    providerEventId,
    at: eventAt(payload, nowMs),
    rawJson,
  });

  if (!inserted) {
    // Replay of an already-recorded event: every side effect above
    // already happened or just no-opped idempotently. Report and stop.
    return {
      status: 200,
      body: { ok: true, outcome: "duplicate", type: eventType },
    };
  }

  log(
    `[resend-webhook] ${eventType} recorded for send ${send.id} (svix ${providerEventId})` +
      (wantsSuppression ? `; suppressed ${send.email} (${suppressionReason})` : ""),
  );
  return {
    status: 200,
    body: {
      ok: true,
      outcome: "recorded",
      type: eventType,
      suppressed: wantsSuppression ? 1 : 0,
    },
  };
}
