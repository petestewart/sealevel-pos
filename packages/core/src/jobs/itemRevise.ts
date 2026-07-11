import { createHash } from "node:crypto";

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

import {
  EMAIL_BODY_MAX_CHARS,
  INSTRUCTION_MAX_CHARS,
  truncateForPrompt,
} from "../brain/budget.js";
import { loadRulesBlock } from "../db/settings.js";
import { loadStudioInfoBlock } from "../db/studioInfo.js";
import {
  getPendingEmailReplyItem,
  recordDraftAnswer,
  recordItemUsage,
  reviseEmailReplyDraft,
} from "../db/itemDrafts.js";
import {
  createKbToolset,
  KB_PROMPT_GUIDANCE,
  kbConfigured,
  type KbRunLog,
} from "../tools/kb.js";
import type { Job, JobContext } from "./types.js";

/**
 * item.revise (GH-36): one-shot operator instruction about a pending
 * email_reply draft. The operator either asks for an edit ("make it two
 * sentences shorter") or asks a question ("what class is she asking
 * about?"). The model decides which, and the output contract is
 * structural, not prompt-hope: the only side-effect surface is two
 * per-run tools closed over this item's id:
 *
 * - update_draft   -> replaces the draft, pushes the prior draft onto
 *                     payload.draft_revisions (capped), clears
 *                     payload.last_answer;
 * - answer_question -> writes payload.last_answer { question, answer, at }
 *                     and leaves the draft untouched.
 *
 * The job declares no registry tools at all (tools: []), so its toolset
 * is read-only apart from those two item-payload writes; there is no
 * outbound capability to misuse. Both DB writes are guarded on
 * status = 'pending_approval', so an item decided mid-revision is never
 * mutated; the tool throws and the run fails with a clear log instead.
 *
 * Enqueue + poll contract for the console (GH-37): see
 * docs/item-revise.md. Deterministic jobId: reviseJobId(itemId, instruction).
 */

/** Payload for an item.revise run. */
export interface ItemRevisePayload {
  itemId: string;
  instruction: string;
}

/**
 * Deterministic BullMQ jobId for an item.revise enqueue:
 * revise-<itemId>-<sha256(instruction) prefix>. Re-submitting the same
 * instruction for the same item while the prior job record still exists
 * in Redis is a no-op (windowed idempotency, see queue/queue.ts).
 */
export function reviseJobId(itemId: string, instruction: string): string {
  const hash = createHash("sha256").update(instruction).digest("hex").slice(0, 12);
  return `revise-${itemId}-${hash}`;
}

function parsePayload(payload: unknown): ItemRevisePayload {
  const p = (payload ?? {}) as Partial<ItemRevisePayload>;
  if (typeof p.itemId !== "string" || p.itemId.length === 0) {
    throw new Error("item.revise: payload.itemId (string) is required");
  }
  if (typeof p.instruction !== "string" || p.instruction.trim().length === 0) {
    throw new Error("item.revise: payload.instruction (string) is required");
  }
  return { itemId: p.itemId, instruction: p.instruction };
}

/**
 * Per-run private tools, closed over the target item id so the model can
 * only touch this one item. Exported for the toolset smoke check
 * (jobs/itemRevise.smoke.ts), which asserts these two names are the
 * job's entire side-effect surface.
 */
export function itemReviseTools(
  itemId: string,
  kbLog?: KbRunLog,
): BetaRunnableTool<any>[] {
  const updateDraft = betaZodTool({
    name: "update_draft",
    description:
      "Replace the pending draft reply with a revised version. The prior draft is preserved in the item's revision history automatically. Use this only when the operator asked for a change to the draft.",
    inputSchema: z.object({
      subject: z.string().min(1).describe("The revised reply subject."),
      body: z.string().min(1).describe("The full revised reply body."),
      rationale: z
        .string()
        .optional()
        .describe(
          "1-3 plain sentences explaining why the revised draft says what it says. Replaces the previous 'Why this draft' note shown to the reviewing human (payload.draft_rationale).",
        ),
    }),
    run: async ({ subject, body, rationale }) => {
      const item = await reviseEmailReplyDraft(itemId, {
        subject,
        body,
        rationale,
        // KB lookups behind this revision (GH-57), recorded structurally.
        sources: kbLog && kbLog.sources.length > 0 ? kbLog.sources : undefined,
      });
      const revisions = Array.isArray(item.payload["draft_revisions"])
        ? (item.payload["draft_revisions"] as unknown[]).length
        : 0;
      return JSON.stringify({ id: item.id, revised: true, revisions });
    },
  });

  const answerQuestion = betaZodTool({
    name: "answer_question",
    description:
      "Answer the operator's question about the draft or the original email without changing the draft. Use this only when the operator asked a question rather than requesting an edit.",
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .describe("The operator's question, as asked."),
      answer: z.string().min(1).describe("Your answer to the question."),
    }),
    run: async ({ question, answer }) => {
      const item = await recordDraftAnswer(itemId, { question, answer });
      return JSON.stringify({ id: item.id, answered: true });
    },
  });

  return [updateDraft, answerQuestion];
}

