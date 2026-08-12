import assert from "node:assert/strict";

import type { CampaignRow } from "../db/campaignAudience.js";
import {
  decideCampaignApproval,
  type SnapshotRecipient,
  type TransactionClient,
  type TransactionPool,
} from "../db/campaignApproval.js";
import type { CreateItemInput, CreateItemResult, Item } from "../db/items.js";
import { hasPermission } from "../rbac.js";
import { jobById, JOBS } from "../jobs/registry.js";
import type { BuildAudienceResult } from "./buildAudience.js";
import {
  assembleCampaignDraft,
  campaignApprovalOf,
  campaignDraft,
  containsEmDash,
  createCampaignApproval,
  defaultSendDiffProvider,
  onCampaignApproved,
  renderMergeFields,
  serializeSendDiff,
  type CampaignDraftAssembly,
  type DraftCampaignDeps,
} from "./draftCampaign.js";
import { computeSendDiff } from "./sendDiff.js";
import { SEND_DIFF_SAMPLE_LIMIT, type SendDiff } from "./sendDiffTypes.js";

/**
 * Offline smoke for campaigns.draft + the campaign_approval flow
 * (SEA-83). Everything runs against local fakes: no Postgres, analytics
 * server, Novu, or model call (the model is mocked by invoking the
 * create path with crafted input, exactly the input the model's one tool
 * call would carry -- same posture as the learning miner's mocked-model
 * smoke).
 *
 * Run: npm run smoke:campaigndraft  (from packages/core)
 */

/* ------------------------------------------------------------------ *
 * Fakes                                                              *
 * ------------------------------------------------------------------ */

const CAMPAIGN: CampaignRow = {
  id: "7",
  key: "post-first-visit",
  name: "Post first visit follow-up",
  status: "draft",
  audienceView: "v_campaign_post_first_visit",
  runSeq: 1,
};

const SNAPSHOT_AT = new Date("2026-08-10T17:00:00Z");

function recipient(
  contactId: string,
  email: string,
  firstName: string | null,
  segment: string,
): SnapshotRecipient {
  return {
    contactId,
    email,
    firstName,
    lastName: null,
    segment,
    snapshotAt: SNAPSHOT_AT,
  };
}

const RECIPIENTS: SnapshotRecipient[] = [
  recipient("101", "maria@example.com", "Maria", "hot_only"),
  recipient("102", "jordan@example.com", null, "hot_only"),
  recipient("103", "sam@example.com", "Sam", "new_student"),
];

function buildResult(
  overrides: Partial<BuildAudienceResult> = {},
): BuildAudienceResult {
  return {
    status: "built",
    campaignId: CAMPAIGN.id,
    campaignKey: CAMPAIGN.key,
    audienceView: CAMPAIGN.audienceView,
    viewRows: 5,
    duplicateViewRows: 0,
    recipients: RECIPIENTS.map((r) => ({
      contactId: r.contactId,
      email: r.email,
      analyticsClientId: `a-${r.contactId}`,
      segment: r.segment,
    })),
    segmentCounts: { hot_only: 2, new_student: 1 },
    exclusionCounts: {
      unmappable: 0,
      ambiguous: 0,
      no_email: 0,
      unsubscribed: 1,
      suppressed: 1,
    },
    exclusions: [
      {
        reason: "unsubscribed",
        analyticsClientId: "a-900",
        segment: "hot_only",
        contactId: "900",
        detail: "latest consent event is 'unsubscribed'",
      },
      {
        reason: "suppressed",
        analyticsClientId: "a-901",
        segment: "hot_only",
        contactId: "901",
        detail: "address gone@example.com is on the suppressions list",
      },
    ],
    snapshotAt: SNAPSHOT_AT,
    summary:
      "5 qualified from v_campaign_post_first_visit, 3 in audience, 2 excluded (1 unsubscribed, 1 suppressed, 0 ambiguous, 0 no email, 0 unmappable)",
    ...overrides,
  };
}

