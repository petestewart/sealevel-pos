import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import {
  EMAIL_BODY_MAX_CHARS,
  emptyUsage,
  truncateForPrompt,
  type UsageTotals,
} from "../brain/budget.js";
import {
  bookingConfigured,
  bookingLinkGuidance,
  bookingUrl,
} from "../booking.js";
import { classifyEmailTags } from "../brain/classify.js";
import { suggestAssignee } from "../brain/suggestAssignee.js";
import { recordItemUsage } from "../db/itemDrafts.js";
import { loadRulesBlock } from "../db/settings.js";
import { loadStudioInfoBlock } from "../db/studioInfo.js";
import type { ItemTag } from "../tags.js";
import { stripQuotedReply } from "../gmail/parse.js";
import { createItemTool } from "../tools/registry.js";
import {
  createKbToolset,
  KB_PROMPT_GUIDANCE,
  kbConfigured,
  type KbRunLog,
} from "../tools/kb.js";
import type { Job, JobContext } from "./types.js";

/**
 * Async lane end to end (ARCHITECTURE.md "Two lanes"): the job that drafts
 * a reply to an inbound email and surfaces it as an items row pending human
 * approval. Nothing sends anything here; the draft lives in the item
 * payload until a human approves it in the console (the send is Job B,
 * gmail/send.ts).
 *
 * Trigger (GH-95): `{kind:"email"}` -- fired by the ingestion heartbeat
 * (jobs/dispatch.ts) for every inbound message -- plus `{kind:"manual"}`
 * so it can still be hand-fired (apps/worker fire.ts) for testing without a
 * mailbox. It historically fired only manually as "manual.email_draft".
 *
 * Payload: the inbound email, passed through from the enqueue call. Beyond
 * the human-facing from/subject/body it may carry Gmail threading metadata
 * (threadId, the RFC822 Message-ID, Reply-To); that metadata is kept out of
 * the model's prompt and stamped onto the item structurally (email_meta,
 * below) so a later reply can thread correctly and the model can neither
 * see nor corrupt it -- the same discipline as tags and KB sources.
 */

/** Shape of the inbound email payload this job expects. */
export interface InboundEmailPayload {
  from?: string;
  subject?: string;
  body?: string;
  /** Source message id, used for idempotent enqueue + item dedupe upstream. */
  messageId?: string;
  /** Gmail internal message id (label/read mutations target this). */
  gmailId?: string;
  /** Gmail thread id, so an approved reply threads into the conversation. */
  threadId?: string;
  /** RFC822 Message-ID header, for In-Reply-To / References on a reply. */
  messageIdHeader?: string;
  /** Existing References chain, extended when we reply. */
  references?: string;
  /** Reply-To header, the preferred reply recipient when the sender set one. */
  replyTo?: string;
  /** The inbound To header (informational). */
  to?: string;
}

/**
 * Threading metadata stamped onto the item payload as `email_meta` (GH-95),
 * structurally rather than through the prompt. gmail/send.ts reads this to
 * thread the approved reply; nothing customer-facing depends on it.
 */
export interface EmailMeta {
  gmailId?: string;
  threadId?: string;
  messageIdHeader?: string;
  references?: string;
  replyTo?: string;
  to?: string;
}

