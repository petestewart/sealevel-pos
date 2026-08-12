import assert from "node:assert/strict";

import type { CampaignRow } from "../db/campaignAudience.js";
import type { PriorSendRow, SendDiffStore } from "../db/sendDiff.js";
import type { ApprovedCopy, CopySnapshot } from "../db/campaignSend.js";
import { computeSendDiff, withCurrentCopy } from "./sendDiff.js";
import { SEND_DIFF_SAMPLE_LIMIT } from "./sendDiffTypes.js";

/**
 * Offline smoke for campaigns.send_diff (SEA-86). Everything is served
 * by an in-memory SendDiffStore: no Postgres is touched. The DB layer
 * itself (the two parameterized reads in db/sendDiff.ts) follows the
 * same query shapes as campaignAudience.ts and runs against the real
 * schema via local docker compose, per repo convention.
 *
 * Run: npm run smoke:senddiff  (from packages/core)
 */

class FakeSendDiffStore implements SendDiffStore {
  campaigns = new Map<string, CampaignRow>();
  sendRows = new Map<string, PriorSendRow[]>(); // campaignId -> rows
  audienceEmails = new Map<string, string[]>(); // campaignId -> emails
  /** SEA-84: durable per-run sent-copy snapshots, campaignId -> newest. */
  copySnapshots = new Map<string, CopySnapshot>();
  /** SEA-84: draft copy per "campaignId:runSeq" (campaign_approval item),
   * in either the single or the SEA-88 variants shape. */
  draftCopies = new Map<string, ApprovedCopy>();

  async getCampaignByKey(key: string): Promise<CampaignRow | null> {
    return this.campaigns.get(key) ?? null;
  }
  async listCampaignSendRows(campaignId: string): Promise<PriorSendRow[]> {
    return this.sendRows.get(campaignId) ?? [];
  }
  async listAudienceEmails(campaignId: string): Promise<string[]> {
    return this.audienceEmails.get(campaignId) ?? [];
  }
  async getLatestCopySnapshot(campaignId: string): Promise<CopySnapshot | null> {
    return this.copySnapshots.get(campaignId) ?? null;
  }
  async getDraftCopy(
    campaignId: string,
    runSeq: number,
  ): Promise<ApprovedCopy | null> {
    return this.draftCopies.get(`${campaignId}:${runSeq}`) ?? null;
  }
}

function campaign(id: string, key: string, runSeq = 1): CampaignRow {
  return {
    id,
    key,
    name: key,
    status: "pending_approval",
    audienceView: "v_campaign_post_first_visit",
    runSeq,
    sendAt: null,
  };
}

function sent(email: string, sentAt: string): PriorSendRow {
  return { email, status: "sent", sentAt: new Date(sentAt) };
}

async function testUnknownCampaignThrows(): Promise<void> {
  const store = new FakeSendDiffStore();
  await assert.rejects(
    computeSendDiff("nope", { store }),
    /no campaign with key 'nope'/,
  );
  console.log("[smoke] send_diff: unknown campaign key fails loudly");
}

async function testFirstSendIsNull(): Promise<void> {
  const store = new FakeSendDiffStore();
  store.campaigns.set("fresh", campaign("1", "fresh"));
  store.audienceEmails.set("1", ["a@example.com"]);
  // No send rows at all: first send.
  assert.equal(await computeSendDiff("fresh", { store }), null);
  // Rows that are ALL still queued are an in-flight run, not history.
  store.sendRows.set("1", [
    { email: "a@example.com", status: "queued", sentAt: null },
  ]);
  assert.equal(await computeSendDiff("fresh", { store }), null);
  console.log(
    "[smoke] send_diff: no prior send (none / all-queued) returns null",
  );
}

