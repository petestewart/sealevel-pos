import { Queue } from "bullmq";
import type { JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

/** Default queue name for async work (ARCHITECTURE.md "Queue layer"). */
export const DEFAULT_QUEUE_NAME = "jobs";

/**
 * Default job options for every queue:
 * - retries with exponential backoff (5 attempts: ~1s, 2s, 4s, 8s);
 * - completed jobs pruned after a day / 1000 entries;
 * - failed jobs kept forever (`removeOnFail: false`) — per BullMQ norms the
 *   failed set is the dead-letter surface, inspectable in Bull Board.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: false,
};

/** Create a BullMQ queue on the shared Redis connection. */
export function createQueue(name: string, connection: Redis): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

/**
 * Enqueue a job. Pass a deterministic `jobId` (e.g. derived from the source
 * event id) for idempotent enqueue: BullMQ ignores an add whose jobId already
 * exists, so replays and duplicate webhooks become no-ops (ARCHITECTURE.md
 * "Queue layer"). The guarantee is windowed, not unconditional: it holds only
 * while the job record still exists in Redis. Once a completed job is pruned
 * by `removeOnComplete` (24h / 1000 entries here), the id is freed and a
 * same-id re-add creates a new job.
 */
export async function enqueue<T>(
  queue: Queue,
  name: string,
  data: T,
  options?: JobsOptions & { jobId?: string },
): Promise<string> {
  const job = await queue.add(name, data, options);
  if (job.id === undefined) {
    throw new Error(`BullMQ returned no id for job "${name}"`);
  }
  return job.id;
}
