/**
 * Run one inbound Gmail ingest poll by hand (GH-95), the same routine the
 * worker's email.ingest schedule runs on a timer. Useful for provisioning:
 * after setting the GMAIL_* credentials, run this once to confirm the poll
 * authenticates, pulls unread mail, and dispatches drafting jobs, without
 * waiting for the schedule.
 *
 * Usage (from apps/worker):
 *   npm run ingest:once
 *
 * With Gmail unconfigured it reports skipped and exits 0, so it is safe to
 * run anywhere. It enqueues onto the same "jobs" queue the worker drains,
 * so a running worker will draft the dispatched emails; if no worker is
 * running the jobs simply wait in the queue.
 */
import {
  DEFAULT_QUEUE_NAME,
  createQueue,
  createRedis,
  gmailConfigured,
  ingestInbound,
  loadEnv,
} from "@ai-manager/core";

async function main(): Promise<void> {
  loadEnv();

  if (!gmailConfigured()) {
    console.log(
      "[ingest] Gmail is not configured (set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER). Nothing to poll.",
    );
    return;
  }

  const connection = createRedis();
  const queue = createQueue(DEFAULT_QUEUE_NAME, connection);
  try {
    const result = await ingestInbound(queue);
    console.log(`[ingest] result: ${JSON.stringify(result)}`);
  } finally {
    await queue.close();
    await connection.quit();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