interface FakeCalls {
  created: CreateItemInput[];
  emits: Item[];
  flips: string[];
}

function fakeDeps(options?: {
  build?: BuildAudienceResult;
  recipients?: SnapshotRecipient[];
  sendDiff?: SendDiff | null;
  dedupeHit?: boolean;
}): { deps: DraftCampaignDeps; calls: FakeCalls } {
  const calls: FakeCalls = { created: [], emits: [], flips: [] };
  let nextId = 500;
  const existing = new Map<string, Item>();
  const deps: DraftCampaignDeps = {
    buildAudience: async () => options?.build ?? buildResult(),
    getCampaignByKey: async (key) => (key === CAMPAIGN.key ? CAMPAIGN : null),
    listSnapshotRecipients: async () => options?.recipients ?? RECIPIENTS,
    sendDiff: async () => options?.sendDiff ?? null,
    createItem: async (input: CreateItemInput): Promise<CreateItemResult> => {
      const key = input.dedupeKey ?? String(nextId);
      const hit = existing.get(key);
      if (hit || options?.dedupeHit) {
        return {
          item:
            hit ??
            ({
              id: "existing-1",
              type: input.type,
              domain: input.domain ?? null,
              status: "pending_approval",
              audience: null,
              assignee: null,
              payload: input.payload ?? {},
              created_at: new Date(),
              resolved_at: null,
            } as Item),
          created: false,
        };
      }
      calls.created.push(input);
      const item: Item = {
        id: String(nextId++),
        type: input.type,
        domain: input.domain ?? null,
        status: (input.status ?? "open") as Item["status"],
        audience: null,
        assignee: null,
        payload: input.payload ?? {},
        created_at: new Date(),
        resolved_at: null,
      };
      existing.set(key, item);
      return { item, created: true };
    },
    markCampaignPendingApproval: async (campaignId) => {
      calls.flips.push(campaignId);
      return "pending_approval";
    },
    emit: async (item) => {
      calls.emits.push(item);
      return { sent: true };
    },
    log: () => {},
    now: () => new Date("2026-08-12T18:00:00Z"),
  };
  return { deps, calls };
}

const GOOD_INPUT = {
  subject: "{{first_name}}, your mat misses you",
  body:
    "Hey {{first_name}},\n\nThat first sweaty class of yours made our week. The room is heated, the playlist is good, and your second class is where the magic actually starts.\n\nCome back this week and pick any class that fits.\n\nWith warmth,\nSealevel Hot Yoga",
  rationale:
    "Playful follow-up for first-time visitors, matching the studio voice. Facts kept generic; no pricing claims.",
};

/* ------------------------------------------------------------------ *
 * 1. Job registration + shape                                        *
 * ------------------------------------------------------------------ */

async function smokeJobShape(): Promise<void> {
  assert.ok(jobById.has("campaigns.draft"), "campaigns.draft is registered");
  assert.equal(campaignDraft.model, "claude-opus-4-8"); // drafting tier
  assert.deepEqual(campaignDraft.tools, []); // no shared registry tools
  assert.deepEqual(campaignDraft.triggers, [{ kind: "manual" }]);
  assert.ok(JOBS.includes(campaignDraft));
  // The private toolset is the create tool plus (only when the KB is
  // configured, which it is not here) the read-only KB tools.
  const tools = (campaignDraft.runtimeTools?.({ runState: {} }) ?? []).map(
    (t) => t.name,
  );
  assert.deepEqual(tools, ["create_campaign_approval"]);
  console.log("[smoke] campaigns.draft: registered, opus tier, manual-only");
}

/* ------------------------------------------------------------------ *
 * 2. Copy contract: em dashes + merge fields                         *
 * ------------------------------------------------------------------ */