/** Extract the threading metadata (if any) from an inbound payload. */
function emailMetaOf(payload: InboundEmailPayload): EmailMeta | undefined {
  const meta: EmailMeta = {};
  if (payload.gmailId) meta.gmailId = payload.gmailId;
  if (payload.threadId) meta.threadId = payload.threadId;
  if (payload.messageIdHeader) meta.messageIdHeader = payload.messageIdHeader;
  if (payload.references) meta.references = payload.references;
  if (payload.replyTo) meta.replyTo = payload.replyTo;
  if (payload.to) meta.to = payload.to;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function renderEmail(payload: InboundEmailPayload): string {
  return [
    `From: ${payload.from ?? "(unknown sender)"}`,
    `Subject: ${payload.subject ?? "(no subject)"}`,
    "",
    // Budgeted (GH-62): an arbitrarily long inbound body is re-billed on
    // every tool-loop iteration; a real customer email never trips this.
    // Quoted reply history is stripped here (stripQuotedReply) so the model
    // only answers the NEW message, not questions from the quoted thread
    // beneath it. The stored/threaded body is untouched (parse.ts).
    truncateForPrompt(
      stripQuotedReply(payload.body ?? "(empty body)"),
      EMAIL_BODY_MAX_CHARS,
      "inbound email body",
    ),
  ].join("\n");
}

/**
 * create_item, wrapped so KB usage is recorded structurally (GH-57): if
 * the run consulted the knowledge base, the created item's payload gains
 * `sources` (the lookups, for a future approval-card display) and, when
 * any lookup failed, `kb_unavailable: true` so the reviewing human knows
 * the draft may lack KB facts. The sources RECORD cannot be forgotten or
 * forged by the model (it rides on the tool call itself); what the draft
 * BODY says is still governed by the prompt rules plus human approval.
 */
function createItemWithSources(
  log: KbRunLog,
  runState?: Record<string, unknown>,
  emailMeta?: EmailMeta,
): BetaRunnableTool<any> {
  const base = createItemTool as BetaRunnableTool<any>;
  return {
    ...base,
    run: async (input: Record<string, unknown>) => {
      // Everything here rides on the tool call structurally, never through
      // the model's prompt, so the drafting model can neither forget nor
      // forge it:
      //  - tags (GH-65): a separate sonnet classification;
      //  - sources / kb_unavailable (GH-57): the KB lookups this run made;
      //  - email_meta (GH-95): Gmail threading data for a later reply;
      //  - assignee_suggestion (GH-95): the sonnet routing suggestion.
      const tags = runState?.["tags"] as ItemTag[] | undefined;
      const suggestion = runState?.["assignee_suggestion"];
      const extra: Record<string, unknown> = {
        ...(log.sources.length > 0 || log.unavailable
          ? {
              sources: log.sources,
              ...(log.unavailable ? { kb_unavailable: true } : {}),
            }
          : {}),
        ...((tags?.length ?? 0) > 0 ? { tags } : {}),
        ...(emailMeta ? { email_meta: emailMeta } : {}),
        ...(suggestion ? { assignee_suggestion: suggestion } : {}),
      };
      if (Object.keys(extra).length > 0) {
        input = {
          ...input,
          payload: {
            ...((input["payload"] as Record<string, unknown>) ?? {}),
            ...extra,
          },
        };
      }
      const result = await base.run(input);
      // Breadcrumb for recordUsage (GH-62): remember which item this run
      // created so the run's token usage can be attached to it after the
      // loop finishes.
      if (runState && typeof result === "string") {
        try {
          const parsed = JSON.parse(result) as { id?: unknown };
          if (typeof parsed.id === "string") runState["itemId"] = parsed.id;
        } catch {
          // Non-JSON tool result: no breadcrumb, usage is just logged.
        }
      }
      return result;
    },
  };
}

export const emailDraft: Job = {
  id: "email.received",
  enabled: true,
  // Fires on any inbound email (the ingestion heartbeat), and stays
  // hand-fireable for testing without a mailbox (fire.ts).
  triggers: [{ kind: "email", match: /.*/ }, { kind: "manual" }],
  // create_item moves to runtimeTools so the per-run KB log can ride on it.
  tools: [],
  runtimeTools: (ctx: JobContext) => {
    const kb = createKbToolset();
    const meta = emailMetaOf((ctx.payload ?? {}) as InboundEmailPayload);
    return [
      createItemWithSources(kb.log, ctx.runState, meta),
      ...kb.tools,
    ];
  },
  recordUsage: async (ctx, usage) => {
    const itemId = ctx.runState?.["itemId"];
    if (typeof itemId !== "string") return; // no item created this run
    // Include the tag-classification sonnet call (GH-65) so the per-item
    // cost record (GH-62) counts every API call the run made.
    const classify = ctx.runState?.["classifyUsage"] as UsageTotals | undefined;
    const total = { ...usage };
    if (classify) {
      total.input_tokens += classify.input_tokens;
      total.output_tokens += classify.output_tokens;
      total.cache_creation_input_tokens += classify.cache_creation_input_tokens;
      total.cache_read_input_tokens += classify.cache_read_input_tokens;
      total.api_calls += classify.api_calls;
    }
    await recordItemUsage(itemId, total);
  },
  model: "claude-opus-4-8", // drafting job (locked decisions in CLAUDE.md)
  instructions: async (ctx: JobContext) => {
    const payload = (ctx.payload ?? {}) as InboundEmailPayload;
    // Owner-set studio rules (GH-66). Loaded per run so edits apply to
    // the next draft immediately; a rule edit invalidates the prompt
    // cache for the next call, which is acceptable at studio volume.
    const rules = await loadRulesBlock();
    // Owner-set studio info (GH-71): customer-safe facts (booking link,
    // policies), injected right after the rules block, same lifecycle.
    const studioInfo = await loadStudioInfoBlock();
    // Booking link rule: when SEALEVEL_BOOKING_URL is configured, tell the
    // model to close a class-attendance reply with a booking invitation and
    // the EXACT configured link (booking.ts). Gated exactly like the KB
    // guidance: unset means no rule and no behavior change. The URL is
    // interpolated verbatim so the model copies it rather than inventing one.
    const booking = bookingConfigured()
      ? bookingLinkGuidance(bookingUrl()!)
      : "";
    // Triage sonnet calls (GH-65 tags, GH-95 assignee suggestion): separate
    // small calls before the opus drafting loop, run concurrently. Both are
    // best-effort ([]/null on failure) and the draft proceeds identically
    // either way. Their results land on the item via the create_item
    // wrapper (runState), not via the prompt, and their token usage is
    // folded into the per-item cost record (recordUsage below).
    if (ctx.runState) {
      const classifyUsage = emptyUsage();
      const [tags, suggestion] = await Promise.all([
        classifyEmailTags(payload, classifyUsage),
        suggestAssignee(payload, classifyUsage),
      ]);
      ctx.runState["tags"] = tags;
      ctx.runState["assignee_suggestion"] = suggestion ?? undefined;
      ctx.runState["classifyUsage"] = classifyUsage;
    }
    return `
An inbound email to the studio needs a reply. Draft one; do not send anything.
${kbConfigured() ? KB_PROMPT_GUIDANCE : ""}${booking}${rules}${studioInfo}
Inbound email:
---
${renderEmail(payload)}
---

Do this:
1. Write a short, warm, plain reply (a few sentences). No em dashes. Sign off with "Sealevel Hot Yoga" as the final line. Never sign as an AI or mention AI authorship. Never describe your own knowledge or access in any wording: not having something to hand, not being able to see or pull up something, needing to check, or any mention of tools or systems. If you cannot state a fact, do not refer to the fact's absence at all. Never make commitments about future actions (no "I'll follow up", "we will get back to you", "will confirm and reply") unless the inbound explicitly requires a human action that cannot be resolved in this reply. When a fact is not available, answer what IS known and point the customer to the booking page link for the rest when one is configured (prices and schedule live there); if no link is configured, simply answer what is known and invite the customer to reply if they need the specific detail. Lead with what you DO know.
2. Call create_item exactly once with:
   - type: "email_reply"
   - domain: "email"
   - status: "pending_approval"${
     payload.messageId
       ? `\n   - dedupe_key: ${JSON.stringify(payload.messageId)} (retry safety: if an item with this key already exists, the tool returns it instead of creating a duplicate; treat that as success)`
       : ""
   }
   - payload: { "draft_subject": <reply subject>, "draft_body": <your reply>, "original_email": <the inbound email fields you were given> }
   - rationale: 1 to 3 plain sentences explaining why the draft says what it says, e.g. which policy, fact, or judgment shaped it ("Extended the intro offer because the customer was sick; matched the warm tone policy"). No em dashes. This is shown to the human reviewer as a "Why this draft" note.
3. Reply with a one-line summary including the created item id.

The draft only becomes real if a human approves it later. Do not claim anything was sent.
`;
  },
};
