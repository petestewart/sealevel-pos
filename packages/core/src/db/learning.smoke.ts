import assert from "node:assert/strict";

import {
  buildSignalDigest,
  mineOperatorLessons,
  LEARNING_DIGEST_MAX_SIGNALS,
  type LearningMinerDeps,
} from "../brain/learnRules.js";
import { loadEnv } from "../env.js";
import {
  learningMineJobId,
  learningThresholdKind,
} from "../queue/enqueue.js";
import { closePool, getPool } from "./client.js";
import { runMigrations } from "./migrate.js";
import { createItem, getItemById, resolveItem, type Item } from "./items.js";
import {
  advanceLearningState,
  buildRuleProposalPayload,
  collectLearningSignals,
  countOperatorDecisionsSince,
  createRuleProposalItem,
  getLearningState,
  insertRuleFromProposal,
  listRejectedRuleFingerprints,
  normalizeRuleFingerprint,
  recordRejectedRuleProposal,
  recordRuleInsert,
  ruleInsertOf,
  ruleProposalOf,
  saveRuleProposalEdits,
  signalsFromDecidedItem,
  LEARNING_EVIDENCE_MAX_CHARS,
  type LearningSignal,
  type RuleProposal,
} from "./learning.js";
import { deleteRule, RULES_MAX_INJECTED } from "./settings.js";

/**
 * Smoke for the learning loop (GH-127). The first half is fully offline
 * (pure signal extraction, digest assembly, dedupe against active rules
 * and the rejection memory, cap and payload shapes, the miner run with a
 * MOCKED model call); the second half exercises the SQL guards
 * (approve-inserts-rule with the cap, reject-records-memory, the
 * high-water mark, proposal dedupe) against DATABASE_URL and is skipped
 * with a notice when none is configured (CI runs the offline half; run
 * the DB half locally against docker compose or an ephemeral Postgres 16
 * cluster). Seeded rows are deleted at the end.
 *
 * Run: npm run smoke:learning  (from packages/core)
 */

const BY = { id: "user_smoke", name: "Smoke Operator" };
const SYSTEM = { id: "system", name: "System" };