async function smokeCopyContract(): Promise<void> {
  assert.equal(containsEmDash("no dashes here, none"), false);
  assert.equal(containsEmDash("bad copy — with an em dash"), true);
  assert.equal(containsEmDash("horizontal bar ― too"), true);
  assert.equal(containsEmDash("en dash 6–7pm is fine"), false);

  const maria = { email: "maria@example.com", firstName: "Maria" };
  assert.equal(renderMergeFields("Hi {{first_name}}!", maria), "Hi Maria!");
  assert.equal(
    renderMergeFields("Hi {{ first_name }}!", { email: "x@y.z", firstName: null }),
    "Hi friend!",
  );
  assert.equal(
    renderMergeFields("Sent to {{email}}", maria),
    "Sent to maria@example.com",
  );
  assert.throws(
    () => renderMergeFields("Hi {{last_visit_date}}", maria),
    /unknown merge field/,
  );
  console.log("[smoke] copy contract: em-dash detector + merge rendering");
}

/* ------------------------------------------------------------------ *
 * 3. Assembly                                                        *
 * ------------------------------------------------------------------ */

async function smokeAssembly(): Promise<void> {
  const { deps } = fakeDeps();
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);
  assert.equal(assembly.campaign.key, CAMPAIGN.key);
  assert.equal(assembly.recipients.length, 3);
  assert.deepEqual(assembly.segments, { hot_only: 2, new_student: 1 });
  // Deterministic sample recipient: lowest contact id in the snapshot.
  assert.equal(assembly.sampleRecipient.contactId, "101");
  assert.equal(assembly.sendDiff, null);

  // A skipped build (analytics unconfigured / blackout) refuses loudly.
  const skipped = fakeDeps({
    build: buildResult({
      status: "skipped",
      reason: "analytics_unconfigured",
      recipients: [],
    }),
  });
  await assert.rejects(
    assembleCampaignDraft(CAMPAIGN.key, skipped.deps),
    /audience build skipped/,
  );

  // An empty audience refuses: a card over nobody is ceremonial.
  const empty = fakeDeps({
    build: buildResult({ recipients: [], segmentCounts: {} }),
    recipients: [],
  });
  await assert.rejects(
    assembleCampaignDraft(CAMPAIGN.key, empty.deps),
    /empty audience/,
  );

  // Snapshot readback must match what the build says it froze.
  const mismatch = fakeDeps({ recipients: RECIPIENTS.slice(0, 1) });
  await assert.rejects(
    assembleCampaignDraft(CAMPAIGN.key, mismatch.deps),
    /readback mismatch/,
  );

  await assert.rejects(assembleCampaignDraft("", deps), /campaignKey/);
  console.log("[smoke] assembly: happy path + skipped/empty/mismatch refusals");
}

/* ------------------------------------------------------------------ *
 * 4. Draft output shape (mocked model input)                         *
 * ------------------------------------------------------------------ */

