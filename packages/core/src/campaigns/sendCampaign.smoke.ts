import assert from "node:assert/strict";

import type { CampaignRow } from "../db/campaignAudience.js";
import type {
  ApprovedCopy,
  CampaignSendStore,
  ClaimedSend,
  CopySnapshot,
  CopySnapshotVariant,
  SendRecipient,
  SendTimeBlock,
} from "../db/campaignSend.js";
import {
  copyForRecipient,
  DEFAULT_SEND_CONFIG,
  deriveDedupeKey,
  resendMailer,
  sendCampaign,
  stepForRun,
  unsubscribeFooter,
  type Mailer,
  type OutboundMessage,
  type SendCampaignDeps,
} from "./sendCampaign.js";
import { copyFromApprovalPayload } from "../db/campaignSend.js";
import { computeSendDiff } from "./sendDiff.js";
import type { SendDiffStore } from "../db/sendDiff.js";
import type { PriorSendRow } from "../db/sendDiff.js";
import { verifyUnsubscribeToken } from "./unsubscribe.js";

/**
 * Offline smoke for campaigns.send (SEA-84). Everything runs against an
 * in-memory CampaignSendStore and a mock mailer (plus a mocked Resend
 * HTTP layer for the real mailer's request shape) -- no Postgres, Redis,
 * or network. The DB layer (dedupe_key unique index, ON CONFLICT claim,
 * copy-snapshot append-only) is the 0011/0018 schema's job, verified
 * against a real Postgres via `npm run migrate` + docker compose per
 * repo convention.
 *
 * Run: npm run smoke:campaignsend  (from packages/core)
 */

const SECRET = "send-smoke-secret";
const BASE_URL = "https://worker.example.com";
const NOW = new Date("2026-08-12T17:00:00Z");

interface SendRow {
  id: string;
  campaignId: string;
  contactId: string;
  email: string;
  step: string;
  dedupeKey: string;
  status: ClaimedSend["status"];
  providerMessageId: string | null;
  sentAt: Date | null;
  error: string | null;
}

/** In-memory CampaignSendStore mirroring the 0011/0018 guards. */
class FakeSendStore implements CampaignSendStore {
  campaign: CampaignRow;
  recipients: SendRecipient[] = [];
  blocks = new Map<string, SendTimeBlock>();
  rows = new Map<string, SendRow>(); // by dedupe_key
  /** by "campaignId:runSeq"; per-segment map mirrors the (run, segment)
   * UNIQUE constraint (first write wins per segment). */
  snapshots = new Map<string, Map<string, CopySnapshotVariant>>();
  approvedCopy: ApprovedCopy | null = null;
  /** Extra already-sent count for the ramp window (other campaigns). */
  priorWindowSent = 0;
  private nextId = 1;

