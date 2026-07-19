import { createHash } from "node:crypto";

import { emitItemEvent } from "../notifications/emit.js";
import { workerVersion } from "../version.js";
import { getPool } from "./client.js";
import { createItem, type CreateItemResult, type Item } from "./items.js";

/**
 * The kb_update item type (KB write-back epic GH-114; design doc
 * docs/design/kb-write-back.md). A kb_update item is a PROPOSED knowledge
 * base change riding the existing items backbone: born pending_approval,
 * decided in the console with the same DecisionRecord audit as email
 * replies, and only then written to the wiki by the kb.write worker job
 * (kb/write.ts) through the MCP server's gated write_wiki_page tool.
 * Creating one is inert: no KB write happens until a human approves.
 *
 * Payload layout (flat, per the design doc):
 *   target_page       wiki page name, normalized (lowercase, no .md)
 *   change_kind       "edit" | "new_page"
 *   base_content      page content the proposal was computed against
 *                     ("" for a new page)
 *   base_hash         sha256 hex of base_content ("" for a new page);
 *                     the write tool's staleness guard
 *   proposed_content  the FULL proposed page content (not a patch)
 *   summary           one-line operator-facing description
 *   rationale         why the change is proposed (operator-facing)
 *   visibility_intent "internal" (fail-closed default per the design)
 *   source            structural provenance: the email/item the fact came
 *                     from, or {revert_of_item_id} for a rollback proposal
 *   detector          {confidence, at} when the GH-111 detector proposed it
 *   decision          written by the console decideItem (same shape as
 *                     email replies)
 *   kb_write          written by the console (queued) and the kb.write job
 *                     (terminal outcome); see KbWriteRecord
 *   original_proposal captured on the first human edit (saveKbProposalEdits)
 */

export type KbChangeKind = "edit" | "new_page";

/** Provenance of a proposal, stamped structurally (never via a prompt). */
export interface KbSourceRef {
  /** The email item the fact surfaced in (detector proposals). */
  item_id?: string;
  /** Source email's messageId / gmail id / thread id, when known. */
  message_id?: string;
  gmail_id?: string;
  thread_id?: string;
  from?: string;
  subject?: string;
  /** The written kb_update item a rollback proposal reverts (GH-113). */
  revert_of_item_id?: string;
}

/** The proposal fields of a kb_update payload, validated. */
export interface KbProposal {
  target_page: string;
  change_kind: KbChangeKind;
  base_content: string;
  base_hash: string;
  proposed_content: string;
  summary: string;
  rationale: string;
}

/**
 * KB write outcome recorded on the item payload under `kb_write`:
 *   queued   the console approved and enqueued the kb.write job
 *   written  committed to the wiki (new_hash = sha256 of the content)
 *   stale    the page changed between propose and approve; nothing written
 *   denied   the server refused (protected page name or identity); nothing
 *            written
 *   failed   the write errored (still retryable via reopen + re-approve)
 *   skipped  the writer token is not configured; the decision stands and
 *            re-approving after configuration retries the write
 */
export type KbWriteStatus =
  | "queued"
  | "written"
  | "stale"
  | "denied"
  | "failed"
  | "skipped";

export interface KbWriteRecord {
  status: KbWriteStatus;
  at: string;
  /** sha256 hex of the committed content (status "written"). */
  new_hash?: string;
  /** Operator-facing detail for non-written outcomes. No em dashes. */
  error?: string;
}

const KB_WRITE_STATUSES: readonly KbWriteStatus[] = [
  "queued",
  "written",
  "stale",
  "denied",
  "failed",
  "skipped",
];

/**
 * Page-name namespaces the write path refuses, mirroring the server-side
 * denylist in sealevel-mcp-server src/kb-write.ts (PR #26). Schedule and
 * pricing are single-sourced live from Mindbody (upcoming_classes,
 * class_pricing) and must never be duplicated into the wiki. Enforced
 * here at proposal time (the detector drops such targets) as well as
 * server-side at write time: belt and suspenders, same as the identity
 * gating.
 */
const PROTECTED_KB_NAME_PATTERNS: readonly RegExp[] = [
  /schedule/i,
  /pric(e|es|ing)/i,
];

export function isProtectedKbPageName(name: string): boolean {
  return PROTECTED_KB_NAME_PATTERNS.some((re) => re.test(name));
}

/** Normalize a page name the way the server does: no .md, trimmed, lowercase. */
export function normalizeKbPageName(name: string): string {
  return name.replace(/\.md$/i, "").trim().toLowerCase();
}

/** sha256 of the exact content string, lowercase hex (matches the server). */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Validate the proposal fields of a kb_update payload. Untrusted data
 * (payloads are jsonb); returns null for anything malformed so callers
 * degrade to an honest "malformed proposal" instead of crashing. An empty
 * base_content/base_hash pair is valid (a new page); a non-empty
 * proposed_content is required (the server refuses empty content, and an
 * empty proposal is meaningless to approve).
 */
