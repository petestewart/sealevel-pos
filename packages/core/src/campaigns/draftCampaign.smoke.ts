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
import { computeSendDiff, withCurrentCopy } from "./sendDiff.js";
import { SEND_DIFF_SAMPLE_LIMIT, type SendDiff } from "./sendDiffTypes.js";
import type { CampaignBriefEntry } from "./campaignBriefs.js";
import { resolveCampaignBrief } from "./campaignBriefs.js";
import {
  FALL_ANNOUNCEMENT_CAMPAIGN_KEY,
  unverifiedFallFacts,
  type CampaignFact,
} from "./fallAnnouncement.js";
import {
  containsEmDash as variantsContainsEmDash,
  type SegmentedDraftRequest,
} from "./draftVariants.js";

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
  sendAt: null,
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
  brief?: CampaignBriefEntry | null;
  buildCalls?: string[];
}): { deps: DraftCampaignDeps; calls: FakeCalls } {
  const calls: FakeCalls = { created: [], emits: [], flips: [] };
  let nextId = 500;
  const existing = new Map<string, Item>();
  const deps: DraftCampaignDeps = {
    buildAudience: async ({ campaignKey }) => {
      options?.buildCalls?.push(campaignKey);
      return options?.build ?? buildResult();
    },
    getCampaignByKey: async (key) => (key === CAMPAIGN.key ? CAMPAIGN : null),
    listSnapshotRecipients: async () => options?.recipients ?? RECIPIENTS,
    resolveBrief: () => options?.brief ?? null,
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

/* --- Briefed-campaign fixtures (SEA-88 integration) ---------------- */

/** A test brief whose facts are all confirmed, shaped to the fake
 * snapshot's segments (hot_only x2, new_student x1). */
const TEST_BRIEF: SegmentedDraftRequest = {
  campaignKey: CAMPAIGN.key,
  audienceView: CAMPAIGN.audienceView,
  subjectTheme: "Your second month at the studio.",
  sharedFacts: ["The studio runs hot classes every day of the week."],
  copyRules: ["No em dashes anywhere in the copy."],
  variants: [
    {
      segment: "hot_only",
      audience: "Regulars who only take hot classes.",
      framing: ["Respect the routine; celebrate the streak."],
    },
    {
      segment: "new_student",
      audience: "Students inside their first month.",
      framing: ["Welcoming, low pressure, one concrete next step."],
    },
  ],
  fallbackSegment: "hot_only",
};

function testBriefEntry(overrides?: {
  unverified?: CampaignFact[];
  request?: SegmentedDraftRequest;
}): CampaignBriefEntry {
  return {
    request: () => overrides?.request ?? TEST_BRIEF,
    unverifiedFacts: () => overrides?.unverified ?? [],
    factsFile: "packages/core/src/campaigns/testBrief.fixture.ts",
  };
}

const GOOD_VARIANTS = {
  variants: [
    {
      segment: "hot_only",
      subject: "{{first_name}}, the hot room has news",
      body:
        "Hey {{first_name}},\n\nYour streak in the hot room has not gone unnoticed. Classes run every day of the week, same heat, same playlist energy.\n\nSee you on the mat,\nSealevel Hot Yoga",
    },
    {
      segment: "new_student",
      subject: "One month in, {{first_name}}",
      body:
        "Hey {{first_name}},\n\nMonth one is the hard part and you did it. Classes run every day of the week, so pick the time that fits and keep going.\n\nWith warmth,\nSealevel Hot Yoga",
    },
  ],
  rationale:
    "Two variants matching the brief: streak recognition for regulars, gentle momentum for new students.",
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
  assert.equal(containsEmDash("two-em dash ⸺ caught"), true);
  assert.equal(containsEmDash("three-em dash ⸻ caught"), true);
  // ONE character class everywhere (SEA-88 unification): the predicate
  // draftCampaign re-exports IS draftVariants' canonical one, not a fork.
  assert.equal(containsEmDash, variantsContainsEmDash);

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
  // 3. The rendered email with ONE real recipient's merge fields resolved
  // (single un-briefed shape: the trio is present, variants absent).
  assert.equal(payload.variants, undefined);
  assert.equal(payload.rendered_preview!.recipient.email, "maria@example.com");
  assert.equal(payload.rendered_preview!.subject, "Maria, your mat misses you");
  assert.ok(payload.rendered_preview!.body.startsWith("Hey Maria,"));
  assert.ok(!payload.rendered_preview!.body.includes("{{"));
  // The stored draft keeps the merge fields unresolved for the real send.
  assert.ok(payload.draft_body!.includes("{{first_name}}"));
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
  // became an ISO string at the payload boundary. Since SEA-84 the
  // create step re-runs the copy comparison with the ACTUAL draft copy
  // (withCurrentCopy); with no stored prior copy on the diff, the
  // verdict honestly stays null.
  const stored = payload.send_diff;
  assert.ok(stored);
  assert.equal(stored.priorSend.sentAt, "2026-07-01T17:00:00.000Z");
  assert.deepEqual(
    stored,
    serializeSendDiff(
      withCurrentCopy(diff, {
        subject: GOOD_INPUT.subject,
        body: GOOD_INPUT.body,
      }),
    ),
  );
  assert.equal(stored.copyChanged, null); // unknown stays null (no prior copy)
  assert.match(stored.copySummary, /no stored prior copy/);
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

  // SEA-84 loop closure: with a STORED PRIOR COPY on the diff, the
  // create step compares the model's actual draft against it and the
  // card gets a REAL boolean, not null.
  {
    const withPrior = canonicalDiff();
    withPrior.priorCopy = {
      runSeq: 1,
      variants: [
        { segment: "", subject: GOOD_INPUT.subject, body: GOOD_INPUT.body },
      ],
    };
    const { deps: d2, calls: c2 } = fakeDeps({ sendDiff: withPrior });
    const a2 = await assembleCampaignDraft(CAMPAIGN.key, d2);
    await createCampaignApproval(a2, GOOD_INPUT, d2);
    const p2 = campaignApprovalOf(c2.created[0]!.payload ?? {});
    assert.ok(p2);
    assert.equal(p2.send_diff!.copyChanged, false); // identical copy
    assert.match(p2.send_diff!.summary, /copy: unchanged/);

    const changedPrior = canonicalDiff();
    changedPrior.priorCopy = {
      runSeq: 1,
      variants: [{ segment: "", subject: "Old subject", body: "Old body" }],
    };
    const { deps: d3, calls: c3 } = fakeDeps({ sendDiff: changedPrior });
    const a3 = await assembleCampaignDraft(CAMPAIGN.key, d3);
    await createCampaignApproval(a3, GOOD_INPUT, d3);
    const p3 = campaignApprovalOf(c3.created[0]!.payload ?? {});
    assert.ok(p3);
    assert.equal(p3.send_diff!.copyChanged, true);
    assert.match(p3.send_diff!.summary, /copy: CHANGED/);
  }

  console.log(
    "[smoke] send-diff: canonical re-send diff flows assembly -> payload -> validator (JSON-safe; copy unknown preserved without a prior copy, REAL boolean with one)",
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
 * 6b. Facts gate (SEA-88): unverified facts refuse the whole run     *
 * ------------------------------------------------------------------ */

async function smokeFactsGate(): Promise<void> {
  // A briefed campaign with unverified facts REFUSES loudly, naming
  // each unverified fact and the file to fix, BEFORE the audience build
  // runs (no snapshot side effects behind the refusal).
  const buildCalls: string[] = [];
  const gated = fakeDeps({
    buildCalls,
    brief: testBriefEntry({
      unverified: [
        {
          fact: "The fall schedule adds roughly 25 new weekly classes.",
          status: "needs_verification",
          source: "SEA-88 ticket",
        },
      ],
    }),
  });
  await assert.rejects(
    assembleCampaignDraft(CAMPAIGN.key, gated.deps),
    (err: Error) => {
      assert.match(err.message, /REFUSING to draft briefed campaign/);
      assert.match(err.message, /roughly 25 new weekly classes/);
      assert.match(err.message, /testBrief\.fixture\.ts/);
      return true;
    },
  );
  assert.deepEqual(buildCalls, [], "gate fired before the audience build");

  // All facts confirmed: the same campaign assembles, with a plan.
  const ok = fakeDeps({ brief: testBriefEntry() });
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, ok.deps);
  assert.ok(assembly.variantPlan);

  // The REAL registry wires the fall campaign to its real facts file:
  // while unverifiedFallFacts() is non-empty (it is today, by design:
  // the rollout is still moving), drafting the fall campaign refuses.
  assert.ok(resolveCampaignBrief(FALL_ANNOUNCEMENT_CAMPAIGN_KEY));
  assert.equal(resolveCampaignBrief("post-first-visit"), null);
  if (unverifiedFallFacts().length > 0) {
    const real = fakeDeps();
    real.deps.resolveBrief = resolveCampaignBrief;
    await assert.rejects(
      assembleCampaignDraft(FALL_ANNOUNCEMENT_CAMPAIGN_KEY, real.deps),
      /fallAnnouncement\.ts/,
    );
  }
  console.log(
    "[smoke] facts gate: unverified facts refuse before any side effect; confirmed facts pass; fall campaign gated via the real registry",
  );
}

/* ------------------------------------------------------------------ *
 * 6c. Briefed fan-out: N variants, ONE approval item                 *
 * ------------------------------------------------------------------ */

async function smokeBriefedFanOut(): Promise<void> {
  const { deps, calls } = fakeDeps({ brief: testBriefEntry() });
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);

  // The plan: one job per non-empty bucket, counts from the snapshot.
  assert.ok(assembly.brief);
  assert.deepEqual(
    assembly.variantPlan!.jobs.map((j) => [j.segment, j.recipients]),
    [
      ["hot_only", 2],
      ["new_student", 1],
    ],
  );
  // Per-segment deterministic samples (lowest contact id per segment).
  assert.equal(assembly.samplesBySegment["hot_only"]!.contactId, "101");
  assert.equal(assembly.samplesBySegment["new_student"]!.contactId, "103");

  const result = await createCampaignApproval(assembly, GOOD_VARIANTS, deps);
  assert.equal(result.status, "created");
  assert.equal(calls.created.length, 1);
  const input = calls.created[0]!;
  // Still ONE campaign-level approval item, same dedupe key as ever.
  assert.equal(input.type, "campaign_approval");
  assert.equal(input.dedupeKey, "campaign-7-run-1");

  const payload = campaignApprovalOf(input.payload ?? {});
  assert.ok(payload, "briefed payload passes campaignApprovalOf");
  // Element 3, briefed shape: variants present, single trio absent.
  assert.ok(payload.variants);
  assert.equal("draft_subject" in payload, false);
  assert.equal("rendered_preview" in payload, false);
  assert.deepEqual(
    payload.variants.map((v) => [v.segment, v.recipient_count]),
    [
      ["hot_only", 2],
      ["new_student", 1],
    ],
  );
  // Each variant rendered for a sample recipient FROM ITS OWN SEGMENT.
  const [hot, fresh] = payload.variants;
  assert.equal(hot!.rendered_preview.recipient.email, "maria@example.com");
  assert.equal(hot!.rendered_preview.recipient.segment, "hot_only");
  assert.equal(hot!.rendered_preview.subject, "Maria, the hot room has news");
  assert.equal(fresh!.rendered_preview.recipient.email, "sam@example.com");
  assert.equal(fresh!.rendered_preview.recipient.segment, "new_student");
  assert.equal(fresh!.rendered_preview.subject, "One month in, Sam");
  assert.ok(!hot!.rendered_preview.body.includes("{{"));
  // Stored drafts keep merge fields unresolved for the real send.
  assert.ok(hot!.draft_body.includes("{{first_name}}"));

  // The other three card elements are unchanged by the fan-out.
  assert.equal(payload.audience.recipients, 3);
  assert.ok("send_diff" in payload);

  // JSONB round-trip still validates (all-JSON-safe payload).
  assert.ok(
    campaignApprovalOf(
      JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
    ),
  );

  // Dedupe stays airtight: a retried briefed draft reuses the item.
  const second = await createCampaignApproval(assembly, GOOD_VARIANTS, deps);
  assert.equal(second.status, "exists");
  assert.equal(calls.emits.length, 1);
  console.log(
    "[smoke] briefed fan-out: N variants in ONE approval item, per-segment samples, dedupe intact",
  );
}

/** Unknown snapshot label: drafted via the brief's fallback variant,
 * and the model must still cover it (it is a planned segment). */
async function smokeBriefedUnknownSegment(): Promise<void> {
  const extraRecipient = recipient("104", "week2@example.com", "Wren", "week_two");
  const build = buildResult({
    recipients: [...RECIPIENTS, extraRecipient].map((r) => ({
      contactId: r.contactId,
      email: r.email,
      analyticsClientId: `a-${r.contactId}`,
      segment: r.segment,
    })),
    segmentCounts: { hot_only: 2, new_student: 1, week_two: 1 },
  });
  const { deps, calls } = fakeDeps({
    brief: testBriefEntry(),
    build,
    recipients: [...RECIPIENTS, extraRecipient],
  });
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);
  assert.deepEqual(assembly.variantPlan!.unknownSegments, ["week_two"]);
  const weekTwoJob = assembly.variantPlan!.jobs.find(
    (j) => j.segment === "week_two",
  )!;
  // Fallback copy guidance, real segment label.
  assert.equal(weekTwoJob.variant.segment, "hot_only");

  // Not covering the unknown segment is a rejection...
  const partial = await createCampaignApproval(assembly, GOOD_VARIANTS, deps);
  assert.equal(partial.status, "rejected");
  assert.match(
    partial.status === "rejected" ? partial.reason : "",
    /missing variant\(s\) for segment\(s\): week_two/,
  );
  // ...and covering it files one item with three variants, the unknown
  // one rendered for ITS OWN segment's sample recipient.
  const full = await createCampaignApproval(
    assembly,
    {
      ...GOOD_VARIANTS,
      variants: [
        ...GOOD_VARIANTS.variants,
        {
          segment: "week_two",
          subject: "Week two, {{first_name}}",
          body: "Hey {{first_name}},\n\nKeep the streak alive this week.\n\nSealevel Hot Yoga",
        },
      ],
    },
    deps,
  );
  assert.equal(full.status, "created");
  const payload = campaignApprovalOf(calls.created[0]!.payload ?? {})!;
  assert.equal(payload.variants!.length, 3);
  const weekTwo = payload.variants!.find((v) => v.segment === "week_two")!;
  assert.equal(weekTwo.recipient_count, 1);
  assert.equal(weekTwo.rendered_preview.recipient.email, "week2@example.com");
  assert.equal(weekTwo.rendered_preview.subject, "Week two, Wren");
  console.log(
    "[smoke] briefed fan-out: unknown label drafts via fallback, must be covered, gets its own sample",
  );
}

/* ------------------------------------------------------------------ *
 * 6d. Variant enforcement: copy contract + coverage, per variant     *
 * ------------------------------------------------------------------ */

async function smokeVariantEnforcement(): Promise<void> {
  const { deps, calls } = fakeDeps({ brief: testBriefEntry() });
  const assembly = await assembleCampaignDraft(CAMPAIGN.key, deps);

  const reject = async (
    input: Parameters<typeof createCampaignApproval>[1],
    pattern: RegExp,
  ): Promise<void> => {
    const result = await createCampaignApproval(assembly, input, deps);
    assert.equal(result.status, "rejected");
    assert.match(result.status === "rejected" ? result.reason : "", pattern);
  };

  // A briefed campaign cannot fall back to the single-draft shape.
  await reject(
    { subject: "One size", body: "fits none", rationale: "r" },
    /per-segment variants/,
  );
  // Coverage: missing, unknown, and duplicate segments all rejected.
  await reject(
    { variants: GOOD_VARIANTS.variants.slice(0, 1), rationale: "r" },
    /missing variant\(s\) for segment\(s\): new_student/,
  );
  await reject(
    {
      variants: [
        ...GOOD_VARIANTS.variants,
        { segment: "lapsed", subject: "s", body: "b" },
      ],
      rationale: "r",
    },
    /unknown variant segment 'lapsed'/,
  );
  await reject(
    {
      variants: [...GOOD_VARIANTS.variants, GOOD_VARIANTS.variants[0]!],
      rationale: "r",
    },
    /duplicate variant for segment 'hot_only'/,
  );
  // Copy contract per variant: em dashes and merge fields, named by
  // segment so the model can fix the right draft.
  await reject(
    {
      variants: [
        GOOD_VARIANTS.variants[0]!,
        {
          ...GOOD_VARIANTS.variants[1]!,
          body: "Month one — you did it.",
        },
      ],
      rationale: "r",
    },
    /variant 'new_student' body contains an em dash/,
  );
  await reject(
    {
      variants: [
        {
          ...GOOD_VARIANTS.variants[0]!,
          subject: "Hi {{nickname}}",
        },
        GOOD_VARIANTS.variants[1]!,
      ],
      rationale: "r",
    },
    /variant 'hot_only': unknown merge field/,
  );
  await reject(
    {
      variants: [
        { ...GOOD_VARIANTS.variants[0]!, body: "   " },
        GOOD_VARIANTS.variants[1]!,
      ],
      rationale: "r",
    },
    /variant 'hot_only': subject and body must be non-empty/,
  );
  // Rationale is checked once for the whole set.
  await reject(
    { ...GOOD_VARIANTS, rationale: "Two variants — done." },
    /rationale contains an em dash/,
  );

  // And the mirror image: an UN-briefed campaign rejects variants.
  const single = fakeDeps();
  const singleAssembly = await assembleCampaignDraft(CAMPAIGN.key, single.deps);
  const wrongShape = await createCampaignApproval(
    singleAssembly,
    { variants: GOOD_VARIANTS.variants, rationale: "r" },
    single.deps,
  );
  assert.equal(wrongShape.status, "rejected");
  assert.match(
    wrongShape.status === "rejected" ? wrongShape.reason : "",
    /no segment brief/,
  );

  // No rejected attempt created an item, flipped status, or emitted.
  assert.equal(calls.created.length, 0);
  assert.deepEqual(calls.flips, []);
  assert.equal(calls.emits.length, 0);
  console.log(
    "[smoke] variant enforcement: coverage, per-variant copy contract and shape mismatches rejected with no side effects",
  );
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

  // Variant-shape negatives (SEA-88): build a valid briefed payload,
  // then break its variants one field at a time.
  const briefed = fakeDeps({ brief: testBriefEntry() });
  const briefedAssembly = await assembleCampaignDraft(CAMPAIGN.key, briefed.deps);
  await createCampaignApproval(briefedAssembly, GOOD_VARIANTS, briefed.deps);
  const goodBriefed = briefed.calls.created[0]!.payload as Record<string, unknown>;
  assert.ok(campaignApprovalOf(goodBriefed));
  const breakVariants = (
    mutate: (variants: Array<Record<string, unknown>>) => void,
  ): Record<string, unknown> => {
    const clone = JSON.parse(JSON.stringify(goodBriefed)) as Record<
      string,
      unknown
    >;
    mutate(clone["variants"] as Array<Record<string, unknown>>);
    return clone;
  };
  // An empty variants array is ceremonial, not a card.
  assert.equal(
    campaignApprovalOf(breakVariants((v) => v.splice(0, v.length))),
    null,
  );
  // Every variant must be complete: preview, drafts, count, segment.
  assert.equal(
    campaignApprovalOf(breakVariants((v) => delete v[0]!["rendered_preview"])),
    null,
  );
  assert.equal(
    campaignApprovalOf(breakVariants((v) => delete v[1]!["draft_body"])),
    null,
  );
  assert.equal(
    campaignApprovalOf(breakVariants((v) => (v[0]!["recipient_count"] = "2"))),
    null,
  );
  assert.equal(
    campaignApprovalOf(breakVariants((v) => (v[0]!["segment"] = ""))),
    null,
  );
  // Two variants claiming one segment is ambiguous, so malformed.
  assert.equal(
    campaignApprovalOf(
      breakVariants((v) => (v[1]!["segment"] = v[0]!["segment"] as string)),
    ),
    null,
  );
  // A briefed payload with variants present as a non-array is malformed.
  const nonArray = JSON.parse(JSON.stringify(goodBriefed)) as Record<
    string,
    unknown
  >;
  nonArray["variants"] = { hot_only: {} };
  assert.equal(campaignApprovalOf(nonArray), null);
  console.log(
    "[smoke] card data: all-four validation rejects partial payloads, drifted diff shapes, unserialized dates and malformed variants",
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
 * 9. SEA-84 seam: approval enqueues the send                          *
 * ------------------------------------------------------------------ */

async function smokeApprovedSeam(): Promise<void> {
  const NOW = new Date("2026-08-12T17:00:00Z");
  const enqueues: Array<{
    campaignKey: string;
    campaignId: string;
    runSeq: number;
    delayMs?: number;
  }> = [];
  const deps = (sendAt: Date | null, failEnqueue = false) => ({
    getSchedule: async () => ({ sendAt, runSeq: 1 }),
    enqueueSend: async (options: {
      campaignKey: string;
      campaignId: string;
      runSeq: number;
      delayMs?: number;
    }) => {
      if (failEnqueue) throw new Error("redis unavailable");
      enqueues.push(options);
      return `job-${enqueues.length}`;
    },
    now: () => NOW,
    log: () => {},
  });

  // send_at null: enqueued to fire immediately (no delay).
  let result = await onCampaignApproved(
    { id: "7", key: CAMPAIGN.key },
    deps(null),
  );
  assert.equal(result.enqueued, true);
  assert.equal(result.delayMs, 0);
  assert.equal(enqueues[0]!.delayMs, undefined);

  // Future send_at: DELAYED for exactly (send_at - now).
  const sendAt = new Date(NOW.getTime() + 90 * 60 * 1000);
  result = await onCampaignApproved({ id: "7", key: CAMPAIGN.key }, deps(sendAt));
  assert.equal(result.enqueued, true);
  assert.equal(result.delayMs, 90 * 60 * 1000);
  assert.equal(enqueues[1]!.delayMs, 90 * 60 * 1000);

  // PAST send_at (approval landed after the scheduled time): fires now,
  // never a negative delay.
  const past = new Date(NOW.getTime() - 60_000);
  result = await onCampaignApproved({ id: "7", key: CAMPAIGN.key }, deps(past));
  assert.equal(result.enqueued, true);
  assert.equal(result.delayMs, 0);

  // Enqueue failure NEVER throws (the approval is already committed);
  // it reports honestly and leaves the monitor's overdue backstop to
  // catch the lost send.
  result = await onCampaignApproved(
    { id: "7", key: CAMPAIGN.key },
    deps(null, true),
  );
  assert.equal(result.enqueued, false);
  assert.match(result.reason ?? "", /redis unavailable/);

  console.log(
    "[smoke] SEA-84 seam: approval enqueues the send (immediate, delayed to send_at, past send_at fires now, enqueue failure contained)",
  );
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
  await smokeFactsGate();
  await smokeBriefedFanOut();
  await smokeBriefedUnknownSegment();
  await smokeVariantEnforcement();
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
