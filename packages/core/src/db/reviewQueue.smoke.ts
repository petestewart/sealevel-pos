import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import { getPool, closePool } from "./client.js";
import { runMigrations } from "./migrate.js";
import { createItem, type Item } from "./items.js";
import {
  getUserSettings,
  setStageApprovals,
  setUserSettings,
} from "./settings.js";
import {
  countStagedApprovedItems,
  listStagedApprovedItems,
  markDeliveryQueued,
  recordDeliverySent,
} from "./delivery.js";

/**
 * DB-backed smoke for the review-queue layer (GH-106): runs the
 * migrations, then exercises the stage_approvals user setting round trip
 * and the staged-approved-items predicates against DATABASE_URL (local
 * docker compose Postgres, or an ephemeral cluster). Seeded rows are
 * deleted at the end.
 *
 * Run: npm run smoke:reviewqueue  (from packages/core)
 */

const SMOKE_USER = `smoke-reviewqueue-${Date.now()}`;
const BY = { id: SMOKE_USER, name: "Smoke Operator" };

function assertOk(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`reviewQueue smoke: ${msg}`);
}

async function testStageApprovalsSetting(): Promise<void> {
  // Default: a user with no row stages nothing.
  const fresh = await getUserSettings(SMOKE_USER);
  assert.equal(fresh.stage_approvals, false, "default stage_approvals false");

  // Turn staging on; the setting round-trips.
  const on = await setStageApprovals(SMOKE_USER, true);
  assert.equal(on.stage_approvals, true, "setStageApprovals(true) sticks");

  // A signature save must NOT clobber the staging preference...
  await setUserSettings(SMOKE_USER, {
    signWithName: true,
    signatureName: "Smoke",
  });
  const afterSig = await getUserSettings(SMOKE_USER);
  assert.equal(
    afterSig.stage_approvals,
    true,
    "signature save preserves stage_approvals",
  );
  assert.equal(afterSig.sign_with_name, true, "signature save applied");

  // ...and a staging save must not clobber the signature.
  const off = await setStageApprovals(SMOKE_USER, false);
  assert.equal(off.stage_approvals, false, "setStageApprovals(false) sticks");
  assert.equal(off.sign_with_name, true, "staging save preserves signature");

  console.log("[smoke] stage_approvals: default/round-trip/no-clobber ok");
}

/** Create a resolved email_reply with the given decision + payload extras. */
async function seedResolved(
  decisionAction: string | null,
  extra: Record<string, unknown> = {},
): Promise<Item> {
  const { item } = await createItem({
    type: "email_reply",
    status: "pending_approval",
    payload: {
      smoke: SMOKE_USER,
      draft_subject: "Re: smoke",
      draft_body: "Hello from the review-queue smoke.",
      ...(decisionAction !== null
        ? {
            decision: {
              action: decisionAction,
              by: BY,
              at: new Date().toISOString(),
              edited: false,
            },
          }
        : {}),
      ...extra,
    },
  });
  const { rows } = await getPool().query<Item>(
    `UPDATE items SET status = 'resolved', resolved_at = now()
     WHERE id = $1 RETURNING *`,
    [item.id],
  );
  return rows[0]!;
}

async function testStagedPredicates(): Promise<void> {
  const staged = await seedResolved("approved");
  const rejected = await seedResolved("rejected");
  const noReply = await seedResolved("no_reply_needed");
  const trashed = await seedResolved("trashed", {
    trashed: { at: new Date().toISOString(), by: BY, reason: "unwanted" },
  });
  const archived = await seedResolved("approved", {
    archived: { at: new Date().toISOString(), by: BY },
  });
  const draftless = await seedResolved("approved", { draft_body: "" });
  const delivered = await seedResolved("approved");
  await recordDeliverySent(delivered.id, {
    messageId: "smoke-msg",
    to: "customer@example.test",
  });

  const ids = (items: Item[]) => new Set(items.map((it) => String(it.id)));
  const listed = ids(await listStagedApprovedItems());
  assertOk(listed.has(String(staged.id)), "approved+no-delivery is staged");
  assertOk(!listed.has(String(rejected.id)), "rejected never staged");
  assertOk(!listed.has(String(noReply.id)), "no_reply_needed never staged");
  assertOk(!listed.has(String(trashed.id)), "trashed never staged");
  assertOk(!listed.has(String(archived.id)), "archived never staged");
  assertOk(!listed.has(String(draftless.id)), "empty draft never staged");
  assertOk(!listed.has(String(delivered.id)), "sent item never staged");

  const before = await countStagedApprovedItems();
  assertOk(before >= 1, "count sees the staged item");

  // Release path: markDeliveryQueued stamps 'queued' and the item leaves
  // the queue. This is exactly what the console's Send approved does.
  const released = await markDeliveryQueued(staged.id);
  assertOk(released !== null, "release queues a staged item");
  const afterRelease = ids(await listStagedApprovedItems());
  assertOk(
    !afterRelease.has(String(staged.id)),
    "released item leaves the queue",
  );

  // Double-send safety: a sent item can never be re-queued by a release.
  const requeueSent = await markDeliveryQueued(delivered.id);
  assert.equal(requeueSent, null, "sent item cannot be re-queued");

  // Reopen naturally unstages: back to pending_approval, out of the queue.
  const reopened = await seedResolved("approved");
  assertOk(
    ids(await listStagedApprovedItems()).has(String(reopened.id)),
    "second staged item listed",
  );
  await getPool().query(
    `UPDATE items SET status = 'pending_approval', resolved_at = NULL
     WHERE id = $1`,
    [reopened.id],
  );
  assertOk(
    !ids(await listStagedApprovedItems()).has(String(reopened.id)),
    "reopened item leaves the queue",
  );

  console.log("[smoke] staged predicates: list/count/release/reopen ok");
}

async function main(): Promise<void> {
  loadEnv();
  await runMigrations();
  try {
    await testStageApprovalsSetting();
    await testStagedPredicates();
  } finally {
    await getPool().query(
      `DELETE FROM items WHERE payload->>'smoke' = $1`,
      [SMOKE_USER],
    );
    await getPool().query(`DELETE FROM user_settings WHERE user_id = $1`, [
      SMOKE_USER,
    ]);
    await closePool();
  }
  console.log("reviewQueue smoke: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
