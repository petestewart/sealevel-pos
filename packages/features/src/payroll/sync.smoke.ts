/**
 * Smoke: SEA-112 — the on-demand sync dispatch (policy §6 steps 2-3) the
 * Sunday-evening payday depends on. dispatchSyncAndWait already exposes
 * injectable fetchImpl/sleep, so every branch runs offline against
 * scripted responses and an instant sleep: no GitHub, no network.
 * Run: npm run smoke:payrollsync (from packages/features).
 */
import assert from "node:assert/strict";

import { dispatchSyncAndWait } from "./sync.js";

const TOKEN_VAR = "ANALYTICS_SYNC_GH_TOKEN";
const WINDOW = { start: "2026-08-14", end: "2026-08-16" };

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** Minimal Response stand-in: only the fields sync.ts reads. */
function res(input: {
  status: number;
  body?: unknown;
  text?: string;
}): Response {
  return {
    status: input.status,
    ok: input.status >= 200 && input.status < 300,
    text: async () => input.text ?? "",
    json: async () => input.body,
  } as unknown as Response;
}

/** Scripted fetch: returns responses in order; repeats the last one if
 * called again (for deadline-spinning cases). Records every call. */
function fakeFetch(responses: Response[]): {
  impl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    assert.ok(next, "fake fetch called with no scripted response");
    return next;
  };
  return { impl, calls };
}

const instantSleep = async (): Promise<void> => undefined;

function runsList(
  run: { id: number; status: string; conclusion?: string | null },
): unknown {
  return { workflow_runs: [run] };
}

async function testMissingTokenSkips(): Promise<void> {
  delete process.env[TOKEN_VAR];
  const fetch = fakeFetch([]);
  const result = await dispatchSyncAndWait({
    ...WINDOW,
    fetchImpl: fetch.impl,
    sleep: instantSleep,
  });
  assert.equal(result.status, "skipped");
  assert.ok(result.reason?.includes(TOKEN_VAR));
  // Never even reaches the network without a credential.
  assert.equal(fetch.calls.length, 0);
  console.log("[smoke] sync: missing token skips honestly, fetch untouched");
}

async function testHappyPath(): Promise<void> {
  process.env[TOKEN_VAR] = "smoke-test-token";
  const fetch = fakeFetch([
    res({ status: 204 }), // dispatch accepted
    res({ status: 200, body: runsList({ id: 4242, status: "in_progress" }) }),
    res({ status: 200, body: { id: 4242, status: "completed", conclusion: "success" } }),
  ]);
  const result = await dispatchSyncAndWait({
    ...WINDOW,
    fetchImpl: fetch.impl,
    sleep: instantSleep,
  });
  assert.equal(result.status, "completed");
  assert.equal(fetch.calls.length, 3);

  // The dispatch must carry ref main and the start/end window inputs.
  const dispatch = fetch.calls[0]!;
  assert.ok(dispatch.url.endsWith("/actions/workflows/nightly-sync.yml/dispatches"));
  assert.equal(dispatch.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(dispatch.init?.body)), {
    ref: "main",
    inputs: { start: WINDOW.start, end: WINDOW.end },
  });
  // Once the run is identified, polling switches to the run-id URL.
  assert.ok(fetch.calls[1]!.url.includes("/actions/workflows/nightly-sync.yml/runs?"));
  assert.ok(fetch.calls[2]!.url.endsWith("/actions/runs/4242"));
  console.log("[smoke] sync: dispatch + poll to success, correct body and URLs");
}

async function testDispatchRejectedFails(): Promise<void> {
  process.env[TOKEN_VAR] = "smoke-test-token";
  const fetch = fakeFetch([
    res({ status: 401, text: '{"message":"Bad credentials"}' }),
  ]);
  const result = await dispatchSyncAndWait({
    ...WINDOW,
    fetchImpl: fetch.impl,
    sleep: instantSleep,
  });
  assert.equal(result.status, "failed");
  assert.ok(result.reason?.includes("401"));
  assert.ok(result.reason?.includes("Bad credentials"));
  // A rejected dispatch never polls.
  assert.equal(fetch.calls.length, 1);
  console.log("[smoke] sync: non-204 dispatch fails with the HTTP status");
}

async function testRunConclusionFailureFails(): Promise<void> {
  process.env[TOKEN_VAR] = "smoke-test-token";
  const fetch = fakeFetch([
    res({ status: 204 }),
    res({ status: 200, body: runsList({ id: 7, status: "completed", conclusion: "failure" }) }),
  ]);
  const result = await dispatchSyncAndWait({
    ...WINDOW,
    fetchImpl: fetch.impl,
    sleep: instantSleep,
  });
  assert.equal(result.status, "failed");
  assert.ok(result.reason?.includes("failure"));
  console.log("[smoke] sync: run concluding failure reports the conclusion");
}

async function testTimeoutExits(): Promise<void> {
  process.env[TOKEN_VAR] = "smoke-test-token";
  // Polls never see a completed run; sleep advances nothing, so the loop
  // spins on real Date.now() until the tiny deadline passes. The suite
  // finishing at all proves the loop exits.
  const fetch = fakeFetch([
    res({ status: 204 }),
    res({ status: 200, body: runsList({ id: 9, status: "in_progress" }) }),
  ]);
  const result = await dispatchSyncAndWait({
    ...WINDOW,
    timeoutMs: 25,
    fetchImpl: fetch.impl,
    sleep: instantSleep,
  });
  assert.equal(result.status, "timed_out");
  assert.ok(result.reason?.includes("did not complete"));
  console.log("[smoke] sync: never-completing run times out, loop exits");
}

async function testTransientPollErrorsTolerated(): Promise<void> {
  process.env[TOKEN_VAR] = "smoke-test-token";
  const fetch = fakeFetch([
    res({ status: 204 }),
    res({ status: 502, text: "bad gateway" }), // transient: keep polling
    res({ status: 500, text: "boom" }), // transient: keep polling
    res({ status: 200, body: runsList({ id: 11, status: "completed", conclusion: "success" }) }),
  ]);
  const result = await dispatchSyncAndWait({
    ...WINDOW,
    fetchImpl: fetch.impl,
    sleep: instantSleep,
  });
  assert.equal(result.status, "completed");
  assert.equal(fetch.calls.length, 4);
  console.log("[smoke] sync: transient poll errors tolerated through to success");
}

async function main(): Promise<void> {
  const savedToken = process.env[TOKEN_VAR];
  try {
    await testMissingTokenSkips();
    await testHappyPath();
    await testDispatchRejectedFails();
    await testRunConclusionFailureFails();
    await testTimeoutExits();
    await testTransientPollErrorsTolerated();
  } finally {
    if (savedToken === undefined) delete process.env[TOKEN_VAR];
    else process.env[TOKEN_VAR] = savedToken;
  }
  console.log("[smoke] sync: all passed");
}

await main();