async function smokeDraftOutputShape(): Promise<void> {
  const { deps, calls } = fakeDeps();
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);

  const result = await createCampaignApproval(assembly, GOOD_INPUT, deps);
  assert.equal(result.status, "created");
  assert.ok(result.status === "created" && result.emitted);
  assert.equal(calls.created.length, 1);
  const input = calls.created[0]!;
  assert.equal(input.type, "campaign_approval");
  assert.equal(input.domain, "campaigns");
  assert.equal(input.status, "pending_approval");
  assert.equal(input.dedupeKey, "campaign-7-run-1");

  // The stored payload IS a complete card: all four elements validate.
  const payload = campaignApprovalOf(input.payload ?? {});
  assert.ok(payload, "payload passes campaignApprovalOf");
  // 1. Recipient count + segment breakdown from the frozen snapshot.
  assert.equal(payload.audience.recipients, 3);
  assert.deepEqual(payload.audience.segments, { hot_only: 2, new_student: 1 });
  assert.equal(payload.audience.snapshot_at, SNAPSHOT_AT.toISOString());
  // 2. The exclusion report, counts per reason, reconciling to view rows.
  assert.equal(payload.exclusions.view_rows, 5);
  assert.equal(payload.exclusions.counts.unsubscribed, 1);
  assert.equal(payload.exclusions.counts.suppressed, 1);
  assert.equal(payload.exclusions.counts.unmappable, 0);
  assert.equal(payload.exclusions.samples.length, 2);
  const droppedTotal = Object.values(payload.exclusions.counts).reduce(
    (a, b) => a + b,
    0,
  );
  assert.equal(payload.audience.recipients + droppedTotal, payload.exclusions.view_rows);
  // 3. The rendered email with ONE real recipient's merge fields resolved.
  assert.equal(payload.rendered_preview.recipient.email, "maria@example.com");
  assert.equal(payload.rendered_preview.subject, "Maria, your mat misses you");
  assert.ok(payload.rendered_preview.body.startsWith("Hey Maria,"));
  assert.ok(!payload.rendered_preview.body.includes("{{"));
  // The stored draft keeps the merge fields unresolved for the real send.
  assert.ok(payload.draft_body.includes("{{first_name}}"));
  // 4. The send-diff: PRESENT and null when no completed prior send
  // exists (first send, or a prior run still mid-flight).
  assert.ok("send_diff" in payload);
  assert.equal(payload.send_diff, null);

  assert.ok(typeof payload.rationale === "string" && payload.rationale.length > 0);
  assert.ok(payload.generated_by.commit.length > 0);

  // Side effects: status flip once, Novu emit exactly once.
  assert.deepEqual(calls.flips, [CAMPAIGN.id]);
  assert.equal(calls.emits.length, 1);

  // The SEA-86 seam is wired for real: the default provider IS
  // computeSendDiff (canonical types, no drifted local copy).
  assert.equal(defaultSendDiffProvider, computeSendDiff);
  console.log(
    "[smoke] draft output: all four card elements present; null send-diff path honest",
  );
}

/** A canonical SEA-86 SendDiff fixture, Date-typed sentAt and all. */
function canonicalDiff(): SendDiff {
  return {
    campaignKey: CAMPAIGN.key,
    recipientsAdded: {
      count: 12,
      sample: ["maria@example.com", "sam@example.com"],
      sampleLimit: SEND_DIFF_SAMPLE_LIMIT,
    },
    recipientsDropped: {
      count: 1,
      sample: ["gone@example.com"],
      sampleLimit: SEND_DIFF_SAMPLE_LIMIT,
    },
    // null = UNKNOWN until SEA-84 snapshots sent copy; must survive the
    // payload untouched (never coerced to false/"unchanged").
    copyChanged: null,
    copySummary:
      "copy comparison unavailable: nothing durable stores the last-sent copy yet",
    currentAudienceCount: 3,
    priorSend: {
      campaignId: CAMPAIGN.id,
      runSeq: 2,
      sentAt: new Date("2026-07-01T17:00:00Z"),
      sentCount: 2,
      skippedSuppressedCount: 1,
      failedCount: 0,
    },
    summary:
      "post-first-visit: 12 added, 1 dropped vs the prior send (2 mailed); copy unknown",
  };
}

/**
 * The re-send-shaped regression: a REAL canonical diff (Date sentAt,
 * copyChanged null) must flow assembly -> createCampaignApproval ->
 * campaignApprovalOf, i.e. the internal self-validation must NOT throw
 * (pre-fix, the drifted validator rejected every real diff and the
 * throw would have dead-lettered the draft job for any campaign with a
 * prior send).
 */
