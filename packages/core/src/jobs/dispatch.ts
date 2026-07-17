import { createHash } from "node:crypto";

import type { Queue } from "bullmq";

import { enqueue } from "../queue/queue.js";
import { JOBS } from "./registry.js";
import type { InboundEmailPayload } from "./emailDraft.js";
import type { Job } from "./types.js";

/**
 * The heartbeat's email dispatch (ARCHITECTURE.md "Async lane": "the
 * heartbeat matches an inbound event to the jobs whose triggers fire, and
 * enqueues each with a deterministic jobId for idempotency").
 *
 * This is the path that had been inert since Phase 0: Job.triggers was
 * declared and never read, and only `manual` was ever dispatched. Here we
 * finally read the `email` triggers -- a job fires on an inbound email when
 * any of its `{kind:"email", match}` triggers matches the message -- so a
 * new email-reacting job is added by declaring a trigger, with no change to
 * the ingestion edge.
 *
 * Idempotency: each enqueue uses a deterministic jobId derived from the
 * job id and the source message id, so a duplicate poll (or a webhook
 * replay, later) is a no-op while the job record lives in Redis, layered on
 * top of the item-level dedupe_key the drafting job itself uses.
 */

/** The text an email trigger's RegExp is tested against. */
function haystack(email: InboundEmailPayload): string {
  return [email.from ?? "", email.subject ?? "", email.body ?? ""].join("\n");
}

/** Jobs whose enabled `email` triggers match this inbound message. */
export function jobsForInboundEmail(email: InboundEmailPayload): Job[] {
  const text = haystack(email);
  return JOBS.filter(
    (job) =>
      job.enabled &&
      job.triggers.some((t) => t.kind === "email" && t.match.test(text)),
  );
}

/**
 * BullMQ custom job ids may not contain ":". Hash the source message id
 * (an RFC822 Message-ID like `<abc.123@mail.gmail.com>`, or a Gmail id) to a
 * fixed safe token so the same source email always maps to the same jobId.
 * A hash (not character substitution) is used so distinct message ids that
 * differ only in punctuation cannot alias to the same token and cause the
 * second real email to be dropped as a false duplicate.
 */
function safeIdToken(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex").slice(0, 16);
}

/** The deterministic BullMQ jobId for dispatching `email` to a given job. */
export function inboundEmailJobId(
  jobId: string,
  messageId: string,
): string {
  return `email-${jobId}-${safeIdToken(messageId)}`;
}

export interface DispatchResult {
  /** Registry job ids the email was enqueued to (matched + not duplicate). */
  dispatched: string[];
  /** Job ids skipped because their jobId already existed in Redis. */
  duplicates: string[];
}

/**
 * Match an inbound email to the jobs whose email triggers fire and enqueue
 * each one, idempotently. Returns which jobs were newly enqueued and which
 * were already present (a duplicate poll). Requires `email.messageId`; the
 * ingestion layer guarantees it (parseGmailMessage always resolves one).
 */
export async function dispatchInboundEmail(
  queue: Queue,
  email: InboundEmailPayload,
): Promise<DispatchResult> {
  if (!email.messageId || typeof email.messageId !== "string") {
    throw new Error(
      "dispatchInboundEmail: email.messageId is required (keys the idempotent jobId and item dedupe)",
    );
  }

  const dispatched: string[] = [];
  const duplicates: string[] = [];
  for (const job of jobsForInboundEmail(email)) {
    const jobId = inboundEmailJobId(job.id, email.messageId);
    const existing = await queue.getJob(jobId);
    if (existing) {
      duplicates.push(job.id);
      continue;
    }
    await enqueue(queue, job.id, email, { jobId });
    dispatched.push(job.id);
  }
  return { dispatched, duplicates };
}
