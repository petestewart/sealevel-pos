import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

import {
  listSnapshotRecipients,
  markCampaignPendingApproval,
  type SnapshotRecipient,
} from "../db/campaignApproval.js";
import { getCampaignByKey, type CampaignRow } from "../db/campaignAudience.js";
import { getPool } from "../db/client.js";
import { recordItemUsage } from "../db/itemDrafts.js";
import { createItem, type CreateItemResult, type Item } from "../db/items.js";
import { emitItemEvent, type EmitResult } from "../notifications/emit.js";
import { enqueueCampaignSend } from "../queue/enqueue.js";
import {
  createKbToolset,
  KB_PROMPT_GUIDANCE,
  kbConfigured,
  type KbRunLog,
} from "../tools/kb.js";
import { workerVersion } from "../version.js";
import type { Job, JobContext } from "../jobs/types.js";
import {
  buildAudience,
  type BuildAudienceResult,
  type ExclusionReason,
  EXCLUSION_REASONS,
} from "./buildAudience.js";
import {
  resolveCampaignBrief,
  type CampaignBriefEntry,
} from "./campaignBriefs.js";
import {
  containsEmDash,
  EM_DASH_RE,
  planSegmentVariants,
  type SegmentDraftJob,
  type SegmentedDraftRequest,
  type VariantPlan,
} from "./draftVariants.js";
import {
  computeSendDiff,
  withCurrentCopy,
  type CurrentCopy,
} from "./sendDiff.js";
import type { PriorSendInfo, SendDiff } from "./sendDiffTypes.js";

/**
 * campaigns.draft (SEA-83): the ONLY campaign job that uses the brain.
 * Claude drafts the campaign message; it NEVER chooses recipients. The
 * recipient list is the pure-code audience build's frozen snapshot, and
 * the model's entire side-effect surface is one private tool that files
 * ONE campaign_approval item pending human approval. Nothing sends from
 * THIS job: approval triggers the SEA-84 send (see onCampaignApproved
 * below, which enqueues campaigns.send, delayed to send_at).
 *
 * Flow (payload: { campaignKey }):
 *
 * 1. Assembly (pure code, in instructions()): run the SEA-82 audience
 *    build for the campaign. Running the build HERE, rather than reading
 *    a snapshot some earlier run froze, is deliberate: buildAudience only
 *    persists the snapshot rows (campaign_audience), not the exclusion
 *    report, and the card must show the exclusion report FOR the exact
 *    snapshot being approved. One build run inside the draft job makes
 *    snapshot and report inseparable, and the report is then persisted
 *    durably in the item payload (no migration needed). buildAudience
 *    itself refuses campaigns at approved-or-beyond, so this can never
 *    mutate an audience a human already signed off on.
 *
 * 2. The model (claude-opus-4-8, drafting tier) writes the message and
 *    calls create_campaign_approval exactly once. For a BRIEFED campaign
 *    (one registered in campaignBriefs.ts, SEA-88) the prompt carries the
 *    brief's subject theme, shared facts, copy rules and each segment's
 *    audience/framing, the model writes ONE VARIANT PER NON-EMPTY
 *    SEGMENT, and facts come exclusively from the brief (the KB stays
 *    available for voice reference). Un-briefed campaigns keep the
 *    original single-draft flow with KB fact sourcing. Either way the
 *    tool enforces the copy contract structurally: NO EM DASHES
 *    (CLAUDE.md convention, checked in code, not prompt-hoped), and
 *    every {{merge_field}} must be one this job can render.
 *
 * 3. The tool assembles the approval-card payload (all four elements:
 *    audience summary from the frozen snapshot, exclusion report from
 *    the build, the rendered email(s) with a real recipient's merge
 *    fields resolved (one sample PER SEGMENT for briefed variants), and
 *    the send-diff vs the last send of this campaign key), files the
 *    item (deduped: ONE campaign_approval per campaign run, variants and
 *    all), moves the campaign to pending_approval, and emits the
 *    campaign_approval Novu event (workflow seeded by 0015).
 *
 * SEA-88 facts gate: a briefed campaign REFUSES to draft (loud throw in
 * assembleCampaignDraft, before any side effect) while its brief still
 * carries needs_verification facts.
 */

/* ------------------------------------------------------------------ *
 * Send-diff seam (SEA-86)                                            *
 * ------------------------------------------------------------------ */

/**
 * The send-diff versus the last send of this campaign key: the CANONICAL
 * SendDiff from sendDiffTypes.ts (SEA-86), computed by computeSendDiff.
 * null means NO COMPLETED PRIOR SEND, which covers two honest cases: a
 * true first send, and a prior run whose send rows are all still queued
 * (mid-flight is not history). Card wording must stay true for both.
 */
export type SendDiffProvider = (campaignKey: string) => Promise<SendDiff | null>;

/** The SEA-86 seam, wired: the approval card's diff IS computeSendDiff.
 * Tests inject their own provider through DraftCampaignDeps.sendDiff. */
export const defaultSendDiffProvider: SendDiffProvider = computeSendDiff;

/**
 * SendDiff as persisted in the item payload. The payload is JSONB: a
 * Date does not survive the JSON round-trip (it stringifies on write and
 * reads back as a plain string), so a Date-typed field on the payload
 * type would LIE on readback. The one Date in the canonical shape
 * (priorSend.sentAt) is serialized to an ISO string at this boundary,
 * and campaignApprovalOf validates the SERIALIZED shape. sendDiffTypes.ts
 * itself stays untouched (merged SEA-86 code; the Date is right for the
 * live computation, only the persisted form must be JSON-safe).
 */
export interface SendDiffPayload extends Omit<SendDiff, "priorSend"> {
  priorSend: Omit<PriorSendInfo, "sentAt"> & { sentAt: string | null };
}

/** Serialize a canonical SendDiff for the JSON item payload (the
 * priorSend.sentAt Date -> ISO string boundary). Exported for the smoke. */
