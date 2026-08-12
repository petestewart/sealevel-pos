import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import { closePool, getPool } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  campaignOverviewCounts,
  foldOverviewCounts,
  listCampaignSummaries,
  toCampaignSummary,
} from "./campaignStats.js";

/**
 * Smoke for the campaign console stats (SEA-90). The first half is fully
 * offline (the GROUP BY fold and row shaping, including the zero-campaign
 * shapes the widget must render before any campaign exists); the second
 * half exercises the real SQL against DATABASE_URL -- seeding a campaign
 * with an audience snapshot, sends, and DUPLICATE provider events to
 * prove the DISTINCT-per-type aggregation absorbs a replayed webhook --
 * and is skipped with a notice when none is configured (CI runs the
 * offline half; run the DB half locally against docker compose or an
 * ephemeral Postgres 16 cluster). Seeded rows are deleted at the end.
 *
 * Run: npm run smoke:campaignstats  (from packages/core)
 */

const SMOKE_KEY = `smoke.campaignstats.${Date.now()}`;

function testOverviewFold(): void {
  // Empty table: the widget's zero-campaign rendering path.
  assert.deepEqual(foldOverviewCounts([]), { pendingApproval: 0, sending: 0 });

  assert.deepEqual(
    foldOverviewCounts([
      { status: "pending_approval", count: "3" },
      { status: "sending", count: "1" },
    ]),
    { pendingApproval: 3, sending: 1 },
  );

  // One-sided rows leave the other side at zero.
  assert.deepEqual(foldOverviewCounts([{ status: "sending", count: "2" }]), {
    pendingApproval: 0,
    sending: 2,
  });
}

function testSummaryShaping(): void {
  const createdAt = new Date("2026-08-01T00:00:00Z");
  const summary = toCampaignSummary({
    id: "7",
    key: "welcome.2026-08",
    name: "Welcome",
    status: "sent",
    run_seq: 2,
    created_at: createdAt,
    approved_at: null,
    send_at: null,
    recipients: "40",
    delivered: "38",
    opened: "20",
    clicked: "5",
    bounced: "2",
    complained: "0",
  });
  assert.deepEqual(summary, {
    id: "7",
    key: "welcome.2026-08",
    name: "Welcome",
    status: "sent",
    runSeq: 2,
    createdAt,
    approvedAt: null,
    sendAt: null,
    recipients: 40,
    events: { delivered: 38, opened: 20, clicked: 5, bounced: 2, complained: 0 },
  });

  // Multi-run labeled-total shape: for run_seq > 1 the event counts span
  // every run of the campaign row, so delivered can legitimately EXCEED
  // recipients (40-contact snapshot, two runs). Shaping must pass the
  // numbers through untouched; the console labels them "across runs".
  const multiRun = toCampaignSummary({
    id: "8",
    key: "welcome.2026-08",
    name: "Welcome",
    status: "sent",
    run_seq: 2,
    created_at: createdAt,
    approved_at: createdAt,
    send_at: createdAt,
    recipients: "40",
    delivered: "77",
    opened: "31",
    clicked: "9",
    bounced: "3",
    complained: "0",
  });
  assert.equal(multiRun.recipients, 40);
  assert.equal(multiRun.events.delivered, 77);
  assert.equal(multiRun.runSeq, 2);
}

/**
 * DB half: seed one pending campaign (no audience, no sends -- the sparse
 * shape) and one sending campaign with a THREE-contact audience snapshot
 * but only two sends (so recipients provably comes from campaign_audience,
 * not from counting send rows) and events including an exact duplicate
 * webhook row; assert both queries; then simulate a re-run (bump run_seq,
 * add an 'initial#2' send + event) and assert the documented campaign-row
 * totals-across-runs semantics. Everything is deleted at the end;
 * campaign_events has no append-only trigger, and the RESTRICT foreign
 * keys allow deletes in child-first order.
 */