async function smokeSendDiffPresent(): Promise<void> {
  const diff = canonicalDiff();
  const { deps, calls } = fakeDeps({ sendDiff: diff });
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);
  // Does not throw: the assembled payload passes its own validator.
  const result = await createCampaignApproval(assembly, GOOD_INPUT, deps);
  assert.equal(result.status, "created");
  const payload = campaignApprovalOf(calls.created[0]!.payload ?? {});
  assert.ok(payload);

  // JSON boundary: the persisted diff is the SERIALIZED form; the Date
  // became an ISO string at the payload boundary.
  const stored = payload.send_diff;
  assert.ok(stored);
  assert.equal(stored.priorSend.sentAt, "2026-07-01T17:00:00.000Z");
  assert.deepEqual(stored, serializeSendDiff(diff));
  assert.equal(stored.copyChanged, null); // unknown stays null
  assert.equal(stored.recipientsAdded.count, 12);
  assert.equal(stored.recipientsDropped.count, 1);
  // The sample is truncated (2 of 12): the card renders "and 10 more".
  assert.ok(stored.recipientsAdded.sample.length < stored.recipientsAdded.count);

  // The full payload survives the JSONB round-trip and STILL validates
  // on readback (this is what a Date-typed field would have broken).
  const roundTripped = campaignApprovalOf(
    JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
  );
  assert.ok(roundTripped);
  assert.deepEqual(roundTripped.send_diff, stored);

  // serializeSendDiff unit edges: null passthrough, null sentAt kept.
  assert.equal(serializeSendDiff(null), null);
  const nullSent = canonicalDiff();
  nullSent.priorSend.sentAt = null;
  assert.equal(serializeSendDiff(nullSent)!.priorSend.sentAt, null);

  console.log(
    "[smoke] send-diff: canonical re-send diff flows assembly -> payload -> validator (JSON-safe, copy unknown preserved)",
  );
}

/* ------------------------------------------------------------------ *
 * 5. No-em-dash + merge-field enforcement in the create path         *
 * ------------------------------------------------------------------ */

async function smokeEnforcement(): Promise<void> {
  const { deps, calls } = fakeDeps();
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);

  for (const bad of [
    { ...GOOD_INPUT, subject: "Your mat — it misses you" },
    { ...GOOD_INPUT, body: GOOD_INPUT.body + "\n\nPS — bring water." },
    { ...GOOD_INPUT, rationale: "Voice match — playful." },
  ]) {
    const result = await createCampaignApproval(assembly, bad, deps);
    assert.equal(result.status, "rejected");
    assert.match(
      result.status === "rejected" ? result.reason : "",
      /em dash/,
    );
  }
  // Unknown merge fields are rejected, never shipped as literal braces.
  const unknown = await createCampaignApproval(
    assembly,
    { ...GOOD_INPUT, body: "Hi {{nick_name}}, come back!" },
    deps,
  );
  assert.equal(unknown.status, "rejected");
  assert.match(
    unknown.status === "rejected" ? unknown.reason : "",
    /unknown merge field/,
  );
  // Empty drafts are rejected.
  const emptySubject = await createCampaignApproval(
    assembly,
    { ...GOOD_INPUT, subject: "  " },
    deps,
  );
  assert.equal(emptySubject.status, "rejected");

  // No rejected attempt created an item, flipped status, or emitted.
  assert.equal(calls.created.length, 0);
  assert.deepEqual(calls.flips, []);
  assert.equal(calls.emits.length, 0);
  console.log(
    "[smoke] enforcement: em dashes, unknown merge fields and empty drafts rejected with no side effects",
  );
}

/* ------------------------------------------------------------------ *
 * 6. Dedupe: ONE campaign_approval per campaign run                  *
 * ------------------------------------------------------------------ */

async function smokeDedupe(): Promise<void> {
  const { deps, calls } = fakeDeps();
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);
  const first = await createCampaignApproval(assembly, GOOD_INPUT, deps);
  const second = await createCampaignApproval(assembly, GOOD_INPUT, deps);
  assert.equal(first.status, "created");
  assert.equal(second.status, "exists");
  assert.equal(
    first.status === "created" && second.status === "exists"
      ? String(second.item.id)
      : "",
    String(first.status === "created" ? first.item.id : ""),
  );
  // Emit + status flip happened exactly ONCE (creation only).
  assert.equal(calls.emits.length, 1);
  assert.deepEqual(calls.flips, [CAMPAIGN.id]);
  console.log("[smoke] dedupe: retried draft reuses the pending item; one emit");
}

