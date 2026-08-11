import { loadEnv } from "../env.js";
import { closePool } from "../db/client.js";
import { syncContacts } from "./syncContacts.js";

/**
 * Manual entry point for campaigns.sync_contacts (SEA-81):
 *   npm run sync:contacts          -- incremental (watermark-driven)
 *   npm run sync:contacts -- --full  -- ignore the watermark, re-pull all
 *
 * Prints the same report the nightly worker run logs, ending with the
 * done-when line "N contacts synced, M consented, K ambiguous excluded,
 * J unmappable".
 */
loadEnv();

const full = process.argv.includes("--full");

try {
  const result = await syncContacts(undefined, { full });
  if (result.status === "skipped") process.exitCode = 1;
} finally {
  await closePool();
}
