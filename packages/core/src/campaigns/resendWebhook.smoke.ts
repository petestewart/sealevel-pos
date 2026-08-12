import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import type {
  CampaignEventType,
  CampaignSendRef,
  ResendEventStore,
  SuppressionReason,
} from "../db/campaignEvents.js";
import {
  processResendWebhook,
  verifyResendSignature,
  type ResendWebhookResponse,
} from "./resendWebhook.js";

/**
 * Offline smoke for the Resend webhook ingest (SEA-85). Everything runs
 * against an in-memory fake store: no Postgres or HTTP server is touched.
 * The DB layer itself (0014 partial-unique dedupe insert, suppressions
 * ON CONFLICT, append-only consent trigger) is exercised by the real
 * schema via a local `npm run migrate` against docker compose, per repo
 * convention.
 *
 * Run: npm run smoke:resendwebhook  (from packages/core)
 */

const SECRET_BYTES = Buffer.from("resend-smoke-secret-0123456789ab");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const NOW_MS = Date.parse("2026-08-11T12:00:00Z");

/** Sign a body exactly as Svix does: HMAC-SHA256 over "{id}.{ts}.{body}". */
function sign(body: string, id: string, timestampSec: number, secret = SECRET): {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
} {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key)
    .update(`${id}.${timestampSec}.${body}`)
    .digest("base64");
  return {
    svixId: id,
    svixTimestamp: String(timestampSec),
    svixSignature: `v1,${sig}`,
  };
}

function webhookBody(
  type: string,
  emailId: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    created_at: "2026-08-11T11:59:00.000Z",
    data: {
      email_id: emailId,
      from: "studio@sealevelhotyoga.com",
      to: ["Customer@Example.com"],
      subject: "August at Sealevel",
      ...extra,
    },
  });
}

/** In-memory ResendEventStore recording every mutation for assertions. */
class FakeStore implements ResendEventStore {
  sends = new Map<string, CampaignSendRef>(); // by provider_message_id
  events: Array<{
    sendId: string | null;
    type: CampaignEventType;
    providerEventId: string;
    at: Date;
    rawJson: string;
  }> = [];
  suppressions = new Map<string, SuppressionReason>();
  consent: Array<{
    contactId: string;
    email: string;
    state: string;
    source: string;
    detail: string;
  }> = [];
  /** When set, insertCampaignEvent throws (simulates a mid-handler crash). */
  crashOnEventInsert = false;

  async findSendByProviderMessageId(providerMessageId: string) {
    return this.sends.get(providerMessageId) ?? null;
  }
  async insertCampaignEvent(event: {
    sendId: string | null;
    type: CampaignEventType;
    providerEventId: string;
    at: Date;
    rawJson: string;
  }) {
    if (this.crashOnEventInsert) {
      throw new Error("simulated crash before the event insert landed");
    }
    // Mirrors the 0014 partial unique index + ON CONFLICT DO NOTHING.
    if (this.events.some((e) => e.providerEventId === event.providerEventId)) {
      return false;
    }
    this.events.push(event);
    return true;
  }
  async upsertSuppression(email: string, reason: SuppressionReason) {
    // Mirrors ON CONFLICT (email) DO NOTHING: first reason sticks.
    if (!this.suppressions.has(email)) this.suppressions.set(email, reason);
  }
  async appendConsentEventOnce(event: {
    contactId: string;
    email: string;
    state: "subscribed" | "unsubscribed";
    source: "complaint";
    detail: string;
  }) {
    // Mirrors INSERT ... WHERE NOT EXISTS (contact_id, source, detail).
    if (
      this.consent.some(
        (e) =>
          e.contactId === event.contactId &&
          e.source === event.source &&
          e.detail === event.detail,
      )
    ) {
      return false;
    }
    this.consent.push(event);
    return true;
  }
}

