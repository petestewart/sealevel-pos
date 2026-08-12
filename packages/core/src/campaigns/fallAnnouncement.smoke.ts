import assert from "node:assert/strict";

import type {
  AudienceCandidate,
  AudienceEntry,
  AudienceStore,
  CampaignRow,
} from "../db/campaignAudience.js";
import { buildAudience, type BuildAudienceDeps } from "./buildAudience.js";
import {
  findEmDashes,
  planSegmentVariants,
  type SegmentedDraftRequest,
} from "./draftVariants.js";
import {
  FALL_2026_SCHEDULE_FACTS,
  FALL_ANNOUNCEMENT_AUDIENCE_VIEW,
  FALL_ANNOUNCEMENT_CAMPAIGN_KEY,
  FALL_ANNOUNCEMENT_SEGMENTS,
  fallAnnouncementDraftRequest,
  unverifiedFallFacts,
} from "./fallAnnouncement.js";
import {
  CAMPAIGN_SEEDS,
  campaignSeedByKey,
  resolveCampaignBrief,
} from "./campaignBriefs.js";
import { containsEmDash } from "./draftCampaign.js";

/**
 * Offline smoke for the fall 2026 announcement campaign (SEA-88):
 *   1. buildAudience dry-run against v_campaign_fall_announcement with
 *      mocked view rows covering EVERY bucket (the offline equivalent of
 *      `npm run audience:dry-run -- --view v_campaign_fall_announcement`),
 *      proving SEA-82's segment passthrough handles the new view;
 *   2. the segment-variant fan-out (planSegmentVariants) this ticket owns;
 *   3. the content brief's integrity (labels match the view, no em
 *      dashes, unverified facts stay flagged).
 * Everything is served by local fakes: no MCP server, no Postgres.
 *
 * Run: npm run smoke:fallannouncement  (from packages/core)
 */

const ENV_VARS = ["SEALEVEL_MCP_URL", "SEALEVEL_MCP_ANALYTICS_TOKEN"] as const;