export function serializeSendDiff(
  diff: SendDiff | null,
): SendDiffPayload | null {
  if (diff === null) return null;
  return {
    ...diff,
    priorSend: {
      ...diff.priorSend,
      sentAt: diff.priorSend.sentAt
        ? diff.priorSend.sentAt.toISOString()
        : null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * SEA-84 seam: what approval triggers                                *
 * ------------------------------------------------------------------ */

/** Injectable dependencies for onCampaignApproved so the offline smoke
 * drives both timing branches without Postgres or Redis. */
export interface OnCampaignApprovedDeps {
  /** Read the campaign row's scheduling fields (send_at, run_seq). */
  getSchedule: (
    campaignId: string,
  ) => Promise<{ sendAt: Date | null; runSeq: number } | null>;
  /** Enqueue the (possibly delayed) send job; returns the jobId. */
  enqueueSend: (options: {
    campaignKey: string;
    campaignId: string;
    runSeq: number;
    delayMs?: number;
  }) => Promise<string>;
  now: () => Date;
  log: (line: string) => void;
}

function defaultOnCampaignApprovedDeps(): OnCampaignApprovedDeps {
  return {
    getSchedule: async (campaignId) => {
      const result = await getPool().query(
        `SELECT send_at, run_seq FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      const row = result.rows[0] as
        | { send_at: Date | null; run_seq: number }
        | undefined;
      return row ? { sendAt: row.send_at, runSeq: Number(row.run_seq) } : null;
    },
    enqueueSend: (options) => enqueueCampaignSend(options),
    now: () => new Date(),
    log: (line) => console.log(line),
  };
}

export interface OnCampaignApprovedResult {
  enqueued: boolean;
  reason?: string;
  jobId?: string;
  /** Delay applied to the enqueue: 0 = sends now, >0 = scheduled send. */
  delayMs?: number;
}

/**
 * SEA-84, wired: called by the console after a campaign approval commits
 * (status flipped to 'approved' with approved_by/approved_at). Enqueues
 * the campaigns.send BullMQ job -- immediately for send_at NULL, or as a
 * DELAYED job for max(now, send_at) when the campaign carries a
 * scheduled send time (0018). The delay is safe because the send job
 * re-checks suppressions and consent per recipient when it fires.
 *
 * Failure posture: NEVER throws. The approval decision is already
 * committed when this runs, and a Redis hiccup must not surface as a
 * failed approval; a lost enqueue is caught by the monitor
 * (overdue_scheduled: an approved campaign past its due time with no
 * send rows) and can be re-fired by hand. The enqueue itself is
 * idempotent per campaign run (deterministic jobId), so a double approve
 * submit enqueues one send.
 */
export async function onCampaignApproved(
  campaign: { id: string; key: string },
  deps: OnCampaignApprovedDeps = defaultOnCampaignApprovedDeps(),
): Promise<OnCampaignApprovedResult> {
  try {
    const schedule = await deps.getSchedule(campaign.id);
    if (!schedule) {
      const reason = `campaign ${campaign.id} not found when scheduling the send`;
      deps.log(`[campaigns.send] WARNING: ${reason}`);
      return { enqueued: false, reason };
    }
    const nowMs = deps.now().getTime();
    const delayMs = schedule.sendAt
      ? Math.max(0, schedule.sendAt.getTime() - nowMs)
      : 0;
    const jobId = await deps.enqueueSend({
      campaignKey: campaign.key,
      campaignId: campaign.id,
      runSeq: schedule.runSeq,
      ...(delayMs > 0 ? { delayMs } : {}),
    });
    deps.log(
      delayMs > 0
        ? `[campaigns.send] campaign '${campaign.key}' approved; send scheduled for ${schedule.sendAt!.toISOString()} (job ${jobId}, delay ${Math.round(delayMs / 1000)}s)`
        : `[campaigns.send] campaign '${campaign.key}' approved; send enqueued to fire now (job ${jobId})`,
    );
    return { enqueued: true, jobId, delayMs };
  } catch (err) {
    // The approval is committed; a failed enqueue must not undo it or
    // error the operator's decision. The monitor's overdue_scheduled
    // condition is the backstop for a send that never got enqueued.
    const reason = err instanceof Error ? err.message : String(err);
    deps.log(
      `[campaigns.send] WARNING: could not enqueue send for approved campaign '${campaign.key}': ${reason}. The campaign monitor will flag it as overdue.`,
    );
    return { enqueued: false, reason };
  }
}

/* ------------------------------------------------------------------ *
 * Copy contract checks                                               *
 * ------------------------------------------------------------------ */

/**
 * The no-em-dash predicate (em dash plus lookalikes: horizontal bar,
 * two-em/three-em dash; en dash U+2013 stays legal, ranges like 6–7pm
 * are fine). ONE character class everywhere: the canonical definition
 * lives in draftVariants.ts (the dependency-free module) and is
 * re-exported here so existing importers keep working. findEmDashes
 * (brief guidance) and this job's copy enforcement check the exact
 * same characters.
 */
export { containsEmDash, EM_DASH_RE };

/** Merge fields campaigns.draft can render. first_name falls back to
 * "friend" (playful-voice-safe) when the contact has no first name. */
export const MERGE_FIELDS = ["first_name", "email"] as const;

const MERGE_TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Render {{merge_field}} tokens for one recipient. Throws on a token this
 * job cannot render, so an invented field is caught at draft time, never
 * discovered as literal braces in a customer's inbox. Exported for the
 * smoke.
 */
export function renderMergeFields(
  text: string,
  recipient: { email: string; firstName: string | null },
): string {
  return text.replace(MERGE_TOKEN_RE, (whole, name: string) => {
    switch (name) {
      case "first_name":
        return recipient.firstName?.trim() || "friend";
      case "email":
        return recipient.email;
      default:
        throw new UnknownMergeFieldError(whole);
    }
  });
}

export class UnknownMergeFieldError extends Error {
  constructor(public readonly token: string) {
    super(
      `unknown merge field ${token}; available: ${MERGE_FIELDS.map(
        (f) => `{{${f}}}`,
      ).join(", ")}`,
    );
    this.name = "UnknownMergeFieldError";
  }
}

/* ------------------------------------------------------------------ *
 * Payload types (what the card reads)                                *
 * ------------------------------------------------------------------ */

/** Bounded per-reason samples persisted with the exclusion report. */
export const EXCLUSION_SAMPLES_PER_REASON = 5;

/** One rendered-preview block: the email exactly as it will send, one
 * real recipient's merge fields resolved. */
export interface RenderedPreviewPayload {
  recipient: {
    contact_id: string;
    email: string;
    first_name: string | null;
    segment: string;
  };
  subject: string;
  body: string;
}

/**
 * One per-segment copy variant in a briefed campaign's approval payload
 * (SEA-88): the variant's stored draft (merge fields unresolved) plus
 * its rendered preview for ONE sample recipient FROM THAT SEGMENT,
 * resolved from the frozen snapshot. recipient_count is the segment's
 * recipient count in the frozen snapshot, so the reviewer sees exactly
 * who gets which copy.
 */
export interface CampaignApprovalVariant {
  segment: string;
  recipient_count: number;
  draft_subject: string;
  draft_body: string;
  rendered_preview: RenderedPreviewPayload;
}

/** The campaign_approval item payload, under the standard payload keys.
 * Everything the card renders is HERE, durably, so the card never
 * re-derives numbers that could drift from what was approved.
 *
 * Element 3 comes in exactly one of two shapes:
 *   - un-briefed campaigns: the single draft_subject / draft_body /
 *     rendered_preview trio (the original SEA-83 shape, still valid);
 *   - briefed campaigns (SEA-88): `variants`, one entry per non-empty
 *     audience segment, each with its own draft + per-segment sample
 *     preview. Still ONE approval item for the whole campaign (the
 *     locked campaign-level approval design). */
export interface CampaignApprovalPayload {
  campaign_id: string;
  campaign_key: string;
  campaign_name: string;
  run_seq: number;
  audience_view: string;
  /** Element 1: the frozen snapshot's recipient count + segment breakdown. */
  audience: {
    recipients: number;
    segments: Record<string, number>;
    snapshot_at: string;
  };
  /** Element 2: the exclusion report from the audience build that froze
   * this snapshot (persisted here because buildAudience stores only the
   * snapshot rows; see the module comment). */
  exclusions: {
    view_rows: number;
    counts: Record<ExclusionReason, number>;
    /** Up to EXCLUSION_SAMPLES_PER_REASON illustrative drops per reason. */
    samples: Array<{
      reason: ExclusionReason;
      detail: string;
      contact_id: string | null;
    }>;
    built_at: string;
    summary: string;
  };
  /** The draft as it will be stored/sent, merge fields unresolved.
   * Present exactly when `variants` is absent (un-briefed campaigns). */
  draft_subject?: string;
  draft_body?: string;
  /** Element 3 (un-briefed): the email exactly as it will send, ONE real
   * recipient's merge fields resolved. */
  rendered_preview?: RenderedPreviewPayload;
  /** Element 3 (briefed, SEA-88): one variant per non-empty segment,
   * each with a per-segment sample preview. Non-empty when present. */
  variants?: CampaignApprovalVariant[];
  /** Element 4: diff vs the last send of this campaign key, in the
   * JSON-safe serialized form (priorSend.sentAt is an ISO string); null =
   * no completed prior send (first send, or prior run still mid-flight). */
  send_diff: SendDiffPayload | null;
  /** Scheduled send time (campaigns.send_at, 0018) as an ISO string;
   * null = sends on approval. Optional: items filed before SEA-84 lack
   * the field, and the card treats absent as "sends on approval". */
  send_at?: string | null;
  rationale: string;
  sources?: unknown[];
  kb_unavailable?: boolean;
  generated_by: { commit: string; at: string };
  [key: string]: unknown;
}

/**
 * Validate an item payload as a campaign_approval card's data. Returns
 * null when any of the four required elements is missing or malformed;
 * the console renders the malformed-item fallback instead of a
 * ceremonial partial card. Exported for the console and the smoke.
 */
export function campaignApprovalOf(
  payload: Record<string, unknown>,
): CampaignApprovalPayload | null {
  const p = payload as Partial<CampaignApprovalPayload>;
  if (typeof p.campaign_id !== "string" || p.campaign_id.length === 0) return null;
  if (typeof p.campaign_key !== "string" || p.campaign_key.length === 0) return null;
  if (typeof p.campaign_name !== "string") return null;
  if (typeof p.run_seq !== "number") return null;
  // Element 1: audience.
  const audience = p.audience;
  if (
    !audience ||
    typeof audience.recipients !== "number" ||
    typeof audience.segments !== "object" ||
    audience.segments === null ||
    typeof audience.snapshot_at !== "string"
  ) {
    return null;
  }
  // Element 2: exclusion report (all reasons present, zero or not).
  const exclusions = p.exclusions;
  if (
    !exclusions ||
    typeof exclusions.view_rows !== "number" ||
    typeof exclusions.counts !== "object" ||
    exclusions.counts === null ||
    !Array.isArray(exclusions.samples) ||
    !EXCLUSION_REASONS.every(
      (r) => typeof (exclusions.counts as Record<string, unknown>)[r] === "number",
    )
  ) {
    return null;
  }
  // Element 3: either the briefed variants array (every variant complete,
  // same rigor as the single shape) or the single draft + preview trio.
  if ("variants" in payload) {
    const variants = p.variants;
    if (!Array.isArray(variants) || variants.length === 0) return null;
    for (const v of variants) {
      if (!isApprovalVariant(v)) return null;
    }
    // Segments must be unique: two variants claiming one bucket would
    // make "who gets which copy" ambiguous at send time.
    const segments = new Set(variants.map((v) => v.segment));
    if (segments.size !== variants.length) return null;
  } else {
    const preview = p.rendered_preview;
    if (!isRenderedPreview(preview)) return null;
    if (typeof p.draft_subject !== "string" || typeof p.draft_body !== "string") {
      return null;
    }
  }
  // Element 4: send_diff must be PRESENT (null is the honest no-completed-
  // prior-send value; ABSENT means the assembler never ran the seam) and,
  // when non-null, must be the SERIALIZED canonical SEA-86 shape.
  if (!("send_diff" in payload)) return null;
  const diff = p.send_diff;
  if (diff !== null) {
    if (!diff || !isRecipientDelta(diff.recipientsAdded) ||
        !isRecipientDelta(diff.recipientsDropped)) {
      return null;
    }
    if (typeof diff.currentAudienceCount !== "number") return null;
    // copyChanged is tri-state; null = unknown and must stay null, never
    // coerced (renderers show it as "copy: unknown").
    if (
      diff.copyChanged !== true &&
      diff.copyChanged !== false &&
      diff.copyChanged !== null
    ) {
      return null;
    }
    if (typeof diff.copySummary !== "string") return null;
    if (typeof diff.summary !== "string") return null;
    const prior = diff.priorSend;
    if (
      !prior ||
      typeof prior.runSeq !== "number" ||
      typeof prior.sentCount !== "number" ||
      // The JSON boundary: sentAt must be an ISO string or null here. A
      // Date object (someone skipped serializeSendDiff) fails validation
      // instead of lying on readback.
      !(typeof prior.sentAt === "string" || prior.sentAt === null)
    ) {
      return null;
    }
  }
  return payload as CampaignApprovalPayload;
}

/** Structural check for a rendered preview block. */
function isRenderedPreview(value: unknown): value is RenderedPreviewPayload {
  if (typeof value !== "object" || value === null) return false;
  const preview = value as Partial<RenderedPreviewPayload>;
  return (
    typeof preview.subject === "string" &&
    typeof preview.body === "string" &&
    typeof preview.recipient === "object" &&
    preview.recipient !== null &&
    typeof preview.recipient.email === "string"
  );
}

/** Structural check for one briefed-campaign approval variant. */
function isApprovalVariant(value: unknown): value is CampaignApprovalVariant {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CampaignApprovalVariant>;
  return (
    typeof v.segment === "string" &&
    v.segment.length > 0 &&
    typeof v.recipient_count === "number" &&
    typeof v.draft_subject === "string" &&
    typeof v.draft_body === "string" &&
    isRenderedPreview(v.rendered_preview)
  );
}

/** Structural check for a serialized RecipientDelta. */
function isRecipientDelta(value: unknown): value is {
  count: number;
  sample: string[];
  sampleLimit: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const delta = value as { count?: unknown; sample?: unknown };
  return typeof delta.count === "number" && Array.isArray(delta.sample);
}

/* ------------------------------------------------------------------ *
 * Assembly (pure code, before any model call)                        *
 * ------------------------------------------------------------------ */

/** Injectable dependencies so the offline smoke runs every branch with
 * no Postgres, analytics server, Novu, or model. Production callers pass
 * nothing. */
export interface DraftCampaignDeps {
  buildAudience: (options: {
    campaignKey: string;
  }) => Promise<BuildAudienceResult>;
  getCampaignByKey: (key: string) => Promise<CampaignRow | null>;
  listSnapshotRecipients: (campaignId: string) => Promise<SnapshotRecipient[]>;
  /** Brief registry lookup (SEA-88). null = un-briefed single draft. The
   * smoke injects test briefs; production is the registry itself. */
  resolveBrief: (campaignKey: string) => CampaignBriefEntry | null;
  sendDiff: SendDiffProvider;
  createItem: typeof createItem;
  markCampaignPendingApproval: (campaignId: string) => Promise<string | null>;
  emit: (item: Item) => Promise<EmitResult>;
  log: (line: string) => void;
  now: () => Date;
}

export function defaultDraftCampaignDeps(): DraftCampaignDeps {
  return {
    buildAudience: (options) => buildAudience(options),
    getCampaignByKey: (key) => getCampaignByKey(getPool(), key),
    listSnapshotRecipients: (campaignId) =>
      listSnapshotRecipients(getPool(), campaignId),
    resolveBrief: resolveCampaignBrief,
    sendDiff: defaultSendDiffProvider,
    createItem,
    markCampaignPendingApproval: (campaignId) =>
      markCampaignPendingApproval(getPool(), campaignId),
    emit: (item) => emitItemEvent("campaign_approval", item, "brain"),
    log: (line) => console.log(line),
    now: () => new Date(),
  };
}

/** Everything the drafting prompt and the create tool need, assembled
 * once per run before the model is involved. */
export interface CampaignDraftAssembly {
  campaign: CampaignRow;
  recipients: SnapshotRecipient[];
  segments: Record<string, number>;
  snapshotAt: string;
  /** The build run that froze this exact snapshot. */
  build: BuildAudienceResult;
  /** Deterministic sample recipient (lowest contact id) for the preview. */
  sampleRecipient: SnapshotRecipient;
  /** Deterministic sample recipient PER SEGMENT (lowest contact id in
   * each segment), for briefed campaigns' per-variant previews. */
  samplesBySegment: Record<string, SnapshotRecipient>;
  /** The campaign's drafting brief, when registered (SEA-88). */
  brief: SegmentedDraftRequest | null;
  /** The per-segment fan-out plan for a briefed campaign; null for
   * un-briefed campaigns (exactly the original single-draft flow). */
  variantPlan: VariantPlan | null;
  sendDiff: SendDiff | null;
}

/**
 * Run the pure-code assembly for one campaign. Throws (so BullMQ retries
 * or dead-letters loudly) when the campaign is missing, beyond approval,
 * the audience build cannot run (analytics unconfigured / blackout), or
 * the audience is empty; a campaign_approval card over nothing would be
 * ceremonial. Exported for the smoke.
 */
export async function assembleCampaignDraft(
  campaignKey: string,
  deps: DraftCampaignDeps = defaultDraftCampaignDeps(),
): Promise<CampaignDraftAssembly> {
  if (typeof campaignKey !== "string" || campaignKey.length === 0) {
    throw new Error("campaigns.draft: payload.campaignKey is required");
  }

  // FACTS GATE (SEA-88): a briefed campaign whose facts file still holds
  // unverified claims REFUSES to draft, loudly, BEFORE the audience build
  // runs (no snapshot side effects behind a refusal). This is what makes
  // merging the brief safe while the real fall rollout is still moving:
  // the facts file gets rewritten later, and nothing drafts until every
  // claim in it is confirmed.
  const briefEntry = deps.resolveBrief(campaignKey);
  if (briefEntry) {
    const unverified = briefEntry.unverifiedFacts();
    if (unverified.length > 0) {
      const lines = unverified
        .map((f) => `  - ${f.fact} (${f.source})`)
        .join("\n");
      throw new Error(
        `campaigns.draft: REFUSING to draft briefed campaign '${campaignKey}': ` +
          `${unverified.length} fact(s) still need verification:\n${lines}\n` +
          `Verify each claim and mark it 'confirmed' in ${briefEntry.factsFile}, then re-run.`,
      );
    }
  }

  // The build validates campaign existence and status (draft /
  // pending_approval only) itself; a skip is a refusal here, never a
  // silent no-op that files an approval card with no exclusion report.
  const build = await deps.buildAudience({ campaignKey });
  if (build.status === "skipped") {
    throw new Error(
      `campaigns.draft: audience build skipped (${build.reason ?? "unknown"}); ${build.summary}`,
    );
  }
  if (build.recipients.length === 0) {
    throw new Error(
      `campaigns.draft: campaign '${campaignKey}' has an empty audience; nothing to draft for (${build.summary})`,
    );
  }

  const campaign = await deps.getCampaignByKey(campaignKey);
  if (!campaign) {
    throw new Error(`campaigns.draft: no campaign with key '${campaignKey}'`);
  }

  // Element 1 reads the FROZEN SNAPSHOT back from the database, not the
  // in-memory build result, so what the card claims is what is stored.
  const recipients = await deps.listSnapshotRecipients(campaign.id);
  if (recipients.length !== build.recipients.length) {
    throw new Error(
      `campaigns.draft: snapshot readback mismatch for '${campaignKey}' (${recipients.length} stored, ${build.recipients.length} built)`,
    );
  }
  const segments: Record<string, number> = {};
  const samplesBySegment: Record<string, SnapshotRecipient> = {};
  for (const r of recipients) {
    segments[r.segment] = (segments[r.segment] ?? 0) + 1;
    // Recipients come back ordered by contact id, so the first one seen
    // per segment is that segment's deterministic sample.
    samplesBySegment[r.segment] ??= r;
  }

  // Briefed campaigns: fan the brief out over the snapshot's real
  // per-segment counts (planSegmentVariants validates the brief and the
  // fan-out identity; unknown labels degrade to the fallback variant).
  const brief = briefEntry ? briefEntry.request() : null;
  const variantPlan = brief ? planSegmentVariants(brief, segments) : null;
  if (variantPlan) {
    for (const job of variantPlan.jobs) {
      if (!samplesBySegment[job.segment]) {
        throw new Error(
          `campaigns.draft: no snapshot recipient for planned segment '${job.segment}' (bug)`,
        );
      }
    }
  }

  const sendDiff = await deps.sendDiff(campaignKey);

  return {
    campaign,
    recipients,
    segments,
    snapshotAt: (recipients[0]!.snapshotAt ?? deps.now()).toISOString(),
    build,
    sampleRecipient: recipients[0]!,
    samplesBySegment,
    brief,
    variantPlan,
    sendDiff,
  };
}

/* ------------------------------------------------------------------ *
 * The create tool (the model's only side effect)                     *
 * ------------------------------------------------------------------ */

/** One per-segment variant as the model hands it to the tool. */
export interface CampaignVariantInput {
  segment: string;
  subject: string;
  body: string;
}

/** What the model must hand the tool: subject/body for un-briefed
 * campaigns, `variants` (one entry per planned segment, in ONE call)
 * for briefed campaigns. rationale always. */
export interface CampaignDraftInput {
  subject?: string;
  body?: string;
  variants?: CampaignVariantInput[];
  rationale: string;
}

export type CreateApprovalResult =
  | { status: "created"; item: Item; emitted: boolean }
  | { status: "exists"; item: Item }
  | { status: "rejected"; reason: string };

/**
 * Validate the model's draft and file the campaign_approval item. This
 * is where the copy contract is ENFORCED (not prompted): em dashes and
 * unknown merge fields are rejected back to the model as tool errors, so
 * bad copy never reaches an item. Deduped one item per (campaign, run):
 * a retried job returns the existing pending item and emits nothing
 * twice. Exported for the smoke (this is the mocked-model entry point:
 * the smoke calls it with crafted input exactly as the model would).
 */
export async function createCampaignApproval(
  assembly: CampaignDraftAssembly,
  input: CampaignDraftInput,
  deps: DraftCampaignDeps = defaultDraftCampaignDeps(),
  kbLog?: KbRunLog,
): Promise<CreateApprovalResult> {
  const rationale = input.rationale?.trim() ?? "";
  // The no-em-dash convention is enforced in code on every outgoing
  // field (rationale included: operator-facing copy follows the same
  // convention, as every operator-facing string in this repo does).
  if (containsEmDash(rationale)) {
    return {
      status: "rejected",
      reason:
        "rationale contains an em dash; rewrite it without em dashes (project copy convention)",
    };
  }

  // Element 3, one of two shapes: the briefed per-segment variants
  // (SEA-88) or the original single draft. Same rigor either way: every
  // outgoing field is em-dash-checked, every draft is rendered against a
  // REAL snapshot recipient so an unknown merge field is a rejection,
  // never a customer-visible {{typo}}.
  const plan = assembly.variantPlan;
  let single: {
    draft_subject: string;
    draft_body: string;
    rendered_preview: RenderedPreviewPayload;
  } | null = null;
  let payloadVariants: CampaignApprovalVariant[] | null = null;

  if (plan) {
    const built = buildVariantPayloads(plan.jobs, assembly, input);
    if ("rejected" in built) {
      return { status: "rejected", reason: built.rejected };
    }
    payloadVariants = built.variants;
  } else {
    if (Array.isArray(input.variants)) {
      return {
        status: "rejected",
        reason:
          "this campaign has no segment brief; call create_campaign_approval with subject and body (no variants)",
      };
    }
    const subject = input.subject?.trim() ?? "";
    const body = input.body?.trim() ?? "";
    if (subject.length === 0 || body.length === 0) {
      return { status: "rejected", reason: "subject and body must be non-empty" };
    }
    for (const [field, text] of [
      ["subject", subject],
      ["body", body],
    ] as const) {
      if (containsEmDash(text)) {
        return {
          status: "rejected",
          reason: `${field} contains an em dash; rewrite it without em dashes (project copy convention)`,
        };
      }
    }
    const sample = assembly.sampleRecipient;
    try {
      single = {
        draft_subject: subject,
        draft_body: body,
        rendered_preview: {
          recipient: {
            contact_id: sample.contactId,
            email: sample.email,
            first_name: sample.firstName,
            segment: sample.segment,
          },
          subject: renderMergeFields(subject, sample),
          body: renderMergeFields(body, sample),
        },
      };
    } catch (err) {
      if (err instanceof UnknownMergeFieldError) {
        return { status: "rejected", reason: err.message };
      }
      throw err;
    }
  }

  // Complete the copy loop (SEA-84): the diff was computed at assembly
  // time, before any draft existed; NOW the actual draft copy exists --
  // the single trio, or the briefed per-segment variants (SEA-88) -- so
  // re-run the per-segment comparison against the stored prior copy and
  // persist the real verdict on the card. Pure; the null path survives
  // when no prior copy snapshot exists (pre-snapshot history).
  const currentCopy: CurrentCopy = payloadVariants
    ? {
        variants: payloadVariants.map((v) => ({
          segment: v.segment,
          subject: v.draft_subject,
          body: v.draft_body,
        })),
      }
    : { subject: single!.draft_subject, body: single!.draft_body };
  const sendDiffWithCopy = assembly.sendDiff
    ? withCurrentCopy(assembly.sendDiff, currentCopy)
    : null;

  const { campaign, build } = assembly;
  const samples: CampaignApprovalPayload["exclusions"]["samples"] = [];
  const perReason = new Map<ExclusionReason, number>();
  for (const e of build.exclusions) {
    const shown = perReason.get(e.reason) ?? 0;
    if (shown >= EXCLUSION_SAMPLES_PER_REASON) continue;
    perReason.set(e.reason, shown + 1);
    samples.push({ reason: e.reason, detail: e.detail, contact_id: e.contactId });
  }

  const now = deps.now().toISOString();
  const payload: CampaignApprovalPayload = {
    campaign_id: campaign.id,
    campaign_key: campaign.key,
    campaign_name: campaign.name,
    run_seq: campaign.runSeq,
    audience_view: build.audienceView,
    audience: {
      recipients: assembly.recipients.length,
      segments: assembly.segments,
      snapshot_at: assembly.snapshotAt,
    },
    exclusions: {
      view_rows: build.viewRows,
      counts: build.exclusionCounts,
      samples,
      built_at: build.snapshotAt?.toISOString() ?? now,
      summary: build.summary,
    },
    ...(payloadVariants ? { variants: payloadVariants } : single!),
    send_diff: serializeSendDiff(sendDiffWithCopy),
    send_at: campaign.sendAt ? campaign.sendAt.toISOString() : null,
    rationale,
    ...(kbLog && (kbLog.sources.length > 0 || kbLog.unavailable)
      ? {
          sources: kbLog.sources,
          ...(kbLog.unavailable ? { kb_unavailable: true } : {}),
        }
      : {}),
    generated_by: { commit: workerVersion(), at: now },
  };

  // Belt and suspenders: what we are about to persist must parse as a
  // complete card. A gap here is a bug in THIS file; fail loudly.
  if (!campaignApprovalOf(payload)) {
    throw new Error(
      "campaigns.draft: assembled payload failed campaignApprovalOf validation (bug)",
    );
  }

  // ONE campaign_approval item per campaign run (the locked design:
  // campaign-level approval, never per recipient). The dedupe key is
  // (campaign id, run_seq), so a deliberate re-run (run_seq bump) gets a
  // fresh approval while a retried draft job finds the existing item.
  const result: CreateItemResult = await deps.createItem({
    type: "campaign_approval",
    domain: "campaigns",
    status: "pending_approval",
    payload,
    dedupeKey: `campaign-${campaign.id}-run-${campaign.runSeq}`,
  });

  if (!result.created) {
    deps.log(
      `[campaigns.draft] campaign '${campaign.key}' already has a pending approval item ${result.item.id}; not duplicating`,
    );
    return { status: "exists", item: result.item };
  }

  // Durable state first (the item), then the campaign status, then the
  // notification. markCampaignPendingApproval is guarded: a campaign that
  // moved beyond approval concurrently logs a warning and the mismatch
  // stays visible (the approval action will refuse it honestly later).
  const status = await deps.markCampaignPendingApproval(campaign.id);
  if (status === null) {
    deps.log(
      `[campaigns.draft] WARNING: campaign '${campaign.key}' is beyond approval; item ${result.item.id} filed but status not flipped`,
    );
  }

  // The one-line Novu call (SEA-92 plumbing; workflow + prefs seeded by
  // 0015). Emitted exactly once, on creation only. emitItemEvent never
  // throws.
  const emitted = (await deps.emit(result.item)).sent;
  deps.log(
    `[campaigns.draft] filed campaign_approval item ${result.item.id} for '${campaign.key}' (${assembly.recipients.length} recipients${
      payloadVariants ? `, ${payloadVariants.length} segment variants` : ""
    }; notify ${emitted ? "sent" : "skipped"})`,
  );
  return { status: "created", item: result.item, emitted };
}

/**
 * Validate a briefed campaign's variant input against the fan-out plan
 * and build the payload variants. The model must cover EXACTLY the
 * planned segments, once each, in one call: missing, extra, or duplicate
 * segments are rejections (keeping the dedupe airtight: one tool call,
 * one item, no partial accumulation to reconcile). Each variant's copy
 * gets the full contract (em dashes, merge fields) and its preview is
 * rendered for that SEGMENT'S sample recipient from the frozen snapshot.
 */
function buildVariantPayloads(
  jobs: SegmentDraftJob[],
  assembly: CampaignDraftAssembly,
  input: CampaignDraftInput,
): { variants: CampaignApprovalVariant[] } | { rejected: string } {
  const planned = jobs.map((j) => j.segment);
  const supplied = input.variants;
  if (!Array.isArray(supplied) || supplied.length === 0) {
    return {
      rejected:
        `this campaign drafts per-segment variants; call create_campaign_approval ONCE with variants, one entry per segment: ${planned.join(", ")}`,
    };
  }
  const bySegment = new Map<string, CampaignVariantInput>();
  for (const v of supplied) {
    const segment = typeof v.segment === "string" ? v.segment : "";
    if (!planned.includes(segment)) {
      return {
        rejected: `unknown variant segment '${segment}'; the segments to draft are: ${planned.join(", ")}`,
      };
    }
    if (bySegment.has(segment)) {
      return { rejected: `duplicate variant for segment '${segment}'` };
    }
    bySegment.set(segment, v);
  }
  const missing = planned.filter((s) => !bySegment.has(s));
  if (missing.length > 0) {
    return {
      rejected: `missing variant(s) for segment(s): ${missing.join(", ")}; provide all of ${planned.join(", ")} in one call`,
    };
  }

  const variants: CampaignApprovalVariant[] = [];
  for (const job of jobs) {
    const v = bySegment.get(job.segment)!;
    const subject = v.subject?.trim() ?? "";
    const body = v.body?.trim() ?? "";
    if (subject.length === 0 || body.length === 0) {
      return {
        rejected: `variant '${job.segment}': subject and body must be non-empty`,
      };
    }
    for (const [field, text] of [
      ["subject", subject],
      ["body", body],
    ] as const) {
      if (containsEmDash(text)) {
        return {
          rejected: `variant '${job.segment}' ${field} contains an em dash; rewrite it without em dashes (project copy convention)`,
        };
      }
    }
    const sample = assembly.samplesBySegment[job.segment];
    if (!sample) {
      // assembleCampaignDraft guarantees this; a gap here is a bug.
      throw new Error(
        `campaigns.draft: no sample recipient for segment '${job.segment}' (bug)`,
      );
    }
    try {
      variants.push({
        segment: job.segment,
        recipient_count: job.recipients,
        draft_subject: subject,
        draft_body: body,
        rendered_preview: {
          recipient: {
            contact_id: sample.contactId,
            email: sample.email,
            first_name: sample.firstName,
            segment: sample.segment,
          },
          subject: renderMergeFields(subject, sample),
          body: renderMergeFields(body, sample),
        },
      });
    } catch (err) {
      if (err instanceof UnknownMergeFieldError) {
        return { rejected: `variant '${job.segment}': ${err.message}` };
      }
      throw err;
    }
  }
  return { variants };
}

/* ------------------------------------------------------------------ *
 * The registered job                                                 *
 * ------------------------------------------------------------------ */

const RUN_STATE_ASSEMBLY = "campaignAssembly";
const RUN_STATE_DEPS = "campaignDeps";

function assemblyFrom(ctx: JobContext): CampaignDraftAssembly {
  const assembly = ctx.runState?.[RUN_STATE_ASSEMBLY];
  if (!assembly) {
    throw new Error(
      "campaigns.draft: assembly missing from runState (instructions() must run before the tool loop)",
    );
  }
  return assembly as CampaignDraftAssembly;
}

function depsFrom(ctx: JobContext): DraftCampaignDeps {
  return (
    (ctx.runState?.[RUN_STATE_DEPS] as DraftCampaignDeps | undefined) ??
    defaultDraftCampaignDeps()
  );
}

/** Human-readable segment line for the prompt ("412 hot-only, ..."). */
function segmentLine(segments: Record<string, number>): string {
  return (
    Object.entries(segments)
      .map(([segment, count]) => `${count} ${segment}`)
      .join(", ") || "(one segment)"
  );
}

/** The private create tool, closed over the run's assembly. */
export function createCampaignApprovalTool(
  ctx: JobContext,
  kbLog: KbRunLog,
): BetaRunnableTool<any> {
  return betaZodTool({
    name: "create_campaign_approval",
    description:
      "File the drafted campaign for human approval. Call exactly once. " +
      "For a single-draft campaign pass subject/body; for a campaign " +
      "with per-segment variants (the instructions list the segments) " +
      "pass variants instead, one entry per segment, all in this ONE " +
      "call. Merge fields {{first_name}} and {{email}} allowed; " +
      "rationale is 1-3 plain sentences for the reviewing human. No em " +
      "dashes anywhere.",
    inputSchema: z.object({
      subject: z
        .string()
        .optional()
        .describe("The outgoing email subject line (single-draft campaigns only)."),
      body: z
        .string()
        .optional()
        .describe(
          "The outgoing email body, plain text, merge fields allowed (single-draft campaigns only).",
        ),
      variants: z
        .array(
          z.object({
            segment: z
              .string()
              .describe("The segment label exactly as listed in the instructions."),
            subject: z.string().describe("This segment's subject line."),
            body: z
              .string()
              .describe("This segment's email body, plain text, merge fields allowed."),
          }),
        )
        .optional()
        .describe(
          "Per-segment copy variants (briefed campaigns only): one entry per segment listed in the instructions, all in one call.",
        ),
      rationale: z
        .string()
        .describe("Why the draft says what it says. 1-3 plain sentences."),
    }),
    run: async (input: CampaignDraftInput) => {
      const assembly = assemblyFrom(ctx);
      const deps = depsFrom(ctx);
      const result = await createCampaignApproval(assembly, input, deps, kbLog);
      if (result.status === "rejected") {
        return `ERROR: ${result.reason}. Fix the draft and call create_campaign_approval again.`;
      }
      if (ctx.runState) ctx.runState["itemId"] = String(result.item.id);
      return JSON.stringify({
        id: String(result.item.id),
        deduped: result.status === "exists",
        campaign: assembly.campaign.key,
        recipients: assembly.recipients.length,
        ...(assembly.variantPlan
          ? { variants: assembly.variantPlan.jobs.length }
          : {}),
      });
    },
  }) as BetaRunnableTool<any>;
}

export const campaignDraft: Job = {
  id: "campaigns.draft",
  enabled: true,
  // Fired deliberately per campaign: by hand (npm run campaign:draft, or
  // an enqueue with { campaignKey }), never on a schedule.
  triggers: [{ kind: "manual" }],
  tools: [],
  model: "claude-opus-4-8", // drafting tier (locked decisions, CLAUDE.md)
  runtimeTools: (ctx: JobContext) => {
    // KB tools for voice/fact reference (read-only; absent when the MCP
    // connection is unconfigured) plus the single private create tool.
    const kb = createKbToolset();
    if (ctx.runState) ctx.runState["kbLog"] = kb.log;
    return [createCampaignApprovalTool(ctx, kb.log), ...kb.tools];
  },
  instructions: async (ctx: JobContext) => {
    const payload = (ctx.payload ?? {}) as { campaignKey?: unknown };
    const campaignKey =
      typeof payload.campaignKey === "string" ? payload.campaignKey : "";
    const deps = depsFrom(ctx);
    // Assembly runs HERE (pure code, no model billed yet); the create
    // tool reads it from runState. A throw propagates and BullMQ retries.
    const assembly = await assembleCampaignDraft(campaignKey, deps);
    if (ctx.runState) ctx.runState[RUN_STATE_ASSEMBLY] = assembly;

    const { campaign, recipients, segments, sendDiff, build, brief, variantPlan } =
      assembly;
    // The canonical diff carries its own ready-made one-liner. null means
    // no COMPLETED prior send (first send, or a prior run still queued).
    const diffLine = sendDiff
      ? sendDiff.summary
      : "No completed prior send of this campaign.";

    const common = `
Campaign: ${campaign.name} (key ${campaign.key}, run ${campaign.runSeq})
Audience: ${recipients.length} recipients from ${build.audienceView}: ${segmentLine(segments)}.
${diffLine}
${kbConfigured() ? KB_PROMPT_GUIDANCE : ""}
Voice (modeled on Hot Yoga Asheville's emails): playful, personal, and human. Write like a real person at the studio emailing people they know: warm, a little funny, zero marketing gloss. Never "Dear Valued Member", never corporate phrasing, never exclamation-mark spam. Short paragraphs. Sign off warmly with "Sealevel Hot Yoga" as the final line. Never sign as an AI or mention AI authorship, tools, or systems.
`;

    if (brief && variantPlan) {
      // Briefed campaign (SEA-88): the model drafts one copy variant per
      // non-empty segment, and its FACTS come from the brief (the KB
      // stays available for voice/tone reference only). Every claim in
      // the brief passed the facts gate before this prompt was built.
      const variantBlocks = variantPlan.jobs
        .map((job) => {
          const framing = job.variant.framing.map((l) => `  - ${l}`).join("\n");
          return `Segment '${job.segment}' (${job.recipients} recipient${job.recipients === 1 ? "" : "s"}): ${job.variant.audience}\n${framing}`;
        })
        .join("\n\n");
      return `
Draft the outgoing email for the campaign below, as ONE copy variant per audience segment. A human approves (or rejects) the whole set later; nothing sends now, and you do not choose recipients (a separate audited process froze the list).
${common}
Subject theme: ${brief.subjectTheme}

Facts you may state (the ONLY facts allowed; do not add specifics from anywhere else, including the knowledge base):
${brief.sharedFacts.map((f) => `- ${f}`).join("\n")}

Copy rules for every variant:
${brief.copyRules.map((r) => `- ${r}`).join("\n")}

Variants to write, one per segment:

${variantBlocks}

Hard rules:
- NO EM DASHES anywhere in any subject, body, or the rationale (use a comma, a period, or a colon instead). This is enforced; drafts containing one are rejected.
- Merge fields: you may use {{first_name}} (and {{email}} if truly needed). No other merge fields exist.
- Facts come exclusively from the shared facts and each segment's framing above. The knowledge base tools are for voice and tone reference only; never pull additional specifics from them.
- Do not promise follow-ups and do not offer to book anyone; booking is self-service.

Do this:
1. If the knowledge base tools are available, skim briefly for voice and tone only.
2. Write every variant: subject plus a short body (roughly 80-160 words each), tailored to that segment's audience and framing.
3. Call create_campaign_approval exactly ONCE with variants (one entry per segment listed above: ${variantPlan.jobs.map((j) => j.segment).join(", ")}) and a 1-3 sentence rationale covering the set. If it returns an ERROR, fix the drafts and call it again.
4. Reply with a one-line summary including the created item id.
`;
    }

    return `
Draft the outgoing email for the campaign below. A human approves (or rejects) it later; nothing sends now, and you do not choose recipients (a separate audited process froze the list).
${common}
Hard rules:
- NO EM DASHES anywhere in the subject, body, or rationale (use a comma, a period, or a colon instead). This is enforced; drafts containing one are rejected.
- Merge fields: you may use {{first_name}} (and {{email}} if truly needed). No other merge fields exist.
- Facts (schedule, prices, policies) must come from the knowledge base tools when available; never invent specifics. Prices and schedule questions belong to the live tools, not the wiki.
- Do not promise follow-ups and do not offer to book anyone; booking is self-service.

Do this:
1. If the knowledge base tools are available, skim what is relevant to this campaign's audience for voice and facts.
2. Write the email: subject plus a short body (roughly 80-160 words).
3. Call create_campaign_approval exactly once with subject, body, and a 1-3 sentence rationale. If it returns an ERROR, fix the draft and call it again.
4. Reply with a one-line summary including the created item id.
`;
  },
  recordUsage: async (ctx, usage) => {
    const itemId = ctx.runState?.["itemId"];
    if (typeof itemId !== "string") return; // no item created this run
    await recordItemUsage(itemId, { ...usage });
  },
};
