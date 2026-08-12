import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  AudienceCandidate,
  AudienceEntry,
  AudienceStore,
  CampaignRow,
} from "../db/campaignAudience.js";
import {
  buildAudience,
  DEFAULT_AUDIENCE_VIEW,
  EXCLUSION_REASONS,
  type BuildAudienceDeps,
} from "./buildAudience.js";

/**
 * Offline smoke for campaigns.build_audience (SEA-82). Everything is
 * served by local fakes: no MCP server or Postgres is touched. The DB
 * layer itself (lateral latest-consent join, suppressions email join,
 * transactional snapshot replace) runs against the real SEA-80 schema via
 * a local `npm run migrate` + docker compose, per repo convention.
 *
 * Run: npm run smoke:audience  (from packages/core)
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

/** In-memory AudienceStore recording every snapshot write. */
class FakeAudienceStore implements AudienceStore {
  candidates: AudienceCandidate[] = [];
  campaigns = new Map<string, CampaignRow>();
  snapshots: Array<{
    campaignId: string;
    entries: AudienceEntry[];
    snapshotAt: Date;
  }> = [];
  /** Override the stored-count answer to simulate a verification gap. */
  countOverride: number | null = null;

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
    // Replace semantics: a re-build supersedes the previous snapshot.
    this.snapshots = this.snapshots.filter((s) => s.campaignId !== campaignId);
    this.snapshots.push({ campaignId, entries, snapshotAt });
  }
  async countAudience(campaignId: string): Promise<number> {
    if (this.countOverride !== null) return this.countOverride;
    return (
      this.snapshots.find((s) => s.campaignId === campaignId)?.entries.length ??
      0
    );
  }
}

function candidate(
  overrides: Partial<AudienceCandidate> & {
    contactId: string;
    analyticsClientId: string;
  },
): AudienceCandidate {
  return {
    email: `${overrides.contactId}@example.com`,
    isAmbiguous: false,
    ambiguousReason: null,
    consentState: "subscribed",
    suppressed: false,
    ...overrides,
  };
}

function depsWith(
  store: FakeAudienceStore,
  viewRows: Array<Record<string, unknown>>,
  options: { queries?: string[]; now?: Date } = {},
): BuildAudienceDeps {
  return {
    pageSelect: async function* (select: string) {
      options.queries?.push(select);
      // Serve in run_sql-sized pages to exercise multi-page assembly.
      for (let i = 0; i < viewRows.length; i += 200) {
        yield viewRows.slice(i, i + 200);
      }
    } as typeof import("../tools/analytics.js").pageSelect,
    store,
    log: () => {},
    now: () => options.now ?? new Date("2026-08-11T19:00:00Z"), // 12:00 PT
  };
}

async function testConfigGate(): Promise<void> {
  await withEnv({}, async () => {
    const store = new FakeAudienceStore();
    const result = await buildAudience({}, depsWith(store, []));
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "analytics_unconfigured");
    assert.equal(store.snapshots.length, 0);
  });
  console.log(
    "[smoke] build_audience: config gate (unset analytics env = logged skip)",
  );
}

async function testBlackoutGate(): Promise<void> {
  await withEnv(ANALYTICS_ENV, async () => {
    const store = new FakeAudienceStore();
    // 09:30Z on a PDT date = 02:30 America/Los_Angeles: mid-rebuild.
    const result = await buildAudience(
      {},
      depsWith(store, [], { now: new Date("2026-08-11T09:30:00Z") }),
    );
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "analytics_blackout");
    // ignoreBlackout overrides (tests/operator use).
    const forced = await buildAudience(
      { ignoreBlackout: true },
      depsWith(store, [], { now: new Date("2026-08-11T09:30:00Z") }),
    );
    assert.equal(forced.status, "dry_run");
  });
  console.log("[smoke] build_audience: blackout gate (02:15-06:00 PT skip)");
}