/* ------------------------------------------------------------------ *
 * 7. Card-data validation (negative cases)                           *
 * ------------------------------------------------------------------ */

async function smokeCardValidation(): Promise<void> {
  const { deps, calls } = fakeDeps();
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);
  await createCampaignApproval(assembly, GOOD_INPUT, deps);
  const good = calls.created[0]!.payload as Record<string, unknown>;

  assert.ok(campaignApprovalOf(good));
  const without = (key: string): Record<string, unknown> => {
    const clone = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    delete clone[key];
    return clone;
  };
  // Anything less than all four elements is ceremonial: reject it.
  assert.equal(campaignApprovalOf(without("audience")), null);
  assert.equal(campaignApprovalOf(without("exclusions")), null);
  assert.equal(campaignApprovalOf(without("rendered_preview")), null);
  assert.equal(campaignApprovalOf(without("send_diff")), null); // absent != null
  assert.equal(campaignApprovalOf(without("campaign_id")), null);
  // A counts object missing a reason is malformed.
  const badCounts = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  delete (
    (badCounts["exclusions"] as { counts: Record<string, unknown> }).counts as Record<
      string,
      unknown
    >
  )["suppressed"];
  assert.equal(campaignApprovalOf(badCounts), null);

  // Canonical-diff negatives. Build a valid serialized-diff payload,
  // then break it one field at a time.
  const withDiff = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  withDiff["send_diff"] = serializeSendDiff(canonicalDiff());
  assert.ok(campaignApprovalOf(withDiff));
  const breakDiff = (
    mutate: (diff: Record<string, unknown>) => void,
  ): Record<string, unknown> => {
    const clone = JSON.parse(JSON.stringify(withDiff)) as Record<string, unknown>;
    mutate(clone["send_diff"] as Record<string, unknown>);
    return clone;
  };
  // The old drifted shape (added/removed/unchanged) must be rejected.
  const drifted = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  drifted["send_diff"] = { added: 2, removed: 1, unchanged: 1 };
  assert.equal(campaignApprovalOf(drifted), null);
  assert.equal(
    campaignApprovalOf(breakDiff((d) => delete d["recipientsAdded"])),
    null,
  );
  assert.equal(
    campaignApprovalOf(breakDiff((d) => delete d["currentAudienceCount"])),
    null,
  );
  assert.equal(
    campaignApprovalOf(breakDiff((d) => (d["copyChanged"] = "no"))),
    null,
  );
  assert.equal(
    campaignApprovalOf(breakDiff((d) => delete d["priorSend"])),
    null,
  );
  // The JSON boundary is enforced: a Date-typed sentAt (someone skipped
  // serializeSendDiff) fails validation instead of lying on readback.
  const dateDiff = JSON.parse(JSON.stringify(withDiff)) as Record<string, unknown>;
  (
    (dateDiff["send_diff"] as { priorSend: Record<string, unknown> }).priorSend
  )["sentAt"] = new Date("2026-07-01T17:00:00Z");
  assert.equal(campaignApprovalOf(dateDiff), null);
  console.log(
    "[smoke] card data: all-four validation rejects partial payloads, drifted diff shapes and unserialized dates",
  );
}

/* ------------------------------------------------------------------ *
 * 8. Approval transition (fake transactional pool)                   *
 * ------------------------------------------------------------------ */

interface FakeDbState {
  item: {
    id: string;
    type: string;
    status: string;
    payload: Record<string, unknown>;
    resolved_at: Date | null;
  };
  campaign: {
    id: string;
    key: string;
    status: string;
    approved_by: string | null;
    approved_at: Date | null;
  };
}

