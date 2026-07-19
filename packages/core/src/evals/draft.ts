import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import { addUsage, emptyUsage, type UsageTotals } from "../brain/budget.js";
import { classifyNoReply, type NoReplyClassification } from "../brain/noReply.js";
import { SYSTEM_PROMPT } from "../brain/prompts.js";
import { emailDraft } from "../jobs/emailDraft.js";
import type { JobContext } from "../jobs/types.js";
import { createItemTool } from "../tools/registry.js";
import { createKbToolset } from "../tools/kb.js";
import type { EvalCase } from "./cases.js";
import { applyCaseEnv, installFixtureKb } from "./fixtures.js";

/**
 * Run one golden case through the REAL drafting path.
 *
 * Correctness requires production parity, so this mirrors brain/run.ts
 * exactly for everything the model can observe: the same system prompt
 * and cache breakpoints, the same model (emailDraft.model, the opus
 * drafting tier; never swapped for a cheaper model), the same
 * max_tokens/max_iterations/thinking config, the job's own
 * instructions() for prompt assembly, and the real KB toolset served
 * from fixtures via fetch interception (fixtures.ts).
 *
 * Two deliberate departures, both invisible to the model:
 * - create_item keeps its real name/description/schema but its run() is
 *   swapped for a capture that returns a canned item id, so no DB is
 *   touched and the draft is harvested from the tool call itself.
 * - ctx.runState is omitted, which (by emailDraft's own gate) skips the
 *   two best-effort sonnet triage calls (tags + assignee suggestion).
 *   They never influence the draft text, so skipping them saves tokens
 *   on every eval run without changing what is being measured.
 */

export interface DraftRunResult {
  draft?: { subject?: string; body?: string; rationale?: string };
  createItemCalls: number;
  finalText: string;
  stopReason: BetaMessage["stop_reason"] | null;
  usage: UsageTotals;
  /**
   * GH-115: set when the no-reply gate (the same brain/noReply.ts layers
   * the production preflight runs) classified the inbound, in which case
   * drafting was skipped and `draft` is absent.
   */
  classification?: NoReplyClassification;
}

const MAX_ITERATIONS = 12; // mirrors brain/run.ts

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Live eval runs draft with the real " +
        "drafting model and judge with the triage model; set the key, or " +
        "use --offline to re-check cached outputs with zero API calls.",
    );
  }
  client ??= new Anthropic();
  return client;
}

export async function runDraftCase(c: EvalCase): Promise<DraftRunResult> {
  const restoreEnv = applyCaseEnv(c.env);
  const uninstallKb = installFixtureKb(c.fixtures ?? []);
  try {
    // The no-reply gate (GH-115) runs first, exactly as the production
    // preflight does: tiers 1-2 free, tier 3 one sonnet call. On a hit the
    // drafting loop is skipped entirely and the classification is the
    // run's result. This IS part of what the suite measures (a case can
    // assert either outcome via expectNoReply), so unlike the tags and
    // assignee triage calls it is not skipped for token savings.
    const gateUsage = emptyUsage();
    const classification = await classifyNoReply(c.inbound, gateUsage);
    if (classification) {
      return {
        classification,
        createItemCalls: 0,
        finalText: "",
        stopReason: null,
        usage: gateUsage,
      };
    }

    const captured: Array<Record<string, unknown>> = [];
    const base = createItemTool as BetaRunnableTool<any>;
    const captureCreateItem: BetaRunnableTool<any> = {
      ...base,
      run: async (input: Record<string, unknown>) => {
        captured.push(input);
        return JSON.stringify({
          id: `eval-item-${captured.length}`,
          status: "pending_approval",
        });
      },
    };
    const kb = createKbToolset();
    const tools = [captureCreateItem, ...kb.tools];

    // messageId gives the prompt its production dedupe_key line.
    const ctx: JobContext = {
      payload: { ...c.inbound, messageId: `eval-${c.id}` },
    };
    const content = await emailDraft.instructions(ctx);

    const runner = getClient().beta.messages.toolRunner({
      model: emailDraft.model ?? "claude-opus-4-8",
      max_tokens: 16000,
      max_iterations: MAX_ITERATIONS,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          // Same breakpoints as production; across a suite run the
          // tools+system prefix is written once and cache-read by every
          // later case, which is most of the suite's input tokens.
          cache_control: { type: "ephemeral" },
        },
      ],
      tools,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: content, cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });

    // Start from the gate's usage so a tier-3 "needs a reply" screening
    // call is counted in the run's spend, matching production accounting.
    const usage = gateUsage;
    let finalMessage: BetaMessage | undefined;
    for await (const message of runner) {
      addUsage(usage, message.usage);
      finalMessage = message;
    }
    if (!finalMessage) throw new Error(`case ${c.id} produced no response`);
    if (finalMessage.stop_reason === "tool_use") {
      throw new Error(
        `case ${c.id} hit the ${MAX_ITERATIONS}-iteration cap mid-tool-call`,
      );
    }

    const first = captured[0];
    const payload = (first?.["payload"] ?? {}) as Record<string, unknown>;
    const draft = first
      ? {
          ...(typeof payload["draft_subject"] === "string"
            ? { subject: payload["draft_subject"] }
            : {}),
          ...(typeof payload["draft_body"] === "string"
            ? { body: payload["draft_body"] }
            : {}),
          ...(typeof first["rationale"] === "string"
            ? { rationale: first["rationale"] as string }
            : {}),
        }
      : undefined;
    return {
      ...(draft ? { draft } : {}),
      createItemCalls: captured.length,
      finalText: finalMessage.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
      stopReason: finalMessage.stop_reason,
      usage,
    };
  } finally {
    uninstallKb();
    restoreEnv();
  }
}
