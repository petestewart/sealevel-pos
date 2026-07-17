/**
 * Worker app — BullMQ worker + repeatable schedules + Bull Board.
 * Queue jobs named after a registered brain job (jobById) dispatch to
 * runJob(jobId, payload); the plain-function test processors remain for
 * queue-layer smoke checks.
 */
import express from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { Job } from "bullmq";
import {
  DEFAULT_QUEUE_NAME,
  EMAIL_INGEST_JOB,
  EMAIL_SEND_JOB,
  JOBS,
  createQueue,
  createQueueWorker,
  createRedis,
  cronSchedulesFromJobs,
  emailIngestSchedule,
  enqueue,
  ingestInbound,
  jobById,
  loadEnv,
  registerSchedules,
  runJob,
  sendApprovedReply,
} from "@ai-manager/core";

loadEnv();

const connection = createRedis();
const queue = createQueue(DEFAULT_QUEUE_NAME, connection);

/**
 * Plain-function processors, keyed by job name, for inbound-edge plumbing
 * and queue-layer smoke checks. These are NOT brain jobs: ingestion polls a
 * mailbox and sending delivers an already-approved reply, neither of which
 * needs Claude. Registered brain jobs (job name in jobById) go to runJob
 * instead (below).
 */
const processors: Record<string, (job: Job) => Promise<void>> = {
  // Inbound Gmail poll (GH-95): pull unread mail and dispatch each message
  // to the jobs whose email triggers fire. No-op until Gmail is configured.
  [EMAIL_INGEST_JOB]: async () => {
    const result = await ingestInbound(queue);
    if (!result.skipped && result.fetched > 0) {
      console.log(
        `[worker] ${EMAIL_INGEST_JOB}: fetched=${result.fetched} dispatched=${result.dispatched} dup=${result.duplicates} errors=${result.errors}`,
      );
    }
  },
  // Outbound send on approval (GH-95, Job B): deliver one item's approved
  // reply via Gmail. Enqueued by the console when an operator approves.
  [EMAIL_SEND_JOB]: async (job) => {
    const itemId = (job.data as { itemId?: unknown })?.itemId;
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw new Error(`${EMAIL_SEND_JOB}: job ${job.id} has no itemId in data`);
    }
    const result = await sendApprovedReply(itemId);
    console.log(
      `[worker] ${EMAIL_SEND_JOB} item ${itemId}: ${result.status}${
        result.reason ? ` (${result.reason})` : ""
      }`,
    );
  },
  "test-heartbeat": async (job) => {
    console.log(
      `[worker] test-heartbeat ran (job ${job.id}, attempt ${job.attemptsMade + 1})`,
    );
  },
  "test-fail": async (job) => {
    throw new Error(
      `test-fail always throws (job ${job.id}, attempt ${job.attemptsMade + 1})`,
    );
  },
};

const worker = createQueueWorker(
  DEFAULT_QUEUE_NAME,
  async (job) => {
    // Registered brain jobs (job name = registry job id) go to the brain.
    if (jobById.has(job.name)) {
      const stopReason = await runJob(job.name, job.data);
      console.log(
        `[worker] brain job ${job.name} (${job.id}) finished, stop_reason=${stopReason}`,
      );
      return;
    }
    const processor = processors[job.name];
    if (!processor) throw new Error(`No processor for job name "${job.name}"`);
    await processor(job);
  },
  connection,
);

worker.on("completed", (job) => {
  console.log(`[worker] completed ${job.name} (${job.id})`);
});
worker.on("failed", (job, err) => {
  console.error(
    `[worker] failed ${job?.name} (${job?.id}) attempt ${job?.attemptsMade}: ${err.message}`,
  );
});

// Register the declared repeatable schedules idempotently on every boot:
// the inbound Gmail poll (GH-95), any registry jobs with cron triggers
// (Job.triggers, read via cronSchedulesFromJobs), and the Phase 0
// test-heartbeat demo. registerSchedules prunes any scheduler not listed.
await registerSchedules(queue, [
  emailIngestSchedule(),
  ...cronSchedulesFromJobs(JOBS),
  {
    id: "test-heartbeat",
    pattern: "* * * * *",
    jobName: "test-heartbeat",
  },
]);

// Self-demonstrating retry path: one failing job, enqueued idempotently with
// a deterministic jobId. It retries with backoff and lands in the failed
// (dead-letter) set, visible in Bull Board; because failed jobs are kept and
// the jobId is deterministic, reboots do not re-enqueue it.
await enqueue(
  queue,
  "test-fail",
  { purpose: "demonstrate retry + dead-letter" },
  { jobId: "test-fail-demo", attempts: 3 },
);

// Bull Board, served from this worker process.
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [new BullMQAdapter(queue)],
  serverAdapter,
});

const app = express();
app.use("/admin/queues", serverAdapter.getRouter());
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Railway injects PORT and points its healthcheck at it; locally
// BULL_BOARD_PORT (default 3010) keeps the existing dev behavior.
const port = Number(process.env.PORT ?? process.env.BULL_BOARD_PORT ?? 3010);
const server = app.listen(port, () => {
  console.log(`[worker] Bull Board on http://localhost:${port}/admin/queues`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received, shutting down`);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await worker.close();
  await queue.close();
  await connection.quit();
  console.log("[worker] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(
  `[worker] started: queue "${DEFAULT_QUEUE_NAME}", concurrency ${worker.opts.concurrency}`,
);
