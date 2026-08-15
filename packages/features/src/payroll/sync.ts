/**
 * On-demand analytics sync for payday (policy §6, decided 2026-08-11):
 * payroll.prepare fires Sunday 20:30 PT and makes the data current before
 * reading it, by dispatching sealevel-analytics' nightly-sync.yml via
 * workflow_dispatch (which accepts start/end inputs) and waiting for the
 * run to finish. This does not breach plan §2.4's scheduling ownership:
 * GitHub Actions still owns the data pipeline; ai-manager asks it to run,
 * never pulls from Mindbody itself.
 *
 * Credential: ANALYTICS_SYNC_GH_TOKEN, a GitHub token with actions:write
 * on petestewart/sealevel-analytics. Worker only, never the console (the
 * QBO/Gmail posture). Unset = dispatch is skipped with an honest reason;
 * the freshness gate downstream still decides whether the run may
 * proceed, so a missing token can delay payroll but never corrupt it.
 */

const SYNC_REPO = "petestewart/sealevel-analytics";
const SYNC_WORKFLOW = "nightly-sync.yml";
const API = "https://api.github.com";

/** Observed sync runs take ~2.5 minutes; GitHub can queue under load. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;

export function syncDispatchConfigured(): boolean {
  return Boolean(process.env["ANALYTICS_SYNC_GH_TOKEN"]);
}

export interface SyncDispatchResult {
  status: "completed" | "skipped" | "failed" | "timed_out";
  reason?: string;
}

interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Dispatch the sync over a window covering the period tail (wider than
 * strictly needed so a late-posted roster is not missed, policy §6 step
 * 2) and wait for the dispatched run to complete.
 */
export async function dispatchSyncAndWait(input: {
  /** YYYY-MM-DD window passed to the workflow's start/end inputs. */
  start: string;
  end: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SyncDispatchResult> {
  const token = process.env["ANALYTICS_SYNC_GH_TOKEN"];
  if (!token) {
    return {
      status: "skipped",
      reason: "ANALYTICS_SYNC_GH_TOKEN is not set; relying on the nightly sync",
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dispatchedAt = new Date();

  const dispatch = await fetchImpl(
    `${API}/repos/${SYNC_REPO}/actions/workflows/${SYNC_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: { start: input.start, end: input.end },
      }),
    },
  );
  if (dispatch.status !== 204) {
    const text = await dispatch.text();
    return {
      status: "failed",
      reason: `workflow_dispatch returned HTTP ${dispatch.status}: ${text.slice(0, 200)}`,
    };
  }

  // workflow_dispatch returns no run id; find the run this dispatch
  // created by polling for the newest run created at/after dispatch time,
  // then wait for it to conclude.
  const deadline = Date.now() + timeoutMs;
  let runId: number | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const url = runId
      ? `${API}/repos/${SYNC_REPO}/actions/runs/${runId}`
      : `${API}/repos/${SYNC_REPO}/actions/workflows/${SYNC_WORKFLOW}/runs?event=workflow_dispatch&created=>=${encodeURIComponent(dispatchedAt.toISOString())}&per_page=5`;
    const res = await fetchImpl(url, { headers: headers(token) });
    if (!res.ok) continue; // transient; keep polling until the deadline
    const data = (await res.json()) as {
      workflow_runs?: Array<{ id?: number; status?: string; conclusion?: string | null }>;
      id?: number;
      status?: string;
      conclusion?: string | null;
    };
    const run:
      | { id?: number; status?: string; conclusion?: string | null }
      | undefined = runId
      ? data
      : data.workflow_runs?.find((r) => typeof r.id === "number");
    if (!run || typeof run.id !== "number") continue;
    runId = run.id;
    if (run.status === "completed") {
      return run.conclusion === "success"
        ? { status: "completed" }
        : {
            status: "failed",
            reason: `sync run ${runId} concluded ${run.conclusion ?? "unknown"}`,
          };
    }
  }
  return {
    status: "timed_out",
    reason: `sync run did not complete within ${Math.round(timeoutMs / 60000)} minutes`,
  };
}