  constructor(campaign: CampaignRow) {
    this.campaign = campaign;
  }
  async getCampaignByKey(key: string): Promise<CampaignRow | null> {
    return this.campaign.key === key ? { ...this.campaign } : null;
  }
  async listSendRecipients(): Promise<SendRecipient[]> {
    return this.recipients;
  }
  async sendTimeBlocks(contactIds: string[]): Promise<Map<string, SendTimeBlock>> {
    const map = new Map<string, SendTimeBlock>();
    for (const id of contactIds) {
      const block = this.blocks.get(id);
      if (block) map.set(id, block);
    }
    return map;
  }
  async claimSend(send: {
    campaignId: string;
    contactId: string;
    email: string;
    step: string;
    dedupeKey: string;
    status: "queued" | "skipped_suppressed";
    detail?: string;
  }): Promise<ClaimedSend> {
    const existing = this.rows.get(send.dedupeKey);
    if (existing) {
      return {
        id: existing.id,
        status: existing.status,
        providerMessageId: existing.providerMessageId,
        inserted: false,
      };
    }
    const row: SendRow = {
      id: String(this.nextId++),
      campaignId: send.campaignId,
      contactId: send.contactId,
      email: send.email,
      step: send.step,
      dedupeKey: send.dedupeKey,
      status: send.status,
      providerMessageId: null,
      sentAt: null,
      error: send.detail ?? null,
    };
    this.rows.set(send.dedupeKey, row);
    return { id: row.id, status: row.status, providerMessageId: null, inserted: true };
  }
  async markSendSent(sendId: string, providerMessageId: string, sentAt: Date) {
    const row = [...this.rows.values()].find((r) => r.id === sendId)!;
    row.status = "sent";
    row.providerMessageId = providerMessageId;
    row.sentAt = sentAt;
  }
  async markSendFailed(sendId: string, error: string) {
    const row = [...this.rows.values()].find((r) => r.id === sendId)!;
    row.status = "failed";
    row.error = error;
  }
  async countSentSince(): Promise<number> {
    return (
      this.priorWindowSent +
      [...this.rows.values()].filter((r) => r.status === "sent").length
    );
  }
  async markCampaignSending(campaignId: string): Promise<string | null> {
    if (this.campaign.id !== campaignId) return null;
    if (!["approved", "sending"].includes(this.campaign.status)) return null;
    this.campaign.status = "sending";
    return "sending";
  }
  async markCampaignSent(campaignId: string): Promise<boolean> {
    if (this.campaign.id !== campaignId || this.campaign.status !== "sending") {
      return false;
    }
    const queued = [...this.rows.values()].some((r) => r.status === "queued");
    if (queued) return false;
    this.campaign.status = "sent";
    return true;
  }
  async insertCopySnapshot(snapshot: {
    campaignId: string;
    runSeq: number;
    variants: CopySnapshotVariant[];
  }): Promise<CopySnapshot> {
    const key = `${snapshot.campaignId}:${snapshot.runSeq}`;
    // First write wins PER (run, segment) (UNIQUE + ON CONFLICT DO NOTHING).
    const set = this.snapshots.get(key) ?? new Map<string, CopySnapshotVariant>();
    for (const variant of snapshot.variants) {
      if (!set.has(variant.segment)) set.set(variant.segment, { ...variant });
    }
    this.snapshots.set(key, set);
    return {
      runSeq: snapshot.runSeq,
      variants: [...set.values()].sort((a, b) =>
        a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0,
      ),
    };
  }
  async getApprovedDraftCopy(): Promise<ApprovedCopy | null> {
    return this.approvedCopy;
  }
}

/** Mock mailer recording every accepted message. */
class FakeMailer implements Mailer {
  sent: Array<{ message: OutboundMessage; idempotencyKey: string }> = [];
  /** email -> permanent-rejection error. */
  rejects = new Map<string, string>();
  /** When set, every send throws (retryable provider trouble). */
  throwAll: string | null = null;

  async sendOne(message: OutboundMessage, idempotencyKey: string) {
    if (this.throwAll) throw new Error(this.throwAll);
    const reject = this.rejects.get(message.to);
    if (reject) return { ok: false as const, error: reject };
    this.sent.push({ message, idempotencyKey });
    return { ok: true as const, id: `re_${this.sent.length}` };
  }
}

function campaignRow(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "42",
    key: "post-first-visit",
    name: "Post first visit follow-up",
    status: "approved",
    audienceView: "v_campaign_post_first_visit",
    runSeq: 1,
    sendAt: null,
    ...overrides,
  };
}

const SUBSCRIBED: SendTimeBlock = { suppressed: false, consentState: "subscribed" };

function recipient(contactId: string, email: string, firstName: string | null = null): SendRecipient {
  return { contactId, email, firstName, segment: "hot_only" };
}

interface Harness {
  store: FakeSendStore;
  mailer: FakeMailer;
  deps: SendCampaignDeps;
}

function harness(options: {
  campaign?: Partial<CampaignRow>;
  config?: Partial<typeof DEFAULT_SEND_CONFIG>;
  mailer?: Mailer | null;
  unsubscribe?: { secret: string; baseUrl: string } | null;
  fromEmail?: string | null;
  replyTo?: string | null;
} = {}): Harness {
  const store = new FakeSendStore(campaignRow(options.campaign));
  store.approvedCopy = {
    subject: "{{first_name}}, your mat misses you",
    body: "Hey {{first_name}},\n\nCome back this week.\n\nSealevel Hot Yoga",
  };
  store.recipients = [
    recipient("7", "maria@example.com", "Maria"),
    recipient("8", "sam@example.com", null),
    recipient("9", "lee@example.com", "Lee"),
  ];
  for (const r of store.recipients) store.blocks.set(r.contactId, { ...SUBSCRIBED });
  const mailer = options.mailer === undefined ? new FakeMailer() : options.mailer;
  const deps: SendCampaignDeps = {
    store,
    mailer,
    fromEmail:
      options.fromEmail === undefined
        ? "Sealevel Hot Yoga <hello@mail.example.com>"
        : options.fromEmail,
    replyTo: options.replyTo ?? null,
    unsubscribe:
      options.unsubscribe === undefined
        ? { secret: SECRET, baseUrl: BASE_URL }
        : options.unsubscribe,
    config: { ...DEFAULT_SEND_CONFIG, sendIntervalMs: 1, ...options.config },
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
  };
  return { store, mailer: mailer as FakeMailer, deps };
}