function storeWithSend(emailId = "re_msg_1"): FakeStore {
  const store = new FakeStore();
  store.sends.set(emailId, {
    id: "77",
    contactId: "5",
    email: "customer@example.com",
  });
  return store;
}

async function deliver(
  store: FakeStore,
  body: string,
  headers: ReturnType<typeof sign>,
  overrides: { secret?: string | null; nowMs?: number } = {},
): Promise<ResendWebhookResponse> {
  return processResendWebhook(
    { rawBody: Buffer.from(body, "utf8"), headers },
    {
      store,
      secret: overrides.secret !== undefined ? overrides.secret : SECRET,
      nowMs: overrides.nowMs ?? NOW_MS,
      log: () => {},
    },
  );
}

async function testConfigGate(): Promise<void> {
  const body = webhookBody("email.delivered", "re_msg_1");
  const store = storeWithSend();
  const result = await deliver(store, body, sign(body, "evt_gate", NOW_MS / 1000), {
    secret: null,
  });
  assert.equal(result.status, 404);
  assert.equal(store.events.length, 0);

  // The env-driven default gate too: unset secret = 404.
  const saved = process_env_swap(undefined);
  try {
    const viaEnv = await processResendWebhook(
      { rawBody: body, headers: sign(body, "evt_gate2", NOW_MS / 1000) },
      { store, nowMs: NOW_MS, log: () => {} },
    );
    assert.equal(viaEnv.status, 404);
  } finally {
    process_env_swap(saved);
  }
  console.log("[smoke] resend_webhook: config gate (unset secret = 404, nothing stored)");
}

function process_env_swap(value: string | undefined): string | undefined {
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  if (value === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = value;
  return saved;
}

async function testSignatureRejection(): Promise<void> {
  const body = webhookBody("email.delivered", "re_msg_1");
  const store = storeWithSend();
  const good = sign(body, "evt_sig", NOW_MS / 1000);

  // Missing headers.
  for (const headers of [
    {},
    { svixId: good.svixId },
    { svixId: good.svixId, svixTimestamp: good.svixTimestamp },
  ]) {
    const result = await deliver(store, body, headers as ReturnType<typeof sign>);
    assert.equal(result.status, 401);
  }
  // Wrong secret.
  const wrongSecret = sign(body, "evt_sig", NOW_MS / 1000, `whsec_${Buffer.from("not-the-real-secret-material!!").toString("base64")}`);
  assert.equal((await deliver(store, body, wrongSecret)).status, 401);
  // Tampered body (signature no longer covers these bytes).
  const tampered = body.replace("email.delivered", "email.complained");
  assert.equal((await deliver(store, tampered, good)).status, 401);
  // Tampered svix-id (it is part of the signed content).
  assert.equal(
    (await deliver(store, body, { ...good, svixId: "evt_other" })).status,
    401,
  );
  // Garbage signature values.
  assert.equal(
    (await deliver(store, body, { ...good, svixSignature: "v1,!!!not-base64!!!" })).status,
    401,
  );
  assert.equal(
    (await deliver(store, body, { ...good, svixSignature: "v0,AAAA" })).status,
    401,
  );
  // Stale and far-future timestamps (replay window).
  const staleTs = NOW_MS / 1000 - 6 * 60;
  assert.equal((await deliver(store, body, sign(body, "evt_sig", staleTs))).status, 401);
  const futureTs = NOW_MS / 1000 + 6 * 60;
  assert.equal((await deliver(store, body, sign(body, "evt_sig", futureTs))).status, 401);

  assert.equal(store.events.length, 0);
  assert.equal(store.suppressions.size, 0);
  console.log("[smoke] resend_webhook: bad/missing/stale signatures all 401, nothing stored");
}

async function testValidSignatureAccepted(): Promise<void> {
  const body = webhookBody("email.delivered", "re_msg_1");
  const store = storeWithSend();
  const result = await deliver(store, body, sign(body, "evt_ok", NOW_MS / 1000));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    outcome: "recorded",
    type: "delivered",
    suppressed: 0,
  });
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0]!.sendId, "77");
  assert.equal(store.events[0]!.providerEventId, "evt_ok");
  // The verbatim body landed in raw, and created_at was honored.
  assert.equal(store.events[0]!.rawJson, body);
  assert.equal(store.events[0]!.at.toISOString(), "2026-08-11T11:59:00.000Z");
  // A second signature entry (secret rotation) still verifies.
  const rotated = sign(body, "evt_ok2", NOW_MS / 1000);
  rotated.svixSignature = `v1,AAAA ${rotated.svixSignature}`;
  assert.equal((await deliver(store, body, rotated)).status, 200);
  console.log("[smoke] resend_webhook: valid signature accepted, event correlated to send");
}

