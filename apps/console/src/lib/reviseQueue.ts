import {
  createQueue,
  createRedis,
  DEFAULT_QUEUE_NAME,
} from "@ai-manager/core";

type JobsQueue = ReturnType<typeof createQueue>;

/**
 * Process-cached handle on the shared jobs queue, mirroring the getPool()
 * pattern in @ai-manager/core: server actions are invoked per-request, so
 * without a cache every revise submit/poll would open (and leak) a fresh
 * Redis connection. The queue is only ever used to enqueue item.revise
 * runs and inspect job state (docs/item-revise.md); the worker owns
 * processing.
 */
let queue: JobsQueue | null = null;

export function getJobsQueue(): JobsQueue {
  if (queue === null) {
    queue = createQueue(DEFAULT_QUEUE_NAME, createRedis());
  }
  return queue;
}