async function testAddedDroppedDetection(): Promise<void> {
  const store = new FakeSendDiffStore();
  store.campaigns.set("pfv", campaign("7", "pfv", 2));
  store.sendRows.set("7", [
    sent("stays@example.com", "2026-07-01T10:00:00Z"),
    sent("dropped@example.com", "2026-07-01T10:05:00Z"), // latest sent_at
    // Held back last time; absent now, but NOT a "dropped recipient"
    // (was never mailed) -- surfaces only in the prior-send counts.
    {
      email: "suppressed@example.com",
      status: "skipped_suppressed",
      sentAt: null,
    },
    { email: "failed@example.com", status: "failed", sentAt: null },
  ]);
  store.audienceEmails.set("7", [
    "STAYS@example.com ", // case/whitespace-normalized before comparison
    "added@example.com",
  ]);

  const diff = await computeSendDiff("pfv", { store });
  assert.ok(diff);
  assert.equal(diff.campaignKey, "pfv");
  assert.deepEqual(diff.recipientsAdded, {
    count: 1,
    sample: ["added@example.com"],
    sampleLimit: SEND_DIFF_SAMPLE_LIMIT,
  });
  assert.deepEqual(diff.recipientsDropped, {
    count: 1,
    sample: ["dropped@example.com"],
    sampleLimit: SEND_DIFF_SAMPLE_LIMIT,
  });
  assert.equal(diff.currentAudienceCount, 2);
  // Prior-run identity: when it sent, how many, per-outcome counts.
  assert.deepEqual(diff.priorSend, {
    campaignId: "7",
    runSeq: 2,
    sentAt: new Date("2026-07-01T10:05:00Z"),
    sentCount: 2,
    skippedSuppressedCount: 1,
    failedCount: 1,
  });
  // No stored prior copy (pre-snapshot history) and no current draft:
  // copy stays UNKNOWN -- null, never false.
  assert.equal(diff.copyChanged, null);
  assert.match(diff.copySummary, /no stored prior copy/);
  assert.equal(diff.priorCopy, null);
  assert.match(diff.summary, /1 added, 1 dropped, 2 now in audience/);
  assert.match(diff.summary, /copy: unknown/);
  console.log(
    "[smoke] send_diff: added/dropped detection (address-keyed, normalized; suppressed/failed are counts, not drops; copy unknown)",
  );
}

async function testBoundedSamples(): Promise<void> {
  const store = new FakeSendDiffStore();
  store.campaigns.set("big", campaign("9", "big"));
  store.sendRows.set("9", [sent("only.prior@example.com", "2026-07-01T00:00:00Z")]);
  const emails = Array.from(
    { length: SEND_DIFF_SAMPLE_LIMIT + 5 },
    (_, i) => `added${String(i).padStart(2, "0")}@example.com`,
  );
  store.audienceEmails.set("9", [...emails, "only.prior@example.com"]);

  const diff = await computeSendDiff("big", { store });
  assert.ok(diff);
  // Exact count, bounded deterministic (ascending) sample.
  assert.equal(diff.recipientsAdded.count, SEND_DIFF_SAMPLE_LIMIT + 5);
  assert.equal(diff.recipientsAdded.sample.length, SEND_DIFF_SAMPLE_LIMIT);
  assert.deepEqual(
    diff.recipientsAdded.sample,
    [...emails].sort().slice(0, SEND_DIFF_SAMPLE_LIMIT),
  );
  assert.equal(diff.recipientsDropped.count, 0);
  assert.deepEqual(diff.recipientsDropped.sample, []);
  console.log(
    "[smoke] send_diff: samples bounded at SEND_DIFF_SAMPLE_LIMIT with exact counts",
  );
}

async function testIdenticalAudienceIsEmptyDiff(): Promise<void> {
  const store = new FakeSendDiffStore();
  store.campaigns.set("same", campaign("3", "same"));
  store.sendRows.set("3", [sent("a@example.com", "2026-07-01T00:00:00Z")]);
  store.audienceEmails.set("3", ["a@example.com"]);
  const diff = await computeSendDiff("same", { store });
  assert.ok(diff, "a prior send exists, so the diff must not be null");
  assert.equal(diff.recipientsAdded.count, 0);
  assert.equal(diff.recipientsDropped.count, 0);
  console.log(
    "[smoke] send_diff: identical audience yields an empty (non-null) diff",
  );
}

/**
 * SEA-84 loop closure: with a stored copy snapshot (the send job writes
 * one per run) and a current draft copy, copyChanged is a REAL boolean;
 * each side missing keeps the honest null.
 */
