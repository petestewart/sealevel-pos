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
  EMAIL_GMAIL_STATE_JOB,
  EMAIL_INGEST_JOB,
  EMAIL_SEND_JOB,
  EVAL_CAPTURE_JOB,
  JOBS,
  applyGmailState,
  captureEvalCase,
  closeSharedQueue,
  createQueue,
  createQueueWorker,
  createRedis,
  cronSchedulesFromJobs,
  emailIngestSchedule,
  enqueue,
  ingestInbound,
  isGmailStateAction,
  jobById,
  loadEnv,
  markGmailTrashed,
  registerSchedules,
  runJob,
  sendApprovedReply,
  workerVersion,
} from "@ai-manager/core";

loadEnv();

// Deploy-version stamp (GH-122 first slice): make "which code is this
// worker running?" a grep of the boot log, matching the generated_by
// stamp drafting runs put on their items.
console.log(`[worker] starting, commit ${workerVersion()}`);

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
  // reply via Gmail, or park it as a draft when GMAIL_SEND_MODE=draft (Gmail
  // send/draft mode, GH-97). The same job handles both modes; sendApprovedReply
  // branches internally. Enqueued by the console when an operator approves.
  [EMAIL_SEND_JOB]: async (job) => {
    const itemId = (job.data as { itemId?: unknown })?.itemId;
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw new Error(`${EMAIL_SEND_JOB}: job ${job.id} has no itemId in data`);
    }
    const result = await sendApprovedReply(itemId);
    // 'drafted' carries a draftId (no reason); 'skipped' carries a reason.
    const detail =
      result.status === "drafted" && result.draftId
        ? ` (draft ${result.draftId})`
        : result.reason
          ? ` (${result.reason})`
          : "";
    console.log(
      `[worker] ${EMAIL_SEND_JOB} item ${itemId}: ${result.status}${detail}`,
    );
  },
  // Gmail state on decision (read = decided): mark the source message
  // read, trash it, report it as spam, or restore it, depending on what
  // was decided in the console (or by the no-reply classifier). Enqueued
  // best-effort by every decision path; the console never talks to Gmail
  // itself (the GH-116 gate split: console enqueues, worker holds creds).
  // All operations are idempotent, so BullMQ's default retries are safe;
  // with Gmail unconfigured the job degrades to a logged skip.
  [EMAIL_GMAIL_STATE_JOB]: async (job) => {
    const data = (job.data ?? {}) as {
      itemId?: unknown;
      gmailId?: unknown;
      action?: unknown;
    };
    const { itemId, gmailId, action } = data;
    if (typeof gmailId !== "string" || gmailId.length === 0) {
      throw new Error(
        `${EMAIL_GMAIL_STATE_JOB}: job ${job.id} has no gmailId in data`,
      );
    }
    if (!isGmailStateAction(action)) {
      throw new Error(
        `${EMAIL_GMAIL_STATE_JOB}: job ${job.id} has unknown action "${String(action)}"`,
      );
    }
    const result = await applyGmailState(action, gmailId);
    // Stamp the item once its Gmail message is actually in the trash
    // (surfaced in the Trash view). Best-effort metadata, never a failure.
    if (result.status === "applied" && action === "trash" && typeof itemId === "string") {
      await markGmailTrashed(itemId).catch((err: unknown) =>
        console.warn(
          `[worker] could not stamp gmail_trashed on item ${itemId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    console.log(
      `[worker] ${EMAIL_GMAIL_STATE_JOB} ${action} message ${gmailId}${
        typeof itemId === "string" ? ` (item ${itemId})` : ""
      }: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
    );
  },
  // Eval-case capture (GH-128): replay the item's recorded trace calls
  // against the live KB toolset and store a runnable golden-case JSON at
  // payload.eval_capture. Enqueued by the console (operator action); the
  // worker holds the KB credentials. Capture-level failures (KB
  // unconfigured, replay error) are recorded honestly on the payload by
  // captureEvalCase itself; only a missing item or a failed DB write
  // throws (and retries).
  [EVAL_CAPTURE_JOB]: async (job) => {
    const itemId = (job.data as { itemId?: unknown })?.itemId;
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw new Error(
        `${EVAL_CAPTURE_JOB}: job ${job.id} has no itemId in data`,
      );
    }
    const record = await captureEvalCase(itemId);
    console.log(
      `[worker] ${EVAL_CAPTURE_JOB} item ${itemId}: ${
        record.error ? `failed (${record.error})` : "captured"
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
  // The no-reply preflight enqueues mark-read via the shared producer
  // queue; close it too (a no-op when it was never created).
  await closeSharedQueue();
  await connection.quit();
  console.log("[worker] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(
  `[worker] started: queue "${DEFAULT_QUEUE_NAME}", concurrency ${worker.opts.concurrency}`,
);