function decidedPayload(
  action: string,
  by: { id: string; name: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    original_email: { from: "a@b.c", subject: "Class question", body: "Hi" },
    draft_subject: "Re: Class question",
    draft_body: "Final draft body.",
    decision: { action, by, at: "2026-07-19T10:00:00.000Z", edited: false },
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * Offline: signal extraction                                          *
 * ------------------------------------------------------------------ */

function testSignalExtraction(): void {
  // Operator edit: original_draft vs final draft.
  const edit = signalsFromDecidedItem(
    "1",
    decidedPayload("approved", BY, {
      original_draft: { draft_subject: "Re:", draft_body: "AI draft body." },
    }),
    "t1",
  );
  assert.equal(edit.length, 1);
  assert.equal(edit[0]!.kind, "edit");
  assert.equal(edit[0]!.before, "AI draft body.");
  assert.equal(edit[0]!.after, "Final draft body.");

  // Redo history: first revision entry vs final draft, count noted.
  const revision = signalsFromDecidedItem(
    "2",
    decidedPayload("approved", BY, {
      draft_revisions: [
        { draft_subject: "Re:", draft_body: "First AI attempt." },
        { draft_subject: "Re:", draft_body: "Second AI attempt." },
      ],
    }),
    "t2",
  );
  assert.equal(revision.length, 1);
  assert.equal(revision[0]!.kind, "revision");
  assert.equal(revision[0]!.before, "First AI attempt.");
  assert.ok(revision[0]!.note?.includes("2 revision(s)"));

  // Both at once: an edited AND revised item yields both signals.
  const both = signalsFromDecidedItem(
    "3",
    decidedPayload("approved", BY, {
      original_draft: { draft_body: "AI draft body." },
      draft_revisions: [{ draft_body: "First AI attempt." }],
    }),
    "t3",
  );
  assert.deepEqual(
    both.map((s) => s.kind),
    ["edit", "revision"],
  );

  // Rejection carries the rejected draft.
  const rejection = signalsFromDecidedItem(
    "4",
    decidedPayload("rejected", BY),
    "t4",
  );
  assert.equal(rejection.length, 1);
  assert.equal(rejection[0]!.kind, "rejection");
  assert.equal(rejection[0]!.before, "Final draft body.");

  // Operator no-reply keeps the reason; SYSTEM decisions yield nothing
  // (the classifier is not an operator; the loop learns from humans).
  const noReply = signalsFromDecidedItem(
    "5",
    decidedPayload("no_reply_needed", BY, {
      decision: {
        action: "no_reply_needed",
        by: BY,
        at: "t",
        edited: false,
        reason: "Automated receipt.",
      },
    }),
    "t5",
  );
  assert.equal(noReply.length, 1);
  assert.equal(noReply[0]!.kind, "no_reply");
  assert.equal(noReply[0]!.note, "Automated receipt.");
  assert.deepEqual(
    signalsFromDecidedItem("6", decidedPayload("no_reply_needed", SYSTEM), "t"),
    [],
  );

  // Spam and trash decisions are signals; approvals without edits are not.
  assert.equal(
    signalsFromDecidedItem("7", decidedPayload("spam", BY), "t")[0]!.kind,
    "spam",
  );
  assert.equal(
    signalsFromDecidedItem("8", decidedPayload("trashed", BY), "t")[0]!.kind,
    "trash",
  );
  assert.deepEqual(signalsFromDecidedItem("9", decidedPayload("approved", BY), "t"), []);

  // Malformed decisions never crash, never signal.
  assert.deepEqual(signalsFromDecidedItem("10", {}, "t"), []);
  assert.deepEqual(signalsFromDecidedItem("11", { decision: "rejected" }, "t"), []);
  console.log("[smoke] learning: signal extraction from decided payloads");
}

/* ------------------------------------------------------------------ *
 * Offline: digest assembly                                            *
 * ------------------------------------------------------------------ */

function sig(n: number, kind: LearningSignal["kind"] = "edit"): LearningSignal {
  return {
    itemId: String(n),
    kind,
    subject: `Subject ${n}`,
    before: `Before ${n}`,
    after: `After ${n}`,
    resolvedAt: `t${n}`,
  };
}

function testDigestAssembly(): void {
  const signals = [sig(1), sig(2, "rejection"), sig(3)];
  const { digest, included } = buildSignalDigest(signals, [
    "Always include the booking link.",
  ]);
  assert.equal(included.length, 3);
  assert.ok(digest.includes("Signal 1 (item 1)"));
  assert.ok(digest.includes("Signal 3 (item 3)"));
  assert.ok(digest.includes("Always include the booking link."));
  assert.ok(digest.includes("operator rejected the draft"));

  // Oversized windows keep the newest and say how many were omitted.
  const many = Array.from({ length: LEARNING_DIGEST_MAX_SIGNALS + 5 }, (_, i) =>
    sig(i + 1),
  );
  const capped = buildSignalDigest(many, []);
  assert.equal(capped.included.length, LEARNING_DIGEST_MAX_SIGNALS);
  assert.equal(capped.included[0]!.itemId, "6", "newest signals kept");
  assert.ok(capped.digest.includes("5 older omitted"));

  // Oversized excerpts are clipped with a marker.
  const big = { ...sig(1), before: "x".repeat(5_000) };
  const clipped = buildSignalDigest([big], []);
  assert.ok(clipped.digest.includes("[...]"));
  assert.ok(clipped.digest.length < 5_000);
  console.log("[smoke] learning: digest numbering, caps, and omission notes");
}

/* ------------------------------------------------------------------ *
 * Offline: fingerprints + payload shape                               *
 * ------------------------------------------------------------------ */

function testFingerprintsAndPayload(): void {
  // Rephrasings that differ only in case/punctuation/whitespace match.
  const a = normalizeRuleFingerprint("Never open with 'I hope this finds you well.'");
  const b = normalizeRuleFingerprint("  never open with I HOPE this finds you   well ");
  assert.equal(a, b, "normalized fingerprints match across punctuation/case");
  assert.notEqual(a, normalizeRuleFingerprint("Always include the booking link."));

  const proposal: RuleProposal = {
    rule_text: "Keep replies to two short paragraphs.",
    evidence: [
      {
        item_id: "42",
        kind: "edit",
        before: "b".repeat(2_000),
        after: "after text",
      },
    ],
    confidence: 0.85,
    mined_window: { from: "2026-07-01T00:00:00Z", to: "2026-07-19T00:00:00Z", signals: 7 },
  };
  const payload = buildRuleProposalPayload({
    proposal,
    now: "2026-07-19T04:00:00.000Z",
  });
  assert.equal(payload["rule_text"], proposal.rule_text);
  assert.ok("generated_by" in payload, "version stamp present");
  assert.ok(!("decision" in payload), "born undecided");
  assert.ok(!("rule_insert" in payload), "born uninserted");
  const evidence = payload["evidence"] as Array<Record<string, unknown>>;
  assert.equal(
    (evidence[0]!["before"] as string).length,
    LEARNING_EVIDENCE_MAX_CHARS,
    "evidence excerpts capped",
  );
  // Round-trips through the validator both sides read.
  const parsed = ruleProposalOf(payload);
  assert.ok(parsed);
  assert.equal(parsed.confidence, 0.85);
  assert.equal(parsed.mined_window.signals, 7);
  assert.equal(parsed.evidence.length, 1);
  // Malformed payloads validate to null / drop bad entries, never crash.
  assert.equal(ruleProposalOf({}), null);
  assert.equal(ruleProposalOf({ rule_text: "  " }), null);
  const badEvidence = ruleProposalOf({
    rule_text: "r",
    evidence: [{ kind: "edit" }, 7, { item_id: "1", kind: "nope" }],
  });
  assert.ok(badEvidence);
  assert.equal(badEvidence.evidence.length, 0);
  assert.equal(ruleInsertOf({}), null);
  assert.ok(
    ruleInsertOf({ rule_insert: { status: "inserted", at: "t", rule_id: "1" } }),
  );
  console.log("[smoke] learning: fingerprints + proposal payload shape");
}

/* ------------------------------------------------------------------ *
 * Offline: the miner with a mocked model                              *
 * ------------------------------------------------------------------ */

interface MinerScript {
  signals: LearningSignal[];
  capped?: boolean;
  lastResolvedAt?: string | null;
  activeRules?: string[];
  rejected?: string[];
  toolResult?: Record<string, unknown> | Error;
}

function scriptedMiner(script: MinerScript) {
  const filed: RuleProposal[] = [];
  const advanced: Array<{ through: string; signalsSeen: number; proposalsFiled: number }> = [];
  let toolCalls = 0;
  const deps: LearningMinerDeps = {
    runTool: async () => {
      toolCalls++;
      if (script.toolResult instanceof Error) throw script.toolResult;
      return script.toolResult ?? { rules: [] };
    },
    getState: async () => ({ last_mined_at: "2026-07-01T00:00:00.000Z" }),
    collectSignals: async () => ({
      signals: script.signals,
      lastResolvedAt:
        script.lastResolvedAt ??
        (script.signals.length > 0
          ? script.signals[script.signals.length - 1]!.resolvedAt
          : null),
      capped: script.capped ?? false,
    }),
    activeRuleTexts: async () => script.activeRules ?? [],
    rejectedFingerprints: async () =>
      (script.rejected ?? []).map((r) => normalizeRuleFingerprint(r)),
    fileProposal: async (proposal) => {
      filed.push(proposal);
      return { created: true };
    },
    advance: async (through, counters) => {
      advanced.push({ through, ...counters });
    },
    now: () => "2026-07-19T04:00:00.000Z",
  };
  return { deps, filed, advanced, calls: () => toolCalls };
}

async function testMinerRuns(): Promise<void> {
  // Below the signal floor: skip, no model call, no advance (signals
  // accumulate for the next trigger).
  const quiet = scriptedMiner({ signals: [sig(1), sig(2)] });
  const skipped = await mineOperatorLessons(quiet.deps);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "not-enough-signals");
  assert.equal(quiet.calls(), 0, "no model call on a quiet window");
  assert.equal(quiet.advanced.length, 0, "high-water mark not advanced");

  // Happy path: candidates dedupe against active rules AND the rejection
  // memory; a survivor files with resolved evidence; the mark advances.
  const run = scriptedMiner({
    signals: [sig(1), sig(2), sig(3), sig(4)],
    activeRules: ["Always include the booking link."],
    rejected: ["Never use exclamation marks!"],
    toolResult: {
      rules: [
        {
          // Matches an active rule after normalization: dropped.
          rule_text: "always include the booking link",
          evidence_signals: [1, 2],
          confidence: 0.9,
        },
        {
          // Matches a rejected proposal after normalization: dropped.
          rule_text: "Never use exclamation marks",
          evidence_signals: [1, 2],
          confidence: 0.9,
        },
        {
          // Survives; em dash stripped; invalid evidence refs ignored.
          rule_text: "Keep replies short — two paragraphs at most.",
          evidence_signals: [2, 99, 3],
          confidence: 0.8,
        },
      ],
    },
  });
  const mined = await mineOperatorLessons(run.deps);
  assert.equal(mined.status, "mined");
  assert.equal(mined.signals, 4);
  assert.equal(mined.candidates, 3);
  assert.equal(mined.proposalsFiled, 1, "dedupe dropped two candidates");
  assert.equal(run.filed.length, 1);
  const filed = run.filed[0]!;
  assert.ok(!filed.rule_text.includes("—"), "em dash stripped");
  assert.deepEqual(
    filed.evidence.map((e) => e.item_id),
    ["2", "3"],
    "evidence resolved from digest refs; invalid ref dropped",
  );
  assert.equal(filed.mined_window.signals, 4);
  assert.deepEqual(run.advanced, [
    {
      through: "2026-07-19T04:00:00.000Z",
      signalsSeen: 4,
      proposalsFiled: 1,
    },
  ]);

  // Zero candidates is a successful run: the mark still advances (the
  // signals were examined; there was just nothing to learn).
  const nothing = scriptedMiner({
    signals: [sig(1), sig(2), sig(3)],
    toolResult: { rules: [] },
  });
  const none = await mineOperatorLessons(nothing.deps);
  assert.equal(none.status, "mined");
  assert.equal(none.proposalsFiled, 0);
  assert.equal(nothing.advanced.length, 1);

  // A capped window advances only to the last examined decision.
  const cappedRun = scriptedMiner({
    signals: [sig(1), sig(2), sig(3)],
    capped: true,
    lastResolvedAt: "2026-07-10T00:00:00.000Z",
    toolResult: { rules: [] },
  });
  await mineOperatorLessons(cappedRun.deps);
  assert.equal(cappedRun.advanced[0]!.through, "2026-07-10T00:00:00.000Z");

  // A model failure throws (BullMQ retries) with the mark un-advanced.
  const failing = scriptedMiner({
    signals: [sig(1), sig(2), sig(3)],
    toolResult: new Error("api down"),
  });
  await assert.rejects(mineOperatorLessons(failing.deps), /api down/);
  assert.equal(failing.advanced.length, 0);

  // Without an API key and without injected deps: an honest skip.
  const savedKey = process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
  try {
    const noKey = await mineOperatorLessons();
    assert.equal(noKey.status, "skipped");
    assert.equal(noKey.reason, "no-api-key");
  } finally {
    if (savedKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedKey;
  }
  console.log(
    "[smoke] learning: miner floor/dedupe/cap/advance semantics with a mocked model",
  );
}

function testJobIds(): void {
  assert.equal(learningMineJobId("manual-1"), "learnmine-manual-1");
  assert.equal(
    learningThresholdKind("2026-07-01T00:00:00.000Z"),
    learningThresholdKind("2026-07-01T00:00:00.000Z"),
    "threshold kind deterministic per watermark",
  );
  assert.ok(!learningMineJobId(learningThresholdKind("bogus")).includes(":"));
  console.log("[smoke] learning: job ids deterministic and BullMQ-safe");
}

/* ------------------------------------------------------------------ *
 * DB-backed: the SQL guards                                           *
 * ------------------------------------------------------------------ */

async function testDbGuards(): Promise<void> {
  await runMigrations();
  const pool = getPool();
  const marker = `smoke-learning-${Date.now()}`;
  const seededRuleIds: string[] = [];
  const seededItemIds: string[] = [];

  // Save/restore the high-water mark so this smoke never advances a real
  // deployment's mark past unmined signals.
  const stateBefore = await getLearningState();
  try {
    // learning_state: advance is monotonic.
    await advanceLearningState("2000-01-01T00:00:00.000Z", {
      signalsSeen: 0,
      proposalsFiled: 0,
    });
    const state = await getLearningState();
    assert.ok(
      Date.parse(state.last_mined_at) >= Date.parse(stateBefore.last_mined_at),
      "advance never moves the mark backwards",
    );

    // Proposal items dedupe on the normalized fingerprint.
    const proposal: RuleProposal = {
      rule_text: `Keep replies brief (${marker}).`,
      evidence: [],
      confidence: 0.7,
      mined_window: { from: "a", to: "b", signals: 3 },
    };
    const first = await createRuleProposalItem({ proposal });
    seededItemIds.push(String(first.item.id));
    assert.equal(first.created, true);
    const dup = await createRuleProposalItem({
      proposal: { ...proposal, rule_text: `keep REPLIES brief ${marker}` },
    });
    assert.equal(dup.created, false, "rephrased duplicate dedupes to the survivor");
    assert.equal(String(dup.item.id), String(first.item.id));

    // Editable before approval: first edit captures the original and
    // stamps the audit flags; the guarded update refuses decided items.
    const edited = await saveRuleProposalEdits(
      String(first.item.id),
      `Keep replies brief and warm (${marker}).`,
    );
    assert.equal(
      (edited.payload["original_proposal"] as { rule_text?: string }).rule_text,
      proposal.rule_text,
      "first edit captures the AI original",
    );
    assert.equal(edited.payload["draft_edited"], true);
    assert.equal(edited.payload["proposal_edited"], true);

    // rule_insert record round-trips on the item.
    await recordRuleInsert(String(first.item.id), {
      status: "failed",
      error: "Rule limit reached.",
    });
    const withRecord = await getItemById(String(first.item.id));
    assert.equal(ruleInsertOf(withRecord!.payload)?.status, "failed");

    await resolveItem(String(first.item.id));
    await assert.rejects(
      saveRuleProposalEdits(String(first.item.id), "too late"),
      /no pending_approval item/,
      "decided proposals are not editable",
    );

    // Approve path: the insert respects the active-rule cap in SQL.
    const { rows: activeCount } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rules WHERE active`,
    );
    const room = RULES_MAX_INJECTED - Number(activeCount[0]!.count);
    assert.ok(room > 0, "smoke expects headroom under the rule cap");
    const inserted = await insertRuleFromProposal(
      `Learned rule ${marker}.`,
      BY.id,
    );
    assert.notEqual(inserted, "cap");
    if (inserted !== "cap") {
      seededRuleIds.push(inserted.id);
      assert.equal(inserted.category, "learned", "provenance category");
      assert.equal(inserted.active, true);
    }
    // Fill to the cap, then the guarded INSERT refuses.
    for (let i = 1; i < room; i++) {
      const filler = await insertRuleFromProposal(
        `Filler rule ${marker} ${i}.`,
        BY.id,
      );
      assert.notEqual(filler, "cap");
      if (filler !== "cap") seededRuleIds.push(filler.id);
    }
    const overCap = await insertRuleFromProposal(
      `One rule too many ${marker}.`,
      BY.id,
    );
    assert.equal(overCap, "cap", "insert at the cap records honest failure");

    // Reject path: the fingerprint lands in the negative memory, upserted.
    const lesson = `Never say namaste twice (${marker}).`;
    await recordRejectedRuleProposal(lesson, BY.id);
    await recordRejectedRuleProposal(lesson.toUpperCase(), BY.id);
    const fingerprints = await listRejectedRuleFingerprints();
    const fp = normalizeRuleFingerprint(lesson);
    assert.equal(
      fingerprints.filter((f) => f === fp).length,
      1,
      "rejection memory upserts on the fingerprint",
    );

    // Signal collection + threshold count honor the mark and skip system
    // decisions.
    const since = new Date(Date.now() - 60_000).toISOString();
    const opItem = await createItem({
      type: "email_reply",
      status: "pending_approval",
      payload: decidedPayload("rejected", BY, { smoke: marker }),
    });
    seededItemIds.push(String(opItem.item.id));
    await resolveItem(String(opItem.item.id));
    const sysItem = await createItem({
      type: "email_reply",
      status: "pending_approval",
      payload: decidedPayload("no_reply_needed", SYSTEM, { smoke: marker }),
    });
    seededItemIds.push(String(sysItem.item.id));
    await resolveItem(String(sysItem.item.id));

    const collected = await collectLearningSignals(
      since,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const mine = collected.signals.filter((s) =>
      seededItemIds.includes(s.itemId),
    );
    assert.equal(mine.length, 1, "operator rejection collected");
    assert.equal(mine[0]!.kind, "rejection");
    assert.ok(
      !collected.signals.some((s) => s.itemId === String(sysItem.item.id)),
      "system decisions are not signals",
    );
    const count = await countOperatorDecisionsSince(since);
    assert.ok(count >= 1, "threshold count sees the operator decision");
    console.log("[smoke] learning: DB guards (dedupe, edits, cap, memory, signals)");
  } finally {
    // Cleanup: seeded rules, items, memory rows; restore the mark.
    for (const id of seededRuleIds) await deleteRule(id, BY.id);
    if (seededItemIds.length > 0) {
      await pool.query(`DELETE FROM items WHERE id = ANY($1::bigint[])`, [
        seededItemIds,
      ]);
    }
    await pool.query(
      `DELETE FROM rule_proposal_memory WHERE rule_text LIKE '%' || $1 || '%'`,
      [marker],
    );
    await pool.query(
      `UPDATE learning_state SET last_mined_at = $1::timestamptz WHERE id = 1`,
      [stateBefore.last_mined_at],
    );
  }
}

async function main(): Promise<void> {
  loadEnv();
  testSignalExtraction();
  testDigestAssembly();
  testFingerprintsAndPayload();
  await testMinerRuns();
  testJobIds();
  if (process.env.DATABASE_URL) {
    await testDbGuards();
    await closePool();
  } else {
    console.log(
      "[smoke] learning: DATABASE_URL not set; DB guard checks skipped (run against docker compose or an ephemeral Postgres 16)",
    );
  }
  console.log("[smoke] learning loop: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