export function kbProposalOf(
  payload: Record<string, unknown>,
): KbProposal | null {
  const target = str(payload["target_page"]);
  const kind = payload["change_kind"];
  const base = str(payload["base_content"]);
  const baseHash = str(payload["base_hash"]);
  const proposed = str(payload["proposed_content"]);
  const summary = str(payload["summary"]) ?? "";
  const rationale = str(payload["rationale"]) ?? "";
  if (
    !target ||
    target.trim().length === 0 ||
    (kind !== "edit" && kind !== "new_page") ||
    base === undefined ||
    baseHash === undefined ||
    !proposed ||
    proposed.trim().length === 0
  ) {
    return null;
  }
  return {
    target_page: target,
    change_kind: kind,
    base_content: base,
    base_hash: baseHash,
    proposed_content: proposed,
    summary,
    rationale,
  };
}

/** Validate payload.kb_write, or null (absent / malformed). */
export function kbWriteOf(
  payload: Record<string, unknown>,
): KbWriteRecord | null {
  const raw = payload["kb_write"] as Partial<KbWriteRecord> | undefined;
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof raw.status === "string" &&
    (KB_WRITE_STATUSES as readonly string[]).includes(raw.status) &&
    typeof raw.at === "string"
  ) {
    return raw as KbWriteRecord;
  }
  return null;
}

/** Input for building a kb_update payload (detector or rollback path). */
export interface KbUpdatePayloadInput {
  proposal: KbProposal;
  source: KbSourceRef;
  /** Detector confidence (GH-111 proposals only). */
  confidence?: number;
  /** Injectable clock for tests. */
  now?: string;
}

/**
 * Build a kb_update payload (pure; exported for the offline smoke). The
 * source reference and version stamp are applied structurally here, never
 * through a model prompt, so provenance can be neither forgotten nor
 * forged (same discipline as email_meta / sources on email items).
 */
export function buildKbUpdatePayload(
  input: KbUpdatePayloadInput,
): Record<string, unknown> {
  const now = input.now ?? new Date().toISOString();
  const { proposal } = input;
  return {
    target_page: normalizeKbPageName(proposal.target_page),
    change_kind: proposal.change_kind,
    base_content: proposal.base_content,
    base_hash: proposal.base_hash,
    proposed_content: proposal.proposed_content,
    summary: proposal.summary,
    rationale: proposal.rationale,
    // Fail-closed default per the design's visibility guardrail: a
    // write-back page never becomes public without a deliberate,
    // reviewable act (frontmatter in the diff a human approves).
    visibility_intent: "internal",
    source: input.source,
    ...(input.confidence !== undefined
      ? { detector: { confidence: input.confidence, at: now } }
      : {}),
    generated_by: { commit: workerVersion(), at: now },
  };
}

/**
 * Create a pending kb_update proposal item. Inert by design: nothing is
 * written to the KB until a human approves in the console and the kb.write
 * job runs. The dedupe key (source email messageId for detector proposals,
 * kb-revert:<item> for rollbacks) caps proposals at one unresolved item
 * per source, so job retries and double-clicks cannot duplicate them.
 * Notifies like any other pending_approval item (emitItemEvent no-ops
 * without Novu and never throws).
 */
export async function createKbUpdateItem(
  input: KbUpdatePayloadInput & { dedupeKey?: string },
): Promise<CreateItemResult> {
  const result = await createItem({
    type: "kb_update",
    domain: "knowledge",
    status: "pending_approval",
    payload: buildKbUpdatePayload(input),
    ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
  });
  if (result.created) {
    await emitItemEvent("item.pending_approval", result.item, "brain");
  }
  return result;
}

/**
 * Save a human edit to a pending proposal's content (the kb analogue of
 * saveDraftEdits, GH-112): proposed_content is replaced, the AI original
 * is captured under original_proposal on the FIRST edit only, and both
 * proposal_edited and draft_edited are set -- the latter because
 * decideItem's no-edits branch reads payload.draft_edited to stamp the
 * decision audit's `edited` flag, so an edited-then-approved proposal is
 * audited as edited without forking the decide path. Guarded on
 * pending_approval like every draft mutation; a lost race throws with the
 * same "no pending_approval item" message the stale-card handling keys on.
 */
