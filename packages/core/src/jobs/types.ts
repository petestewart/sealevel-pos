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
  /** Model to run on. Defaults to claude-opus-4-8 when omitted. */
  model?: BrainModel;
  /** The prompt. Almost entirely prose. */
  instructions: (ctx: JobContext) => string;
}

export type Trigger =
  | { kind: "cron"; expr: string }
  | { kind: "webhook"; eventType: string }
  | { kind: "email"; match: RegExp }
  | { kind: "manual" }; // fire by hand (CLI/dashboard)