/** Store + view fixture covering EVERY exclusion reason plus survivors. */
function filterChainFixture(): {
  store: FakeAudienceStore;
  viewRows: Array<Record<string, unknown>>;
} {
  const store = new FakeAudienceStore();
  store.candidates = [
    candidate({ contactId: "1", analyticsClientId: "101", email: "ok@example.com" }),
    candidate({
      contactId: "2",
      analyticsClientId: "102",
      isAmbiguous: true,
      ambiguousReason: "sync-dupe: duplicate mb_client_id 42 in Mindbody pull",
    }),
    candidate({ contactId: "3", analyticsClientId: "103", email: "" }),
    candidate({ contactId: "4", analyticsClientId: "104", consentState: "unsubscribed" }),
    candidate({ contactId: "5", analyticsClientId: "105", consentState: null }),
    candidate({
      contactId: "6",
      analyticsClientId: "106",
      email: "held@example.com",
      suppressed: true,
    }),
    // Two live contacts sharing one stamp: reconcile invariant broken.
    candidate({ contactId: "7", analyticsClientId: "107" }),
    candidate({ contactId: "8", analyticsClientId: "107" }),
    candidate({
      contactId: "9",
      analyticsClientId: "109",
      email: "second@example.com",
    }),
  ];
  const viewRows = [
    { client_id: 101, segment: "post_first_visit" },
    { client_id: 102, segment: "post_first_visit" }, // ambiguous flag
    { client_id: 103, segment: "post_first_visit" }, // no email
    { client_id: 104, segment: "post_first_visit" }, // unsubscribed
    { client_id: 105, segment: "post_first_visit" }, // empty ledger
    { client_id: 106, segment: "post_first_visit" }, // suppressed
    { client_id: 107, segment: "post_first_visit" }, // double stamp
    { client_id: 108, segment: "post_first_visit" }, // unmappable
    { client_id: 109, segment: "week_two_nudge" }, // segment passthrough
    { client_id: 109, segment: "week_two_nudge" }, // duplicate view row
  ];
  return { store, viewRows };
}

async function testDryRunFilterChain(): Promise<void> {
  await withEnv(ANALYTICS_ENV, async () => {
    const { store, viewRows } = filterChainFixture();
    const queries: string[] = [];
    const result = await buildAudience({}, depsWith(store, viewRows, { queries }));

    assert.equal(result.status, "dry_run");
    assert.equal(result.audienceView, DEFAULT_AUDIENCE_VIEW);
    assert.equal(
      queries[0],
      `SELECT client_id, segment FROM ${DEFAULT_AUDIENCE_VIEW} ORDER BY client_id`,
    );
    // Duplicate view row deduped and counted.
    assert.equal(result.viewRows, 9);
    assert.equal(result.duplicateViewRows, 1);
    // Survivors: 101 and 109, with segments passed straight through.
    assert.deepEqual(
      result.recipients.map((r) => [r.contactId, r.email, r.segment]),
      [
        ["1", "ok@example.com", "post_first_visit"],
        ["9", "second@example.com", "week_two_nudge"],
      ],
    );
    assert.deepEqual(result.segmentCounts, {
      post_first_visit: 1,
      week_two_nudge: 1,
    });
    // Every exclusion reason, categorized once, first-reason-wins.
    assert.deepEqual(result.exclusionCounts, {
      unmappable: 1, // 108
      ambiguous: 2, // 102 (flag) + 107 (double stamp)
      no_email: 1, // 103
      unsubscribed: 2, // 104 (opted out) + 105 (empty ledger)
      suppressed: 1, // 106
    });
    // Exclusion detail rows explain themselves.
    const byId = (id: string) =>
      result.exclusions.find((e) => e.analyticsClientId === id)!;
    assert.match(byId("102").detail, /^sync-dupe:/);
    assert.match(byId("105").detail, /empty.*not consent/);
    assert.match(byId("107").detail, /stamped on 2 live contacts/);
    assert.equal(byId("108").contactId, null);
    // The reconciliation identity: view rows = recipients + drops.
    const dropped = Object.values(result.exclusionCounts).reduce(
      (a, b) => a + b,
      0,
    );
    assert.equal(result.viewRows, result.recipients.length + dropped);
    assert.equal(EXCLUSION_REASONS.length, Object.keys(result.exclusionCounts).length);
    // Dry-run wrote NOTHING and needed no campaign row.
    assert.equal(store.snapshots.length, 0);
    assert.equal(result.snapshotAt, null);
    assert.equal(result.campaignId, null);
    // The done-when summary carries every count.
    assert.match(
      result.summary,
      /^9 qualified from v_campaign_post_first_visit, 2 in audience, 7 excluded \(2 unsubscribed, 1 suppressed, 2 ambiguous, 1 no email, 1 unmappable\)$/,
    );
  });
  console.log(
    "[smoke] build_audience: dry-run filter chain (every exclusion reason, segment passthrough, counts reconcile, no writes)",
  );
}