/* ------------------------------------------------------------------ */

function dedupeKeyShape(): void {
  // Pinned derivation: sha256 over US-joined inputs (0011 point 2). The
  // US delimiter keeps (1,12) and (11,2) distinct.
  const key = deriveDedupeKey("42", "7", "initial");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(
    deriveDedupeKey("1", "12", "initial"),
    deriveDedupeKey("11", "2", "initial"),
  );
  assert.equal(stepForRun(1), "initial");
  assert.equal(stepForRun(3), "initial#3");
  console.log("[smoke] campaigns.send: dedupe_key derivation pinned (US-joined sha256)");
}

async function happyPath(): Promise<void> {
  const { store, mailer, deps } = harness();
  const result = await sendCampaign("post-first-visit", deps);

  assert.equal(result.status, "sent");
  assert.equal(result.sentNow, 3);
  assert.equal(result.failedNow, 0);
  assert.equal(store.campaign.status, "sent"); // approved -> sending -> sent
  assert.equal(store.rows.size, 3);

  // Copy snapshot stored durably BEFORE sending, keyed to the run: the
  // single shape stores one ''-segment variant.
  assert.deepEqual([...store.snapshots.get("42:1")!.values()], [
    {
      segment: "",
      subject: "{{first_name}}, your mat misses you",
      body: "Hey {{first_name}},\n\nCome back this week.\n\nSealevel Hot Yoga",
    },
  ]);

  // Every row: sent, provider id stored (webhook correlation), address
  // snapshotted.
  for (const row of store.rows.values()) {
    assert.equal(row.status, "sent");
    assert.match(row.providerMessageId!, /^re_/);
    assert.equal(row.sentAt, NOW);
  }

  // First message: merge fields rendered, unsubscribe footer + RFC 8058
  // headers with a VALID signed token for (campaign, contact).
  const first = mailer.sent[0]!;
  assert.equal(first.message.to, "maria@example.com");
  assert.equal(first.message.subject, "Maria, your mat misses you");
  assert.match(first.message.text, /Hey Maria,/);
  assert.match(first.message.text, /unsubscribe with one click: https:\/\/worker\.example\.com\/unsubscribe\?token=/);
  const url = new URL(first.message.headers["List-Unsubscribe"]!.slice(1, -1));
  assert.equal(url.pathname, "/unsubscribe");
  assert.deepEqual(verifyUnsubscribeToken(url.searchParams.get("token")!, SECRET), {
    campaignId: "42",
    contactId: "7",
  });
  assert.equal(
    first.message.headers["List-Unsubscribe-Post"],
    "List-Unsubscribe=One-Click",
  );
  // Idempotency key = the row's dedupe_key.
  assert.equal(first.idempotencyKey, deriveDedupeKey("42", "7", "initial"));

  // Missing first name falls back to "friend" (draft contract).
  const second = mailer.sent[1]!;
  assert.equal(second.message.subject, "friend, your mat misses you");
  console.log(
    "[smoke] campaigns.send: happy path (approved -> sending -> sent, copy snapshot, provider ids, unsubscribe link + headers, merge fields)",
  );
}

async function sendTimeRecheck(): Promise<void> {
  const { store, mailer, deps } = harness();
  // Between approval and send: maria unsubscribed (suppression list),
  // sam's latest consent flipped, lee is untouched.
  store.blocks.set("7", { suppressed: true, consentState: "subscribed" });
  store.blocks.set("8", { suppressed: false, consentState: "unsubscribed" });

  const result = await sendCampaign("post-first-visit", deps);
  assert.equal(result.status, "sent");
  assert.equal(result.sentNow, 1);
  assert.equal(result.skippedSuppressedNow, 2);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]!.message.to, "lee@example.com");

  // Recorded outcomes, not silent absences (0011).
  const maria = store.rows.get(deriveDedupeKey("42", "7", "initial"))!;
  assert.equal(maria.status, "skipped_suppressed");
  assert.match(maria.error!, /suppressions list at send time/);
  const sam = store.rows.get(deriveDedupeKey("42", "8", "initial"))!;
  assert.equal(sam.status, "skipped_suppressed");
  assert.match(sam.error!, /'unsubscribed' at send time/);
  assert.equal(store.campaign.status, "sent");
  console.log(
    "[smoke] campaigns.send: suppression/consent re-checked per recipient at send time; drops recorded as skipped_suppressed",
  );
}