async function testEachEventTypeLands(): Promise<void> {
  const cases: Array<[string, CampaignEventType, Record<string, unknown>]> = [
    ["email.delivered", "delivered", {}],
    ["email.opened", "opened", {}],
    ["email.clicked", "clicked", { click: { link: "https://example.com" } }],
    [
      "email.bounced",
      "bounced",
      { bounce: { type: "Transient", subType: "MailboxFull", message: "full" } },
    ],
    ["email.complained", "complained", {}],
  ];
  const store = storeWithSend();
  for (const [resendType, expected, extra] of cases) {
    const body = webhookBody(resendType, "re_msg_1", extra);
    const result = await deliver(
      store,
      body,
      sign(body, `evt_${expected}`, NOW_MS / 1000),
    );
    assert.equal(result.status, 200);
    assert.equal((result.body as { type?: string }).type, expected);
  }
  assert.deepEqual(
    store.events.map((e) => e.type),
    ["delivered", "opened", "clicked", "bounced", "complained"],
  );
  // Every event correlated to the same send via provider_message_id.
  assert.ok(store.events.every((e) => e.sendId === "77"));
  console.log("[smoke] resend_webhook: all five event types map and land");
}

async function testHardBounceSuppresses(): Promise<void> {
  const body = webhookBody("email.bounced", "re_msg_1", {
    bounce: { type: "Permanent", subType: "General", message: "mailbox gone" },
  });
  const store = storeWithSend();
  const result = await deliver(store, body, sign(body, "evt_hard", NOW_MS / 1000));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    outcome: "recorded",
    type: "bounced",
    suppressed: 1,
  });
  // Suppression keys on the SEND row's snapshotted address, synchronously.
  assert.equal(store.suppressions.get("customer@example.com"), "hard_bounce");
  // A hard bounce is not a consent signal; the ledger stays untouched.
  assert.equal(store.consent.length, 0);
  console.log("[smoke] resend_webhook: hard bounce suppresses synchronously (email-keyed)");
}

async function testSoftBounceDoesNotSuppress(): Promise<void> {
  const store = storeWithSend();
  for (const bounce of [
    { type: "Transient", subType: "MailboxFull" },
    { type: "Undetermined" },
    {}, // missing type: never suppress on guesswork
  ]) {
    const body = webhookBody("email.bounced", "re_msg_1", { bounce });
    const result = await deliver(
      store,
      body,
      sign(body, `evt_soft_${JSON.stringify(bounce).length}`, NOW_MS / 1000),
    );
    assert.equal(result.status, 200);
  }
  assert.equal(store.events.length, 3); // all recorded as bounced events
  assert.equal(store.suppressions.size, 0); // none suppressed
  console.log("[smoke] resend_webhook: soft/undetermined bounces record but never suppress");
}

