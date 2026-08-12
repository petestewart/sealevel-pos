import { loadEnv } from "../env.js";
import { closePool } from "../db/client.js";
import { buildAudience, DEFAULT_AUDIENCE_VIEW } from "./buildAudience.js";

/**
 * Manual entry point for campaigns.build_audience (SEA-82):
 *
 *   npm run audience:dry-run                       -- dry-run against
 *       v_campaign_post_first_visit: full recipient list + per-segment
 *       counts + exclusion report; writes NOTHING, needs no campaign row.
 *   npm run audience:dry-run -- --view <v_name>    -- dry-run another view.
 *   npm run audience:build -- --campaign <key>     -- the real thing:
 *       freezes the survivors into campaign_audience for that campaign.
 *
 * The MODE is a mandatory positional argument baked into the npm scripts
 * ("dry-run" / "build"), not inferred from which flags happen to be
 * present. This is deliberate: `audience:build` without --campaign must
 * FAIL LOUDLY, never quietly degrade into a dry run whose
 * successful-looking report hides that nothing was written (the silent
 * no-op is the worst failure mode this project has). Symmetrically,
 * `audience:dry-run` refuses --campaign so the write path is only
 * reachable through the entrypoint named for it.
 *
 * The exclusion report's numbers reconcile against SEA-81's
 * reconciliation report: unmappable here are (a subset of) its zero-match
 * clients, ambiguous here are contacts its flags exclude.
 */
loadEnv();

const USAGE = `usage:
  npm run audience:dry-run [-- --view <v_name>]
  npm run audience:build -- --campaign <key>`;

function fail(message: string): never {
  console.error(`[build_audience] ERROR: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.argv[2];
if (mode !== "dry-run" && mode !== "build") {
  fail(
    `missing or unknown mode '${mode ?? ""}' (expected 'dry-run' or 'build'; use the npm scripts, which pass it)`,
  );
}

const campaignKey = argValue("--campaign");
const view = argValue("--view");

if (mode === "build") {
  if (!campaignKey) {
    fail(
      "audience:build requires --campaign <key>; refusing to fall back to a dry run (nothing would be written). Use: npm run audience:build -- --campaign <key>",
    );
  }
  if (view) {
    fail(
      "audience:build takes the view from the campaign row's audience_view; --view is only for dry runs",
    );
  }
} else if (campaignKey) {
  fail(
    "audience:dry-run never writes and takes no --campaign; use npm run audience:build -- --campaign <key> to build for real",
  );
}

try {
  const result = await buildAudience({
    ...(mode === "build" ? { campaignKey } : {}),
    ...(view ? { view } : {}),
  });
  if (result.status === "skipped") {
    process.exitCode = 1;
  } else if (mode === "dry-run") {
    // The headline deliverable: the FULL recipient list, one line each.
    console.log("");
    console.log(
      `recipient list (${result.recipients.length} recipients, view ${
        result.audienceView ?? DEFAULT_AUDIENCE_VIEW
      }):`,
    );
    for (const r of result.recipients) {
      console.log(
        `  ${r.email}  [${r.segment}]  contact=${r.contactId} analytics=${r.analyticsClientId}`,
      );
    }
    console.log("");
    console.log("exclusion report:");
    for (const [reason, count] of Object.entries(result.exclusionCounts)) {
      console.log(`  ${reason}: ${count}`);
    }
    for (const e of result.exclusions) {
      console.log(
        `    (${e.reason}) analytics client ${e.analyticsClientId}${
          e.contactId ? `, contact ${e.contactId}` : ""
        }: ${e.detail}`,
      );
    }
  }
} finally {
  await closePool();
}
