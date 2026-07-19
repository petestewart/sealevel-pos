import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import { emailDraft } from "../jobs/emailDraft.js";
import { getPool, closePool } from "./client.js";
import { runMigrations } from "./migrate.js";
import { createItem, type Item } from "./items.js";
import {
  deleteSpamSignal,
  listSpamSignals,
  matchesSpamSignal,
  recordSpamSignal,
} from "./spamSignals.js";
import {
  listTrashedItems,
  markGmailTrashed,
  restoreTrashedItem,
  trashItem,
  countTrashedItems,
} from "./trash.js";

/**
 * DB-backed smoke for the spam/trash layer (GH-115 follow-on): runs the
 * migrations, then exercises the spam-signal record/match round trip, the
 * trash/spam decision + restore round trip, and the suspected-spam
 * ingestion preflight, against DATABASE_URL (local docker compose
 * Postgres, or an ephemeral cluster in CI). Seeded rows are deleted at
 * the end; signals are deleted via the same API the settings UI will use.
 *
 * Run: npm run smoke:spamtrash  (from packages/core)
 */

const SMOKE_SENDER = `Junk Sender <smoke.spamtrash.${Date.now()}@smoke-spamtrash.example>`;
const SMOKE_DOMAIN = "smoke-spamtrash.example";
const BY = { id: "smoke-user", name: "Smoke Operator" };

function assertOk(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`spamTrash smoke: ${msg}`);
}

async function testSpamSignalRoundTrip(): Promise<string[]> {
  // Record: saves the sender AND the domain, lowercased.
  await recordSpamSignal(SMOKE_SENDER, BY, "smoke reason");

  // Exact sender matches (case-insensitively, display name stripped).
  const senderHit = await matchesSpamSignal(SMOKE_SENDER.toUpperCase());
  assertOk(senderHit !== null, "sender should match after record");
  assert.equal(senderHit!.kind, "sender");

  // A DIFFERENT address on the same domain matches the domain signal.
  const domainHit = await matchesSpamSignal(`other@${SMOKE_DOMAIN}`);
  assertOk(domainHit !== null, "domain should match after record");
  assert.equal(domainHit!.kind, "domain");
  assert.equal(domainHit!.value, SMOKE_DOMAIN);

  // A clean sender does not match.
  const clean = await matchesSpamSignal("customer@clean-example.example");
  assert.equal(clean, null, "unrelated sender must not match");

  // Re-recording upserts: hit_count bumps instead of duplicating.
  await recordSpamSignal(SMOKE_SENDER, BY);
  const again = await matchesSpamSignal(SMOKE_SENDER);
  assert.equal(again!.hit_count, 2, "repeat confirm bumps hit_count");

  // Listed for the (future) settings UI.
  const listed = await listSpamSignals(500);
  const ours = listed.filter(
    (s) => s.value === SMOKE_DOMAIN || s.value.endsWith(`@${SMOKE_DOMAIN}`),
  );
  // >= 2 (not == 2): a previously failed smoke run may have left signals
  // on this domain behind; cleanup below removes everything we find.
  assertOk(ours.length >= 2, "sender + domain signals are listed");

  console.log("[smoke] spam signals: record/match/upsert/list round trip ok");
  return ours.map((s) => String(s.id));
}

async function testTrashRestoreRoundTrip(): Promise<Item> {
  const { item } = await createItem({
    type: "email_reply",
    domain: "email",
    status: "pending_approval",
    payload: {
      original_email: { from: SMOKE_SENDER, subject: "smoke", body: "junk" },
      email_meta: { gmailId: "gm-smoke-1" },
    },
  });

  // Trash decision: resolves with the decide()-shaped audit + trash marker.
  const trashed = await trashItem(item.id, BY, "unwanted");
  assertOk(trashed !== null, "trash should win on a pending item");
  assert.equal(trashed!.status, "resolved");
  const decision = trashed!.payload["decision"] as Record<string, unknown>;
  assert.equal(decision["action"], "trashed");
  assert.deepEqual(decision["by"], BY);
  assert.equal(decision["edited"], false);
  const marker = trashed!.payload["trashed"] as Record<string, unknown>;
  assert.equal(marker["reason"], "unwanted");
  assert.equal(marker["prev_status"], "pending_approval");

  // Double trash loses cleanly.
  assert.equal(await trashItem(item.id, BY, "unwanted"), null);

  // Appears in the Trash listing and count.
  const listed = await listTrashedItems(1, 200);
  assertOk(
    listed.some((it) => it.id === item.id),
    "trashed item should be listed",
  );
  assertOk((await countTrashedItems()) >= 1, "trashed count includes it");

  // Worker stamp after the Gmail move.
  await markGmailTrashed(item.id);
  const stamped = await listTrashedItems(1, 200);
  const mine = stamped.find((it) => it.id === item.id)!;
  assert.equal(
    (mine.payload["trashed"] as Record<string, unknown>)["gmail_trashed"],
    true,
  );

  // Restore: back to pending, decision preserved on history, marker gone.
  const restored = await restoreTrashedItem(item.id);
  assertOk(restored !== null, "restore should win on a trashed item");
  assert.equal(restored!.status, "pending_approval");
  assert.equal(restored!.resolved_at, null);
  assertOk(!("trashed" in restored!.payload), "marker removed");
  assertOk(!("decision" in restored!.payload), "decision cleared");
  const history = restored!.payload["decision_history"] as Array<
    Record<string, unknown>
  >;
  assert.equal(history[history.length - 1]!["action"], "trashed");

  // Double restore loses cleanly.
  assert.equal(await restoreTrashedItem(item.id), null);

  // Spam flavor: decision action is "spam", marker reason "spam".
  const spammed = await trashItem(item.id, BY, "spam", "smoke spam reason");
  assertOk(spammed !== null, "spam decision should win after restore");
  const spamDecision = spammed!.payload["decision"] as Record<string, unknown>;
  assert.equal(spamDecision["action"], "spam");
  assert.equal(spamDecision["reason"], "smoke spam reason");
  assert.equal(
    (spammed!.payload["trashed"] as Record<string, unknown>)["reason"],
    "spam",
  );

  console.log(
    "[smoke] trash: decision audit + marker + list + restore + spam flavor ok",
  );
  return spammed!;
}

