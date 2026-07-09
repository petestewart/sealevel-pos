import { Redis } from "ioredis";
import { requireEnv } from "./env.js";

/**
 * Create a Redis connection from REDIS_URL.
 *
 * maxRetriesPerRequest is set to null because BullMQ (the queue layer,
 * ARCHITECTURE.md "Queue layer") requires it on its connections; using
 * the same factory everywhere keeps one connection convention.
 */
export function createRedis(): Redis {
  return new Redis(requireEnv("REDIS_URL"), {
    maxRetriesPerRequest: null,
  });
}
