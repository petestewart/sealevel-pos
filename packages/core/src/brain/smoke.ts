import assert from "node:assert/strict";

import { loadEnv } from "../env.js";
import { createItemTool, toolsForJob } from "../tools/registry.js";
import { runJob } from "./run.js";

/**
 * Brain smoke test (same pattern as db/smoke.ts). Dry-run checks always
 * run; the live end-to-end heartbeat run only happens when
 * ANTHROPIC_API_KEY is set (it also needs the docker compose Postgres if
 * the job uses the create_item tool).
 */
async function main(): Promise<void> {
  loadEnv();

  // runJob rejects unknown job ids.
  await assert.rejects(runJob("no.such.job"), /unknown job: no\.such\.job/);
  console.log("ok: runJob throws on unknown job id");

  // Tool scoping selects exactly the requested subset, in order.
  assert.deepEqual(toolsForJob([]), []);
  assert.deepEqual(toolsForJob(["create_item"]), [createItemTool]);
  assert.throws(() => toolsForJob(["no_such_tool"]), /unknown tool: no_such_tool/);
  console.log("ok: tool scoping selects the right subset; unknown tool throws");

  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.log("skip: ANTHROPIC_API_KEY not set; live runJob not exercised");
    return;
  }

  const stopReason = await runJob("manual.heartbeat");
  console.log(`ok: live heartbeat run completed, stop_reason=${stopReason}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