async function retryIsDeduped(): Promise<void> {
  const { store, mailer, deps } = harness();
  await sendCampaign("post-first-visit", deps);
  assert.equal(mailer.sent.length, 3);

  // The retried job (same campaign, same run): every dedupe_key already
  // has a terminal row, so NOTHING is re-mailed and no rows are added.
  store.campaign.status = "sending"; // as if the retry raced the flip
  const retry = await sendCampaign("post-first-visit", deps);
  assert.equal(retry.status, "sent");
  assert.equal(retry.sentNow, 0);
  assert.equal(retry.alreadyDone, 3);
  assert.equal(mailer.sent.length, 3); // no second send
  assert.equal(store.rows.size, 3);
  assert.equal(store.campaign.status, "sent");

  // Fully-sent campaign: a stale duplicate job is a logged no-op.
  const dup = await sendCampaign("post-first-visit", deps);
  assert.equal(dup.status, "skipped");
  assert.equal(dup.reason, "already_sent");
  console.log("[smoke] campaigns.send: retried job re-derives keys and double-sends nobody");
}

async function rampLimiting(): Promise<void> {
  const { store, mailer, deps } = harness({ config: { rampPerDay: 2, batchSize: 10 } });
  const result = await sendCampaign("post-first-visit", deps);

  // Budget 2 of 3: the run pauses, remaining recipient untouched, the
  // campaign stays 'sending' (never stamped sent early).
  assert.equal(result.status, "ramp_paused");
  assert.equal(result.sentNow, 2);
  assert.equal(result.remaining, 1);
  assert.equal(result.resumeDelayMs, DEFAULT_SEND_CONFIG.rampRetryMinutes * 60 * 1000);
  assert.equal(mailer.sent.length, 2);
  assert.equal(store.campaign.status, "sending");
  assert.equal(store.rows.size, 2);

  // The resume run (window still full): pauses again immediately.
  const stillFull = await sendCampaign("post-first-visit", deps);
  assert.equal(stillFull.status, "ramp_paused");
  assert.equal(mailer.sent.length, 2);

  // Window decayed (yesterday's sends aged out): the resume finishes the
  // remaining recipient and completes the campaign.
  store.priorWindowSent = -2; // offset the 2 in-window rows (aged out)
  const resumed = await sendCampaign("post-first-visit", deps);
  assert.equal(resumed.status, "sent");
  assert.equal(resumed.sentNow, 1);
  assert.equal(resumed.alreadyDone, 2);
  assert.equal(store.campaign.status, "sent");
  console.log(
    "[smoke] campaigns.send: warmup ramp pauses at the 24h budget and resumes without double-sending",
  );
}

async function rampCountsOtherCampaigns(): Promise<void> {
  // The budget is DOMAIN-global: sends from other campaigns consume it.
  const { store, deps } = harness({ config: { rampPerDay: 10 } });
  store.priorWindowSent = 10;
  const result = await sendCampaign("post-first-visit", deps);
  assert.equal(result.status, "ramp_paused");
  assert.equal(result.sentNow, 0);
  assert.equal(result.remaining, 3);
  console.log("[smoke] campaigns.send: ramp budget is global across campaigns");
}

async function configGates(): Promise<void> {
  // No unsubscribe config: REFUSED, loudly, before any state change.
  {
    const { store, mailer, deps } = harness({ unsubscribe: null });
    const lines: string[] = [];
    deps.log = (line) => lines.push(line);
    const result = await sendCampaign("post-first-visit", deps);
    assert.equal(result.status, "refused");
    assert.equal(result.reason, "unsubscribe_unconfigured");
    assert.equal(store.campaign.status, "approved"); // untouched
    assert.equal(mailer.sent.length, 0);
    assert.equal(store.rows.size, 0);
    assert.match(lines.join("\n"), /REFUSING/);
    assert.match(lines.join("\n"), /CAN-SPAM/);
  }
  // No API key: logged skip, campaign untouched.
  {
    const { store, deps } = harness({ mailer: null });
    const result = await sendCampaign("post-first-visit", deps);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "resend_unconfigured");
    assert.equal(store.campaign.status, "approved");
  }
  // No From address: logged skip.
  {
    const { deps } = harness({ fromEmail: null });
    const result = await sendCampaign("post-first-visit", deps);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "from_unconfigured");
  }
  console.log(
    "[smoke] campaigns.send: config gates (no unsubscribe = refuse; no API key / From = logged skip; campaign left approved)",
  );
}

