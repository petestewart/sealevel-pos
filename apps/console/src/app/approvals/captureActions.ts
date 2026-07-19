"use server";

import { enqueueEvalCapture, getPool } from "@ai-manager/core";
import { requireDecider } from "../../lib/requireDecider";

/**
 * Server action for "Capture as eval case" (GH-128). The console cannot
 * replay tool calls itself (no KB credentials here; the GH-116 gate
 * split), so the action only enqueues the eval.capture worker job for the
 * item. The worker replays the run's recorded trace calls against the
 * live toolsets, assembles the case JSON, and stores it (or an honest
 * failure note) at payload.eval_capture; the page then renders it as a
 * copyable/downloadable block. Operator-only: requireDecider re-checks
 * the session and RBAC server-side, like every approval mutation.
 */

export interface EvalCaptureActionState {
  error: string | null;
  /** Set when a capture job was queued; the UI shows a working note. */
  queuedAt?: string;
}

export async function captureEvalCaseAction(
  _prev: EvalCaptureActionState,
  formData: FormData,
): Promise<EvalCaptureActionState> {
  await requireDecider();
  const id = formData.get("id");
  if (typeof id !== "string" || id.trim().length === 0) {
    return { error: "Missing item id." };
  }
  // Light existence/type guard so a stale form gets a clear message
  // instead of a dead-letter job. Any item with an inbound email
  // qualifies; the worker handles the rest (missing trace, KB config).
  const { rows } = await getPool().query<{ type: string }>(
    `SELECT type FROM items WHERE id = $1`,
    [id],
  );
  if (!rows[0] || rows[0].type !== "email_reply") {
    return { error: "No email reply item found for this id." };
  }
  try {
    await enqueueEvalCapture(id);
  } catch (err) {
    console.error(
      `[eval-capture] failed to enqueue capture for item ${id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { error: "Could not queue the capture. Try again." };
  }
  return { error: null, queuedAt: new Date().toISOString() };
}
