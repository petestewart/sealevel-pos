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
  const keys = (c.rubric ?? []).map((_, i) => `"${i + 1}":true|false`).join(",");
  return `Grade a drafted reply to an inbound email to a yoga studio against the numbered criteria.

Inbound email:
From: ${c.inbound.from}
Subject: ${c.inbound.subject}
${body}

Draft reply:
${draftBody}

Criteria:
${criteria}

Respond with ONLY minified JSON, nothing else: {${keys},"notes":"<=30 words"}`;
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
  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: buildJudgePrompt(c, draftBody) }],
  });
  addUsage(usage, response.usage);
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const { criteria, notes } = parseVerdict(text, rubric.length);
  return { criteria, notes, usage };
}
