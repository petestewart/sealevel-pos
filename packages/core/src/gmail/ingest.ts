import type { Queue } from "bullmq";

import { dispatchInboundEmail } from "../jobs/dispatch.js";
import { gmailClient } from "./client.js";
import { gmailConfig, gmailConfigured } from "./config.js";
import { parseGmailMessage } from "./parse.js";

/**
 * Inbound Gmail ingestion (GH-95): the poll that turns the system from a
 * demo you hand-feed (fire.ts) into something that actually watches the
 * studio inbox. Runs on the `email.ingest` repeatable schedule; each tick
 * pulls unread mail, dispatches every message to the jobs whose email
 * triggers fire (dispatchInboundEmail, with per-message idempotency), and
 * marks the message processed so the next poll does not re-fetch it.
 *
 * Config-gated: with Gmail unconfigured this is a no-op (skipped=true), so
 * the schedule can run harmlessly on a not-yet-provisioned deploy and start
 * working the moment the credentials land -- no code change, no redeploy.
 *
 * Failure posture: one bad message never sinks the batch. A message is
 * marked processed ONLY after its dispatch succeeds, so a mid-poll failure
 * leaves it unread for the next poll; re-dispatch is a no-op via the
 * deterministic jobId + the item dedupe_key, and re-marking is safe. A
 * top-level failure (auth, list) throws so BullMQ retries the whole tick.
 */

export interface IngestResult {
  /** True when Gmail is unconfigured and nothing was attempted. */
  skipped: boolean;
  /** Messages returned by the poll query. */
  fetched: number;
  /** Registry job enqueues performed (a message can fire multiple jobs). */
  dispatched: number;
  /** Enqueues skipped as duplicates (already in Redis from a prior poll). */
  duplicates: number;
  /** Messages that failed to fetch/parse/dispatch and were left for retry. */
  errors: number;
}

export async function ingestInbound(queue: Queue): Promise<IngestResult> {
  const result: IngestResult = {
    skipped: false,
    fetched: 0,
    dispatched: 0,
    duplicates: 0,
    errors: 0,
  };

  if (!gmailConfigured()) {
    result.skipped = true;
    return result;
  }

  const config = gmailConfig();
  const client = gmailClient();

  // Exclude the processed label from the poll query so an already-ingested
  // message is never re-fetched. This is what makes read = decided cheap:
  // by default (GMAIL_MARK_READ=false) ingestion leaves the message UNREAD
  // -- it stays unread until its item is decided and the email.gmailState
  // job flips it -- and the label alone keeps the poll from re-ingesting,
  // robust past the 24h window where the BullMQ jobId dedupe expires.
  const query = config.processedLabel
    ? `${config.ingestQuery} -label:"${config.processedLabel}"`
    : config.ingestQuery;

  const ids = await client.listMessageIds(query);
  result.fetched = ids.length;
  if (ids.length === 0) return result;

  // Resolve the processed label once per poll (cached in the client too).
  let processedLabelId: string | undefined;
  if (config.processedLabel) {
    try {
      processedLabelId = await client.ensureLabelId(config.processedLabel);
    } catch (err) {
      // A label failure must not block ingestion; we just skip labeling.
      console.warn(
        `[ingest] could not resolve processed label "${config.processedLabel}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  for (const id of ids) {
    try {
      const raw = await client.getMessage(id);
      const email = parseGmailMessage(raw);
      const { dispatched, duplicates } = await dispatchInboundEmail(
        queue,
        email,
      );
      result.dispatched += dispatched.length;
      result.duplicates += duplicates.length;

      // Only mark processed AFTER a successful dispatch, so a failure leaves
      // the message unread for the next poll (re-dispatch is idempotent).
      const removeLabelIds = config.markRead ? ["UNREAD"] : [];
      const addLabelIds = processedLabelId ? [processedLabelId] : [];
      if (removeLabelIds.length > 0 || addLabelIds.length > 0) {
        await client.modifyMessage(id, { addLabelIds, removeLabelIds });
      }

      console.log(
        `[ingest] ${email.messageId}: dispatched=${dispatched.join(",") || "none"}${
          duplicates.length > 0 ? ` dup=${duplicates.join(",")}` : ""
        }`,
      );
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[ingest] message ${id} failed, leaving it for the next poll: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  console.log(
    `[ingest] poll done: fetched=${result.fetched} dispatched=${result.dispatched} dup=${result.duplicates} errors=${result.errors}`,
  );
  return result;
}
