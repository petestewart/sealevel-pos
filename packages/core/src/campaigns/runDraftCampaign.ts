import { loadEnv } from "../env.js";
import { closePool } from "../db/client.js";
import { runJob } from "../brain/run.js";

/**
 * Manual entry point for campaigns.draft (SEA-83):
 *
 *   npm run campaign:draft -- --campaign <key>
 *
 * Runs the drafting job in-process (audience build + opus draft + one
 * campaign_approval item pending human approval). Needs DATABASE_URL,
 * the analytics identity (SEALEVEL_MCP_URL / SEALEVEL_MCP_ANALYTICS_TOKEN)
 * and ANTHROPIC_API_KEY. Nothing sends; approval happens in the console,
 * and the send job is SEA-84.
 *
 * --campaign is mandatory and fails loudly when missing: a draft run
 * that quietly did nothing is the failure mode this project fears most.
 */
loadEnv();

function fail(message: string): never {
  console.error(`[campaigns.draft] ERROR: ${message}`);
  console.error("usage: npm run campaign:draft -- --campaign <key>");
  process.exit(2);
}

const i = process.argv.indexOf("--campaign");
const campaignKey = i >= 0 ? process.argv[i + 1] : undefined;
if (!campaignKey) fail("missing --campaign <key>");

try {
  const stopReason = await runJob("campaigns.draft", { campaignKey });
  console.log(`[campaigns.draft] finished, stop_reason=${stopReason}`);
} finally {
  await closePool();
}