async function testDbQueries(): Promise<void> {
  await runMigrations();
  const pool = getPool();

  const before = await campaignOverviewCounts();
  const listedBefore = await listCampaignSummaries();

  const seeded: {
    contactIds: string[];
    campaignIds: string[];
    sendIds: string[];
  } = { contactIds: [], campaignIds: [], sendIds: [] };

  try {
    // Three contacts (no consent events: those are append-only and would
    // make the contacts undeletable). The third gets an audience row but
    // never a send, splitting snapshot size from send count.
    for (const n of [1, 2, 3]) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO contacts (email) VALUES ($1) RETURNING id`,
        [`${SMOKE_KEY}.c${n}@smoke.example`],
      );
      seeded.contactIds.push(rows[0]!.id);
    }

    const insertCampaign = async (
      suffix: string,
      status: string,
      approved: boolean,
    ): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (key, name, audience_view, status, approved_by, approved_at)
         VALUES ($1, $2, 'smoke_view', $3, $4, $5)
         RETURNING id`,
        [
          `${SMOKE_KEY}.${suffix}`,
          `Smoke ${suffix}`,
          status,
          approved ? "smoke-user" : null,
          approved ? new Date() : null,
        ],
      );
      seeded.campaignIds.push(rows[0]!.id);
      return rows[0]!.id;
    };

    const pendingId = await insertCampaign("pending", "pending_approval", false);
    const sendingId = await insertCampaign("sending", "sending", true);

    // Audience snapshot: all three contacts, sending campaign only.
    for (const contactId of seeded.contactIds) {
      await pool.query(
        `INSERT INTO campaign_audience (campaign_id, contact_id) VALUES ($1, $2)`,
        [sendingId, contactId],
      );
    }

    // Sends: only the FIRST TWO contacts (the third is snapshot-only).
    // dedupe_key just needs the shape here; the derivation lives in the
    // enqueue job (SEA-84), not this reader.
    const insertSend = async (
      contactIdx: number,
      step: string,
      fakeKey: string,
    ): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO campaign_sends (campaign_id, contact_id, email, step, dedupe_key, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, 'sent', now())
         RETURNING id`,
        [
          sendingId,
          seeded.contactIds[contactIdx]!,
          `${SMOKE_KEY}.c${contactIdx + 1}@smoke.example`,
          step,
          fakeKey,
        ],
      );
      seeded.sendIds.push(rows[0]!.id);
      return rows[0]!.id;
    };
    await insertSend(0, "initial", "0".repeat(64));
    await insertSend(1, "initial", "1".repeat(64));

    // Events: send 1 delivered + opened, send 2 delivered + bounced --
    // with the second send's 'delivered' delivered TWICE (a replayed
    // provider webhook). The aggregate must count it once.
    const events: [string, string][] = [
      [seeded.sendIds[0]!, "delivered"],
      [seeded.sendIds[0]!, "opened"],
      [seeded.sendIds[1]!, "delivered"],
      [seeded.sendIds[1]!, "delivered"],
      [seeded.sendIds[1]!, "bounced"],
    ];
    for (const [sendId, type] of events) {
      await pool.query(
        `INSERT INTO campaign_events (send_id, type) VALUES ($1, $2)`,
        [sendId, type],
      );
    }

    // Overview: exactly one more pending_approval and one more sending
    // than before the seed.
    const after = await campaignOverviewCounts();
    assert.equal(after.pendingApproval, before.pendingApproval + 1);
    assert.equal(after.sending, before.sending + 1);

    // Detail list: our two campaigns present with the right shapes.
    const listed = await listCampaignSummaries();
    assert.equal(listed.length, listedBefore.length + 2);

    const pending = listed.find((c) => c.id === pendingId);
    assert.ok(pending, "pending campaign listed");
    assert.equal(pending.status, "pending_approval");
    assert.equal(pending.recipients, 0);
    assert.deepEqual(pending.events, {
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
    });

    const sending = listed.find((c) => c.id === sendingId);
    assert.ok(sending, "sending campaign listed");
    assert.equal(sending.status, "sending");
    // recipients = 3, the campaign_audience snapshot size, even though
    // only TWO send rows exist: the count must come from the snapshot,
    // never from counting sends.
    assert.equal(sending.recipients, 3);
    assert.equal(sending.runSeq, 1);
    // delivered = 2 despite three delivered EVENT rows: the duplicate
    // webhook counted once (DISTINCT send per type).
    assert.deepEqual(sending.events, {
      delivered: 2,
      opened: 1,
      clicked: 0,
      bounced: 1,
      complained: 0,
    });

    // Re-run (run_seq bump, per the 0011 comment: fresh sends carrying
    // the run in `step`, e.g. 'initial#2'). The schema has no per-run
    // column on sends or the snapshot, so the documented semantics are
    // campaign-row totals ACROSS runs: the run-2 delivered adds to run
    // 1's count, and the snapshot count is unchanged by the re-run.
    await pool.query(`UPDATE campaigns SET run_seq = 2 WHERE id = $1`, [
      sendingId,
    ]);
    const rerunSendId = await insertSend(0, "initial#2", "2".repeat(64));
    await pool.query(
      `INSERT INTO campaign_events (send_id, type) VALUES ($1, 'delivered')`,
      [rerunSendId],
    );

    const relisted = await listCampaignSummaries();
    const rerun = relisted.find((c) => c.id === sendingId);
    assert.ok(rerun, "re-run campaign listed");
    assert.equal(rerun.runSeq, 2);
    assert.equal(rerun.recipients, 3, "snapshot count unchanged by re-run");
    assert.deepEqual(
      rerun.events,
      { delivered: 3, opened: 1, clicked: 0, bounced: 1, complained: 0 },
      "event counts are totals across runs (2 from run 1 + 1 from run 2)",
    );
  } finally {
    // Child-first teardown (every FK is ON DELETE RESTRICT).
    if (seeded.sendIds.length > 0) {
      await pool.query(
        `DELETE FROM campaign_events WHERE send_id = ANY($1::bigint[])`,
        [seeded.sendIds],
      );
      await pool.query(`DELETE FROM campaign_sends WHERE id = ANY($1::bigint[])`, [
        seeded.sendIds,
      ]);
    }
    if (seeded.campaignIds.length > 0) {
      await pool.query(
        `DELETE FROM campaign_audience WHERE campaign_id = ANY($1::bigint[])`,
        [seeded.campaignIds],
      );
      await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::bigint[])`, [
        seeded.campaignIds,
      ]);
    }
    if (seeded.contactIds.length > 0) {
      await pool.query(`DELETE FROM contacts WHERE id = ANY($1::bigint[])`, [
        seeded.contactIds,
      ]);
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  testOverviewFold();
  testSummaryShaping();
  if (process.env.DATABASE_URL) {
    await testDbQueries();
    await closePool();
  } else {
    console.log(
      "[smoke] campaignstats: DATABASE_URL not set; DB query checks skipped (run against docker compose or an ephemeral Postgres 16)",
    );
  }
  console.log("[smoke] campaign stats: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