async function testComplaintSuppressesAndAppendsConsent(): Promise<void> {
  const body = webhookBody("email.complained", "re_msg_1");
  const store = storeWithSend();
  const result = await deliver(store, body, sign(body, "evt_complaint", NOW_MS / 1000));
  assert.equal(result.status, 200);
  assert.equal(store.suppressions.get("customer@example.com"), "complaint");
  // Consent ledger append: resolvable contact, source 'complaint'.
  assert.equal(store.consent.length, 1);
  const consent = store.consent[0]!;
  assert.equal(consent.contactId, "5");
  assert.equal(consent.email, "customer@example.com");
  assert.equal(consent.state, "unsubscribed");
  assert.equal(consent.source, "complaint");
  assert.match(consent.detail, /evt_complaint/);
  console.log("[smoke] resend_webhook: complaint suppresses + appends consent ledger row");
}

async function testDuplicateDeliveryIsNoOp(): Promise<void> {
  const body = webhookBody("email.complained", "re_msg_1");
  const store = storeWithSend();
  const headers = sign(body, "evt_dup", NOW_MS / 1000);
  const first = await deliver(store, body, headers);
  assert.equal(first.status, 200);
  assert.equal((first.body as { outcome?: string }).outcome, "recorded");
  // Resend redelivers the identical event (same svix-id).
  const second = await deliver(store, body, headers);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { ok: true, outcome: "duplicate", type: "complained" });
  // Exactly one event, one suppression, ONE consent ledger row.
  assert.equal(store.events.length, 1);
  assert.equal(store.suppressions.size, 1);
  assert.equal(store.consent.length, 1);
  console.log("[smoke] resend_webhook: duplicate delivery is a no-op (one event, one ledger row)");
}

async function testUnknownMessageId(): Promise<void> {
  const store = new FakeStore(); // no sends registered at all
  // A delivered event for an unknown id: 200, STORED uncorrelated
  // (NULL send_id, 0014) rather than dropped.
  const delivered = webhookBody("email.delivered", "re_unknown");
  const r1 = await deliver(store, delivered, sign(delivered, "evt_unk1", NOW_MS / 1000));
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, {
    ok: true,
    outcome: "unknown_message_id",
    type: "delivered",
    suppressed: 0,
  });
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0]!.sendId, null);
  assert.equal(store.events[0]!.providerEventId, "evt_unk1");
  assert.equal(store.events[0]!.rawJson, delivered); // verbatim body kept
  // A replay of the same uncorrelated event dedupes on the svix id and
  // still answers 200.
  const r1b = await deliver(store, delivered, sign(delivered, "evt_unk1", NOW_MS / 1000));
  assert.equal(r1b.status, 200);
  assert.equal((r1b.body as { outcome?: string }).outcome, "duplicate");
  assert.equal(store.events.length, 1);
  // A HARD bounce for an unknown id still suppresses the recipient
  // address from the payload: hygiene does not depend on correlation.
  const bounced = webhookBody("email.bounced", "re_unknown", {
    bounce: { type: "Permanent", subType: "General" },
  });
  const r2 = await deliver(store, bounced, sign(bounced, "evt_unk2", NOW_MS / 1000));
  assert.equal(r2.status, 200);
  assert.equal((r2.body as { suppressed?: number }).suppressed, 1);
  assert.equal(store.suppressions.get("customer@example.com"), "hard_bounce");
  assert.equal(store.events.length, 2); // the bounce landed uncorrelated too
  // But no consent row: the contact is not resolvable without a send.
  assert.equal(store.consent.length, 0);
  // Missing email_id entirely: still a clean 200, still stored.
  const noId = JSON.stringify({ type: "email.opened", data: {} });
  const r3 = await deliver(store, noId, sign(noId, "evt_unk3", NOW_MS / 1000));
  assert.equal(r3.status, 200);
  assert.equal(store.events.length, 3);
  console.log("[smoke] resend_webhook: unknown/missing email_id stored uncorrelated, deduped, hard bounce still suppresses");
}

