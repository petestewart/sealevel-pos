import assert from "node:assert/strict";

import {
  generateUnsubscribeToken,
  processUnsubscribe,
  unsubscribeUrl,
  verifyUnsubscribeToken,
  type UnsubscribeStore,
} from "./unsubscribe.js";

/**
 * Offline smoke for the one-click unsubscribe endpoint (SEA-84).
 * Everything runs against an in-memory fake store: no Postgres or HTTP
 * server is touched. The DB layer itself (suppressions ON CONFLICT,
 * consent WHERE NOT EXISTS, campaign_sends fallback read) runs against
 * the real schema via local `npm run migrate` + docker compose, per repo
 * convention.
 *
 * Run: npm run smoke:unsubscribe  (from packages/core)
 */

const SECRET = "unsubscribe-smoke-secret";

/** In-memory UnsubscribeStore recording every mutation for assertions. */
class FakeStore implements UnsubscribeStore {
  recipients = new Map<string, { contactId: string; email: string }>(); // "campaign:contact"
  suppressions = new Map<string, string>(); // email -> first reason
  consent: Array<{
    contactId: string;
    email: string;
    state: string;
    source: string;
    detail: string;
  }> = [];

  async findUnsubscribeRecipient(campaignId: string, contactId: string) {
    return this.recipients.get(`${campaignId}:${contactId}`) ?? null;
  }
  async upsertSuppression(email: string, reason: "unsubscribe") {
    // Mirrors ON CONFLICT DO NOTHING: the first reason is the audit answer.
    if (!this.suppressions.has(email)) this.suppressions.set(email, reason);
  }
  async appendConsentEventOnce(event: {
    contactId: string;
    email: string;
    state: "unsubscribed";
    source: "unsubscribe_link";
    detail: string;
  }) {
    // Mirrors the WHERE NOT EXISTS guard on (contact_id, source, detail).
    const exists = this.consent.some(
      (e) =>
        e.contactId === event.contactId &&
        e.source === event.source &&
        e.detail === event.detail,
    );
    if (exists) return false;
    this.consent.push({ ...event });
    return true;
  }
}

function fixture(): FakeStore {
  const store = new FakeStore();
  store.recipients.set("42:7", { contactId: "7", email: "maria@example.com" });
  return store;
}

function tokenRoundTrip(): void {
  const token = generateUnsubscribeToken("42", "7", SECRET);
  assert.deepEqual(verifyUnsubscribeToken(token, SECRET), {
    campaignId: "42",
    contactId: "7",
  });

  // Tampered in every load-bearing way: flipped ids, truncated or
  // padded signature, wrong secret, garbage. All null, never a throw.
  assert.equal(verifyUnsubscribeToken(token.replace("42.7", "42.8"), SECRET), null);
  assert.equal(verifyUnsubscribeToken(token.slice(0, -2), SECRET), null);
  assert.equal(verifyUnsubscribeToken(`${token}xx`, SECRET), null);
  assert.equal(verifyUnsubscribeToken(token, "other-secret"), null);
  assert.equal(verifyUnsubscribeToken("", SECRET), null);
  assert.equal(verifyUnsubscribeToken("a.b.c", SECRET), null);
  assert.equal(verifyUnsubscribeToken("42.7", SECRET), null);

  // The injective-encoding regression the 0011 dedupe key documents:
  // (campaign 1, contact 12) and (campaign 11, contact 2) must not sign
  // identically.
  assert.notEqual(
    generateUnsubscribeToken("1", "12", SECRET).split(".")[2],
    generateUnsubscribeToken("11", "2", SECRET).split(".")[2],
  );

  // Non-numeric ids never mint a token (nothing enumerable or injectable).
  assert.throws(() => generateUnsubscribeToken("42; DROP", "7", SECRET));

  const url = unsubscribeUrl("https://worker.example.com/", "42", "7", SECRET);
  assert.match(url, /^https:\/\/worker\.example\.com\/unsubscribe\?token=42\.7\./);
  console.log("[smoke] unsubscribe: token round-trip (valid / tampered / injective)");
}

