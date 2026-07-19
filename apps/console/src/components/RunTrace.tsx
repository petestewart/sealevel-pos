/**
 * Collapsible "Run trace" section under "Why this draft" (GH-122):
 * operator-only diagnostics for the run that produced the current draft.
 * Timeline of tool calls with outcome badges and durations, the run's
 * registered toolset (so "available but never called" is one glance),
 * active guidance blocks, degradation flags, model/usage, and the
 * deploy-version stamp folded into the same section. Renders nothing the
 * customer could ever see: it lives on operator-only views behind auth,
 * and nothing here feeds back into the draft.
 */

export interface RunTraceCallData {
  tool: string;
  /** Short args summary (query, page name, filter); may be "". */
  ref: string;
  outcome: "ok" | "empty" | "error";
  /** Sanitized error message, or null. */
  error: string | null;
  /** Result size in chars before truncation, or null. */
  resultChars: number | null;
  durationMs: number | null;
}

export interface RunTraceData {
  calls: RunTraceCallData[];
  /** Calls past the storage cap that were not recorded. */
  droppedCalls: number;
  toolset: string[];
  guidance: string[];
  degraded: string[];
  /** API model id (config value), or null. */
  model: string | null;
  /** Run cost summary from payload.usage (GH-62), or null. */
  usage: {
    apiCalls: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
}

function callMeta(call: RunTraceCallData): string {
  return [
    call.resultChars !== null ? `${call.resultChars} chars` : null,
    call.durationMs !== null ? `${call.durationMs} ms` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function RunTraceSection({
  trace,
  generatedBy,
}: {
  trace: RunTraceData;
  /** Deploy-version stamp (GH-122 first slice), folded into this section. */
  generatedBy: { commit: string; at: string } | null;
}) {
  const usageLine = [
    trace.model,
    trace.usage ? `${trace.usage.apiCalls} API calls` : null,
    trace.usage
      ? `${trace.usage.inputTokens.toLocaleString("en-US")} in / ${trace.usage.outputTokens.toLocaleString("en-US")} out tokens`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <details className="draft-rationale run-trace">
      <summary className="draft-rationale-summary">
        <span className="micro-label">Run trace</span>
        {trace.degraded.length > 0 ? (
          <span className="trace-outcome trace-outcome--error">degraded</span>
        ) : null}
      </summary>
      <div className="run-trace-body">
        {trace.calls.length > 0 ? (
          <ol className="trace-calls">
            {trace.calls.map((call, i) => (
              <li className="trace-call" key={i}>
                <span
                  className={`trace-outcome trace-outcome--${call.outcome}`}
                >
                  {call.outcome}
                </span>
                <span className="trace-tool">{call.tool}</span>
                {call.ref ? <span className="trace-ref">{call.ref}</span> : null}
                {callMeta(call) ? (
                  <span className="trace-meta">{callMeta(call)}</span>
                ) : null}
                {call.error ? (
                  <span className="trace-error">{call.error}</span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <div className="trace-line">No tool calls recorded.</div>
        )}
        {trace.droppedCalls > 0 ? (
          <div className="trace-line">
            {trace.droppedCalls} more{" "}
            {trace.droppedCalls === 1 ? "call" : "calls"} not recorded (cap
            reached).
          </div>
        ) : null}
        {trace.toolset.length > 0 ? (
          <div className="trace-line">
            <span className="trace-line-label">Tools available</span>
            {trace.toolset.join(", ")}
          </div>
        ) : null}
        {trace.guidance.length > 0 ? (
          <div className="trace-line">
            <span className="trace-line-label">Guidance</span>
            {trace.guidance.join(", ")}
          </div>
        ) : null}
        {trace.degraded.length > 0 ? (
          <div className="trace-line trace-line--warn">
            <span className="trace-line-label">Degraded</span>
            {trace.degraded.join(", ")}
          </div>
        ) : null}
        {usageLine ? (
          <div className="trace-line">
            <span className="trace-line-label">Run</span>
            {usageLine}
          </div>
        ) : null}
        {generatedBy ? (
          <div className="trace-line">
            <span className="trace-line-label">Build</span>
            Drafted by {generatedBy.commit}
            {generatedBy.at ? ` at ${generatedBy.at}` : ""}
          </div>
        ) : null}
      </div>
    </details>
  );
}
