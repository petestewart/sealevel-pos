import { loadEnv } from "../env.js";
import { closePool } from "../db/client.js";
import { computeSendDiff } from "./sendDiff.js";
import type { RecipientDelta } from "./sendDiffTypes.js";

/**
 * Manual entry point for campaigns.send_diff (SEA-86):
 *
 *   npm run send-diff -- --campaign <key>
 *
 * Prints a readable "what changes about this send versus the last one":
 * recipients added, recipients dropped (bounded samples, exact counts),
 * the prior send's identity, and the copy comparison (a real verdict
 * whenever SEA-84's stored per-run copy snapshot and a current draft
 * both exist; honest "unknown" for pre-snapshot history). Read-only.
 */
loadEnv();

const USAGE = "usage: npm run send-diff -- --campaign <key>";

function fail(message: string): never {
  console.error(`[send_diff] ERROR: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const campaignKey = argValue("--campaign");
if (!campaignKey) {
  fail("send-diff requires --campaign <key>");
}

function printDelta(label: string, delta: RecipientDelta): void {
  console.log(`${label}: ${delta.count}`);
  for (const email of delta.sample) {
    console.log(`  ${email}`);
  }
  if (delta.count > delta.sample.length) {
    console.log(`  ... and ${delta.count - delta.sample.length} more`);
  }
}

try {
  const diff = await computeSendDiff(campaignKey);
  if (diff === null) {
    console.log(
      `[send_diff] campaign '${campaignKey}' has no prior send: this is the first send, nothing to diff against`,
    );
  } else {
    console.log(`[send_diff] ${diff.summary}`);
    console.log("");
    console.log(
      `prior send: campaign ${diff.priorSend.campaignId} (run_seq ${diff.priorSend.runSeq}), ` +
        `${diff.priorSend.sentCount} sent` +
        (diff.priorSend.sentAt
          ? `, last sent_at ${diff.priorSend.sentAt.toISOString()}`
          : "") +
        (diff.priorSend.skippedSuppressedCount > 0
          ? `, ${diff.priorSend.skippedSuppressedCount} skipped (suppressed)`
          : "") +
        (diff.priorSend.failedCount > 0
          ? `, ${diff.priorSend.failedCount} failed`
          : ""),
    );
    console.log(`current audience: ${diff.currentAudienceCount}`);
    console.log("");
    printDelta("recipients added", diff.recipientsAdded);
    printDelta("recipients dropped", diff.recipientsDropped);
    console.log("");
    console.log(
      `copy changed: ${diff.copyChanged === null ? "unknown" : diff.copyChanged}`,
    );
    console.log(`  ${diff.copySummary}`);
  }
} finally {
  await closePool();
}
