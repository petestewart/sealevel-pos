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
import { computeSendDiff } from "./sendDiff.js";
import type { PriorSendInfo, SendDiff } from "./sendDiffTypes.js";

/**
 * campaigns.draft (SEA-83): the ONLY campaign job that uses the brain.
 * Claude drafts the campaign message; it NEVER chooses recipients. The
 * recipient list is the pure-code audience build's frozen snapshot, and
 * the model's entire side-effect surface is one private tool that files
 * ONE campaign_approval item pending human approval. Nothing sends: the
 * send job is SEA-84 (see onCampaignApproved below).
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
 * 2. The model (claude-opus-4-8, drafting tier) writes the message using
 *    the KB tools for voice/fact reference, and calls
 *    create_campaign_approval exactly once. The tool enforces the copy
 *    contract structurally: NO EM DASHES (CLAUDE.md convention, checked
 *    in code, not prompt-hoped), and every {{merge_field}} must be one
 *    this job can render.
 *
 * 3. The tool assembles the approval-card payload (all four elements:
 *    audience summary from the frozen snapshot, exclusion report from
 *    the build, the rendered email with ONE real recipient's merge
 *    fields resolved, and the send-diff vs the last send of this
 *    campaign key), files the item (deduped: one campaign_approval per
 *    campaign run), moves the campaign to pending_approval, and emits
 *    the campaign_approval Novu event (workflow seeded by 0015).
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

/**
 * SEA-84 SEAM: called by the console after a campaign approval commits
 * (status flipped to 'approved' with approved_by/approved_at). The send
 * job (campaigns.send, SEA-84) is NOT built yet, so this deliberately
 * enqueues NOTHING -- enqueueing a job no processor handles would
 * dead-letter forever. SEA-84 wires the send enqueue here (derive the
 * dedupe keys per 0011 design point 2, enqueue the send job, flip status
 * to 'sending') and nowhere else, so the approval flow itself never
 * changes again.
 */
export async function onCampaignApproved(campaign: {
  id: string;
  key: string;
}): Promise<{ enqueued: false; reason: string }> {
  const reason =
    "campaigns.send (SEA-84) is not built yet; approval stops at the status flip";
  console.log(`[campaigns.draft] campaign '${campaign.key}' approved: ${reason}`);
  return { enqueued: false, reason };
}

/* ------------------------------------------------------------------ *
 * Copy contract checks                                               *
 * ------------------------------------------------------------------ */

/** Em dash and its lookalikes (horizontal bar, two-em/three-em dash).
 * En dash (U+2013) stays legal: ranges like 6–7pm are fine. */
const EM_DASH_RE = /[—―⸺⸻]/;

/** True when the text violates the no-em-dash convention (CLAUDE.md:
 * no em dashes in any outgoing user-facing copy). Exported for the smoke. */
export function containsEmDash(text: string): boolean {
  return EM_DASH_RE.test(text);
}

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

/** The campaign_approval item payload, under the standard payload keys.
 * Everything the card renders is HERE, durably, so the card never
 * re-derives numbers that could drift from what was approved. */
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
  /** The draft as it will be stored/sent, merge fields unresolved. */
  draft_subject: string;
  draft_body: string;
  /** Element 3: the email exactly as it will send, ONE real recipient's
   * merge fields resolved. */
  rendered_preview: {
    recipient: {
      contact_id: string;
      email: string;
      first_name: string | null;
      segment: string;
    };
    subject: string;
    body: string;
  };
  /** Element 4: diff vs the last send of this campaign key, in the
   * JSON-safe serialized form (priorSend.sentAt is an ISO string); null =
   * no completed prior send (first send, or prior run still mid-flight). */
  send_diff: SendDiffPayload | null;
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
  // Element 3: rendered preview with a real recipient.
  const preview = p.rendered_preview;
  if (
    !preview ||
    typeof preview.subject !== "string" ||
    typeof preview.body !== "string" ||
    !preview.recipient ||
    typeof preview.recipient.email !== "string"
  ) {
    return null;
  }
  if (typeof p.draft_subject !== "string" || typeof p.draft_body !== "string") {
    return null;
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
  for (const r of recipients) {
    segments[r.segment] = (segments[r.segment] ?? 0) + 1;
  }

  const sendDiff = await deps.sendDiff(campaignKey);

  return {
    campaign,
    recipients,
    segments,
    snapshotAt: (recipients[0]!.snapshotAt ?? deps.now()).toISOString(),
    build,
    sampleRecipient: recipients[0]!,
    sendDiff,
  };
}

