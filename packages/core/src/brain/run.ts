import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";

import { jobById } from "../jobs/registry.js";
import type { BrainModel } from "../jobs/types.js";
import { toolsForJob } from "../tools/registry.js";
import { addUsage, emptyUsage } from "./budget.js";
import { SYSTEM_PROMPT } from "./prompts.js";

/**
 * The brain (ARCHITECTURE.md "The brain"): the Anthropic SDK tool runner.
 * Per job it loads the job's instructions and only that job's tools, then
 * runs the agentic loop until the model stops calling tools.
 *
 * Cost hardening (GH-62): the system prompt and the instructions message
 * carry prompt-cache breakpoints, and every API response's usage is
 * accumulated and handed to the job's recordUsage hook so runs can store
 * what they cost. In the API's cache-prefix ordering tools precede
 * system, so the system breakpoint caches the tool definitions too; the
 * instructions breakpoint extends the cached prefix over the (per-run)
 * first user message, which is what makes iterations 2..n of the tool
 * loop cache-read instead of re-billing the whole prompt at full price.
 */

export const DEFAULT_BRAIN_MODEL: BrainModel = "claude-opus-4-8";

/** Runaway-loop backstop: far above any legitimate run's iteration count. */
const MAX_ITERATIONS = 12;

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

  // One context object per run, shared by runtimeTools, instructions and
  // recordUsage so per-run tools can leave state (e.g. the created item
  // id) for the usage hook.
  const ctx = { payload, runState: {} as Record<string, unknown> };

  // Scoped per job: named registry tools plus any per-run private tools
  // the job builds from the payload (Job.runtimeTools).
  const tools = [...toolsForJob(job.tools), ...(job.runtimeTools?.(ctx) ?? [])];

  // Instructions may be async (e.g. loading the item a run operates on).
  const content = await job.instructions(ctx);

  const runner = getClient().beta.messages.toolRunner({
    model: job.model ?? DEFAULT_BRAIN_MODEL,
    max_tokens: 16000,
    max_iterations: MAX_ITERATIONS,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Caches tools + system across runs (tools precede system in the
        // cache prefix), independent of the per-run instructions below.
        cache_control: { type: "ephemeral" },
      },
    ],
    tools,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: content,
            // Extends the cached prefix over the instructions so every
            // tool-loop iteration after the first is a cache read.
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  });

  // Iterate rather than await: each yielded message is one API response,
  // whose usage block is accumulated into the run totals.
  const usage = emptyUsage();
  let finalMessage: BetaMessage | undefined;
  for await (const message of runner) {
    addUsage(usage, message.usage);
    finalMessage = message;
  }
  if (!finalMessage) throw new Error(`job ${jobId} produced no response`);

  // Usage recording must never fail the run itself: the work (the tool
  // side effects) already happened.
  if (job.recordUsage) {
    try {
      await job.recordUsage(ctx, usage);
    } catch (err) {
      console.warn(
        `[brain] recordUsage failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(
    `[brain] ${jobId} usage: in=${usage.input_tokens} out=${usage.output_tokens} cache_write=${usage.cache_creation_input_tokens} cache_read=${usage.cache_read_input_tokens} calls=${usage.api_calls}`,
  );

  // A run that ends still wanting to call tools hit MAX_ITERATIONS: its
  // side effects may be missing (no create_item, no update_draft). Fail
  // loudly (after usage is recorded) so BullMQ retries/dead-letters
  // instead of a silent no-op the caller would mistake for success.
  if (finalMessage.stop_reason === "tool_use") {
    throw new Error(
      `job ${jobId} hit the ${MAX_ITERATIONS}-iteration cap mid-tool-call`,
    );
  }

  return finalMessage.stop_reason;
}