async function statusGuards(): Promise<void> {
  // Unknown campaign and non-sendable statuses dead-letter loudly.
  const { deps } = harness();
  await assert.rejects(sendCampaign("nope", deps), /no campaign with key/);
  for (const status of ["draft", "pending_approval", "cancelled"]) {
    const h = harness({ campaign: { status } });
    await assert.rejects(
      sendCampaign("post-first-visit", h.deps),
      new RegExp(`is '${status}'`),
    );
    assert.equal(h.mailer.sent.length, 0);
  }
  // Approved campaign with no approved item: state corruption, throws.
  const h2 = harness();
  h2.store.approvedCopy = null;
  await assert.rejects(
    sendCampaign("post-first-visit", h2.deps),
    /no approved campaign_approval item/,
  );
  console.log("[smoke] campaigns.send: refuses unknown/unsendable campaigns and missing approved copy");
}

async function permanentRejectionIsFailedRow(): Promise<void> {
  const { store, mailer, deps } = harness();
  mailer.rejects.set("sam@example.com", "Resend 422: invalid recipient");
  const result = await sendCampaign("post-first-visit", deps);
  assert.equal(result.status, "sent");
  assert.equal(result.sentNow, 2);
  assert.equal(result.failedNow, 1);
  const sam = store.rows.get(deriveDedupeKey("42", "8", "initial"))!;
  assert.equal(sam.status, "failed");
  assert.match(sam.error!, /422/);
  // failed is terminal: no queued rows remain, so the campaign completes
  // and the failure is visible in the report/monitor, not retried blindly.
  assert.equal(store.campaign.status, "sent");

  // A retry does NOT re-mail the failed row (operator investigates).
  const before = mailer.sent.length;
  store.campaign.status = "sending";
  const retry = await sendCampaign("post-first-visit", deps);
  assert.equal(retry.alreadyDone, 3);
  assert.equal(mailer.sent.length, before);
  console.log("[smoke] campaigns.send: permanent provider rejection = failed row, not a run failure");
}

async function retryableProviderTroubleThrows(): Promise<void> {
  const { store, mailer, deps } = harness();
  mailer.throwAll = "Resend 503 (retryable)";
  await assert.rejects(sendCampaign("post-first-visit", deps), /503/);
  // The claimed row stays queued for the BullMQ retry; nothing was
  // recorded as sent or failed.
  const statuses = [...store.rows.values()].map((r) => r.status);
  assert.deepEqual(statuses, ["queued"]);
  assert.equal(store.campaign.status, "sending");
  console.log("[smoke] campaigns.send: retryable provider trouble throws for BullMQ retry, rows stay queued");
}

async function copySnapshotFirstWriteWins(): Promise<void> {
  const { store, mailer, deps } = harness();
  // A prior (crashed) attempt already snapshotted DIFFERENT copy: the
  // retry must render from the stored snapshot -- what already left is
  // what the rest of the run gets.
  store.snapshots.set(
    "42:1",
    new Map([
      [
        "",
        {
          segment: "",
          subject: "The subject that already left",
          body: "The body that already left",
        },
      ],
    ]),
  );
  await sendCampaign("post-first-visit", deps);
  assert.equal(mailer.sent[0]!.message.subject, "The subject that already left");
  assert.equal(
    store.snapshots.get("42:1")!.get("")!.subject,
    "The subject that already left",
  );
  console.log("[smoke] campaigns.send: copy snapshot is first-write-wins and is what renders");
}

