import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import { suspectedSpamPayload } from "../jobs/emailDraft.js";
import { gmailStateJobId } from "../queue/enqueue.js";
import {
  applyGmailState,
  gmailStateActionForDecision,
  GMAIL_STATE_ACTIONS,
  isGmailStateAction,
  type GmailStateAction,
  type GmailStateClient,
} from "./state.js";

/**
 * Offline smoke for the read = decided Gmail state layer (GH-115
 * follow-on). Everything here is pure or mocked: the Gmail client is a
 * recording fake, config is driven through env vars restored afterwards,
 * and no mailbox, DB, or Redis is touched.
 *
 * Run: npm run smoke:gmailstate  (from packages/core)
 */

/** A recording fake satisfying GmailStateClient. */
function fakeClient(): { client: GmailStateClient; calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (id: string): Promise<void> => {
      calls.push(`${name}:${id}`);
    };
  return {
    calls,
    client: {
      markRead: record("markRead"),
      trashMessage: record("trash"),
      untrashMessage: record("untrash"),
      reportSpam: record("reportSpam"),
      unreportSpam: record("unreportSpam"),
    },
  };
}

const GMAIL_VARS = [
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_USER",
] as const;

function withGmailEnv<T>(configured: boolean, fn: () => Promise<T>): Promise<T> {
  const saved = GMAIL_VARS.map((v) => [v, process.env[v]] as const);
  for (const v of GMAIL_VARS) {
    if (configured) process.env[v] = "smoke-placeholder";
    else delete process.env[v];
  }
  return fn().finally(() => {
    for (const [v, val] of saved) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
  });
}

async function testUnconfiguredSkip(): Promise<void> {
  await withGmailEnv(false, async () => {
    const { client, calls } = fakeClient();
    const result = await applyGmailState("mark_read", "gm-1", client);
    assert.equal(result.status, "skipped");
    assert.ok(result.reason?.includes("not configured"));
    assert.deepEqual(calls, [], "no Gmail calls when unconfigured");
  });
  console.log("[smoke] gmail-state: unconfigured degrades to a logged skip");
}

async function testActionDispatch(): Promise<void> {
  await withGmailEnv(true, async () => {
    const cases: Array<[GmailStateAction, string[]]> = [
      ["mark_read", ["markRead:gm-2"]],
      // Trash also clears UNREAD (a trash decision IS a decision).
      ["trash", ["trash:gm-2", "markRead:gm-2"]],
      // reportSpam folds the UNREAD removal into its single modify call.
      ["spam", ["reportSpam:gm-2"]],
      // Restore does NOT re-mark unread (a human demonstrably looked).
      ["untrash", ["untrash:gm-2"]],
      ["unspam", ["unreportSpam:gm-2"]],
    ];
    for (const [action, expected] of cases) {
      const { client, calls } = fakeClient();
      const result = await applyGmailState(action, "gm-2", client);
      assert.equal(result.status, "applied", `${action} applied`);
      assert.deepEqual(calls, expected, `${action} performs ${expected.join(", ")}`);
    }
  });
  console.log(
    "[smoke] gmail-state: mark_read/trash/spam/untrash/unspam dispatch to the right client calls",
  );
}

async function testClientErrorPropagates(): Promise<void> {
  await withGmailEnv(true, async () => {
    const failing: GmailStateClient = {
      markRead: async () => {
        throw new Error("HTTP 500 backend fell over");
      },
      trashMessage: async () => undefined,
      untrashMessage: async () => undefined,
      reportSpam: async () => undefined,
      unreportSpam: async () => undefined,
    };
    // A Gmail failure must THROW (so BullMQ retries; the ops are
    // idempotent so retrying is always safe), never a silent skip.
    await assert.rejects(
      applyGmailState("mark_read", "gm-3", failing),
      /HTTP 500/,
    );
  });
  console.log("[smoke] gmail-state: a Gmail failure throws so BullMQ retries");
}

