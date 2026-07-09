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
  createQueue,
  createQueueWorker,
  createRedis,
  enqueue,
  jobById,
  loadEnv,
  registerSchedules,
  runJob,
} from "@ai-manager/core";

loadEnv();

const connection = createRedis();
const queue = createQueue(DEFAULT_QUEUE_NAME, connection);

/**
 * Plain-function processors, keyed by job name, for queue-layer smoke
 * checks. Registered brain jobs are dispatched to runJob instead (below).
 */
const processors: Record<string, (job: Job) => Promise<void>> = {
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

// Register the declared cron schedules idempotently on every boot.
await registerSchedules(queue, [
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

const port = Number(process.env.BULL_BOARD_PORT ?? 3010);
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
