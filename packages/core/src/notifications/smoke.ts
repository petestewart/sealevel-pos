import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import type { Item } from "../db/items.js";
import { emitItemEvent, type ItemEventPayload } from "./emit.js";

/**
 * Notifications smoke check (no Novu account required).
 *
 * 1. No-op path: with NOVU_SECRET_KEY unset, emitItemEvent logs and
 *    returns { sent: false } without touching the network.
 * 2. With-key path: with a key set and a stubbed trigger, emitItemEvent
 *    calls the trigger once with the right workflow, subscribers, and
 *    payload.
 * 3. If a real NOVU_SECRET_KEY is present in the environment, do one real
 *    trigger instead of the stub for step 2.
 *
 * Run: npm run smoke:novu --workspace packages/core
 */

const item: Item = {
  id: "42",
  type: "email.reply_draft",
  domain: "email",
  status: "pending_approval",
  audience: null,
  assignee: "pete",
  payload: { draft: "Hi! Yes, the 6am class runs on holidays." },
  created_at: new Date("2026-07-08T12:00:00Z"),
  resolved_at: null,
};

async function main(): Promise<void> {
  loadEnv();
  const realKey = process.env.NOVU_SECRET_KEY;

  // 1. No-op path.
  delete process.env.NOVU_SECRET_KEY;
  const noop = await emitItemEvent("item.pending_approval", item, "brain");
  assert.deepEqual(noop, { sent: false, reason: "NOVU_SECRET_KEY unset" });
  console.log("no-op path OK: emit without key returned", noop);

  // 2. With-key path via stubbed trigger.
  process.env.NOVU_SECRET_KEY = "smoke-test-key";
  process.env.NOVU_SUBSCRIBER_PETE ??= "pete";
  process.env.NOVU_SUBSCRIBER_ALISON ??= "alison";
  const calls: Array<{ workflowId: string; subscriberIds: string[]; payload: ItemEventPayload }> = [];
  const stubbed = await emitItemEvent("item.pending_approval", item, "brain", async (args) => {
    calls.push(args);
  });
  assert.deepEqual(stubbed, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.workflowId, "item.pending_approval");
  assert.deepEqual(calls[0]!.subscriberIds, [
    process.env.NOVU_SUBSCRIBER_PETE,
    process.env.NOVU_SUBSCRIBER_ALISON,
  ]);
  assert.equal(calls[0]!.payload.itemId, "42");
  assert.equal(calls[0]!.payload.actor, "brain");
  console.log("with-key path OK: stub trigger received", JSON.stringify(calls[0]));

  // 3. Failure path: a throwing trigger is contained, never thrown.
  const failed = await emitItemEvent("item.pending_approval", item, "brain", async () => {
    throw new Error("boom");
  });
  assert.deepEqual(failed, { sent: false, reason: "boom" });
  console.log("failure path OK: trigger error contained", failed);

  // 4. Real trigger, only when a real key exists in the environment.
  if (realKey) {
    process.env.NOVU_SECRET_KEY = realKey;
    const real = await emitItemEvent("item.pending_approval", item, "smoke");
    console.log("real Novu trigger result:", real);
  } else {
    delete process.env.NOVU_SECRET_KEY;
    console.log("no real NOVU_SECRET_KEY; skipped live trigger");
  }

  console.log("notifications smoke: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