async function testRealBuildSnapshots(): Promise<void> {
  await withEnv(ANALYTICS_ENV, async () => {
    const { store, viewRows } = filterChainFixture();
    store.campaigns.set("post-first-visit-2026-08", {
      id: "77",
      key: "post-first-visit-2026-08",
      name: "Post first visit follow-up",
      status: "draft",
      audienceView: "v_campaign_post_first_visit",
      runSeq: 1,
    });
    const queries: string[] = [];
    const result = await buildAudience(
      { campaignKey: "post-first-visit-2026-08" },
      depsWith(store, viewRows, { queries }),
    );
    assert.equal(result.status, "built");
    assert.equal(result.campaignId, "77");
    // The view comes from the CAMPAIGN ROW, not the caller.
    assert.match(queries[0]!, /FROM v_campaign_post_first_visit ORDER BY/);
    // Snapshot frozen: same survivors, one snapshot_at for the whole run.
    assert.equal(store.snapshots.length, 1);
    const snap = store.snapshots[0]!;
    assert.equal(snap.campaignId, "77");
    assert.deepEqual(
      snap.entries,
      [
        { contactId: "1", segment: "post_first_visit" },
        { contactId: "9", segment: "week_two_nudge" },
      ],
    );
    assert.ok(result.snapshotAt instanceof Date);
    assert.equal(snap.snapshotAt, result.snapshotAt);

    // A re-build REPLACES the snapshot (no accretion across runs).
    const again = await buildAudience(
      { campaignKey: "post-first-visit-2026-08" },
      depsWith(store, viewRows),
    );
    assert.equal(again.status, "built");
    assert.equal(store.snapshots.length, 1);
    assert.equal(store.snapshots[0]!.entries.length, 2);
  });
  console.log(
    "[smoke] build_audience: real build (snapshot frozen + verified, rebuild replaces)",
  );
}

async function testRealBuildGuards(): Promise<void> {
  await withEnv(ANALYTICS_ENV, async () => {
    const store = new FakeAudienceStore();
    // Unknown campaign key: loud failure, never a silent dry-run.
    await assert.rejects(
      buildAudience({ campaignKey: "nope" }, depsWith(store, [])),
      /no campaign with key 'nope'/,
    );
    // A sent campaign's audience is history; rebuilding it is refused.
    store.campaigns.set("done", {
      id: "1",
      key: "done",
      name: "Done",
      status: "sent",
      audienceView: "v_campaign_post_first_visit",
      runSeq: 1,
    });
    await assert.rejects(
      buildAudience({ campaignKey: "done" }, depsWith(store, [])),
      /is sent; rebuilding/,
    );
    // An APPROVED campaign's snapshot is frozen too: the audience is part
    // of what the human approved, so a rebuild would make the approval
    // ceremonial. Requires moving back to draft/pending_approval.
    store.campaigns.set("signed-off", {
      id: "3",
      key: "signed-off",
      name: "Signed off",
      status: "approved",
      audienceView: "v_campaign_post_first_visit",
      runSeq: 1,
    });
    await assert.rejects(
      buildAudience({ campaignKey: "signed-off" }, depsWith(store, [])),
      /is approved; its approved audience snapshot is frozen/,
    );
    assert.equal(store.snapshots.length, 0); // nothing written by refusals
    // pending_approval is still rebuildable (nothing signed off yet).
    store.campaigns.set("pending", {
      id: "4",
      key: "pending",
      name: "Pending",
      status: "pending_approval",
      audienceView: "v_campaign_post_first_visit",
      runSeq: 1,
    });
    const pending = await buildAudience(
      { campaignKey: "pending" },
      depsWith(store, []),
    );
    assert.equal(pending.status, "built");
    // A hostile/typo view name never reaches the query.
    await assert.rejects(
      buildAudience(
        { view: "clients; DROP TABLE clients" },
        depsWith(store, []),
      ),
      /not a bare identifier/,
    );
    // Snapshot count verification: a mismatch fails the build loudly.
    store.campaigns.set("verify", {
      id: "2",
      key: "verify",
      name: "Verify",
      status: "draft",
      audienceView: "v_campaign_post_first_visit",
      runSeq: 1,
    });
    store.candidates = [
      candidate({ contactId: "1", analyticsClientId: "101" }),
    ];
    store.countOverride = 0;
    await assert.rejects(
      buildAudience(
        { campaignKey: "verify" },
        depsWith(store, [{ client_id: 101, segment: "post_first_visit" }]),
      ),
      /snapshot verification failed/,
    );
  });
  console.log(
    "[smoke] build_audience: guards (missing campaign, sent/approved status, view identifier, snapshot verification)",
  );
}

