/**
 * Fire the email.received drafting job by hand (async lane end to end,
 * ARCHITECTURE.md "Two lanes"). This is the manual test path that predates
 * real Gmail ingestion (GH-95): it enqueues one queue job named after the
 * registry job id with an inbound-email payload; the running worker
 * dispatches it to the brain, which drafts a reply and creates an
 * email_reply item pending approval. Nothing sends anything.
 *
 * For real inbound mail the worker's email.ingest poll dispatches the same
 * job automatically; this stays for testing the draft path without a
 * mailbox (and to exercise it with a crafted payload).
 *
 * Usage (from apps/worker):
 *   npm run fire:email-draft            # sample inbound email
 *   node dist/fire.js '<payload json>'  # custom payload
 *
 * Idempotency: the BullMQ jobId is derived from the payload's messageId
 * (email-draft-<messageId>; BullMQ forbids ":" in custom ids), so
 * re-firing the same source email is a
 * no-op while the job record lives in Redis.
 */
import {
  DEFAULT_QUEUE_NAME,
  createQueue,
  createRedis,
  enqueue,
  loadEnv,
  type InboundEmailPayload,
} from "@ai-manager/core";

const SAMPLE_EMAIL: InboundEmailPayload = {
  messageId: "sample-inbound-001",
  from: "jordan@example.com",
  subject: "Do you have mat rentals for the 6pm class?",
  body:
    "Hi! I am new to Sealevel and coming to the 6pm hot vinyasa class tonight. " +
    "Do you rent mats and towels, or should I bring my own? Thanks, Jordan",
};

async function main(): Promise<void> {
  loadEnv();

  const arg = process.argv[2];
  const payload: InboundEmailPayload = arg
    ? (JSON.parse(arg) as InboundEmailPayload)
    : SAMPLE_EMAIL;
  if (!payload.messageId || typeof payload.messageId !== "string") {
    throw new Error(
      "payload.messageId is required and must be a string (it keys the idempotent jobId and item dedupe)",
    );
  }
  for (const field of ["from", "subject", "body"] as const) {
    const value = payload[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(
        `payload.${field} must be a string when present, got ${typeof value}`,
      );
    }
  }

  const connection = createRedis();
  const queue = createQueue(DEFAULT_QUEUE_NAME, connection);
  const jobId = `email-draft-${payload.messageId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    console.log(
      `[fire] job ${jobId} already exists (state=${await existing.getState()}); not enqueueing a duplicate`,
    );
  } else {
    const id = await enqueue(queue, "email.received", payload, { jobId });
    console.log(
      `[fire] enqueued email.received as job ${id} (from=${payload.from}, subject=${payload.subject})`,
    );
  }

  await queue.close();
  await connection.quit();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