/* ------------------------------------------------------------------ *
 * The create tool (the model's only side effect)                     *
 * ------------------------------------------------------------------ */

/** What the model must hand the tool. */
export interface CampaignDraftInput {
  subject: string;
  body: string;
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
  const subject = input.subject?.trim() ?? "";
  const body = input.body?.trim() ?? "";
  const rationale = input.rationale?.trim() ?? "";
  if (subject.length === 0 || body.length === 0) {
    return { status: "rejected", reason: "subject and body must be non-empty" };
  }
  // The no-em-dash convention is enforced in code on every outgoing
  // field. The rationale is operator-facing copy and follows the same
  // convention (as every operator-facing string in this repo does).
  for (const [field, text] of [
    ["subject", subject],
    ["body", body],
    ["rationale", rationale],
  ] as const) {
    if (containsEmDash(text)) {
      return {
        status: "rejected",
        reason: `${field} contains an em dash; rewrite it without em dashes (project copy convention)`,
      };
    }
  }

  // Element 3: render the exact outgoing email for ONE real recipient.
  // An unknown merge field is a rejection, not a customer-visible {{typo}}.
  const sample = assembly.sampleRecipient;
  let renderedSubject: string;
  let renderedBody: string;
  try {
    renderedSubject = renderMergeFields(subject, sample);
    renderedBody = renderMergeFields(body, sample);
  } catch (err) {
    if (err instanceof UnknownMergeFieldError) {
      return { status: "rejected", reason: err.message };
    }
    throw err;
  }

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
    draft_subject: subject,
    draft_body: body,
    rendered_preview: {
      recipient: {
        contact_id: sample.contactId,
        email: sample.email,
        first_name: sample.firstName,
        segment: sample.segment,
      },
      subject: renderedSubject,
      body: renderedBody,
    },
    send_diff: serializeSendDiff(assembly.sendDiff),
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
    `[campaigns.draft] filed campaign_approval item ${result.item.id} for '${campaign.key}' (${assembly.recipients.length} recipients; notify ${emitted ? "sent" : "skipped"})`,
  );
  return { status: "created", item: result.item, emitted };
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
      "subject/body are the outgoing email (merge fields {{first_name}} " +
      "and {{email}} allowed); rationale is 1-3 plain sentences for the " +
      "reviewing human. No em dashes anywhere.",
    inputSchema: z.object({
      subject: z.string().describe("The outgoing email subject line."),
      body: z
        .string()
        .describe("The outgoing email body, plain text, merge fields allowed."),
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

    const { campaign, recipients, segments, sendDiff, build } = assembly;
    // The canonical diff carries its own ready-made one-liner. null means
    // no COMPLETED prior send (first send, or a prior run still queued).
    const diffLine = sendDiff
      ? sendDiff.summary
      : "No completed prior send of this campaign.";

    return `
Draft the outgoing email for the campaign below. A human approves (or rejects) it later; nothing sends now, and you do not choose recipients (a separate audited process froze the list).

Campaign: ${campaign.name} (key ${campaign.key}, run ${campaign.runSeq})
Audience: ${recipients.length} recipients from ${build.audienceView}: ${segmentLine(segments)}.
${diffLine}
${kbConfigured() ? KB_PROMPT_GUIDANCE : ""}
Voice (modeled on Hot Yoga Asheville's emails): playful, personal, and human. Write like a real person at the studio emailing people they know: warm, a little funny, zero marketing gloss. Never "Dear Valued Member", never corporate phrasing, never exclamation-mark spam. Short paragraphs. Sign off warmly with "Sealevel Hot Yoga" as the final line. Never sign as an AI or mention AI authorship, tools, or systems.

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
