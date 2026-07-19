import { emitItemEvent } from "../notifications/emit.js";
import { workerVersion } from "../version.js";
import { getPool } from "./client.js";
import { createItem, type CreateItemResult, type Item } from "./items.js";
import { RULE_MAX_CHARS, RULES_MAX_INJECTED, type Rule } from "./settings.js";
import { enqueueLearningMine, learningThresholdKind } from "../queue/enqueue.js";

/**
 * Learning-loop data layer (GH-127): the rule_proposal item type and the
 * two small state stores behind the miner.
 *
 * The loop connects two things the app already has: the SIGNAL (operator
 * decisions on email drafts: edits captured under original_draft,
 * revision history under draft_revisions, rejections, no-reply and
 * spam/trash calls) and the MEMORY (the studio rules table, whose active
 * rules are injected into every drafting prompt). The missing middle is
 * distillation, and it is human-gated end to end: the miner only ever
 * FILES a rule_proposal item born pending_approval; a rule reaches the
 * rules table exclusively through the console's Approve click, and every
 * learned rule stays visible and deletable in Settings like any other.
 *
 * Signal tracking (the issue's refinement comment):
 * - High-water mark: learning_state.last_mined_at; the miner reads only
 *   decisions resolved after it and advances it only after a successful
 *   run, so no signal is examined twice and a failed run reprocesses.
 * - Negative memory: rejecting a proposal records its normalized
 *   fingerprint in rule_proposal_memory, so the same lesson is not
 *   re-proposed. Approved lessons dedupe against active rules directly.
 */

/** Minimum signals in the window before the miner spends a model call. */
export const LEARNING_MIN_SIGNALS = 3;

/**
 * Threshold trigger (hybrid schedule): when this many operator decisions
 * have accumulated since the high-water mark, a mine run is enqueued
 * without waiting for the nightly cron.
 */
export const LEARNING_MINE_THRESHOLD = 10;

/** Max decided items one mine run examines (window cap). */
export const LEARNING_SIGNAL_ROW_CAP = 200;

/** Evidence excerpts stored on a proposal are capped to stay readable. */
export const LEARNING_EVIDENCE_MAX_CHARS = 400;

/* ------------------------------------------------------------------ *
 * learning_state: the high-water mark                                 *
 * ------------------------------------------------------------------ */

export interface LearningState {
  /** ISO timestamp; decisions resolved after this are still unmined. */
  last_mined_at: string;
  runs: number;
  signals_seen: number;
  proposals_filed: number;
  updated_at: string;
}

export async function getLearningState(): Promise<LearningState> {
  const { rows } = await getPool().query<LearningState>(
    `SELECT last_mined_at::text, runs, signals_seen, proposals_filed,
            updated_at::text
     FROM learning_state WHERE id = 1`,
  );
  const state = rows[0];
  if (!state) {
    // The migration seeds the row; a missing row means a manual deletion.
    throw new Error("learning_state row is missing; re-run migrations");
  }
  return state;
}

/**
 * Advance the high-water mark after a successful mine run. GREATEST keeps
 * the mark monotonic: a late-finishing retry of an older window can never
 * move it backwards and cause double-mining.
 */
export async function advanceLearningState(
  minedThrough: string,
  counters: { signalsSeen: number; proposalsFiled: number },
): Promise<void> {
  await getPool().query(
    `UPDATE learning_state
     SET last_mined_at = GREATEST(last_mined_at, $1::timestamptz),
         runs = runs + 1,
         signals_seen = signals_seen + $2,
         proposals_filed = proposals_filed + $3,
         updated_at = now()
     WHERE id = 1`,
    [minedThrough, counters.signalsSeen, counters.proposalsFiled],
  );
}

/* ------------------------------------------------------------------ *
 * Fingerprints + negative memory                                      *
 * ------------------------------------------------------------------ */

/**
 * Normalized fingerprint of a rule text for dedupe: lowercased,
 * punctuation stripped, whitespace collapsed. Deliberately simple and
 * inspectable; the known limitation is that only near-identical phrasings
 * match, so a semantic rephrase of a rejected lesson can still surface
 * once more (and its rejection is then remembered under its own
 * fingerprint). Exact-normalized matching is the honest v1 tradeoff:
 * anything smarter (embeddings, fuzzy similarity) would be a black box in
 * a loop whose whole point is inspectability.
 */
export function normalizeRuleFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

