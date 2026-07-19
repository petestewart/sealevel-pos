"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  captureEvalCaseAction,
  type EvalCaptureActionState,
} from "../app/approvals/captureActions";

/**
 * "Capture as eval case" (GH-128): operator-only collapsible under the
 * run trace. One click enqueues the eval.capture worker job; the worker
 * replays the run's recorded trace calls against the live toolsets and
 * stores a runnable case JSON (or an honest failure note) at
 * payload.eval_capture, which this section renders as a copyable block
 * with a download link. The operator commits the file to evals/cases/
 * via a normal PR; nothing is auto-committed.
 */

export interface EvalCaptureData {
  /** ISO timestamp of the last capture run. */
  at: string;
  /** Pretty-printed case JSON, or null when the capture failed. */
  caseJson: string | null;
  /** Suggested download filename (the case id + .json), or null. */
  fileName: string | null;
  /** Honest failure note from the worker, or null. */
  error: string | null;
}

const initialState: EvalCaptureActionState = { error: null };

/** Refresh delays after queueing, to pick up the worker's result. */
const REFRESH_DELAYS_MS = [3000, 8000];

export function EvalCaptureSection({
  id,
  capture,
}: {
  id: string;
  capture: EvalCaptureData | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    captureEvalCaseAction,
    initialState,
  );
  const [copied, setCopied] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // After a capture is queued, refresh a couple of times so the worker's
  // stored result appears without a manual reload. Bounded, no polling
  // loop; a slow worker just needs a manual refresh.
  const queuedAt = state.queuedAt;
  useEffect(() => {
    if (!queuedAt) return;
    timers.current.forEach(clearTimeout);
    timers.current = REFRESH_DELAYS_MS.map((ms) =>
      setTimeout(() => router.refresh(), ms),
    );
    return () => timers.current.forEach(clearTimeout);
  }, [queuedAt, router]);

  // A queued capture is "in flight" until the stored record is newer
  // than the queue click.
  const waiting =
    Boolean(queuedAt) && (!capture || capture.at < (queuedAt as string));

  const downloadHref = capture?.caseJson
    ? `data:application/json;charset=utf-8,${encodeURIComponent(capture.caseJson)}`
    : null;

  const copy = async () => {
    if (!capture?.caseJson) return;
    try {
      await navigator.clipboard.writeText(capture.caseJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions); the block is selectable.
    }
  };

  return (
    <details className="draft-rationale eval-capture">
      <summary className="draft-rationale-summary">
        <span className="micro-label">Eval case</span>
        {capture?.caseJson ? (
          <span className="trace-outcome trace-outcome--ok">captured</span>
        ) : capture?.error ? (
          <span className="trace-outcome trace-outcome--error">failed</span>
        ) : null}
      </summary>
      <div className="eval-capture-body">
        <form action={formAction} className="eval-capture-form">
          <input type="hidden" name="id" value={id} />
          <button
            type="submit"
            className="eval-capture-button"
            disabled={pending || waiting}
          >
            {pending
              ? "Queueing…"
              : waiting
                ? "Capturing…"
                : capture
                  ? "Capture again"
                  : "Capture as eval case"}
          </button>
          <span className="eval-capture-hint">
            Snapshots this email plus re-fetched tool results as a runnable
            eval case. Fixtures reflect capture time, not the original run.
          </span>
        </form>
        {state.error ? (
          <div role="alert" className="eval-capture-error">
            {state.error}
          </div>
        ) : null}
        {waiting ? (
          <div className="trace-line">
            Capture queued. The result appears here when the worker
            finishes; refresh if it does not.
          </div>
        ) : null}
        {capture?.error && !waiting ? (
          <div className="eval-capture-error" role="note">
            {capture.error}
          </div>
        ) : null}
        {capture?.caseJson && !waiting ? (
          <>
            <div className="eval-capture-toolbar">
              <span className="trace-line-label">Captured</span>
              <span className="eval-capture-at">{capture.at}</span>
              <button
                type="button"
                className="eval-capture-button"
                onClick={copy}
              >
                {copied ? "Copied" : "Copy JSON"}
              </button>
              {downloadHref && capture.fileName ? (
                <a
                  className="eval-capture-button eval-capture-download"
                  href={downloadHref}
                  download={capture.fileName}
                >
                  Download {capture.fileName}
                </a>
              ) : null}
            </div>
            <pre className="eval-capture-json">{capture.caseJson}</pre>
            <div className="trace-line">
              Commit this file to evals/cases/ via a normal PR after adding
              rubric criteria. Nothing is committed automatically.
            </div>
          </>
        ) : null}
      </div>
    </details>
  );
}
