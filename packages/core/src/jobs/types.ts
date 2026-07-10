import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import type { UsageTotals } from "../brain/budget.js";

/**
 * Job and Trigger types (see ARCHITECTURE.md "Jobs and the registry").
 *
 * A job is one self-contained object, one file per job in src/jobs/ (or
 * inside a feature module). Adding a job = adding a file; removing =
 * delete or set enabled: false; updating = edit the prose.
 */

/** Context passed to a job's instructions builder when it fires. */
export interface JobContext {
  /** Trigger-specific payload (webhook event, parsed email, cron tick). */
  payload?: unknown;
  /**
   * Per-run scratch state shared between runtimeTools, instructions and
   * recordUsage (one object per run, created by runJob). Lets a per-run
   * tool leave breadcrumbs for the post-run hooks, e.g. the id of the
   * item a create_item call produced, so usage can be attached to it.
   */
  runState?: Record<string, unknown>;
}

/**
 * Models the brain may run a job on (locked decisions in CLAUDE.md):
 * claude-opus-4-8 for drafting-type jobs, claude-sonnet-5 for
 * triage/classification jobs.
 */
export type BrainModel = "claude-opus-4-8" | "claude-sonnet-5";

export interface Job {
  id: string;
  enabled: boolean;
  triggers: Trigger[];
  /** Scoped capability names; the tool runner resolves them by name. */
  tools: string[];
  /**
   * Optional per-run tools, private to this job and built from the run's
   * payload (e.g. tools closed over a specific item id, so the model can
   * only touch that item). Appended after the named tools. Use for output
   * contracts that must be structural rather than prompt-hope.
   */
  // BetaRunnableTool<any>: same reasoning as tools/registry.ts — the list is
  // heterogeneous and each tool's input type appears both contravariantly
  // and covariantly; inputs stay runtime-validated by each tool's Zod schema.
  runtimeTools?: (ctx: JobContext) => BetaRunnableTool<any>[];
  /** Model to run on. Defaults to claude-opus-4-8 when omitted. */
  model?: BrainModel;
  /** The prompt. Almost entirely prose. May load data (async) to build it. */
  instructions: (ctx: JobContext) => string | Promise<string>;
  /**
   * Optional post-run hook (GH-62): receives the token usage accumulated
   * across every API call in the run, so the job can store cost data on
   * whatever it produced (e.g. payload.usage on an item). Failures are
   * logged by runJob and never fail the run.
   */
  recordUsage?: (ctx: JobContext, usage: UsageTotals) => Promise<void>;
}

export type Trigger =
  | { kind: "cron"; expr: string }
  | { kind: "webhook"; eventType: string }
  | { kind: "email"; match: RegExp }
  | { kind: "manual" }; // fire by hand (CLI/dashboard)
