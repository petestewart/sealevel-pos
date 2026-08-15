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
  buildAudience,
  CAMPAIGNS_BUILD_AUDIENCE_JOB,
  CAMPAIGNS_MONITOR_JOB,
  CAMPAIGNS_SEND_JOB,
  campaignsMonitorSchedule,
  CAMPAIGNS_SYNC_CONTACTS_JOB,
  campaignsSyncContactsSchedule,
  enqueueCampaignSendResume,
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
  KB_WRITE_JOB,
  LEARNING_MINE_JOB,
  learningMineSchedule,
  loadEnv,
  markGmailTrashed,
  mineOperatorLessons,
  MONEY_QUEUE_NAME,
  PAYROLL_MONITOR_JOB,
  PAYROLL_PUSH_JOB,
  payrollInvoiceForItem,
  payrollMonitorSchedule,
  runPayrollMonitor,
  claimPayrollPush,
  emitPayrollAlert,
  getItemById,
  qboClient,
  qboConfigured,
  QboError,
  recordPayrollPushed,
  recordPayrollPushFailed,
  revertPayrollPushClaim,
  processResendWebhook,
  processUnsubscribe,
  registerJobs,
  registerSchedules,
  runCampaignMonitor,
  runJob,
  sendApprovedReply,
  sendCampaign,
  syncContacts,
  workerVersion,
  writeApprovedKbUpdate,
} from "@ai-manager/core";
import { featureJobs, payrollPrepare } from "@ai-manager/features";

loadEnv();

// Feature-module jobs (SEA-101) join the registry BEFORE anything reads
// it. Ordering is load-bearing: the schedule sweep below derives cron
// schedules from JOBS and prunes schedulers not in that derived set, so a
// job registered after the sweep would have its schedule deleted.
registerJobs(featureJobs);

// Deploy-version stamp (GH-122 first slice): make "which code is this
// worker running?" a grep of the boot log, matching the generated_by
// stamp drafting runs put on their items.
console.log(`[worker] starting, commit ${workerVersion()}`);

