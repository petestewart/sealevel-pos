import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

import { createRedis } from "../redis.js";
import { createQueue, DEFAULT_QUEUE_NAME, enqueue } from "./queue.js";

/**
 * Process-shared producer queues (GH-95, generalized for SEA-102). The
 * console needs to enqueue outbound jobs when an operator decides an item,
 * and the worker's own queue instance is a separate process; both talk to
 * the same BullMQ queues on the same Redis. This module lends any producer
 * (the console server actions, the fire/ingest CLIs) one lazily-created
 * Queue per queue name for the process, so a server action does not open a
 * Redis connection per call.
 *
 * Queues are created on first use and reused; closeSharedQueue() tears
 * them all down for a clean shutdown (the worker manages its own queues
 * and does not use this).
 */

let sharedConnection: Redis | undefined;
const sharedQueues = new Map<string, Queue>();

/** The lazily-created shared producer queue for this process. */
export function getSharedQueue(name: string = DEFAULT_QUEUE_NAME): Queue {
  let queue = sharedQueues.get(name);
  if (!queue) {
    sharedConnection ??= createRedis();
    queue = createQueue(name, sharedConnection);
    sharedQueues.set(name, queue);
  }
  return queue;
}

/**
 * The outbound-action map (SEA-102, automation plan §2.6). Every job a
 * producer enqueues across the console/worker process boundary is one
 * typed entry here — job name, deterministic jobId, payload shape,
 * attempts, target queue — instead of a per-integration constant plus a
 * hand-rolled enqueuer. Adding an integration (payroll.push,
 * invoice.forward) is a new entry, not a new pipeline.
 */
export interface OutboundAction<A> {
  /** BullMQ job name (also what the worker's processor switch keys on). */
  jobName: string;
  /** Deterministic-or-deliberately-not jobId for one invocation. */
  jobId: (args: A) => string;
  /** Queue payload for one invocation. */
  payload: (args: A) => unknown;
  /**
   * Retry attempts. Deliberately per-action: actions whose failures are
   * surfaced on the item (send, kb write) use low attempts so they fail
   * visibly instead of retrying indefinitely; omitted means the queue
   * default (5, exponential backoff).
   */
  attempts?: number;
  /** Target queue. Defaults to the shared default queue ("jobs"). */
  queue?: string;
}

