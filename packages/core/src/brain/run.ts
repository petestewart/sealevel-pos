import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";

import { jobById } from "../jobs/registry.js";
import type { BrainModel } from "../jobs/types.js";
import { toolsForJob } from "../tools/registry.js";
import { SYSTEM_PROMPT } from "./prompts.js";

/**
 * The brain (ARCHITECTURE.md "The brain"): the Anthropic SDK tool runner.
 * Per job it loads the job's instructions and only that job's tools, then
 * runs the agentic loop until the model stops calling tools.
 */

export const DEFAULT_BRAIN_MODEL: BrainModel = "claude-opus-4-8";

let client: Anthropic | undefined;

/** Lazily construct the client so importing core never requires the key. */
function getClient(): Anthropic {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}

/**
 * Run one job through the tool runner. Tool side effects happen inside
 * the runner; a throw propagates so BullMQ retries. Returns the final
 * message's stop reason.
 */
export async function runJob(
  jobId: string,
  payload?: unknown,
): Promise<BetaMessage["stop_reason"]> {
  const job = jobById.get(jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);

  const finalMessage = await getClient().beta.messages.toolRunner({
    model: job.model ?? DEFAULT_BRAIN_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    tools: toolsForJob(job.tools), // scoped per job
    messages: [{ role: "user", content: job.instructions({ payload }) }],
  });

  return finalMessage.stop_reason;
}