const connection = createRedis();
const queue = createQueue(DEFAULT_QUEUE_NAME, connection);
// Isolated money queue (SEA-104, plan §7b step 6): payroll and invoice
// forwarding run here so a stuck QBO call never starves email triage.
const moneyQueue = createQueue(MONEY_QUEUE_NAME, connection);

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
  // KB write on approval (GH-113, Job B of the KB write-back loop): commit
  // one approved kb_update proposal to the wiki through the MCP server's
  // gated write_wiki_page tool, as the distinct kb-writer identity.
  // Enqueued by the console when an operator approves a kb_update item.
  // Outcomes (written / stale / denied / failed / skipped) are recorded on
  // the item payload; only retryable failures throw for BullMQ. Without
  // the writer token the job records an honest 'skipped'.
  [KB_WRITE_JOB]: async (job) => {
    const itemId = (job.data as { itemId?: unknown })?.itemId;
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw new Error(`${KB_WRITE_JOB}: job ${job.id} has no itemId in data`);
    }
    const result = await writeApprovedKbUpdate(itemId);
    console.log(
      `[worker] ${KB_WRITE_JOB} item ${itemId}: ${result.status}${
        result.detail ? ` (${result.detail})` : ""
      }`,
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
  // Learning-loop miner (GH-127): distill the operator corrections
  // decided since the high-water mark into 0-3 pending rule_proposal
  // items. Fired by the nightly schedule, the decision-count threshold
  // trigger, and the Settings page's "Mine lessons now" button. Nothing
  // is learned here: proposals are inert until a human approves one in
  // the console, which is the only path into the rules table. Runs as a
  // worker job only, never in the drafting path, so the eval suite never
  // sees it. Expected no-ops (quiet window, no API key) return a skipped
  // status instead of throwing, so the nightly run never dead-letters.
  [LEARNING_MINE_JOB]: async (job) => {
    const requested = (job.data as { requested?: unknown })?.requested;
    const result = await mineOperatorLessons();
    console.log(
      `[worker] ${LEARNING_MINE_JOB}${
        typeof requested === "string" ? ` (${requested})` : ""
      }: ${result.status}${result.reason ? ` (${result.reason})` : ""}, signals=${result.signals} candidates=${result.candidates} filed=${result.proposalsFiled}`,
    );
  },
  // Nightly Mindbody contact sync + ID-mapping reconciliation (SEA-81).
  // Pure code, no brain: pages the Mindbody Public API v6 into contacts,
  // settles the append-only consent ledger, then reconciles ids against
  // the analytics mirror (read-only, via the analytics service identity).
  // Fired by the 05:00 PT schedule below; degrades to a logged skip until
  // MINDBODY_API_KEY / MINDBODY_SITE_ID are configured. A mid-run error
  // throws so BullMQ retries; the upsert + append-only ledger make a
  // re-run safe, and the watermark only advances on success.
  [CAMPAIGNS_SYNC_CONTACTS_JOB]: async () => {
    const result = await syncContacts();
    console.log(
      `[worker] ${CAMPAIGNS_SYNC_CONTACTS_JOB}: ${result.status}${
        result.mode ? ` (${result.mode})` : ""
      } -- ${result.summary}`,
    );
  },
  // On-demand campaign audience build (SEA-82). Pure code, no brain:
  // pages WHO qualifies out of the analytics view (client_id + segment,
  // no PII crosses that boundary), resolves contacts via the SEA-81
  // reconciliation's analytics_client_id stamp, runs the consent/
  // suppression/ambiguity filter chain, and freezes the survivors into
  // campaign_audience. NOT scheduled -- enqueued deliberately per
  // campaign with { campaignKey } in the job data. Throws on a mid-run
  // error so BullMQ retries; the snapshot replace is transactional and
  // idempotent, so a retry lands identical rows.
  [CAMPAIGNS_BUILD_AUDIENCE_JOB]: async (job) => {
    const campaignKey = (job.data as { campaignKey?: unknown }).campaignKey;
    if (typeof campaignKey !== "string" || campaignKey === "") {
      throw new Error(
        `${CAMPAIGNS_BUILD_AUDIENCE_JOB} requires { campaignKey } in the job data`,
      );
    }
    const result = await buildAudience({ campaignKey });
    console.log(
      `[worker] ${CAMPAIGNS_BUILD_AUDIENCE_JOB}: ${result.status} -- ${result.summary}`,
    );
  },
  // Campaign send on approval (SEA-84). Pure code, no brain: delivers the
  // frozen audience snapshot the approved copy through Resend, batched
  // and rate-limited under the warmup ramp, with per-recipient
  // suppression/consent re-checks at send time and the signed one-click
  // unsubscribe in every message. Enqueued by onCampaignApproved (the
  // console's approve action), immediately or DELAYED to campaigns.
  // send_at. Idempotent under retries via campaign_sends.dedupe_key +
  // per-send Resend Idempotency-Keys. Degrades to a logged skip without
  // RESEND_API_KEY / CAMPAIGN_FROM_EMAIL, and REFUSES (loudly) without a
  // working unsubscribe config. A ramp pause re-enqueues itself delayed.
  [CAMPAIGNS_SEND_JOB]: async (job) => {
    const campaignKey = (job.data as { campaignKey?: unknown }).campaignKey;
    if (typeof campaignKey !== "string" || campaignKey === "") {
      throw new Error(
        `${CAMPAIGNS_SEND_JOB} requires { campaignKey } in the job data`,
      );
    }
    const result = await sendCampaign(campaignKey);
    console.log(
      `[worker] ${CAMPAIGNS_SEND_JOB}: ${result.status} -- ${result.summary}`,
    );
    if (
      result.status === "ramp_paused" &&
      result.campaignId &&
      result.runSeq !== null
    ) {
      await enqueueCampaignSendResume({
        campaignKey,
        campaignId: result.campaignId,
        runSeq: result.runSeq,
        resumeDelayMs: result.resumeDelayMs ?? 60 * 60 * 1000,
        queue,
      });
      console.log(
        `[worker] ${CAMPAIGNS_SEND_JOB}: resume enqueued for '${campaignKey}' in ${Math.round((result.resumeDelayMs ?? 3_600_000) / 60_000)} min`,
      );
    }
  },
  // Campaign health monitor (SEA-92). Pure code, no brain: complaint
  // rate, hard bounce rate, stuck 'sending' campaigns, zero-recipient
  // runs, read from the campaign tables and alerted through the Novu
  // path (event type campaign_alert) with dedupe in campaign_alert_state.
  // Fired every 15 minutes by the schedule below; degrades to a logged
  // skip without DATABASE_URL. A mid-run Postgres error throws so BullMQ
  // retries; every step is idempotent.
  [CAMPAIGNS_MONITOR_JOB]: async () => {
    const result = await runCampaignMonitor();
    console.log(
      `[worker] ${CAMPAIGNS_MONITOR_JOB}: ${result.status} -- ${result.summary}`,
    );
  },
  // Payroll stuck-row sweeper (SEA-111 fix 2b). Pure code, no brain: any
  // payroll_invoices row sitting 'queued' or 'pushing' past the threshold
  // alerts through the Novu path (event type payroll_alert, alertType
  // stuck_push). The net that does not depend on any handler firing, and
  // the summons-a-human mechanism for rows deliberately parked 'pushing'
  // after a crash. Fired every 30 minutes by the schedule below; degrades
  // to a logged skip without DATABASE_URL. A mid-run Postgres error
  // throws so BullMQ retries; the sweep is read-only.
  [PAYROLL_MONITOR_JOB]: async () => {
    const result = await runPayrollMonitor();
    console.log(
      `[worker] ${PAYROLL_MONITOR_JOB}: ${result.status} -- ${result.summary}`,
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

/**
 * payroll.push (SEA-104, Job B): write one approved invoice's QBO Bill.
 * Runs on the money queue. Idempotency layers (plan §2.8): the ledger's
 * UNIQUE (period, mb_staff_id), the deterministic jobId, the atomic
 * claim below (queued -> pushing; a concurrent retry claims null and
 * skips), and the DocNumber pre-check against QBO itself. The worker
 * re-checks its own credential gate before acting (the
 * gmailSendConfigured pattern); the console only enqueued.
 */
/**
 * A guarded ledger UPDATE that matched nothing (SEA-111 fix 2c): the
 * push outcome and the ledger disagree, and until now the only trace was
 * a log line. Alert loudly; the core/db functions report the miss (they
 * stay notification-free, like every db module) and the worker owns the
 * paging. Never throws: the alert must not fail the push it describes.
 */
async function alertPayrollLedgerMiss(
  itemId: string,
  period: string,
  detail: string,
): Promise<void> {
  console.error(`[worker] ${PAYROLL_PUSH_JOB} item ${itemId}: LEDGER MISS: ${detail}`);
  await emitPayrollAlert({
    alertType: "push_failed",
    period,
    detail,
    teachers: [],
    at: new Date().toISOString(),
  });
}

async function processPayrollPush(itemId: string): Promise<void> {
  if (!qboConfigured()) {
    const recorded = await recordPayrollPushFailed(itemId);
    if (!recorded) {
      await alertPayrollLedgerMiss(
        itemId,
        "unknown",
        `Payroll push for item ${itemId} was skipped (QBO not configured) but the ledger row could not be marked failed (not queued or pushing). Check the payroll_invoices row for item ${itemId} by hand.`,
      );
      return;
    }
    // A ledger row parked 'failed' with only a log line is an approved
    // invoice that silently pays nothing: an operator can approve a
    // whole period against a deconfigured QBO and nobody is paged. Page
    // through the same alert path as every other push failure. Fire and
    // forget with a caught rejection, like the exhausted-retries handler:
    // the alert must never fail the job that describes it.
    void (async () => {
      const row = await payrollInvoiceForItem(itemId);
      await emitPayrollAlert({
        alertType: "push_failed",
        period: row?.period ?? "unknown",
        detail: `Payroll push for item ${itemId}${
          row ? ` (staff ${row.mb_staff_id}, period ${row.period})` : ""
        } was skipped because QuickBooks is not configured (QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REFRESH_TOKEN / QBO_REALM_ID missing on the worker). No Bill was written and the ledger row is marked failed. Restore the QBO_* environment on the worker, then reopen and re-approve the invoice to push it.`,
        teachers: [],
        at: new Date().toISOString(),
      });
    })().catch((alertErr: unknown) =>
      console.error(
        `[worker] could not alert on unconfigured-QBO payroll push for item ${itemId}: ${
          alertErr instanceof Error ? alertErr.message : String(alertErr)
        }`,
      ),
    );
    console.log(
      `[worker] ${PAYROLL_PUSH_JOB} item ${itemId}: skipped (QBO not configured); ledger marked failed, reopen + re-approve after configuring`,
    );
    return;
  }
  const claim = await claimPayrollPush(itemId);
  if (!claim) {
    console.log(
      `[worker] ${PAYROLL_PUSH_JOB} item ${itemId}: no claim (already pushed, in flight, or not queued), skipping`,
    );
    return;
  }
  const docNumber = `${claim.period}-${claim.mb_staff_id}`;
  try {
    const item = await getItemById(itemId);
    if (!item) throw new QboError(`item ${itemId} not found`, false);
    const payload = item.payload as Record<string, unknown>;
    const teacherName = String(payload["teacher_name"] ?? "");
    const totalCents = Number(payload["total_cents"] ?? NaN);
    const summary = String(payload["summary"] ?? "");
    const period = String(payload["period"] ?? claim.period);
    if (!teacherName || !Number.isInteger(totalCents) || totalCents <= 0) {
      throw new QboError(
        `item ${itemId} payload is not a pushable invoice (teacher "${teacherName}", total ${totalCents})`,
        false,
      );
    }

    const client = qboClient();
    // QBO-side idempotency: a Bill already carrying this DocNumber means
    // a prior attempt landed; record it and stop.
    const existing = await client.findBillByDocNumber(docNumber);
    if (existing) {
      const recorded = await recordPayrollPushed(itemId, existing);
      if (!recorded) {
        await alertPayrollLedgerMiss(
          itemId,
          claim.period,
          `Bill ${existing} exists in QuickBooks for ${docNumber} but the ledger row for item ${itemId} could not be marked pushed (no longer in 'pushing'). Reconcile the payroll_invoices row against QuickBooks by hand before any retry.`,
        );
        return;
      }
      console.log(
        `[worker] ${PAYROLL_PUSH_JOB} item ${itemId}: Bill ${existing} already exists for ${docNumber}, recorded`,
      );
      return;
    }
    const vendorId = await client.findVendor(teacherName);
    if (!vendorId) {
      throw new QboError(
        `no QBO Vendor named "${teacherName}"; create the vendor record (policy 10 bookkeeper question), then reopen + re-approve`,
        false,
      );
    }
    const bill = await client.createBill({
      vendorId,
      docNumber,
      txnDate: claim.period.slice(-10),
      lines: [{ description: `${summary} (period ${period})`, amountCents: totalCents }],
      memo: `ai-manager payroll ${period}, staff ${claim.mb_staff_id}`,
    });
    const recorded = await recordPayrollPushed(itemId, bill.billId);
    if (!recorded) {
      await alertPayrollLedgerMiss(
        itemId,
        claim.period,
        `Bill ${bill.billId} was written to QuickBooks for ${docNumber} but the ledger row for item ${itemId} could not be marked pushed (no longer in 'pushing'). Reconcile the payroll_invoices row against QuickBooks by hand before any retry.`,
      );
      return;
    }
    console.log(
      `[worker] ${PAYROLL_PUSH_JOB} item ${itemId}: Bill ${bill.billId} written (${docNumber})`,
    );
  } catch (err) {
    const retryable = err instanceof QboError ? err.retryable : true;
    const message = err instanceof Error ? err.message : String(err);
    if (retryable) {
      // Release the claim so the BullMQ retry can re-claim, then throw
      // for the retry/backoff machinery.
      await revertPayrollPushClaim(itemId);
      throw err;
    }
    const recordedFailed = await recordPayrollPushFailed(itemId);
    if (!recordedFailed) {
      await alertPayrollLedgerMiss(
        itemId,
        claim.period,
        `Payroll push for item ${itemId} (${docNumber}) failed terminally (${message}) but the ledger row could not be marked failed (not queued or pushing). Check the payroll_invoices row and QuickBooks by hand.`,
      );
      return;
    }
    await emitPayrollAlert({
      alertType: "push_failed",
      period: claim.period,
      detail: `QBO push failed for staff ${claim.mb_staff_id}, period ${claim.period}: ${message}. Reopen and re-approve to retry once resolved.`,
      teachers: [],
      at: new Date().toISOString(),
    });
    console.error(
      `[worker] ${PAYROLL_PUSH_JOB} item ${itemId}: terminal failure (${message})`,
    );
  }
}

// The money-queue worker: only outbound money actions run here.
const moneyWorker = createQueueWorker(
  MONEY_QUEUE_NAME,
  async (job) => {
    if (job.name !== PAYROLL_PUSH_JOB) {
      throw new Error(`No money processor for job name "${job.name}"`);
    }
    const itemId = (job.data as { itemId?: unknown })?.itemId;
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw new Error(`${PAYROLL_PUSH_JOB}: job ${job.id} has no itemId in data`);
    }
    await processPayrollPush(itemId);
  },
  connection,
);
moneyWorker.on("failed", (job, err) => {
  console.error(
    `[worker] money failed ${job?.name} (${job?.id}) attempt ${job?.attemptsMade}: ${err.message}`,
  );
  // Exhausted retries (SEA-111 fix 2a): the retryable path reverts the
  // claim (pushing -> queued) and rethrows for BullMQ backoff; after the
  // final attempt BullMQ gives up, the row sits 'queued' forever, and
  // nothing else on this path pages. Terminal failures already alert in
  // processPayrollPush; this closes the dark half. Fire-and-forget: the
  // event handler must never throw, and emitPayrollAlert never does.
  if (
    job &&
    job.name === PAYROLL_PUSH_JOB &&
    job.attemptsMade >= (job.opts.attempts ?? 1)
  ) {
    const itemId = (job.data as { itemId?: unknown })?.itemId;
    void (async () => {
      const row =
        typeof itemId === "string" ? await payrollInvoiceForItem(itemId) : null;
      await emitPayrollAlert({
        alertType: "push_failed",
        period: row?.period ?? "unknown",
        detail: `QuickBooks push for item ${String(itemId)}${
          row ? ` (staff ${row.mb_staff_id}, period ${row.period})` : ""
        } gave up after ${job.attemptsMade} attempts: ${err.message}. The invoice is parked '${
          row?.status ?? "unknown"
        }' and will not retry on its own; the stuck-push sweeper keeps paging until it is resolved.`,
        teachers: [],
        at: new Date().toISOString(),
      });
    })().catch((alertErr: unknown) =>
      console.error(
        `[worker] could not alert on exhausted payroll push retries for item ${String(itemId)}: ${
          alertErr instanceof Error ? alertErr.message : String(alertErr)
        }`,
      ),
    );
  }
});

worker.on("completed", (job) => {
  console.log(`[worker] completed ${job.name} (${job.id})`);
});
worker.on("failed", (job, err) => {
  console.error(
    `[worker] failed ${job?.name} (${job?.id}) attempt ${job?.attemptsMade}: ${err.message}`,
  );
  // payroll.prepare exhausting its retries is a payday that did not
  // happen (SEA-111 fix 2a, extended): the run filed nothing (or filed
  // partially), so the stuck-push sweeper is structurally blind to it,
  // and the in-job catch-all alert may itself have been what failed.
  // Page here as the outermost net. Fire-and-forget: the event handler
  // must never throw, and emitPayrollAlert never does.
  if (
    job &&
    job.name === payrollPrepare.id &&
    job.attemptsMade >= (job.opts.attempts ?? 1)
  ) {
    void emitPayrollAlert({
      alertType: "run_blocked",
      period:
        typeof (job.data as { period?: unknown })?.period === "string"
          ? String((job.data as { period?: unknown }).period)
          : "unknown",
      detail: `payroll.prepare gave up after ${job.attemptsMade} attempts: ${err.message}. The run filed nothing or filed partially and will not retry on its own. Fix the cause and re-fire payroll.prepare for the period; filing is idempotent per invoice, so a re-run is safe.`,
      teachers: [],
      at: new Date().toISOString(),
    }).catch((alertErr: unknown) =>
      console.error(
        `[worker] could not alert on exhausted payroll.prepare retries: ${
          alertErr instanceof Error ? alertErr.message : String(alertErr)
        }`,
      ),
    );
  }
});

// Register the declared repeatable schedules idempotently on every boot:
// the inbound Gmail poll (GH-95), any registry jobs with cron triggers
// (Job.triggers, read via cronSchedulesFromJobs), and the Phase 0
// test-heartbeat demo. registerSchedules prunes any scheduler not listed.
await registerSchedules(queue, [
  emailIngestSchedule(),
  // Nightly learning-loop mine (GH-127): the baseline of the hybrid
  // trigger (cron + threshold + manual). Harmless until signals exist.
  learningMineSchedule(),
  // Nightly Mindbody contact sync (SEA-81), 05:00 America/Los_Angeles --
  // clear of the analytics-mirror rebuild blackout (02:15-06:00 PT, SEA-105).
  campaignsSyncContactsSchedule(),
  // Campaign health monitor (SEA-92), every 15 minutes; harmless (a
  // logged skip) until DATABASE_URL is configured.
  campaignsMonitorSchedule(),
  // Payroll stuck-row sweeper (SEA-111), every 30 minutes; harmless (a
  // logged skip) until DATABASE_URL is configured.
  payrollMonitorSchedule(),
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
  queues: [new BullMQAdapter(queue), new BullMQAdapter(moneyQueue)],
  serverAdapter,
});

const app = express();
app.use("/admin/queues", serverAdapter.getRouter());
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Resend delivery webhook (SEA-85): delivered/opened/clicked/bounced/
// complained -> campaign_events, with hard-bounce/complaint suppression
// written synchronously in the handler. Lives on this worker because it is
// the async inbound edge that already serves HTTP here (healthz + Bull
// Board) and holds the DB. All logic is in core (processResendWebhook);
// this route only adapts Express. express.raw is essential: the Svix
// signature covers the exact request bytes, so the body must reach
// verification unparsed. Config-gated inside core: with
// RESEND_WEBHOOK_SECRET unset the route answers 404 as if it did not
// exist. A store failure returns 500 so Resend retries the delivery (the
// 0014 provider_event_id dedupe makes that retry harmless).
app.post(
  "/webhooks/resend",
  express.raw({ type: "*/*", limit: "1mb" }),
  (req, res) => {
    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    void processResendWebhook({
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      headers: {
        svixId: header("svix-id"),
        svixTimestamp: header("svix-timestamp"),
        svixSignature: header("svix-signature"),
      },
    })
      .then((result) => {
        res.status(result.status).json(result.body);
      })
      .catch((err: unknown) => {
        console.error(
          `[worker] resend webhook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      });
  },
);

// One-click unsubscribe (SEA-84): the CAN-SPAM endpoint, on this worker
// because it is the public inbound edge that already serves HTTP here
// (healthz + /webhooks/resend) and holds the DB. All logic is in core
// (processUnsubscribe); these routes only adapt Express. GET is the
// human click from the email footer (tiny confirmation page); POST is
// the RFC 8058 one-click that mail providers fire from the
// List-Unsubscribe-Post header. Config-gated inside core: with
// UNSUBSCRIBE_TOKEN_SECRET unset both routes answer 404 as if they did
// not exist. A store failure returns 500 so the client retries; every
// write is idempotent, so retries and double clicks are harmless.
const unsubscribeRoute = (req: express.Request, res: express.Response): void => {
  const token = typeof req.query.token === "string" ? req.query.token : undefined;
  void processUnsubscribe({
    method: req.method === "POST" ? "POST" : "GET",
    token,
  })
    .then((result) => {
      res
        .status(result.status)
        .type(result.contentType === "html" ? "text/html" : "application/json")
        .send(result.body);
    })
    .catch((err: unknown) => {
      console.error(
        `[worker] unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    });
};
app.get("/unsubscribe", unsubscribeRoute);
app.post("/unsubscribe", express.urlencoded({ extended: false }), unsubscribeRoute);

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
  await moneyWorker.close();
  await queue.close();
  await moneyQueue.close();
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
