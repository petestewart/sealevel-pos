import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

import { createRedis } from "../redis.js";
import { createQueue, DEFAULT_QUEUE_NAME, enqueue } from "./queue.js";

/**
 * Process-shared producer queue (GH-95). The console needs to enqueue the
 * send job (Job B) when an operator approves a reply, and the worker's own
 * queue instance is a separate process; both talk to the same BullMQ queue
 * on the same Redis. This module lends any producer (the console server
 * actions, the fire/ingest CLIs) one lazily-created Queue for the process
 * so a server action does not open a Redis connection per call.
 *
 * The queue is created on first use and reused; closeSharedQueue() tears it
 * down for a clean shutdown (the worker manages its own queue and does not
 * use this).
 */

let sharedConnection: Redis | undefined;
let sharedQueue: Queue | undefined;

/** The lazily-created shared producer queue for this process. */
export function getSharedQueue(): Queue {
  if (!sharedQueue) {
    sharedConnection = createRedis();
    sharedQueue = createQueue(DEFAULT_QUEUE_NAME, sharedConnection);
  }
  return sharedQueue;
}

/** The BullMQ job name for the outbound send (Job B). */
export const EMAIL_SEND_JOB = "email.send";

/** The deterministic jobId for sending one item's approved reply. */
export function emailSendJobId(itemId: string): string {
  return `send-${itemId}`;
}

/**
 * Enqueue the send of one item's approved reply. Deterministic jobId gives
 * windowed idempotency (a duplicate enqueue while the job record lives in
 * Redis is a no-op); the delivery claim in the worker is the durable
 * guard. Low attempts: a send that keeps failing is surfaced (delivery
 * 'failed') rather than retried indefinitely, and each retry re-claims
 * safely from 'failed'.
 */
export async function enqueueEmailSend(itemId: string): Promise<string> {
  return enqueue(
    getSharedQueue(),
    EMAIL_SEND_JOB,
    { itemId },
    { jobId: emailSendJobId(itemId), attempts: 3 },
  );
}

/** The BullMQ job name for Gmail read/trash/spam state mutations. */
export const EMAIL_GMAIL_STATE_JOB = "email.gmailState";

/**
 * Deterministic jobId for one Gmail state mutation on one item:
 * gmailstate-<itemId>-<action>. Item ids are numeric and actions are a
 * closed lowercase set, so the id is BullMQ-safe (no ":"). Determinism
 * makes a duplicate enqueue (double decision submit, no-reply preflight
 * dedupe hit) a windowed no-op; the operations themselves are idempotent
 * on Gmail's side, so even a re-enqueue past the window is harmless.
 */
export function gmailStateJobId(itemId: string, action: string): string {
  return `gmailstate-${itemId}-${action}`;
}

/** Payload for an email.gmailState job. */
export interface GmailStateJobPayload {
  /** The item whose decision triggered this (for logging + trash stamp). */
  itemId: string;
  /** Gmail internal message id (payload.email_meta.gmailId). */
  gmailId: string;
  /** One of the GmailStateAction values (gmail/state.ts). */
  action: string;
}

/**
 * Enqueue one Gmail state mutation (read = decided). Callers treat this
 * as best-effort: a queue failure must never fail or roll back the
 * recorded decision (the message just stays unread/in place, which the
 * next decision-side enqueue or a manual Gmail touch can fix), so wrap in
 * try/catch at the decision site. Default retry policy (5 attempts,
 * exponential backoff) applies; failed jobs land in the dead-letter set.
 */
export async function enqueueGmailState(
  payload: GmailStateJobPayload,
): Promise<string> {
  return enqueue(getSharedQueue(), EMAIL_GMAIL_STATE_JOB, payload, {
    jobId: gmailStateJobId(payload.itemId, payload.action),
  });
}

/** Close the shared producer queue + connection (clean process shutdown). */
export async function closeSharedQueue(): Promise<void> {
  if (sharedQueue) {
    await sharedQueue.close();
    sharedQueue = undefined;
  }
  if (sharedConnection) {
    await sharedConnection.quit();
    sharedConnection = undefined;
  }
}
