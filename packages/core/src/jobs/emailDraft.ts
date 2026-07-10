import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import {
  EMAIL_BODY_MAX_CHARS,
  emptyUsage,
  truncateForPrompt,
  type UsageTotals,
} from "../brain/budget.js";
import { classifyEmailTags } from "../brain/classify.js";
import { recordItemUsage } from "../db/itemDrafts.js";
import type { ItemTag } from "../tags.js";
import { createItemTool } from "../tools/registry.js";
import {
  createKbToolset,
  KB_PROMPT_GUIDANCE,
  kbConfigured,
  type KbRunLog,
} from "../tools/kb.js";
import type { Job, JobContext } from "./types.js";

/**
 * Async lane end to end (ARCHITECTURE.md "Two lanes"): a manual-trigger
 * job that drafts a reply to an inbound email and surfaces it as an
 * items row pending human approval. Nothing sends anything; the draft
 * lives in the item payload until a human approves it in the console.
 *
 * Payload: the inbound email (from, subject, body, optional messageId),
 * passed through from the enqueue call.
 */

/** Shape of the inbound email payload this job expects. */
export interface InboundEmailPayload {
  from?: string;
  subject?: string;
  body?: string;
  /** Source message id, used for idempotent enqueue upstream. */
  messageId?: string;
}

function renderEmail(payload: InboundEmailPayload): string {
  return [
    `From: ${payload.from ?? "(unknown sender)"}`,
    `Subject: ${payload.subject ?? "(no subject)"}`,
    "",
    // Budgeted (GH-62): an arbitrarily long inbound body is re-billed on
    // every tool-loop iteration; a real customer email never trips this.
    truncateForPrompt(
      payload.body ?? "(empty body)",
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
): BetaRunnableTool<any> {
  const base = createItemTool as BetaRunnableTool<any>;
  return {
    ...base,
    run: async (input: Record<string, unknown>) => {
      // Tags (GH-65) ride on the tool call like sources: classified by a
      // separate sonnet call before the drafting loop and merged here
      // structurally, so the drafting model can neither forget nor forge
      // them (they are not part of its prompt contract at all).
      const tags = runState?.["tags"] as ItemTag[] | undefined;
      if (log.sources.length > 0 || log.unavailable || (tags?.length ?? 0) > 0) {
        input = {
          ...input,
          payload: {
            ...((input["payload"] as Record<string, unknown>) ?? {}),
            ...(log.sources.length > 0 || log.unavailable
              ? {
                  sources: log.sources,
                  ...(log.unavailable ? { kb_unavailable: true } : {}),
                }
              : {}),
            ...((tags?.length ?? 0) > 0 ? { tags } : {}),
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
  id: "manual.email_draft",
  enabled: true,
  triggers: [{ kind: "manual" }],
  // create_item moves to runtimeTools so the per-run KB log can ride on it.
  tools: [],
  runtimeTools: (ctx: JobContext) => {
    const kb = createKbToolset();
    return [createItemWithSources(kb.log, ctx.runState), ...kb.tools];
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
    // Tag classification (GH-65): a separate small sonnet call, before
    // the opus drafting loop. Best-effort: [] on any failure, and the
    // draft proceeds identically either way. The tags land on the item
    // via the create_item wrapper (runState), not via the prompt.
    if (ctx.runState) {
      const classifyUsage = emptyUsage();
      ctx.runState["tags"] = await classifyEmailTags(payload, classifyUsage);
      ctx.runState["classifyUsage"] = classifyUsage;
    }
    return `
An inbound email to the studio needs a reply. Draft one; do not send anything.
${kbConfigured() ? KB_PROMPT_GUIDANCE : ""}
Inbound email:
---
${renderEmail(payload)}
---

Do this:
1. Write a short, warm, plain reply (a few sentences). No em dashes. Sign off as "the AI Manager".
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