function withEnv<T>(
  values: Partial<Record<(typeof ENV_VARS)[number], string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = ENV_VARS.map((v) => [v, process.env[v]] as const);
  for (const v of ENV_VARS) {
    const value = values[v];
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
  return fn().finally(() => {
    for (const [v, val] of saved) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
  });
}

const ANALYTICS_ENV = {
  SEALEVEL_MCP_URL: "http://localhost:0",
  SEALEVEL_MCP_ANALYTICS_TOKEN: "test-token",
};

class FakeAudienceStore implements AudienceStore {
  candidates: AudienceCandidate[] = [];
  campaigns = new Map<string, CampaignRow>();
  snapshots: Array<{
    campaignId: string;
    entries: AudienceEntry[];
    snapshotAt: Date;
  }> = [];

  async listAudienceCandidates(): Promise<AudienceCandidate[]> {
    return this.candidates;
  }
  async getCampaignByKey(key: string): Promise<CampaignRow | null> {
    return this.campaigns.get(key) ?? null;
  }
  async replaceAudienceSnapshot(
    campaignId: string,
    entries: AudienceEntry[],
    snapshotAt: Date,
  ): Promise<void> {
    this.snapshots = this.snapshots.filter((s) => s.campaignId !== campaignId);
    this.snapshots.push({ campaignId, entries, snapshotAt });
  }
  async countAudience(campaignId: string): Promise<number> {
    return (
      this.snapshots.find((s) => s.campaignId === campaignId)?.entries.length ??
      0
    );
  }
}

function candidate(
  contactId: string,
  analyticsClientId: string,
): AudienceCandidate {
  return {
    contactId,
    analyticsClientId,
    email: `${contactId}@example.com`,
    isAmbiguous: false,
    ambiguousReason: null,
    consentState: "subscribed",
    suppressed: false,
  };
}

function depsWith(
  store: FakeAudienceStore,
  viewRows: Array<Record<string, unknown>>,
  queries: string[] = [],
): BuildAudienceDeps {
  return {
    pageSelect: async function* (select: string) {
      queries.push(select);
      for (let i = 0; i < viewRows.length; i += 200) {
        yield viewRows.slice(i, i + 200);
      }
    } as typeof import("../tools/analytics.js").pageSelect,
    store,
    log: () => {},
    now: () => new Date("2026-08-12T19:00:00Z"), // 12:00 PT, outside blackout
  };
}

/** View rows covering every fall-announcement bucket, plus mapped
 * contacts for all of them so segmentCounts show the full fan-out. */
function fallFixture(): {
  store: FakeAudienceStore;
  viewRows: Array<Record<string, unknown>>;
} {
  const store = new FakeAudienceStore();
  const rows: Array<Record<string, unknown>> = [];
  const spec: Array<[string, number]> = [
    ["lapsed_recent", 3],
    ["vinyasa_curious", 1],
    ["hot_only", 2],
    ["generalist", 2],
  ];
  let id = 200;
  for (const [segment, count] of spec) {
    for (let i = 0; i < count; i += 1) {
      id += 1;
      rows.push({ client_id: id, segment });
      store.candidates.push(candidate(String(id), String(id)));
    }
  }
  return { store, viewRows: rows };
}

async function testDryRunAgainstFallView(): Promise<void> {
  await withEnv(ANALYTICS_ENV, async () => {
    const { store, viewRows } = fallFixture();
    const queries: string[] = [];
    // The offline equivalent of
    //   npm run audience:dry-run -- --view v_campaign_fall_announcement
    const result = await buildAudience(
      { view: FALL_ANNOUNCEMENT_AUDIENCE_VIEW },
      depsWith(store, viewRows, queries),
    );
    assert.equal(result.status, "dry_run");
    assert.equal(result.audienceView, FALL_ANNOUNCEMENT_AUDIENCE_VIEW);
    assert.equal(
      queries[0],
      "SELECT client_id, segment FROM v_campaign_fall_announcement ORDER BY client_id",
    );
    // Segment passthrough: every bucket arrives with its count intact.
    assert.deepEqual(result.segmentCounts, {
      lapsed_recent: 3,
      vinyasa_curious: 1,
      hot_only: 2,
      generalist: 2,
    });
    assert.equal(result.recipients.length, 8);
    assert.equal(store.snapshots.length, 0); // dry-run writes nothing
  });
  console.log(
    "[smoke] fall_announcement: dry-run against v_campaign_fall_announcement (every bucket passes through)",
  );
}

async function testRealBuildUsesCampaignRowView(): Promise<void> {
  await withEnv(ANALYTICS_ENV, async () => {
    const { store, viewRows } = fallFixture();
    store.campaigns.set(FALL_ANNOUNCEMENT_CAMPAIGN_KEY, {
      id: "88",
      key: FALL_ANNOUNCEMENT_CAMPAIGN_KEY,
      name: "Fall 2026 schedule announcement",
      status: "draft",
      audienceView: FALL_ANNOUNCEMENT_AUDIENCE_VIEW,
      runSeq: 1,
      sendAt: null,
    });
    const queries: string[] = [];
    const result = await buildAudience(
      { campaignKey: FALL_ANNOUNCEMENT_CAMPAIGN_KEY },
      depsWith(store, viewRows, queries),
    );
    assert.equal(result.status, "built");
    assert.match(queries[0]!, /FROM v_campaign_fall_announcement ORDER BY/);
    assert.equal(store.snapshots.length, 1);
    assert.equal(store.snapshots[0]!.entries.length, 8);
    // Snapshot entries keep the segment labels for the per-segment send.
    const segments = new Set(store.snapshots[0]!.entries.map((e) => e.segment));
    assert.deepEqual(
      [...segments].sort(),
      [...FALL_ANNOUNCEMENT_SEGMENTS].sort(),
    );
  });
  console.log(
    "[smoke] fall_announcement: real build via campaign row (audience_view passthrough, segments in snapshot)",
  );
}

async function testVariantFanOut(): Promise<void> {
  const request = fallAnnouncementDraftRequest();
  const plan = planSegmentVariants(request, {
    lapsed_recent: 3,
    vinyasa_curious: 1,
    hot_only: 2,
    generalist: 2,
  });
  // One job per bucket, in brief order, counts intact.
  assert.deepEqual(
    plan.jobs.map((j) => [j.segment, j.recipients, j.variant.segment]),
    [
      ["lapsed_recent", 3, "lapsed_recent"],
      ["vinyasa_curious", 1, "vinyasa_curious"],
      ["hot_only", 2, "hot_only"],
      ["generalist", 2, "generalist"],
    ],
  );
  assert.deepEqual(plan.emptySegments, []);
  assert.deepEqual(plan.unknownSegments, []);
  for (const job of plan.jobs) {
    assert.equal(job.campaignKey, FALL_ANNOUNCEMENT_CAMPAIGN_KEY);
    assert.ok(job.sharedFacts.length > 0);
    assert.ok(job.copyRules.length > 0);
    // Every bucket gets its own vinyasa framing (ticket requirement).
    assert.ok(
      job.variant.framing.some((line) =>
        line.toLowerCase().includes("vinyasa"),
      ),
      `variant ${job.segment} must carry vinyasa framing`,
    );
  }
  console.log(
    "[smoke] fall_announcement: variant fan-out (one job per bucket, vinyasa framing everywhere)",
  );
}

async function testEmptyAndUnknownSegments(): Promise<void> {
  const request = fallAnnouncementDraftRequest();
  // The realistic launch shape: vinyasa_curious is empty today (the view
  // documents that export facts for vinyasa lag), and a hypothetical new
  // label falls back to the generalist variant instead of crashing.
  const plan = planSegmentVariants(request, {
    lapsed_recent: 1357,
    hot_only: 375,
    generalist: 119,
    vinyasa_curious: 0,
    week_two_nudge: 4,
  });
  assert.deepEqual(plan.emptySegments, ["vinyasa_curious"]);
  assert.deepEqual(plan.unknownSegments, ["week_two_nudge"]);
  const unknown = plan.jobs.find((j) => j.segment === "week_two_nudge")!;
  assert.equal(unknown.variant.segment, "generalist");
  // Fan-out identity: every recipient covered exactly once.
  const covered = plan.jobs.reduce((a, j) => a + j.recipients, 0);
  assert.equal(covered, 1357 + 375 + 119 + 4);
  console.log(
    "[smoke] fall_announcement: empty bucket skipped, unknown label degrades to the fallback variant",
  );
}

async function testBriefIntegrity(): Promise<void> {
  const request = fallAnnouncementDraftRequest();
  // Brief labels are exactly the view's labels.
  assert.deepEqual(
    request.variants.map((v) => v.segment),
    [...FALL_ANNOUNCEMENT_SEGMENTS],
  );
  assert.equal(request.audienceView, FALL_ANNOUNCEMENT_AUDIENCE_VIEW);
  // House rule: no em dashes anywhere in copy guidance.
  assert.deepEqual(findEmDashes(request), []);
  // Every schedule fact carries a status and a source; the ones from the
  // ticket stay flagged for Pete until verified.
  for (const fact of FALL_2026_SCHEDULE_FACTS) {
    assert.ok(fact.source.length > 0);
    assert.ok(["confirmed", "needs_verification"].includes(fact.status));
  }
  assert.ok(
    unverifiedFallFacts().length > 0,
    "the ticket's schedule claims must stay flagged until Pete verifies them",
  );
  console.log(
    "[smoke] fall_announcement: brief integrity (labels match view, no em dashes, unverified facts flagged)",
  );
}

async function testRegistryAndSeed(): Promise<void> {
  // The brief registry (SEA-88 integration): campaigns.draft finds this
  // campaign's brief by key; unknown keys are un-briefed.
  const entry = resolveCampaignBrief(FALL_ANNOUNCEMENT_CAMPAIGN_KEY);
  assert.ok(entry, "fall campaign is registered");
  assert.equal(entry.request().campaignKey, FALL_ANNOUNCEMENT_CAMPAIGN_KEY);
  assert.equal(
    entry.unverifiedFacts().length,
    unverifiedFallFacts().length,
    "registry exposes the brief's own unverified facts",
  );
  assert.match(entry.factsFile, /fallAnnouncement\.ts$/);
  assert.equal(resolveCampaignBrief("no-such-campaign"), null);

  // The seed registry (npm run campaign:seed): the fall campaign row
  // carries the same key and audience view the brief drafts against.
  const seed = campaignSeedByKey(FALL_ANNOUNCEMENT_CAMPAIGN_KEY);
  assert.ok(seed);
  assert.equal(seed.audienceView, FALL_ANNOUNCEMENT_AUDIENCE_VIEW);
  assert.ok(seed.name.length > 0);
  // Seed keys are unique (one ON CONFLICT target each).
  assert.equal(
    new Set(CAMPAIGN_SEEDS.map((s) => s.key)).size,
    CAMPAIGN_SEEDS.length,
  );
  console.log(
    "[smoke] fall_announcement: brief registry + campaign seed agree on key and audience view",
  );
}

async function testEmDashGuard(): Promise<void> {
  const bad: SegmentedDraftRequest = {
    ...fallAnnouncementDraftRequest(),
    subjectTheme: "New classes — this fall",
  };
  assert.equal(findEmDashes(bad).length, 1);
  // ONE character class everywhere: the guidance check catches the same
  // lookalikes (horizontal bar, two-em/three-em dash) the draft job's
  // copy enforcement catches, via the same shared predicate.
  for (const lookalike of ["bar ― here", "two-em ⸺ here", "three-em ⸻ here"]) {
    assert.ok(containsEmDash(lookalike));
    const request: SegmentedDraftRequest = {
      ...fallAnnouncementDraftRequest(),
      subjectTheme: lookalike,
    };
    assert.equal(findEmDashes(request).length, 1);
  }
  assert.throws(
    () => planSegmentVariants(bad, { generalist: 1 }),
    /em dash in copy guidance/,
  );
  // Misconfigured fallback fails loudly, never a silent wrong variant.
  const badFallback: SegmentedDraftRequest = {
    ...fallAnnouncementDraftRequest(),
    fallbackSegment: "nope",
  };
  assert.throws(
    () => planSegmentVariants(badFallback, { generalist: 1 }),
    /fallbackSegment 'nope'/,
  );
  console.log(
    "[smoke] fall_announcement: guards (em dash rejected, bad fallback rejected)",
  );
}

async function main(): Promise<void> {
  await testDryRunAgainstFallView();
  await testRealBuildUsesCampaignRowView();
  await testVariantFanOut();
  await testEmptyAndUnknownSegments();
  await testBriefIntegrity();
  await testRegistryAndSeed();
  await testEmDashGuard();
  console.log("[smoke] fall_announcement: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