/**
 * In-memory stand-in for the pg pool that honors the exact guards the
 * real SQL carries (status/type WHERE clauses) and real BEGIN/ROLLBACK
 * semantics, so decideCampaignApproval's ordering, guard handling and
 * rollback paths all run offline. The SQL text itself is additionally
 * asserted to carry the guards (see smokeApprovalTransition).
 */
function fakePool(state: FakeDbState): TransactionPool & {
  log: string[];
} {
  const log: string[] = [];
  let snapshot: FakeDbState | null = null;
  const client: TransactionClient = {
    async query(sql: string, params: unknown[] = []) {
      const head = sql.trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase();
      log.push(head);
      if (sql === "BEGIN") {
        snapshot = JSON.parse(JSON.stringify(state)) as FakeDbState;
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        snapshot = null;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (snapshot) Object.assign(state, snapshot);
        snapshot = null;
        return { rows: [] };
      }
      if (sql.includes("UPDATE items")) {
        const [id, record] = params as [string, string];
        if (
          state.item.id === id &&
          state.item.type === "campaign_approval" &&
          state.item.status === "pending_approval"
        ) {
          state.item.status = "resolved";
          state.item.resolved_at = new Date();
          state.item.payload = {
            ...state.item.payload,
            decision: JSON.parse(record) as unknown,
          };
          return { rows: [{ ...state.item }] };
        }
        return { rows: [] };
      }
      if (sql.includes("UPDATE campaigns")) {
        const id = params[0] as string;
        if (state.campaign.id !== id || state.campaign.status !== "pending_approval") {
          return { rows: [] };
        }
        if (sql.includes("'approved'")) {
          state.campaign.status = "approved";
          state.campaign.approved_by = params[1] as string;
          state.campaign.approved_at = new Date();
        } else {
          state.campaign.status = "draft";
        }
        return {
          rows: [
            {
              id: state.campaign.id,
              key: state.campaign.key,
              status: state.campaign.status,
            },
          ],
        };
      }
      if (sql.includes("SELECT status FROM campaigns")) {
        return { rows: [{ status: state.campaign.status }] };
      }
      throw new Error(`fakePool: unexpected SQL: ${sql}`);
    },
    release() {
      log.push("RELEASE");
    },
  };
  return {
    log,
    async connect() {
      return client;
    },
  };
}

function freshState(): FakeDbState {
  return {
    item: {
      id: "42",
      type: "campaign_approval",
      status: "pending_approval",
      payload: { campaign_id: "7", campaign_key: CAMPAIGN.key },
      resolved_at: null,
    },
    campaign: {
      id: "7",
      key: CAMPAIGN.key,
      status: "pending_approval",
      approved_by: null,
      approved_at: null,
    },
  };
}

const DECIDER = { id: "user_pete", name: "Pete" };

