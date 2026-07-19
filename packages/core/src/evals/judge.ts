import Anthropic from "@anthropic-ai/sdk";

import { addUsage, emptyUsage, type UsageTotals } from "../brain/budget.js";
import type { EvalCase } from "./cases.js";

/**
 * Token-lean LLM judge. Runs ONLY for cases that declare a rubric, and
 * only after every deterministic check passed (run.ts enforces both).
 * One call per case grades ALL criteria at once on the cheap triage
 * model, and the verdict is compact JSON with a bounded notes field, so
 * no chain-of-thought is ever paid for.
 */

/** Same triage/classification tier the repo uses (CLAUDE.md). */
export const JUDGE_MODEL = "claude-sonnet-5";

/** Inbound context the judge sees; criteria never need more than this. */
const JUDGE_INBOUND_MAX_CHARS = 1200;

export interface JudgeVerdict {
  /** Criterion number (1-based, as string) to pass/fail. */
  criteria: Record<string, boolean>;
  notes: string;
  usage: UsageTotals;
}

export function buildJudgePrompt(c: EvalCase, draftBody: string): string {
  const body =
    c.inbound.body.length > JUDGE_INBOUND_MAX_CHARS
      ? `${c.inbound.body.slice(0, JUDGE_INBOUND_MAX_CHARS)}\n[truncated]`
      : c.inbound.body;
  const criteria = (c.rubric ?? [])
    .map((r, i) => `${i + 1}. ${r}`)
    .join("\n");
  return `Grade a drafted reply to an inbound email to a yoga studio against the numbered criteria.

Inbound email:
From: ${c.inbound.from}
Subject: ${c.inbound.subject}
${body}

Draft reply:
${draftBody}

Criteria:
${criteria}

Grade every criterion and report the result via the verdict tool.`;
}

/** Parse the judge's JSON verdict; a missing criterion counts as a fail. */
export function parseVerdict(
  text: string,
  criteriaCount: number,
): { criteria: Record<string, boolean>; notes: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`judge returned no JSON: ${text.slice(0, 120)}`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<
    string,
    unknown
  >;
  const criteria: Record<string, boolean> = {};
  for (let i = 1; i <= criteriaCount; i++) {
    criteria[String(i)] = parsed[String(i)] === true;
  }
  return {
    criteria,
    notes: typeof parsed["notes"] === "string" ? parsed["notes"] : "",
  };
}

let client: Anthropic | undefined;

export async function judgeCase(
  c: EvalCase,
  draftBody: string,
): Promise<JudgeVerdict> {
  const rubric = c.rubric ?? [];
  client ??= new Anthropic();
  const usage = emptyUsage();
  // The judge occasionally returns an empty or non-JSON body. One retry
  // absorbs the transient case; a second failure degrades to an all-fail
  // verdict (conservative: the case reads as failed, with the reason in
  // notes) instead of throwing, so one flaky judge call can never crash
  // the whole suite and eat the scorecard.
  // Forced tool use: the model MUST call the verdict tool, so the result
  // arrives as a structured object with no text parsing. (Assistant
  // prefill is not supported on this model, and free-text JSON proved
  // unreliable: the model could spend the whole budget reasoning and
  // return an empty text body.)
  const properties: Record<string, unknown> = {
    notes: { type: "string", description: "At most 30 words." },
  };
  const required: string[] = ["notes"];
  for (let i = 1; i <= rubric.length; i++) {
    properties[String(i)] = {
      type: "boolean",
      description: `Criterion ${i} passes.`,
    };
    required.push(String(i));
  }
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: buildJudgePrompt(c, draftBody) }],
        tools: [
          {
            name: "verdict",
            description: "Report the grading verdict for every criterion.",
            input_schema: { type: "object", properties, required },
          },
        ],
        tool_choice: { type: "tool", name: "verdict" },
      });
      addUsage(usage, response.usage);
      const block = response.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new Error(
          `judge returned no verdict tool call (stop_reason=${response.stop_reason ?? "?"})`,
        );
      }
      const input = block.input as Record<string, unknown>;
      const criteria: Record<string, boolean> = {};
      for (let i = 1; i <= rubric.length; i++) {
        criteria[String(i)] = input[String(i)] === true;
      }
      return {
        criteria,
        notes: typeof input["notes"] === "string" ? input["notes"] : "",
        usage,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  const criteria: Record<string, boolean> = {};
  for (let i = 1; i <= rubric.length; i++) criteria[String(i)] = false;
  return { criteria, notes: `judge unusable after retry: ${lastError}`, usage };
}