/**
 * The ingestion preflight, end to end against the DB: a sender with a
 * recorded spam signal files a PENDING draftless item flagged
 * suspected_spam (no model call, no draft), and a plain no-reply sender
 * still files its resolved no-reply item (the GH-115 path, unbroken).
 */
async function testSuspectedSpamPreflight(): Promise<Item> {
  const preflight = emailDraft.preflight!;
  const messageId = `<smoke.suspect.${Date.now()}@${SMOKE_DOMAIN}>`;
  const outcome = await preflight({
    payload: {
      from: `another.person@${SMOKE_DOMAIN}`,
      subject: "totally real offer",
      body: "buy now",
      messageId,
    },
  });
  assert.equal(outcome.handled, true, "spam-signal match handles the run");

  const { rows } = await getPool().query<Item>(
    `SELECT * FROM items WHERE payload->>'dedupe_key' = $1`,
    [messageId],
  );
  assert.equal(rows.length, 1, "exactly one suspected-spam item");
  const item = rows[0]!;
  assert.equal(item.status, "pending_approval", "PENDING: operator confirms");
  const flag = item.payload["suspected_spam"] as {
    matched_signal: { kind: string; value: string };
  };
  assert.equal(flag.matched_signal.value, SMOKE_DOMAIN);
  assertOk(!("draft_body" in item.payload), "no draft was made");
  assertOk(!("decision" in item.payload), "not decided");

  // Idempotent on retry: same messageId dedupes to the same item.
  const retry = await preflight({
    payload: {
      from: `another.person@${SMOKE_DOMAIN}`,
      subject: "totally real offer",
      body: "buy now",
      messageId,
    },
  });
  assert.equal(retry.handled, true);
  const { rows: after } = await getPool().query(
    `SELECT count(*)::int AS n FROM items WHERE payload->>'dedupe_key' = $1`,
    [messageId],
  );
  assert.equal((after[0] as { n: number }).n, 1, "retry dedupes, no duplicate");

  // A clean no-reply sender still takes the GH-115 path (resolved item).
  const noReplyId = `<smoke.noreply.${Date.now()}@notifier.example>`;
  const noReply = await preflight({
    payload: {
      from: "Notifier <no-reply@notifier.example>",
      subject: "Your receipt",
      body: "Thanks for your order.",
      messageId: noReplyId,
    },
  });
  assert.equal(noReply.handled, true, "no-reply gate still fires");
  const { rows: nr } = await getPool().query<Item>(
    `SELECT * FROM items WHERE payload->>'dedupe_key' = $1`,
    [noReplyId],
  );
  assert.equal(nr.length, 1);
  assert.equal(nr[0]!.status, "resolved");
  assert.equal(
    (nr[0]!.payload["decision"] as Record<string, unknown>)["action"],
    "no_reply_needed",
  );

  console.log(
    "[smoke] preflight: spam sender -> pending suspected-spam item (no draft); no-reply gate unbroken",
  );
  return item;
}

async function main(): Promise<void> {
  loadEnv();
  if (!process.env["DATABASE_URL"]) {
    console.error(
      "spamTrash smoke needs DATABASE_URL (docker compose up -d, or an ephemeral Postgres)",
    );
    process.exit(1);
  }
  const applied = await runMigrations();
  if (applied.length > 0) {
    console.log(`[smoke] migrations applied: ${applied.join(", ")}`);
  }

  const cleanupIds: string[] = [];
  const signalIds = await testSpamSignalRoundTrip();
  try {
    const trashedItemRow = await testTrashRestoreRoundTrip();
    cleanupIds.push(trashedItemRow.id);
    const suspect = await testSuspectedSpamPreflight();
    cleanupIds.push(suspect.id);
  } finally {
    // Delete seeded rows; signals go through the real delete API.
    for (const id of signalIds) {
      const removed = await deleteSpamSignal(id);
      assertOk(removed, `signal ${id} should delete`);
    }
    assert.equal(
      await matchesSpamSignal(SMOKE_SENDER),
      null,
      "deleted signals no longer match",
    );
    await getPool().query(
      `DELETE FROM items
       WHERE payload->'original_email'->>'from' LIKE '%${SMOKE_DOMAIN}%'
          OR payload->'original_email'->>'from' LIKE '%notifier.example%'`,
    );
  }
  console.log("[smoke] spam/trash: all DB-backed assertions passed");
}

main().then(
  () => closePool().then(() => process.exit(0)),
  (err) => {
    console.error(err);
    return closePool().then(() => process.exit(1));
  },
);
