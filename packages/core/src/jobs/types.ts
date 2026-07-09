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

export interface Job {
  id: string;
  enabled: boolean;
  triggers: Trigger[];
  /** Scoped capability names; the tool runner resolves them by name. */
  tools: string[];
  /** The prompt. Almost entirely prose. */
  instructions: (ctx: JobContext) => string;
}

export type Trigger =
  | { kind: "cron"; expr: string }
  | { kind: "webhook"; eventType: string }
  | { kind: "email"; match: RegExp }
  | { kind: "manual" }; // fire by hand (CLI/dashboard)
