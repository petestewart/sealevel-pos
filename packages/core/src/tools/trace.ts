/**
 * Per-run trace capture (GH-122, second slice; the deploy-version stamp
 * in version.ts landed first).
 *
 * A drafting run leaves a structured RunTrace on the item it creates
 * (payload.run_trace) so a misfire is diagnosable from the console: which
 * tools were called in what order, what each returned (ok / empty / error
 * with the sanitized message), which tools were AVAILABLE but never
 * called, which guidance blocks were active, and every degradation the
 * run hit. Generalizes the KbRunLog.unavailable idea (tools/kb.ts) into
 * one record for the whole run.
 *
 * Posture (issue constraints):
 * - Best-effort: capture must never fail or slow the job. Every recorder
 *   method swallows its own errors, and call sites additionally guard
 *   with try/catch so even a broken recorder object cannot break a draft.
 * - Small: hard caps on entry count and per-entry text so the payload
 *   stays a few KB at most (the KB_RESULT_MAX_CHARS spirit at a much
 *   smaller budget; traces are operator diagnostics, not content).
 * - No secrets: only tool names, refs, sizes, durations and error
 *   messages already sanitized at the client layer (kb.ts never puts the
 *   token in an error) are recorded. Result TEXT is never stored, only
 *   its size.
 */

/** Max recorded tool calls per run; later calls only bump dropped_calls. */
export const TRACE_MAX_CALLS = 30;

/** Per-entry budget for the ref/args summary. */
export const TRACE_REF_MAX_CHARS = 200;

/** Per-entry budget for a sanitized error message. */
export const TRACE_ERROR_MAX_CHARS = 200;

export type TraceOutcome = "ok" | "empty" | "error";

/** One recorded tool call, display-ready for the console trace view. */
export interface TraceCall {
  /** Tool name, e.g. "upcoming_classes" or "create_item". */
  tool: string;
  /** Short ref/args summary (the query, page name, filter), capped. */
  ref: string;
  outcome: TraceOutcome;
  /** Sanitized error message, capped; only when outcome is "error". */
  error?: string;
  /** Result size in characters BEFORE any prompt-budget truncation. */
  result_chars?: number;
  duration_ms?: number;
  at: string;
}

/** The per-run trace stored at payload.run_trace. */
export interface RunTrace {
  /** Tool calls in order, capped at TRACE_MAX_CALLS. */
  calls: TraceCall[];
  /** How many calls past the cap were not recorded. */
  dropped_calls?: number;
  /** Every tool registered for the run, so "available but never called"
   * is visible at a glance. */
  toolset: string[];
  /** Active guidance blocks: "kb", "booking", "rules", "studio-info". */
  guidance: string[];
  /** Degradation flags, one per fallback the run hit, e.g.
   * "kb-unavailable", "rules-unavailable", "studio-info-unavailable". */
  degraded: string[];
  /** API model id the run used (config value, e.g. "claude-opus-4-8"). */
  model?: string;
}

/** Cut oversized capture text; a single char marks the cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Input shape for TraceRecorder.record (camelCase, pre-cap). */
export interface TraceCallInput {
  tool: string;
  ref?: string;
  outcome: TraceOutcome;
  error?: string;
  resultChars?: number;
  durationMs?: number;
}

/**
 * Per-run trace recorder. One instance is created per job run (in the
 * job's runtimeTools), threaded into the KB toolset and the item tool,
 * and snapshotted onto the item payload when the item is written.
 */
export class TraceRecorder {
  readonly trace: RunTrace = {
    calls: [],
    toolset: [],
    guidance: [],
    degraded: [],
  };

  /** Record one tool call, enforcing the entry cap and text budgets. */
  record(call: TraceCallInput): void {
    try {
      if (this.trace.calls.length >= TRACE_MAX_CALLS) {
        this.trace.dropped_calls = (this.trace.dropped_calls ?? 0) + 1;
        return;
      }
      const entry: TraceCall = {
        tool: clip(call.tool, 80),
        ref: clip(call.ref ?? "", TRACE_REF_MAX_CHARS),
        outcome: call.outcome,
        at: new Date().toISOString(),
      };
      if (call.outcome === "error" && call.error) {
        entry.error = clip(call.error, TRACE_ERROR_MAX_CHARS);
      }
      if (typeof call.resultChars === "number") {
        entry.result_chars = call.resultChars;
      }
      if (typeof call.durationMs === "number") {
        entry.duration_ms = Math.max(0, Math.round(call.durationMs));
      }
      this.trace.calls.push(entry);
    } catch {
      // Capture must never fail the run.
    }
  }

  /** Note the full toolset registered for the run (names, deduplicated). */
  setToolset(names: string[]): void {
    try {
      this.trace.toolset = [...new Set(names)].map((n) => clip(n, 80));
    } catch {
      // Capture must never fail the run.
    }
  }

  /** Flag a guidance block as active for the run (deduplicated). */
  guide(flag: string): void {
    try {
      const f = clip(flag, 80);
      if (!this.trace.guidance.includes(f)) this.trace.guidance.push(f);
    } catch {
      // Capture must never fail the run.
    }
  }

  /** Flag a degradation the run hit (deduplicated). */
  degrade(flag: string): void {
    try {
      const f = clip(flag, 80);
      if (!this.trace.degraded.includes(f)) this.trace.degraded.push(f);
    } catch {
      // Capture must never fail the run.
    }
  }

  /** Note the API model id the run uses. */
  setModel(model: string): void {
    try {
      this.trace.model = clip(model, 80);
    } catch {
      // Capture must never fail the run.
    }
  }

  /**
   * A payload-ready copy of the trace (optional fields only when set),
   * or undefined if the copy itself fails; callers treat undefined as
   * "draft proceeds untraced".
   */
  snapshot(): RunTrace | undefined {
    try {
      const t = this.trace;
      return {
        calls: t.calls.map((c) => ({ ...c })),
        ...(t.dropped_calls ? { dropped_calls: t.dropped_calls } : {}),
        toolset: [...t.toolset],
        guidance: [...t.guidance],
        degraded: [...t.degraded],
        ...(t.model ? { model: t.model } : {}),
      };
    } catch {
      return undefined;
    }
  }
}