async function mockedResendHttp(): Promise<void> {
  // The real mailer against a mocked Resend HTTP layer: request shape,
  // Idempotency-Key, and the retryable/permanent classification.
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let respond: (req: { url: string }) => Response = () =>
    new Response(JSON.stringify({ id: "re_mock_1" }), { status: 200 });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init: init! });
    return respond({ url });
  }) as typeof fetch;

  const mailer = resendMailer("re_test_key", "https://resend.mock", fetchImpl);
  const message: OutboundMessage = {
    from: "Sealevel Hot Yoga <hello@mail.example.com>",
    to: "maria@example.com",
    subject: "Hi",
    text: "Body",
    headers: { "List-Unsubscribe": "<https://x/unsubscribe?token=t>" },
  };

  const ok = await mailer.sendOne(message, "idem-key-1");
  assert.deepEqual(ok, { ok: true, id: "re_mock_1" });
  assert.equal(requests[0]!.url, "https://resend.mock/emails");
  const headers = requests[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer re_test_key");
  assert.equal(headers["Idempotency-Key"], "idem-key-1");
  const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>;
  assert.deepEqual(body.to, ["maria@example.com"]);
  // No replyTo on the message = NO reply_to field in the request at all
  // (not an empty string).
  assert.ok(!("reply_to" in body), "reply_to must be absent when unset");
  assert.equal(
    (body.headers as Record<string, string>)["List-Unsubscribe"],
    "<https://x/unsubscribe?token=t>",
  );

  // replyTo on the message = reply_to in the request, exact value.
  await mailer.sendOne(
    { ...message, replyTo: "hello@sealevelhotyoga.com" },
    "idem-key-1b",
  );
  const withReplyTo = JSON.parse(String(requests[1]!.init.body)) as Record<string, unknown>;
  assert.equal(withReplyTo.reply_to, "hello@sealevelhotyoga.com");

  // 422 = permanent: { ok: false }, never a throw.
  respond = () => new Response("unprocessable", { status: 422 });
  const rejected = await mailer.sendOne(message, "idem-key-2");
  assert.equal(rejected.ok, false);
  assert.match((rejected as { error: string }).error, /422/);

  // 429 / 5xx = retryable: throws for the BullMQ retry.
  respond = () => new Response("slow down", { status: 429 });
  await assert.rejects(mailer.sendOne(message, "idem-key-3"), /429 \(retryable\)/);
  respond = () => new Response("boom", { status: 500 });
  await assert.rejects(mailer.sendOne(message, "idem-key-4"), /500 \(retryable\)/);
  console.log("[smoke] campaigns.send: Resend HTTP mailer (mocked) sends the right shape and classifies failures");
}

/**
 * CAMPAIGN_REPLY_TO end to end: the news subdomain has no inbound mail,
 * so a configured Reply-To routes replies to the monitored studio inbox.
 * Optional and NEVER a gate: unset = no reply_to field in the Resend
 * request at all; malformed = loud warning + omitted, send still fires.
 */
async function replyToEndToEnd(): Promise<void> {
  const REPLY_TO = "hello@sealevelhotyoga.com";

  /** Real resendMailer over a mocked Resend HTTP layer, capturing every
   * request body sendCampaign produces. */
  function httpHarness(replyTo: string | null) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: `re_http_${bodies.length}` }), {
        status: 200,
      });
    }) as typeof fetch;
    const h = harness({
      mailer: resendMailer("re_test_key", "https://resend.mock", fetchImpl),
      replyTo,
    });
    return { ...h, bodies };
  }

  // (a) Configured: every mocked Resend request body carries reply_to
  // with the exact value.
  {
    const { deps, bodies } = httpHarness(REPLY_TO);
    const result = await sendCampaign("post-first-visit", deps);
    assert.equal(result.status, "sent");
    assert.equal(result.sentNow, 3);
    assert.equal(bodies.length, 3);
    for (const body of bodies) assert.equal(body.reply_to, REPLY_TO);
  }

  // (b) Unset: the field is ABSENT from every request (not "").
  {
    const { deps, bodies } = httpHarness(null);
    const result = await sendCampaign("post-first-visit", deps);
    assert.equal(result.status, "sent");
    assert.equal(result.sentNow, 3);
    assert.equal(bodies.length, 3);
    for (const body of bodies) {
      assert.ok(!("reply_to" in body), "reply_to must be absent when unset");
    }
  }

  // (c) Malformed (no '@'): loud warning, reply_to omitted, and the send
  // still succeeds -- a typo'd reply-to must never block a send.
  {
    const { deps, bodies } = httpHarness("not-an-email");
    const lines: string[] = [];
    deps.log = (line) => lines.push(line);
    const result = await sendCampaign("post-first-visit", deps);
    assert.equal(result.status, "sent");
    assert.equal(result.sentNow, 3);
    assert.equal(bodies.length, 3);
    for (const body of bodies) {
      assert.ok(!("reply_to" in body), "malformed reply_to must be omitted");
    }
    const joined = lines.join("\n");
    assert.match(joined, /WARNING/);
    assert.match(joined, /CAMPAIGN_REPLY_TO="not-an-email"/);
  }

  console.log(
    "[smoke] campaigns.send: CAMPAIGN_REPLY_TO (configured = exact reply_to; unset = field absent; malformed = warned + omitted, send unblocked)",
  );
}