/** The BullMQ job name for the outbound send (Job B). */
export const EMAIL_SEND_JOB = "email.send";
/** The BullMQ job name for Gmail read/trash/spam state mutations. */
export const EMAIL_GMAIL_STATE_JOB = "email.gmailState";
/** The BullMQ job name for the gated KB write on approval (GH-113). */
export const KB_WRITE_JOB = "kb.write";
/** The BullMQ job name for eval-case capture from an item (GH-128). */
export const EVAL_CAPTURE_JOB = "eval.capture";
/** The BullMQ job name for the learning-loop miner (GH-127). */
export const LEARNING_MINE_JOB = "learning.mine";

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
 * The five shipped actions. Notes preserved from their standalone
 * enqueuers, because the tuning is deliberate:
 *
 * - email.send — deterministic jobId gives windowed idempotency (a
 *   duplicate enqueue while the job record lives in Redis is a no-op);
 *   the delivery claim in the worker is the durable guard. Low attempts:
 *   a send that keeps failing is surfaced (delivery 'failed') rather
 *   than retried indefinitely, and each retry re-claims safely.
 * - email.gmailState — jobId gmailstate-<itemId>-<action> (item ids are
 *   numeric and actions a closed lowercase set, so BullMQ-safe). Windowed
 *   no-op on duplicate enqueue; the Gmail ops are idempotent server-side,
 *   so even a re-enqueue past the window is harmless. Default retries.
 * - kb.write — jobId kbwrite-<itemId>; the durable double-commit guard is
 *   the MCP server's idempotent write. Low attempts, reopen + re-approve
 *   is the operator retry path.
 * - eval.capture — jobId deliberately timestamped: re-capturing the same
 *   item (after a revise, or after fixing KB config) must never dedupe
 *   into a silent no-op. The job is idempotent in effect (overwrites
 *   payload.eval_capture).
 * - learning.mine — jobId learnmine-<kind>: manual kinds are timestamped
 *   (an operator's "Mine lessons now" always fires), threshold kinds are
 *   deterministic per high-water mark so one burst enqueues one run. Low
 *   attempts: the high-water mark only advances on success, so a failed
 *   run's signals are re-examined by the next trigger.
 */
export const OUTBOUND_ACTIONS = {
  [EMAIL_SEND_JOB]: {
    jobName: EMAIL_SEND_JOB,
    jobId: ({ itemId }) => emailSendJobId(itemId),
    payload: ({ itemId }) => ({ itemId }),
    attempts: 3,
  } satisfies OutboundAction<{ itemId: string }>,
  [EMAIL_GMAIL_STATE_JOB]: {
    jobName: EMAIL_GMAIL_STATE_JOB,
    jobId: ({ itemId, action }) => gmailStateJobId(itemId, action),
    payload: (args) => args,
  } satisfies OutboundAction<GmailStateJobPayload>,
  [KB_WRITE_JOB]: {
    jobName: KB_WRITE_JOB,
    jobId: ({ itemId }) => kbWriteJobId(itemId),
    payload: ({ itemId }) => ({ itemId }),
    attempts: 3,
  } satisfies OutboundAction<{ itemId: string }>,
  [EVAL_CAPTURE_JOB]: {
    jobName: EVAL_CAPTURE_JOB,
    jobId: ({ itemId }) => evalCaptureJobId(itemId),
    payload: ({ itemId }) => ({ itemId }),
    attempts: 2,
  } satisfies OutboundAction<{ itemId: string }>,
  [LEARNING_MINE_JOB]: {
    jobName: LEARNING_MINE_JOB,
    jobId: ({ kind }) => learningMineJobId(kind),
    payload: ({ kind }) => ({ requested: kind }),
    attempts: 2,
  } satisfies OutboundAction<{ kind: string }>,
} as const;

export type OutboundActionName = keyof typeof OUTBOUND_ACTIONS;

/** The argument shape one action's jobId/payload builders take. */
type ActionArgs<K extends OutboundActionName> =
  (typeof OUTBOUND_ACTIONS)[K] extends OutboundAction<infer A> ? A : never;

/**
 * Enqueue one outbound action through the map: one code path builds the
 * jobId, payload, attempts, and target queue for every integration.
 */
export async function enqueueOutboundAction<K extends OutboundActionName>(
  name: K,
  args: ActionArgs<K>,
): Promise<string> {
  // Cast: TS cannot narrow a generic indexed access over a heterogeneous
  // map, but ActionArgs<K> ties args to exactly this entry's shape.
  const action = OUTBOUND_ACTIONS[name] as OutboundAction<ActionArgs<K>>;
  return enqueue(
    getSharedQueue(action.queue),
    action.jobName,
    action.payload(args),
    {
      jobId: action.jobId(args),
      ...(action.attempts !== undefined ? { attempts: action.attempts } : {}),
    },
  );
}

/**
 * Which outbound action an approved item of each type triggers (automation
 * plan §2.6): the console's approve path consults this instead of
 * hardcoding job names, so a new approval-gated integration is one entry
 * here (plus its worker processor), not a new console path. Item types
 * with no entry have no outbound action on approval (reports, proposals
 * whose action is elsewhere).
 */
export const ITEM_TYPE_OUTBOUND: Partial<
  Record<string, OutboundActionName>
> = {
  email_reply: EMAIL_SEND_JOB,
  kb_update: KB_WRITE_JOB,
  // payroll_invoice -> payroll.push and invoice_forward -> invoice.forward
  // land here with their jobs (SEA-104, invoice forwarding).
};

/**
 * Enqueue the outbound action for one approved item, routed by item type
 * through ITEM_TYPE_OUTBOUND. Throws on a type with no mapped action:
 * reaching this for an unmapped type is a programming error (the console
 * should not have offered the action), not a soft skip.
 */
export async function enqueueItemOutbound(
  itemType: string,
  itemId: string,
): Promise<string> {
  const name = ITEM_TYPE_OUTBOUND[itemType];
  if (!name) {
    throw new Error(
      `enqueueItemOutbound: no outbound action mapped for item type "${itemType}"`,
    );
  }
  // Every item-type-mapped action takes { itemId } (the map above only
  // routes approval actions, which are keyed on the item).
  return enqueueOutboundAction(name as "email.send" | "kb.write", { itemId });
}

/** The deterministic jobId for sending one item's approved reply. */
export function emailSendJobId(itemId: string): string {
  return `send-${itemId}`;
}

/** Enqueue the send of one item's approved reply (see map notes). */
export async function enqueueEmailSend(itemId: string): Promise<string> {
  return enqueueOutboundAction(EMAIL_SEND_JOB, { itemId });
}

/**
 * Deterministic jobId for one Gmail state mutation on one item:
 * gmailstate-<itemId>-<action>. Item ids are numeric and actions are a
 * closed lowercase set, so the id is BullMQ-safe (no ":").
 */
export function gmailStateJobId(itemId: string, action: string): string {
  return `gmailstate-${itemId}-${action}`;
}

/**
 * Enqueue one Gmail state mutation (read = decided). Callers treat this
 * as best-effort: a queue failure must never fail or roll back the
 * recorded decision (the message just stays unread/in place, which the
 * next decision-side enqueue or a manual Gmail touch can fix), so wrap in
 * try/catch at the decision site.
 */
export async function enqueueGmailState(
  payload: GmailStateJobPayload,
): Promise<string> {
  return enqueueOutboundAction(EMAIL_GMAIL_STATE_JOB, payload);
}

/** Deterministic jobId for one item's KB write: kbwrite-<itemId>. */
export function kbWriteJobId(itemId: string): string {
  return `kbwrite-${itemId}`;
}

/** Enqueue the KB write for one approved kb_update item (see map notes). */
export async function enqueueKbWrite(itemId: string): Promise<string> {
  return enqueueOutboundAction(KB_WRITE_JOB, { itemId });
}

/** Timestamped jobId for one eval-case capture (deliberately not deterministic). */
export function evalCaptureJobId(itemId: string): string {
  return `evalcapture-${itemId}-${Date.now()}`;
}

/** Enqueue an eval-case capture for one item (GH-128, see map notes). */
export async function enqueueEvalCapture(itemId: string): Promise<string> {
  return enqueueOutboundAction(EVAL_CAPTURE_JOB, { itemId });
}

/** JobId for one mine request: learnmine-<kind>. */
export function learningMineJobId(kind: string): string {
  return `learnmine-${kind}`;
}

/** Deterministic threshold-trigger kind for one high-water-mark window. */
export function learningThresholdKind(lastMinedAt: string): string {
  const epoch = Date.parse(lastMinedAt);
  return `threshold-${Number.isNaN(epoch) ? "unknown" : epoch}`;
}

/** Enqueue a learning-loop mine run (GH-127, see map notes). */
export async function enqueueLearningMine(kind: string): Promise<string> {
  return enqueueOutboundAction(LEARNING_MINE_JOB, { kind });
}

/** Close the shared producer queues + connection (clean process shutdown). */
export async function closeSharedQueue(): Promise<void> {
  for (const queue of sharedQueues.values()) {
    await queue.close();
  }
  sharedQueues.clear();
  if (sharedConnection) {
    await sharedConnection.quit();
    sharedConnection = undefined;
  }
}