/**
 * Remember a REJECTED proposal so rephrasings are not re-proposed.
 * Upserts on the fingerprint: rejecting the same lesson twice refreshes
 * the timestamp instead of duplicating the row.
 */
export async function recordRejectedRuleProposal(
  ruleText: string,
  rejectedBy: string,
): Promise<void> {
  const text = ruleText.trim().slice(0, RULE_MAX_CHARS);
  const fingerprint = normalizeRuleFingerprint(text);
  if (fingerprint.length === 0) return;
  await getPool().query(
    `INSERT INTO rule_proposal_memory (fingerprint, rule_text, rejected_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (fingerprint) DO UPDATE
       SET rejected_at = now(), rejected_by = EXCLUDED.rejected_by`,
    [fingerprint, text, rejectedBy],
  );
}

/** Rejected-proposal fingerprints, newest first, bounded. */
export async function listRejectedRuleFingerprints(
  limit = 500,
): Promise<string[]> {
  const { rows } = await getPool().query<{ fingerprint: string }>(
    `SELECT fingerprint FROM rule_proposal_memory
     ORDER BY rejected_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.fingerprint);
}

/* ------------------------------------------------------------------ *
 * Signal collection                                                   *
 * ------------------------------------------------------------------ */

export type LearningSignalKind =
  | "edit"
  | "revision"
  | "rejection"
  | "no_reply"
  | "spam"
  | "trash";

/** One operator correction extracted from a decided item. */
export interface LearningSignal {
  itemId: string;
  kind: LearningSignalKind;
  /** Inbound email subject, for context. */
  subject: string;
  /** What the AI wrote (excerpt), when applicable. */
  before?: string;
  /** What the operator kept/changed it to (excerpt), when applicable. */
  after?: string;
  /** Extra context (a no-reply reason, a revision count). */
  note?: string;
  resolvedAt: string;
}

function strOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract the operator-correction signals from ONE decided email_reply
 * payload (pure; exported for the offline smoke). System decisions (the
 * no-reply classifier, by.id === "system") are not operator signals and
 * yield nothing: the loop learns from humans only.
 */
export function signalsFromDecidedItem(
  itemId: string,
  payload: Record<string, unknown>,
  resolvedAt: string,
): LearningSignal[] {
  const decision = payload["decision"];
  if (typeof decision !== "object" || decision === null) return [];
  const d = decision as { action?: unknown; by?: { id?: unknown } };
  const action = typeof d.action === "string" ? d.action : undefined;
  const byId = typeof d.by?.id === "string" ? d.by.id : undefined;
  if (!action || byId === "system") return [];

  const original = (payload["original_email"] ?? {}) as { subject?: unknown };
  const subject = strOf(original.subject) ?? "(no subject)";
  const finalBody = strOf(payload["draft_body"]);
  const signals: LearningSignal[] = [];

  if (action === "approved") {
    // Operator edits: the first-edit capture (original_draft) vs the
    // final draft. Only a real difference is a signal.
    const originalDraft = (payload["original_draft"] ?? {}) as {
      draft_body?: unknown;
    };
    const before = strOf(originalDraft.draft_body);
    if (before && finalBody && before !== finalBody) {
      signals.push({
        itemId,
        kind: "edit",
        subject,
        before,
        after: finalBody,
        resolvedAt,
      });
    }
    // Redo/revision requests: draft_revisions holds the prior drafts the
    // operator asked to have redone. The typed instruction itself is not
    // persisted on the item, so the signal is the first AI draft vs the
    // final approved draft, annotated with how many redos it took.
    const revisions = payload["draft_revisions"];
    if (Array.isArray(revisions) && revisions.length > 0) {
      const first = revisions[0] as { draft_body?: unknown };
      const firstBody = strOf(first?.draft_body);
      if (firstBody && finalBody && firstBody !== finalBody) {
        signals.push({
          itemId,
          kind: "revision",
          subject,
          before: firstBody,
          after: finalBody,
          note: `operator requested ${revisions.length} revision(s) before approving`,
          resolvedAt,
        });
      }
    }
  } else if (action === "rejected") {
    if (finalBody) {
      signals.push({
        itemId,
        kind: "rejection",
        subject,
        before: finalBody,
        note: "the operator rejected this draft outright; nothing was sent",
        resolvedAt,
      });
    }
  } else if (action === "no_reply_needed") {
    const reason = strOf((d as { reason?: unknown }).reason);
    signals.push({
      itemId,
      kind: "no_reply",
      subject,
      ...(reason !== undefined ? { note: reason } : {}),
      resolvedAt,
    });
  } else if (action === "spam" || action === "trashed") {
    signals.push({
      itemId,
      kind: action === "spam" ? "spam" : "trash",
      subject,
      note:
        action === "spam"
          ? "the operator confirmed this email as spam"
          : "the operator moved this email to the trash",
      resolvedAt,
    });
  }
  return signals;
}

export interface CollectedSignals {
  signals: LearningSignal[];
  /** resolved_at of the last examined row (advance target when capped). */
  lastResolvedAt: string | null;
  /** True when the row cap was hit (more decisions remain unmined). */
  capped: boolean;
}

/**
 * Read the operator-correction signals from decided email replies in
 * (since, through], oldest first, capped at rowCap rows. When the cap is
 * hit the caller must advance the high-water mark only to lastResolvedAt
 * so the remainder is picked up by the next run.
 */
export async function collectLearningSignals(
  since: string,
  through: string,
  rowCap = LEARNING_SIGNAL_ROW_CAP,
): Promise<CollectedSignals> {
  const { rows } = await getPool().query<{
    id: string;
    payload: Record<string, unknown>;
    resolved_at: string;
  }>(
    `SELECT id::text, payload, resolved_at::text
     FROM items
     WHERE type = 'email_reply' AND status = 'resolved'
       AND resolved_at > $1::timestamptz AND resolved_at <= $2::timestamptz
     ORDER BY resolved_at ASC, id ASC
     LIMIT $3`,
    [since, through, rowCap],
  );
  const signals = rows.flatMap((row) =>
    signalsFromDecidedItem(row.id, row.payload, row.resolved_at),
  );
  return {
    signals,
    lastResolvedAt: rows.length > 0 ? rows[rows.length - 1]!.resolved_at : null,
    capped: rows.length >= rowCap,
  };
}

/**
 * Count operator decisions accumulated since the high-water mark, for the
 * cheap threshold trigger. One bounded COUNT over decided email replies;
 * system (classifier) decisions are excluded, matching what the miner
 * treats as a signal.
 */
export async function countOperatorDecisionsSince(
  since: string,
): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM items
     WHERE type = 'email_reply' AND status = 'resolved'
       AND resolved_at > $1::timestamptz
       AND coalesce(payload->'decision'->'by'->>'id', '') <> 'system'`,
    [since],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Threshold trigger (best-effort, called from the console decide path):
 * when LEARNING_MINE_THRESHOLD operator decisions have accumulated since
 * the last mine, enqueue a mine run. The jobId is deterministic per
 * high-water mark, so the burst of decisions that crosses the threshold
 * enqueues once, not once per decision. Never throws: a miss only means
 * the nightly cron picks the signals up instead.
 */
export async function maybeEnqueueLearningMineOnThreshold(): Promise<boolean> {
  try {
    const state = await getLearningState();
    const count = await countOperatorDecisionsSince(state.last_mined_at);
    if (count < LEARNING_MINE_THRESHOLD) return false;
    await enqueueLearningMine(learningThresholdKind(state.last_mined_at));
    return true;
  } catch (err) {
    console.warn(
      `[learning] threshold check failed (mining waits for the nightly run): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * rule_proposal items                                                 *
 * ------------------------------------------------------------------ */

/** One evidence entry stored on a rule_proposal payload. */
export interface RuleEvidence {
  item_id: string;
  kind: LearningSignalKind;
  /** Short excerpt of what the AI wrote, when applicable. */
  before?: string;
  /** Short excerpt of what the operator changed it to, when applicable. */
  after?: string;
  note?: string;
}

/** The proposal fields of a rule_proposal payload, validated. */
export interface RuleProposal {
  rule_text: string;
  evidence: RuleEvidence[];
  confidence: number;
  mined_window: { from: string; to: string; signals: number };
}

const SIGNAL_KINDS: readonly LearningSignalKind[] = [
  "edit",
  "revision",
  "rejection",
  "no_reply",
  "spam",
  "trash",
];

/**
 * Validate the proposal fields of a rule_proposal payload. Untrusted data
 * (payloads are jsonb); returns null for anything malformed so callers
 * degrade to an honest "malformed proposal" instead of crashing.
 */
export function ruleProposalOf(
  payload: Record<string, unknown>,
): RuleProposal | null {
  const ruleText = strOf(payload["rule_text"]);
  if (!ruleText || ruleText.trim().length === 0) return null;
  const rawEvidence = payload["evidence"];
  const evidence: RuleEvidence[] = Array.isArray(rawEvidence)
    ? rawEvidence.flatMap((entry) => {
        const e = entry as {
          item_id?: unknown;
          kind?: unknown;
          before?: unknown;
          after?: unknown;
          note?: unknown;
        };
        const itemId = strOf(e.item_id);
        const kind = (SIGNAL_KINDS as readonly unknown[]).includes(e.kind)
          ? (e.kind as LearningSignalKind)
          : null;
        if (!itemId || !kind) return [];
        return [
          {
            item_id: itemId,
            kind,
            ...(strOf(e.before) !== undefined ? { before: strOf(e.before)! } : {}),
            ...(strOf(e.after) !== undefined ? { after: strOf(e.after)! } : {}),
            ...(strOf(e.note) !== undefined ? { note: strOf(e.note)! } : {}),
          },
        ];
      })
    : [];
  const confidence =
    typeof payload["confidence"] === "number" &&
    Number.isFinite(payload["confidence"])
      ? (payload["confidence"] as number)
      : 0;
  const rawWindow = (payload["mined_window"] ?? {}) as {
    from?: unknown;
    to?: unknown;
    signals?: unknown;
  };
  return {
    rule_text: ruleText,
    evidence,
    confidence,
    mined_window: {
      from: strOf(rawWindow.from) ?? "",
      to: strOf(rawWindow.to) ?? "",
      signals:
        typeof rawWindow.signals === "number" ? rawWindow.signals : 0,
    },
  };
}

export interface RuleProposalInput {
  proposal: RuleProposal;
  /** Injectable clock for tests. */
  now?: string;
}

/**
 * Build a rule_proposal payload (pure; exported for the offline smoke).
 * The version stamp is applied structurally, never through a prompt.
 */
export function buildRuleProposalPayload(
  input: RuleProposalInput,
): Record<string, unknown> {
  const now = input.now ?? new Date().toISOString();
  const { proposal } = input;
  return {
    rule_text: proposal.rule_text.trim().slice(0, RULE_MAX_CHARS),
    evidence: proposal.evidence.slice(0, 3).map((e) => ({
      ...e,
      ...(e.before !== undefined
        ? { before: e.before.slice(0, LEARNING_EVIDENCE_MAX_CHARS) }
        : {}),
      ...(e.after !== undefined
        ? { after: e.after.slice(0, LEARNING_EVIDENCE_MAX_CHARS) }
        : {}),
    })),
    confidence: proposal.confidence,
    mined_window: proposal.mined_window,
    miner: { at: now },
    generated_by: { commit: workerVersion(), at: now },
  };
}

/**
 * File a pending rule_proposal item. Inert by design: nothing reaches the
 * rules table until a human approves in the console. The dedupe key (the
 * normalized rule fingerprint) caps unresolved proposals at one per
 * distinct lesson DB-wide, so a re-run over the same window (a retry
 * before the high-water mark advanced) cannot duplicate them.
 */
export async function createRuleProposalItem(
  input: RuleProposalInput,
): Promise<CreateItemResult> {
  const fingerprint = normalizeRuleFingerprint(input.proposal.rule_text);
  const result = await createItem({
    type: "rule_proposal",
    domain: "learning",
    status: "pending_approval",
    payload: buildRuleProposalPayload(input),
    ...(fingerprint.length > 0 ? { dedupeKey: `rule:${fingerprint}` } : {}),
  });
  if (result.created) {
    await emitItemEvent("item.pending_approval", result.item, "brain");
  }
  return result;
}

/**
 * Save a human edit to a pending proposal's rule text (the rule analogue
 * of saveDraftEdits / saveKbProposalEdits): rule_text is replaced, the AI
 * original is captured under original_proposal on the FIRST edit only,
 * and both proposal_edited and draft_edited are set -- the latter because
 * decideItem's no-edits branch reads payload.draft_edited to stamp the
 * decision audit's `edited` flag. Guarded on pending_approval; a lost
 * race throws with the same "no pending_approval item" message the
 * stale-card handling keys on.
 */
export async function saveRuleProposalEdits(
  id: string,
  ruleText: string,
): Promise<Item> {
  const text = ruleText.replace(/\r\n/g, "\n").trim();
  if (text.length === 0 || text.length > RULE_MAX_CHARS) {
    throw new Error(`Rule text must be 1 to ${RULE_MAX_CHARS} characters`);
  }
  const { rows: currentRows } = await getPool().query<Item>(
    `SELECT * FROM items
     WHERE id = $1 AND type = 'rule_proposal' AND status = 'pending_approval'`,
    [id],
  );
  const current = currentRows[0];
  if (!current) {
    throw new Error(
      `saveRuleProposalEdits: no pending_approval item with id ${id}`,
    );
  }
  // No-op save hygiene (GH-40 pattern): identical text writes nothing.
  if (strOf(current.payload["rule_text"]) === text) return current;

  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = payload
           || CASE WHEN payload ? 'original_proposal' THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'original_proposal',
                jsonb_build_object('rule_text', payload->'rule_text')
              ) END
           || jsonb_build_object(
                'rule_text', $2::text,
                'proposal_edited', true,
                'draft_edited', true
              )
     WHERE id = $1 AND type = 'rule_proposal' AND status = 'pending_approval'
     RETURNING *`,
    [id, text],
  );
  const item = rows[0];
  if (!item) {
    throw new Error(
      `saveRuleProposalEdits: no pending_approval item with id ${id}`,
    );
  }
  return item;
}

/* ------------------------------------------------------------------ *
 * Approve path: insert into the rules table, honestly capped          *
 * ------------------------------------------------------------------ */

/**
 * Rule-insert outcome recorded on the item payload under `rule_insert`:
 *   inserted  the rule row was created (rule_id points at it)
 *   failed    the insert did not happen (cap reached, or an error);
 *             reopen + re-approve after fixing is the retry path
 */
export interface RuleInsertRecord {
  status: "inserted" | "failed";
  at: string;
  rule_id?: string;
  /** Operator-facing detail for failures. No em dashes. */
  error?: string;
}

/** Validate payload.rule_insert, or null (absent / malformed). */
export function ruleInsertOf(
  payload: Record<string, unknown>,
): RuleInsertRecord | null {
  const raw = payload["rule_insert"] as Partial<RuleInsertRecord> | undefined;
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw.status === "inserted" || raw.status === "failed") &&
    typeof raw.at === "string"
  ) {
    return raw as RuleInsertRecord;
  }
  return null;
}

/**
 * Insert an approved lesson into the studio rules table, honestly capped:
 * the INSERT only fires while fewer than RULES_MAX_INJECTED rules are
 * active, in the same statement, so approving at the cap yields "cap"
 * instead of silently creating a rule the prompt renderer would drop.
 * (Two simultaneous approves can in principle both pass the subquery;
 * renderRulesBlock still hard-caps injection and warns, so the failure
 * mode of that unlikely race is a logged warning, never a bloated
 * prompt.) Category "learned" marks provenance in the Settings list.
 */
export async function insertRuleFromProposal(
  ruleText: string,
  updatedBy: string,
): Promise<Rule | "cap"> {
  const text = ruleText.trim();
  if (text.length === 0 || text.length > RULE_MAX_CHARS) {
    throw new Error(`Rule text must be 1 to ${RULE_MAX_CHARS} characters`);
  }
  const { rows } = await getPool().query<Rule>(
    `INSERT INTO rules (rule_text, category, updated_by)
     SELECT $1::text, 'learned', $2::text
     WHERE (SELECT count(*) FROM rules WHERE active) < $3::int
     RETURNING id::text, rule_text, category, active,
               created_at::text, updated_at::text, updated_by`,
    [text, updatedBy, RULES_MAX_INJECTED],
  );
  return rows[0] ?? "cap";
}

/** Record the rule-insert outcome on a decided rule_proposal item. */
export async function recordRuleInsert(
  id: string,
  record: Omit<RuleInsertRecord, "at">,
): Promise<void> {
  const full: RuleInsertRecord = {
    ...record,
    ...(record.error !== undefined ? { error: record.error.slice(0, 500) } : {}),
    at: new Date().toISOString(),
  };
  await getPool().query(
    `UPDATE items
     SET payload = payload || jsonb_build_object('rule_insert', $2::jsonb)
     WHERE id = $1 AND type = 'rule_proposal'`,
    [id, JSON.stringify(full)],
  );
}