async function unsubscribeFooterShape(): Promise<void> {
  const footer = unsubscribeFooter("https://x/unsubscribe?token=t");
  assert.match(footer, /^\n\n/);
  assert.match(footer, /one click/);
  assert.ok(!/[—―⸺⸻]/.test(footer), "no em dashes in outgoing copy");
  console.log("[smoke] campaigns.send: unsubscribe footer shape (plain, one line, no em dashes)");
}

/** copyForRecipient unit coverage: segment match, base fallback,
 * deterministic first-variant fallback, never a throw for a covered
 * set. */
function copySelection(): void {
  const briefed = [
    { segment: "hot_only", subject: "Hot", body: "Hot body" },
    { segment: "lapsed", subject: "Lapsed", body: "Lapsed body" },
  ];
  // 1. Segment match.
  assert.deepEqual(
    copyForRecipient(briefed, recipient("1", "a@x.com", null)),
    { subject: "Hot", body: "Hot body" },
  );
  assert.deepEqual(
    copyForRecipient(briefed, { ...recipient("1", "a@x.com"), segment: "lapsed" }),
    { subject: "Lapsed", body: "Lapsed body" },
  );
  // 2. '' base variant catches unmatched segments (and the single shape).
  const withBase = [
    { segment: "", subject: "Base", body: "Base body" },
    { segment: "hot_only", subject: "Hot", body: "Hot body" },
  ];
  assert.deepEqual(
    copyForRecipient(withBase, { ...recipient("1", "a@x.com"), segment: "unplanned" }),
    { subject: "Base", body: "Base body" },
  );
  // 3. Briefed set without a base: unmatched segment falls back to the
  //    FIRST variant (stored order is segment-ascending = deterministic),
  //    never a dead-letter.
  assert.deepEqual(
    copyForRecipient(briefed, { ...recipient("1", "a@x.com"), segment: "unplanned" }),
    { subject: "Hot", body: "Hot body" },
  );
  // Empty set is a bug and throws.
  assert.throws(() => copyForRecipient([], recipient("1", "a@x.com")));
  console.log(
    "[smoke] campaigns.send: copyForRecipient selects by segment with base/first fallback",
  );
}

/**
 * Briefed campaign end-to-end (the SEA-88 x SEA-84 seam): a variants
 * approval payload -> copyFromApprovalPayload (the shared validator) ->
 * per-segment copy selected per recipient incl. fallback -> per-segment
 * snapshots stored -> the NEXT run's computeSendDiff yields a real
 * per-segment boolean.
 */