function testDecisionWiring(): void {
  // The decision -> Gmail op table (read = decided). One shared function
  // keeps the console actions and worker preflight from drifting.
  assert.equal(gmailStateActionForDecision("approved"), "mark_read");
  assert.equal(gmailStateActionForDecision("rejected"), "mark_read");
  assert.equal(gmailStateActionForDecision("no_reply_needed"), "mark_read");
  assert.equal(gmailStateActionForDecision("trashed"), "trash");
  assert.equal(gmailStateActionForDecision("spam"), "spam");
  console.log(
    "[smoke] gmail-state: decision wiring (approve/reject/no-reply -> mark_read, trashed -> trash, spam -> spam)",
  );
}

function testJobIdAndActionGuard(): void {
  // Deterministic, BullMQ-safe (no ":"), unique per item+action.
  const id = gmailStateJobId("123", "mark_read");
  assert.equal(id, "gmailstate-123-mark_read");
  assert.equal(gmailStateJobId("123", "mark_read"), id, "deterministic");
  assert.ok(!id.includes(":"), "no colon");
  assert.notEqual(gmailStateJobId("123", "trash"), id, "action-distinct");
  assert.notEqual(gmailStateJobId("124", "mark_read"), id, "item-distinct");

  for (const a of GMAIL_STATE_ACTIONS) assert.ok(isGmailStateAction(a));
  assert.ok(!isGmailStateAction("delete_everything"));
  assert.ok(!isGmailStateAction(undefined));
  console.log("[smoke] gmail-state: jobId deterministic + action guard closed");
}

function testSuspectedSpamPayload(): void {
  // The suspected-spam preflight files a PENDING, DRAFTLESS item whose
  // payload carries the flag and the threading metadata, and nothing else
  // a drafting run would have produced.
  const payload = suspectedSpamPayload(
    {
      from: "Junk Sender <junk@junkmail.example>",
      subject: "You won",
      body: "Click here",
      to: "hello@sealevel.example",
      messageId: "<junk.1@junkmail.example>",
      gmailId: "gm-junk-1",
      threadId: "th-junk-1",
    },
    { kind: "domain", value: "junkmail.example" },
    "2026-07-19T00:00:00.000Z",
  );
  const flag = payload["suspected_spam"] as {
    matched_signal: { kind: string; value: string };
    at: string;
  };
  assert.equal(flag.matched_signal.kind, "domain");
  assert.equal(flag.matched_signal.value, "junkmail.example");
  assert.equal(flag.at, "2026-07-19T00:00:00.000Z");
  const original = payload["original_email"] as Record<string, unknown>;
  assert.equal(original["from"], "Junk Sender <junk@junkmail.example>");
  assert.equal(original["to"], "hello@sealevel.example");
  const meta = payload["email_meta"] as Record<string, unknown>;
  assert.equal(meta["gmailId"], "gm-junk-1", "gmailId rides email_meta");
  assert.equal(meta["threadId"], "th-junk-1");
  assert.ok(!("draft_body" in payload), "no draft: drafting was skipped");
  assert.ok(!("draft_subject" in payload), "no draft subject either");
  assert.ok(!("decision" in payload), "NOT decided: operator confirms");
  assert.ok("generated_by" in payload, "version stamp present");

  // Degenerate inbound: fields fall back, flag still forms.
  const bare = suspectedSpamPayload({}, { kind: "sender", value: "x@y.z" });
  const bareOriginal = bare["original_email"] as Record<string, unknown>;
  assert.equal(bareOriginal["from"], "(unknown sender)");
  assert.ok(!("email_meta" in bare), "no meta fields, no email_meta key");
  console.log(
    "[smoke] suspected-spam payload: pending + draftless + flagged, meta carried, not decided",
  );
}

async function main(): Promise<void> {
  loadEnv();
  await testUnconfiguredSkip();
  await testActionDispatch();
  await testClientErrorPropagates();
  testDecisionWiring();
  testJobIdAndActionGuard();
  testSuspectedSpamPayload();
  console.log("[smoke] gmail-state: all offline assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
