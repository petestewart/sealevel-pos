import { Worker } from "bullmq";
import type { Processor, WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";

/** Default worker concurrency when WORKER_CONCURRENCY is not set. */
export const DEFAULT_WORKER_CONCURRENCY = 2;

/**
 * Resolve the worker concurrency cap from WORKER_CONCURRENCY
 * (positive integer), falling back to DEFAULT_WORKER_CONCURRENCY.
 */
export function workerConcurrency(): number {
  const raw = process.env.WORKER_CONCURRENCY;
  if (raw === undefined || raw === "") return DEFAULT_WORKER_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `WORKER_CONCURRENCY must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Create a concurrency-capped BullMQ worker for a queue. The processor is a
 * plain async function; a thrown error fails the attempt and BullMQ retries
 * with the queue's backoff until the job lands in the failed (dead-letter)
 * set.
 */
export function createQueueWorker<T = unknown, R = unknown>(
  queueName: string,
  processor: Processor<T, R>,
  connection: Redis,
  options?: Partial<Omit<WorkerOptions, "connection">>,
): Worker<T, R> {
  return new Worker<T, R>(queueName, processor, {
    connection,
    concurrency: workerConcurrency(),
    ...options,
  });
}