async function briefedEndToEnd(): Promise<void> {
  const { store, mailer, deps } = harness();
  // Recipients span two briefed segments plus one segment the brief did
  // not cover (audience drift after planning).
  store.recipients = [
    { ...recipient("7", "maria@example.com", "Maria"), segment: "hot_only" },
    { ...recipient("8", "sam@example.com", null), segment: "lapsed" },
    { ...recipient("9", "lee@example.com", "Lee"), segment: "unplanned" },
  ];
  for (const r of store.recipients) store.blocks.set(r.contactId, { ...SUBSCRIBED });

  // The approved copy comes out of a REAL variants payload through the
  // SHARED validator (campaignApprovalOf), exactly as the send path
  // reads it back from the item -- the blocker this reconciliation
  // fixes: a briefed payload has NO top-level draft_subject/draft_body.
  const variantsPayload: Record<string, unknown> = {
    campaign_id: "42",
    campaign_key: "post-first-visit",
    campaign_name: "Post first visit follow-up",
    run_seq: 1,
    audience_view: "v_campaign_post_first_visit",
    audience: { recipients: 3, segments: { hot_only: 1, lapsed: 1, unplanned: 1 }, snapshot_at: "2026-08-12T00:00:00.000Z" },
    exclusions: {
      view_rows: 3,
      counts: { unmappable: 0, ambiguous: 0, no_email: 0, unsubscribed: 0, suppressed: 0 },
      samples: [],
      built_at: "2026-08-12T00:00:00.000Z",
      summary: "3 qualified",
    },
    variants: [
      {
        segment: "hot_only",
        recipient_count: 1,
        draft_subject: "{{first_name}}, hot room news",
        draft_body: "Hot body {{first_name}}",
        rendered_preview: {
          recipient: { contact_id: "7", email: "maria@example.com", first_name: "Maria", segment: "hot_only" },
          subject: "Maria, hot room news",
          body: "Hot body Maria",
        },
      },
      {
        segment: "lapsed",
        recipient_count: 1,
        draft_subject: "Come back, {{first_name}}",
        draft_body: "Lapsed body {{first_name}}",
        rendered_preview: {
          recipient: { contact_id: "8", email: "sam@example.com", first_name: null, segment: "lapsed" },
          subject: "Come back, friend",
          body: "Lapsed body friend",
        },
      },
    ],
    send_diff: null,
    rationale: "per-segment",
    generated_by: { commit: "smoke", at: "2026-08-12T00:00:00.000Z" },
  };
  const approved = copyFromApprovalPayload(variantsPayload);
  assert.ok(approved, "the shared validator must accept a briefed payload");
  assert.ok("variants" in approved!);
  store.approvedCopy = approved;

  const result = await sendCampaign("post-first-visit", deps);
  assert.equal(result.status, "sent");
  assert.equal(result.sentNow, 3);
  assert.equal(store.campaign.status, "sent");

  // Per-segment copy actually selected (merge fields rendered).
  const bySender = new Map(mailer.sent.map((m) => [m.message.to, m.message]));
  assert.equal(bySender.get("maria@example.com")!.subject, "Maria, hot room news");
  assert.equal(bySender.get("sam@example.com")!.subject, "Come back, friend");
  // Unplanned segment: deterministic first-variant fallback (segment-
  // ascending order = hot_only), NOT a dead-letter.
  assert.equal(bySender.get("lee@example.com")!.subject, "Lee, hot room news");

  // Per-segment snapshots stored, one row per variant.
  const stored = store.snapshots.get("42:1")!;
  assert.deepEqual([...stored.keys()].sort(), ["hot_only", "lapsed"]);
  assert.equal(stored.get("lapsed")!.body, "Lapsed body {{first_name}}");

  // The NEXT run's computeSendDiff compares against this stored set and
  // yields a REAL boolean.
  const diffStore: SendDiffStore = {
    getCampaignByKey: async () => ({ ...store.campaign, runSeq: 2, status: "pending_approval" }),
    listCampaignSendRows: async (): Promise<PriorSendRow[]> =>
      [...store.rows.values()].map((r) => ({
        email: r.email,
        status: r.status,
        sentAt: r.sentAt,
      })),
    listAudienceEmails: async () => store.recipients.map((r) => r.email),
    getLatestCopySnapshot: async () => ({
      runSeq: 1,
      variants: [...stored.values()].sort((a, b) =>
        a.segment < b.segment ? -1 : 1,
      ),
    }),
    // Run 2's draft edits ONE segment's copy.
    getDraftCopy: async () => ({
      variants: [
        { segment: "hot_only", subject: "{{first_name}}, hot room news", body: "Hot body {{first_name}}" },
        { segment: "lapsed", subject: "NEW lapsed subject", body: "Lapsed body {{first_name}}" },
      ],
    }),
  };
  const diff = await computeSendDiff("post-first-visit", { store: diffStore });
  assert.ok(diff);
  assert.equal(diff.copyChanged, true);
  assert.match(diff.copySummary, /edited: lapsed/);
  assert.match(diff.summary, /copy: CHANGED/);

  console.log(
    "[smoke] campaigns.send: briefed end-to-end (shared-validator readback, per-segment selection + fallback, per-segment snapshots, next-run diff is a real boolean)",
  );
}

async function main(): Promise<void> {
  dedupeKeyShape();
  copySelection();
  await briefedEndToEnd();
  await happyPath();
  await sendTimeRecheck();
  await retryIsDeduped();
  await rampLimiting();
  await rampCountsOtherCampaigns();
  await configGates();
  await statusGuards();
  await permanentRejectionIsFailedRow();
  await retryableProviderTroubleThrows();
  await copySnapshotFirstWriteWins();
  await mockedResendHttp();
  await replyToEndToEnd();
  await unsubscribeFooterShape();
  console.log("[smoke] campaigns.send: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