/**
 * The CLI mode gate (regression for the silent-no-op finding): `build`
 * without --campaign must exit non-zero with an unmistakable error BEFORE
 * touching analytics or the database -- it must never quietly degrade
 * into a dry run whose successful-looking report hides that nothing was
 * written. Spawns the real built entrypoint with a stripped environment
 * (no DATABASE_URL, no analytics config), so any accidental fall-through
 * to a dry run would surface as a different failure, not exit code 2.
 */
async function testCliModeGate(): Promise<void> {
  const cli = fileURLToPath(new URL("./runBuildAudience.js", import.meta.url));
  const env = { ...process.env };
  delete env["DATABASE_URL"];
  delete env["SEALEVEL_MCP_URL"];
  delete env["SEALEVEL_MCP_ANALYTICS_TOKEN"];
  const run = (
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [cli, ...args],
        { env, timeout: 30_000 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code?: number }).code ?? null)
              : err
                ? null
                : 0;
          if (err && code === null) reject(err);
          else resolve({ code, stdout, stderr });
        },
      );
    });

  // build without --campaign: loud failure, exit 2, no report printed.
  const noKey = await run(["build"]);
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /requires --campaign/);
  assert.match(noKey.stderr, /refusing to fall back to a dry run/);
  assert.doesNotMatch(noKey.stdout, /recipient list/);
  // No mode at all (running the script directly): same loud failure.
  const noMode = await run([]);
  assert.equal(noMode.code, 2);
  assert.match(noMode.stderr, /missing or unknown mode/);
  // dry-run refuses --campaign: the write path is only reachable through
  // the entrypoint named for it.
  const wrongDoor = await run(["dry-run", "--campaign", "x"]);
  assert.equal(wrongDoor.code, 2);
  assert.match(wrongDoor.stderr, /never writes and takes no --campaign/);
  // build refuses --view: a real build's view comes from the campaign row.
  const viewOnBuild = await run(["build", "--campaign", "x", "--view", "v_x"]);
  assert.equal(viewOnBuild.code, 2);
  assert.match(viewOnBuild.stderr, /--view is only for dry runs/);
  console.log(
    "[smoke] build_audience: CLI mode gate (build without --campaign fails loudly, no silent dry-run fallback)",
  );
}

async function testEmptyAudience(): Promise<void> {
  await withEnv(ANALYTICS_ENV, async () => {
    const store = new FakeAudienceStore();
    store.campaigns.set("empty", {
      id: "9",
      key: "empty",
      name: "Empty",
      status: "draft",
      audienceView: "v_campaign_post_first_visit",
      runSeq: 1,
    });
    const result = await buildAudience(
      { campaignKey: "empty" },
      depsWith(store, []),
    );
    assert.equal(result.status, "built");
    assert.equal(result.recipients.length, 0);
    // An empty qualified set still freezes an (empty) snapshot: "nobody
    // qualified when it was built" is itself a reproducible fact.
    assert.equal(store.snapshots.length, 1);
    assert.equal(store.snapshots[0]!.entries.length, 0);
  });
  console.log("[smoke] build_audience: empty audience (empty snapshot is still a snapshot)");
}

async function main(): Promise<void> {
  await testConfigGate();
  await testBlackoutGate();
  await testDryRunFilterChain();
  await testRealBuildSnapshots();
  await testRealBuildGuards();
  await testEmptyAudience();
  await testCliModeGate();
  console.log("[smoke] build_audience: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