function renderPayloadField(
  value: unknown,
  label: string,
  opts?: { truncate?: boolean },
): string {
  const text =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? "(none)"
        : JSON.stringify(value, null, 2);
  // Budgeted (GH-62): reference-only fields (the original email) are
  // re-billed on every tool-loop iteration and safe to cap. The CURRENT
  // DRAFT is deliberately never truncated: update_draft full-overwrites
  // the body, so a truncated view would make the model reproduce a
  // shortened draft and silently corrupt it. Draft size is already
  // bounded in practice by the model's own output cap.
  if (opts?.truncate === false) return text;
  return truncateForPrompt(text, EMAIL_BODY_MAX_CHARS, label);
}

export const itemRevise: Job = {
  id: "item.revise",
  enabled: true,
  triggers: [{ kind: "manual" }], // enqueued by the console (GH-37)
  tools: [], // no registry tools: read-only apart from the two per-run tools
  runtimeTools: (ctx: JobContext) => {
    const { itemId } = parsePayload(ctx.payload);
    // KB read tools (GH-57) join the two private item tools; the KB log
    // threads into update_draft so a KB-informed revision records its
    // sources on the item.
    const kb = createKbToolset();
    return [...itemReviseTools(itemId, kb.log), ...kb.tools];
  },
  model: "claude-opus-4-8", // drafting quality (locked decisions in CLAUDE.md)
  recordUsage: async (ctx, usage) => {
    // The target item is known up front; attach what this revision cost.
    const { itemId } = parsePayload(ctx.payload);
    await recordItemUsage(itemId, { ...usage });
  },
  instructions: async (ctx: JobContext) => {
    const { itemId, instruction } = parsePayload(ctx.payload);
    // Throws unless the item exists, is an email_reply, and is still
    // pending_approval; a decided item must fail the run, not be mutated.
    const item = await getPendingEmailReplyItem(itemId);
    const payload = item.payload;
    // Owner-set studio rules (GH-66); revisions must respect them too.
    const rules = await loadRulesBlock();
    // Owner-set studio info (GH-71); revisions must respect it too.
    const studioInfo = await loadStudioInfoBlock();

    return `
An operator reviewing a pending draft email reply sent you a one-shot instruction. Decide which kind it is and finish with exactly one call to update_draft or answer_question:
${kbConfigured() ? KB_PROMPT_GUIDANCE : ""}${rules}${studioInfo}

- If it asks you to CHANGE the draft (shorten it, change tone, add or remove something), write the revised reply and call update_draft exactly once with the full new subject and body, plus a rationale: 1 to 3 plain sentences on why the revised draft says what it says (what you changed and why). Keep the reply short, warm, and plain. No em dashes, in the reply or the rationale. Sign off with "Sealevel Hot Yoga" as the final line unless the operator asked for a different signoff. Never sign as an AI or mention AI authorship.
- If it asks a QUESTION (about the original email, the draft, or your reasoning), do NOT touch the draft. Call answer_question exactly once with the question and a concise answer.

Never call both update_draft and answer_question, and never call either twice. Knowledge base lookups (if available) may precede that final call.

Original inbound email:
---
${renderPayloadField(payload["original_email"], "original email")}
---

Current draft subject: ${renderPayloadField(payload["draft_subject"], "draft subject", { truncate: false })}
Current draft body:
---
${renderPayloadField(payload["draft_body"], "draft body", { truncate: false })}
---

Operator instruction:
---
${truncateForPrompt(instruction, INSTRUCTION_MAX_CHARS, "operator instruction")}
---

After the tool call, reply with a one-line summary of what you did.
`;
  },
};