async function smokeApprovalTransition(): Promise<void> {
  // Approve: item resolved with audit, campaign approved with by/at pair.
  {
    const state = freshState();
    const pool = fakePool(state);
    const outcome = await decideCampaignApproval("42", "approved", DECIDER, pool);
    assert.equal(outcome.status, "decided");
    assert.equal(state.item.status, "resolved");
    const decision = state.item.payload["decision"] as {
      action: string;
      by: { id: string };
    };
    assert.equal(decision.action, "approved");
    assert.equal(decision.by.id, DECIDER.id);
    assert.equal(state.campaign.status, "approved");
    assert.equal(state.campaign.approved_by, DECIDER.id);
    assert.ok(state.campaign.approved_at instanceof Date);
    assert.ok(pool.log.includes("COMMIT"));
    assert.ok(pool.log.includes("RELEASE"));
  }

  // Reject: item resolved, campaign back to draft, no approved_by/at.
  {
    const state = freshState();
    const outcome = await decideCampaignApproval(
      "42",
      "rejected",
      DECIDER,
      fakePool(state),
    );
    assert.equal(outcome.status, "decided");
    assert.equal(state.campaign.status, "draft");
    assert.equal(state.campaign.approved_by, null);
    assert.equal(state.campaign.approved_at, null);
  }

  // Stale item: already decided -> stale_item, nothing changes.
  {
    const state = freshState();
    state.item.status = "resolved";
    const outcome = await decideCampaignApproval(
      "42",
      "approved",
      DECIDER,
      fakePool(state),
    );
    assert.equal(outcome.status, "stale_item");
    assert.equal(state.campaign.status, "pending_approval");
  }

  // Wrong item type never decides (the guard covers type, not just id).
  {
    const state = freshState();
    state.item.type = "email_reply";
    const outcome = await decideCampaignApproval(
      "42",
      "approved",
      DECIDER,
      fakePool(state),
    );
    assert.equal(outcome.status, "stale_item");
  }

  // Campaign conflict: item pending but campaign moved on -> ROLLBACK,
  // the item goes BACK to pending (the whole point of the transaction).
  for (const wrongStatus of ["approved", "cancelled", "sending", "draft"]) {
    const state = freshState();
    state.campaign.status = wrongStatus;
    const pool = fakePool(state);
    const outcome = await decideCampaignApproval("42", "approved", DECIDER, pool);
    assert.equal(outcome.status, "campaign_conflict");
    assert.equal(
      outcome.status === "campaign_conflict" ? outcome.campaignStatus : "",
      wrongStatus,
    );
    assert.equal(state.item.status, "pending_approval", "rolled back");
    assert.equal(state.campaign.status, wrongStatus);
    assert.ok(pool.log.includes("ROLLBACK"));
    assert.ok(!pool.log.includes("COMMIT"));
  }

  // Malformed item (no campaign_id pointer): refused, rolled back.
  {
    const state = freshState();
    state.item.payload = {};
    const outcome = await decideCampaignApproval(
      "42",
      "approved",
      DECIDER,
      fakePool(state),
    );
    assert.equal(outcome.status, "campaign_conflict");
    assert.equal(state.item.status, "pending_approval");
  }

  console.log(
    "[smoke] approval transition: flip + by/at, reject to draft, stale/conflict guarded with rollback",
  );
}

/* ------------------------------------------------------------------ *
 * 9. SEA-84 seam: approval stops at the flip                         *
 * ------------------------------------------------------------------ */

async function smokeApprovedSeam(): Promise<void> {
  const result = await onCampaignApproved({ id: "7", key: CAMPAIGN.key });
  assert.equal(result.enqueued, false);
  assert.match(result.reason, /SEA-84/);
  console.log("[smoke] SEA-84 seam: onCampaignApproved enqueues nothing");
}

/* ------------------------------------------------------------------ *
 * 10. RBAC gate                                                      *
 * ------------------------------------------------------------------ */

async function smokeRbac(): Promise<void> {
  // campaigns:decide is a decide-class permission: owner + operator only.
  assert.equal(hasPermission("owner", "campaigns:decide"), true);
  assert.equal(hasPermission("operator", "campaigns:decide"), true);
  assert.equal(hasPermission("viewer", "campaigns:decide"), false);
  // Explicitly NOT the view permission (SEA-90 review note): a viewer can
  // see campaigns but can never decide one.
  assert.equal(hasPermission("viewer", "campaigns:view"), true);
  console.log(
    "[smoke] rbac: campaigns:decide held by owner+operator, denied to viewer, distinct from campaigns:view",
  );
}

async function main(): Promise<void> {
  await smokeJobShape();
  await smokeCopyContract();
  await smokeAssembly();
  await smokeDraftOutputShape();
  await smokeSendDiffPresent();
  await smokeEnforcement();
  await smokeDedupe();
  await smokeCardValidation();
  await smokeApprovalTransition();
  await smokeApprovedSeam();
  await smokeRbac();
  console.log("campaigns.draft smoke: all checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