async function testCrashWindowReplayCompletesLedger(): Promise<void> {
  // Regression (PR #149 finding A): a crash mid-handler must never lose
  // the complaint's consent ledger row behind the event dedupe. The
  // consent append runs before the event insert and is idempotent in its
  // own right, so whichever write the crash interrupts, the Resend retry
  // completes the rest exactly once.
  const body = webhookBody("email.complained", "re_msg_1");
  const store = storeWithSend();
  const headers = sign(body, "evt_crash", NOW_MS / 1000);
  // First delivery: suppression + consent land, then the process "dies"
  // at the event insert (store throws; the route answers 500 and Resend
  // will retry).
  store.crashOnEventInsert = true;
  await assert.rejects(
    () => deliver(store, body, headers),
    /simulated crash/,
  );
  assert.equal(store.suppressions.get("customer@example.com"), "complaint");
  assert.equal(store.consent.length, 1);
  assert.equal(store.events.length, 0); // the event insert never landed
  // Resend retries the identical delivery: the replay completes the
  // missing event insert WITHOUT double-appending consent or clobbering
  // the suppression.
  store.crashOnEventInsert = false;
  const retry = await deliver(store, body, headers);
  assert.equal(retry.status, 200);
  assert.equal((retry.body as { outcome?: string }).outcome, "recorded");
  assert.equal(store.events.length, 1);
  assert.equal(store.consent.length, 1); // still exactly one ledger row
  assert.equal(store.suppressions.size, 1);
  // And a further replay after full success is a clean duplicate no-op.
  const replay = await deliver(store, body, headers);
  assert.equal((replay.body as { outcome?: string }).outcome, "duplicate");
  assert.equal(store.consent.length, 1);
  console.log("[smoke] resend_webhook: crash-window replay completes ledger, never double-appends");
}

async function testIgnoredTypesAndBadBodies(): Promise<void> {
  const store = storeWithSend();
  // Untracked event types are acknowledged and ignored.
  for (const type of ["email.sent", "email.delivery_delayed", "contact.created"]) {
    const body = webhookBody(type, "re_msg_1");
    const result = await deliver(store, body, sign(body, `evt_ig_${type}`, NOW_MS / 1000));
    assert.equal(result.status, 200);
    assert.equal((result.body as { outcome?: string }).outcome, "ignored");
  }
  assert.equal(store.events.length, 0);
  // A validly-signed non-JSON body is a 400, not a crash.
  for (const bad of ["not json {", "[1,2,3]", "null"]) {
    const result = await deliver(store, bad, sign(bad, "evt_bad", NOW_MS / 1000));
    assert.equal(result.status, 400);
  }
  console.log("[smoke] resend_webhook: untracked types ignored, malformed bodies 400");
}

function testVerifyDirect(): void {
  // Sanity on the primitive itself with a known vector shape.
  const body = '{"hello":"world"}';
  const headers = sign(body, "msg_p5jz", 1614265330);
  assert.equal(
    verifyResendSignature({
      secret: SECRET,
      headers,
      payload: body,
      nowMs: 1614265330 * 1000,
    }),
    true,
  );
  // Non-numeric timestamp.
  assert.equal(
    verifyResendSignature({
      secret: SECRET,
      headers: { ...headers, svixTimestamp: "yesterday" },
      payload: body,
      nowMs: 1614265330 * 1000,
    }),
    false,
  );
  // Empty secret material.
  assert.equal(
    verifyResendSignature({
      secret: "whsec_",
      headers,
      payload: body,
      nowMs: 1614265330 * 1000,
    }),
    false,
  );
  console.log("[smoke] resend_webhook: verifyResendSignature primitive edges");
}

async function main(): Promise<void> {
  await testConfigGate();
  await testSignatureRejection();
  await testValidSignatureAccepted();
  await testEachEventTypeLands();
  await testHardBounceSuppresses();
  await testSoftBounceDoesNotSuppress();
  await testComplaintSuppressesAndAppendsConsent();
  await testDuplicateDeliveryIsNoOp();
  await testUnknownMessageId();
  await testCrashWindowReplayCompletesLedger();
  await testIgnoredTypesAndBadBodies();
  testVerifyDirect();
  console.log("[smoke] resend_webhook: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
