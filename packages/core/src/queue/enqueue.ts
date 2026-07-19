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

/** The BullMQ job name for the gated KB write on approval (GH-113). */
export const KB_WRITE_JOB = "kb.write";

/**
 * Deterministic jobId for one item's KB write: kbwrite-<itemId>. Item ids
 * are numeric, so the id is BullMQ-safe. Determinism makes a duplicate
 * enqueue (double approve submit, reopen + re-approve inside the job
 * record's lifetime) a windowed no-op; the durable double-commit guard is
 * the server's idempotent write (identical content reports success
 * without a duplicate audit row).
 */
export function kbWriteJobId(itemId: string): string {
  return `kbwrite-${itemId}`;
}

/**
 * Enqueue the KB write for one approved kb_update item. Mirrors
 * enqueueEmailSend: low attempts so a write that keeps failing surfaces
 * on the item (kb_write 'failed') rather than retrying indefinitely;
 * reopen + re-approve is the operator retry path.
 */
export async function enqueueKbWrite(itemId: string): Promise<string> {
  return enqueue(
    getSharedQueue(),
    KB_WRITE_JOB,
    { itemId },
    { jobId: kbWriteJobId(itemId), attempts: 3 },
  );
}

/** The BullMQ job name for eval-case capture from an item (GH-128). */
export const EVAL_CAPTURE_JOB = "eval.capture";

/**
 * Timestamped jobId for one eval-case capture: re-capturing the same item
 * (e.g. after the draft was revised, or after fixing KB config) must
 * never be deduped into a silent no-op, so unlike the send/state jobs the
 * id is deliberately not deterministic. The job itself is idempotent in
 * effect: it overwrites payload.eval_capture with the latest record.
 */
export function evalCaptureJobId(itemId: string): string {
  return `evalcapture-${itemId}-${Date.now()}`;
}

/**
 * Enqueue an eval-case capture for one item (GH-128). Enqueued by the
 * console (operator action); the worker holds the KB credentials and does
 * the replay, matching the GH-116 gate split. Low attempts: capture
 * records its own failures on the item payload, so a thrown failure here
 * means the item is missing or the DB write failed.
 */
export async function enqueueEvalCapture(itemId: string): Promise<string> {
  return enqueue(
    getSharedQueue(),
    EVAL_CAPTURE_JOB,
    { itemId },
    { jobId: evalCaptureJobId(itemId), attempts: 2 },
  );
}

/** The BullMQ job name for the learning-loop miner (GH-127). */
export const LEARNING_MINE_JOB = "learning.mine";

/**
 * JobId for one mine request: learnmine-<kind>. Manual requests use a
 * timestamped kind (an operator's "Mine lessons now" must always fire);
 * the threshold trigger uses a kind deterministic per high-water mark
 * (learningThresholdKind), so the burst of decisions that crosses the
 * threshold enqueues one run, not one per decision (windowed idempotency,
 * see queue.ts). The nightly cron registers separately as a repeatable
 * schedule and never collides with these ids.
 */
export function learningMineJobId(kind: string): string {
  return `learnmine-${kind}`;
}

/** Deterministic threshold-trigger kind for one high-water-mark window. */
export function learningThresholdKind(lastMinedAt: string): string {
  const epoch = Date.parse(lastMinedAt);
  return `threshold-${Number.isNaN(epoch) ? "unknown" : epoch}`;
}

/**
 * Enqueue a learning-loop mine run (GH-127). Low attempts: the miner's
 * high-water mark only advances on success, so a failed run's signals are
 * simply re-examined by the next trigger (nightly cron, threshold, or
 * manual) instead of retrying indefinitely.
 */
export async function enqueueLearningMine(kind: string): Promise<string> {
  return enqueue(
    getSharedQueue(),
    LEARNING_MINE_JOB,
    { requested: kind },
    { jobId: learningMineJobId(kind), attempts: 2 },
  );
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