async function validClickWritesBoth(): Promise<void> {
  const store = fixture();
  const token = generateUnsubscribeToken("42", "7", SECRET);

  const get = await processUnsubscribe(
    { method: "GET", token },
    { store, secret: SECRET, log: () => {} },
  );
  assert.equal(get.status, 200);
  assert.equal(get.contentType, "html");
  assert.match(get.body, /unsubscribed/i);
  assert.equal(store.suppressions.get("maria@example.com"), "unsubscribe");
  assert.equal(store.consent.length, 1);
  assert.equal(store.consent[0]!.state, "unsubscribed");
  assert.equal(store.consent[0]!.source, "unsubscribe_link");
  assert.match(store.consent[0]!.detail, /campaign 42, contact 7/);
  console.log("[smoke] unsubscribe: one GET click writes suppression + consent");
}

async function replayIsIdempotent(): Promise<void> {
  const store = fixture();
  const token = generateUnsubscribeToken("42", "7", SECRET);
  const deps = { store, secret: SECRET, log: () => {} };

  await processUnsubscribe({ method: "GET", token }, deps);
  // Replays: scanner prefetch (GET), double click (GET), provider
  // one-click (POST). All succeed; no double writes.
  const replayGet = await processUnsubscribe({ method: "GET", token }, deps);
  const replayPost = await processUnsubscribe({ method: "POST", token }, deps);
  assert.equal(replayGet.status, 200);
  assert.equal(replayPost.status, 200);
  assert.equal(replayPost.contentType, "json");
  assert.equal(store.suppressions.size, 1);
  assert.equal(store.consent.length, 1);
  console.log("[smoke] unsubscribe: replayed clicks (GET + RFC 8058 POST) stay idempotent");
}

async function postOneClick(): Promise<void> {
  const store = fixture();
  const token = generateUnsubscribeToken("42", "7", SECRET);
  const response = await processUnsubscribe(
    { method: "POST", token },
    { store, secret: SECRET, log: () => {} },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.equal(store.suppressions.has("maria@example.com"), true);
  assert.equal(store.consent.length, 1);
  console.log("[smoke] unsubscribe: RFC 8058 one-click POST performs the writes");
}

async function badTokensAre404(): Promise<void> {
  const store = fixture();
  const deps = { store, secret: SECRET, log: () => {} };
  const token = generateUnsubscribeToken("42", "7", SECRET);

  for (const bad of [
    undefined,
    "",
    "garbage",
    token.slice(0, -3),
    generateUnsubscribeToken("42", "7", "wrong-secret"),
  ]) {
    const response = await processUnsubscribe({ method: "GET", token: bad }, deps);
    assert.equal(response.status, 404, `token ${String(bad)} must 404`);
  }
  // A validly signed token naming an unknown recipient: 404, no writes.
  const unknown = await processUnsubscribe(
    { method: "GET", token: generateUnsubscribeToken("42", "999", SECRET) },
    deps,
  );
  assert.equal(unknown.status, 404);
  assert.equal(store.suppressions.size, 0);
  assert.equal(store.consent.length, 0);
  console.log("[smoke] unsubscribe: tampered/unknown tokens 404 with zero writes");
}

async function configGate(): Promise<void> {
  const store = fixture();
  const token = generateUnsubscribeToken("42", "7", SECRET);
  const response = await processUnsubscribe(
    { method: "GET", token },
    { store, secret: null, log: () => {} },
  );
  assert.equal(response.status, 404);
  assert.equal(store.suppressions.size, 0);
  assert.equal(store.consent.length, 0);
  console.log("[smoke] unsubscribe: secret unset = endpoint answers 404 (disabled)");
}

async function main(): Promise<void> {
  tokenRoundTrip();
  await validClickWritesBoth();
  await replayIsIdempotent();
  await postOneClick();
  await badTokensAre404();
  await configGate();
  console.log("[smoke] unsubscribe: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