export async function saveKbProposalEdits(
  id: string,
  proposedContent: string,
): Promise<Item> {
  // Browsers submit textarea content with CRLF; stored content is LF.
  const content = proposedContent.replace(/\r\n/g, "\n");
  const { rows: currentRows } = await getPool().query<Item>(
    `SELECT * FROM items
     WHERE id = $1 AND type = 'kb_update' AND status = 'pending_approval'`,
    [id],
  );
  const current = currentRows[0];
  if (!current) {
    throw new Error(`saveKbProposalEdits: no pending_approval item with id ${id}`);
  }
  // No-op save hygiene (GH-40 pattern): identical content writes nothing.
  if (str(current.payload["proposed_content"]) === content) return current;

  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = payload
           || CASE WHEN payload ? 'original_proposal' THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'original_proposal', jsonb_build_object(
                  'proposed_content', payload->'proposed_content'
                )
              ) END
           || jsonb_build_object(
                'proposed_content', $2::text,
                'proposal_edited', true,
                'draft_edited', true
              )
     WHERE id = $1 AND type = 'kb_update' AND status = 'pending_approval'
     RETURNING *`,
    [id, content],
  );
  const item = rows[0];
  if (!item) {
    throw new Error(`saveKbProposalEdits: no pending_approval item with id ${id}`);
  }
  return item;
}

/**
 * Stamp kb_write = 'queued' when the console enqueues the write on
 * approval (mirrors markDeliveryQueued). Guarded: only a resolved,
 * APPROVED kb_update whose write has not already committed qualifies, so
 * a rejected or reopened item can never be written, and a reopen +
 * re-approve after a stale/denied/failed/skipped outcome re-queues
 * cleanly while a committed write is never re-stamped. Returns the item,
 * or null when ineligible.
 *
 * Note there is no 'writing' claim state: the server's write_wiki_page is
 * idempotent (identical content reports success without a duplicate audit
 * row), so a double-run of the kb.write job cannot double-commit; the
 * deterministic BullMQ jobId already makes double-enqueue a windowed
 * no-op.
 */
export async function markKbWriteQueued(id: string): Promise<Item | null> {
  const record: KbWriteRecord = {
    status: "queued",
    at: new Date().toISOString(),
  };
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = payload || jsonb_build_object('kb_write', $2::jsonb)
     WHERE id = $1
       AND type = 'kb_update'
       AND status = 'resolved'
       AND payload->'decision'->>'action' = 'approved'
       AND coalesce(payload->'kb_write'->>'status', '') <> 'written'
     RETURNING *`,
    [id, JSON.stringify(record)],
  );
  return rows[0] ?? null;
}

/**
 * Record a kb.write outcome on the item (worker side, GH-113). Guarded so
 * a terminal 'written' record is never downgraded by a late or duplicate
 * attempt (a retry that raced a success), while 'written' itself may be
 * re-recorded (idempotent server responses re-report the same hash).
 */
export async function recordKbWrite(
  id: string,
  record: Omit<KbWriteRecord, "at">,
): Promise<void> {
  const full: KbWriteRecord = {
    ...record,
    ...(record.error !== undefined ? { error: record.error.slice(0, 500) } : {}),
    at: new Date().toISOString(),
  };
  await getPool().query(
    `UPDATE items
     SET payload = payload || jsonb_build_object('kb_write', $2::jsonb)
     WHERE id = $1
       AND type = 'kb_update'
       AND NOT (
         coalesce(payload->'kb_write'->>'status', '') = 'written'
         AND $3::text <> 'written'
       )`,
    [id, JSON.stringify(full), full.status],
  );
}

/**
 * Build the payload for a ROLLBACK proposal (GH-113): a brand-new
 * kb_update whose proposed content is the prior page content stored on a
 * successfully written kb_update item. Rollback is a proposal, not a
 * special power: it flows through the same approve-then-write path, so no
 * unaudited restore exists. Returns null when the source item is not
 * revertable: not a kb_update, never written, or the prior content is
 * empty (the page did not exist before; the server cannot write empty
 * content, and page deletion is deliberately out of scope for the gated
 * write path).
 */
export function buildKbRevertPayload(
  item: Item,
  now?: string,
): Record<string, unknown> | null {
  if (item.type !== "kb_update") return null;
  const proposal = kbProposalOf(item.payload);
  const write = kbWriteOf(item.payload);
  if (!proposal || write?.status !== "written") return null;
  if (proposal.base_content.trim().length === 0) return null;
  const page = normalizeKbPageName(proposal.target_page);
  return buildKbUpdatePayload({
    proposal: {
      target_page: page,
      change_kind: "edit",
      // The content now on the page is what this item's approval wrote.
      base_content: proposal.proposed_content,
      base_hash: sha256Hex(proposal.proposed_content),
      proposed_content: proposal.base_content,
      summary: `Revert the knowledge base change to "${page}"`,
      rationale:
        `Restores the page content from before the update approved in item ${item.id}. ` +
        `Approving this write puts the prior version back.`,
    },
    source: { revert_of_item_id: String(item.id) },
    ...(now !== undefined ? { now } : {}),
  });
}

/**
 * File a rollback proposal for a written kb_update item ("Propose
 * revert", GH-113). Pending like any proposal; a human approves it before
 * anything is restored. Deduped per source item so a double click cannot
 * file two revert proposals. Throws when the item is not revertable (the
 * console action surfaces the message inline).
 */
export async function createKbRevertProposal(
  item: Item,
): Promise<CreateItemResult> {
  const payload = buildKbRevertPayload(item);
  if (!payload) {
    throw new Error(
      `createKbRevertProposal: item ${item.id} has no committed KB write to revert`,
    );
  }
  const result = await createItem({
    type: "kb_update",
    domain: "knowledge",
    status: "pending_approval",
    payload,
    dedupeKey: `kb-revert:${item.id}`,
  });
  if (result.created) {
    await emitItemEvent("item.pending_approval", result.item, "brain");
  }
  return result;
}