async function testCopyComparison(): Promise<void> {
  const store = new FakeSendDiffStore();
  store.campaigns.set("copy", campaign("11", "copy", 2));
  store.sendRows.set("11", [sent("a@example.com", "2026-07-01T00:00:00Z")]);
  store.audienceEmails.set("11", ["a@example.com"]);
  store.copySnapshots.set("11", {
    runSeq: 1,
    variants: [
      { segment: "", subject: "August at Sealevel", body: "Old body copy." },
    ],
  });

  // Prior copy stored, no current draft yet: still unknown, and the
  // stored prior copy rides on the diff for the draft-time comparison.
  let diff = await computeSendDiff("copy", { store });
  assert.ok(diff);
  assert.equal(diff.copyChanged, null);
  assert.match(diff.copySummary, /no current draft/);
  assert.deepEqual(diff.priorCopy, {
    runSeq: 1,
    variants: [
      { segment: "", subject: "August at Sealevel", body: "Old body copy." },
    ],
  });

  // Current draft read back from the run's campaign_approval item:
  // identical copy -> false.
  store.draftCopies.set("11:2", {
    subject: "August at Sealevel",
    body: "Old body copy.\n",
  }); // trailing whitespace is not a copy change
  diff = await computeSendDiff("copy", { store });
  assert.ok(diff);
  assert.equal(diff.copyChanged, false);
  assert.match(diff.summary, /copy: unchanged/);

  // Explicit currentCopy option (the draft job's path) wins over the
  // stored item and detects a change.
  diff = await computeSendDiff(
    "copy",
    { store },
    { currentCopy: { subject: "September at Sealevel", body: "Old body copy." } },
  );
  assert.ok(diff);
  assert.equal(diff.copyChanged, true);
  assert.match(diff.summary, /copy: CHANGED/);

  // withCurrentCopy: the pure draft-time patch recomputes verdict +
  // summary on an existing diff without mutating it.
  const base = await computeSendDiff("copy", { store });
  assert.ok(base);
  const patched = withCurrentCopy(base, {
    subject: "Completely new",
    body: "Completely new body",
  });
  assert.equal(patched.copyChanged, true);
  assert.equal(base.copyChanged, false); // untouched
  assert.match(patched.summary, /copy: CHANGED/);

  console.log(
    "[smoke] send_diff: copyChanged is a real comparison against the stored prior copy (null path preserved for pre-snapshot history)",
  );
}

/**
 * Per-segment comparison (SEA-88 x SEA-84): copyChanged is true iff any
 * segment's copy differs OR the segment set changed, and copySummary
 * names the changed segments.
 */
async function testPerSegmentCopyComparison(): Promise<void> {
  const store = new FakeSendDiffStore();
  store.campaigns.set("seg", campaign("13", "seg", 2));
  store.sendRows.set("13", [sent("a@example.com", "2026-07-01T00:00:00Z")]);
  store.audienceEmails.set("13", ["a@example.com"]);
  store.copySnapshots.set("13", {
    runSeq: 1,
    variants: [
      { segment: "hot_only", subject: "Hot", body: "Hot body" },
      { segment: "lapsed", subject: "Lapsed", body: "Lapsed body" },
    ],
  });

  // Identical variant set: unchanged.
  store.draftCopies.set("13:2", {
    variants: [
      { segment: "hot_only", subject: "Hot", body: "Hot body\n" },
      { segment: "lapsed", subject: "Lapsed", body: "Lapsed body" },
    ],
  });
  let diff = await computeSendDiff("seg", { store });
  assert.ok(diff);
  assert.equal(diff.copyChanged, false);
  assert.match(diff.copySummary, /all 2 segments/);

  // One segment edited: changed, and the summary NAMES it.
  store.draftCopies.set("13:2", {
    variants: [
      { segment: "hot_only", subject: "Hot NEW", body: "Hot body" },
      { segment: "lapsed", subject: "Lapsed", body: "Lapsed body" },
    ],
  });
  diff = await computeSendDiff("seg", { store });
  assert.ok(diff);
  assert.equal(diff.copyChanged, true);
  assert.match(diff.copySummary, /edited: hot_only/);
  assert.ok(!diff.copySummary.includes("lapsed"));

  // Segment set changed (variant added, one removed): changed even with
  // every shared segment's copy identical.
  store.draftCopies.set("13:2", {
    variants: [
      { segment: "hot_only", subject: "Hot", body: "Hot body" },
      { segment: "new_students", subject: "Welcome", body: "Welcome body" },
    ],
  });
  diff = await computeSendDiff("seg", { store });
  assert.ok(diff);
  assert.equal(diff.copyChanged, true);
  assert.match(diff.copySummary, /segments added: new_students/);
  assert.match(diff.copySummary, /segments removed: lapsed/);

  // Shape transition (prior single '' copy, current briefed variants):
  // a copy change by definition, named as base removed.
  store.copySnapshots.set("13", {
    runSeq: 1,
    variants: [{ segment: "", subject: "One", body: "One body" }],
  });
  diff = await computeSendDiff("seg", { store });
  assert.ok(diff);
  assert.equal(diff.copyChanged, true);
  assert.match(diff.copySummary, /segments removed: base/);

  console.log(
    "[smoke] send_diff: per-segment copy comparison (edited names segments; set changes count as changes)",
  );
}

async function main(): Promise<void> {
  await testUnknownCampaignThrows();
  await testFirstSendIsNull();
  await testAddedDroppedDetection();
  await testBoundedSamples();
  await testIdenticalAudienceIsEmptyDiff();
  await testCopyComparison();
  await testPerSegmentCopyComparison();
  console.log("[smoke] send_diff: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
