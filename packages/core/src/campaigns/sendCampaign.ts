import { createHash } from "node:crypto";

import {
  copyVariantsOf,
  pgCampaignSendStore,
  type CampaignSendStore,
  type CopySnapshotVariant,
  type SendRecipient,
} from "../db/campaignSend.js";
import { renderMergeFields } from "./draftCampaign.js";
import {
  unsubscribeBaseUrl,
  unsubscribeSecret,
  unsubscribeUrl,
  UNSUBSCRIBE_BASE_URL_VAR,
  UNSUBSCRIBE_TOKEN_SECRET_VAR,
} from "./unsubscribe.js";

/**
 * campaigns.send (SEA-84): the send-gate. Pure code, no LLM; fires on
 * campaign approval (enqueued by onCampaignApproved as a BullMQ job,
 * delayed to campaigns.send_at when one is set) and delivers the frozen
 * SEA-82 audience snapshot the approved copy, batched and rate-limited
 * through Resend.
 *
 * Non-negotiables enforced here, in order of importance:
 *
 * 1. NEVER without a working unsubscribe. Every message carries a signed
 *    one-click unsubscribe link in the body plus List-Unsubscribe and
 *    List-Unsubscribe-Post headers (RFC 8058, required by inbox
 *    providers at volume). With UNSUBSCRIBE_TOKEN_SECRET or
 *    UNSUBSCRIBE_BASE_URL unset, links cannot be generated, so the send
 *    REFUSES to fire, loudly (result status 'refused'). This is a
 *    CAN-SPAM requirement, not a preference.
 *
 * 2. Suppressions and consent are RE-CHECKED PER RECIPIENT AT SEND TIME
 *    (freshly per batch), not just at audience build: an unsubscribe
 *    click, a complaint webhook, or a manual suppression can land
 *    between approval and send, and a send_at delay widens that window
 *    arbitrarily. A recipient dropped here gets a campaign_sends row
 *    with status 'skipped_suppressed' (a recorded outcome, 0011), never
 *    a silent absence.
 *
 * 3. Idempotent on dedupe_key = sha256(campaign_id US contact_id US
 *    step), NOT NULL UNIQUE (0011 design point 2): a retried BullMQ job
 *    re-derives the same key, the claim insert loses in Postgres, and
 *    rows already terminal (sent / failed / skipped_suppressed) are left
 *    alone. On top of the DB guard, every Resend request carries an
 *    Idempotency-Key equal to the dedupe_key, so even the crash window
 *    between "Resend accepted" and "row updated" cannot double-send: the
 *    retried request replays the stored response instead of mailing
 *    again (Resend retains idempotency keys for 24 hours).
 *
 * 4. WARMUP RAMP: never blast a cold subdomain. Sends accepted across
 *    ALL campaigns in the trailing 24 hours are counted against
 *    CAMPAIGN_SEND_RAMP_PER_DAY (default 200/day, deliberately
 *    conservative for a fresh sending subdomain; raise it week by week
 *    per the warmup plan in docs). When the budget is exhausted the run
 *    pauses: remaining recipients stay unclaimed/queued, the campaign
 *    stays 'sending', and the worker re-enqueues a delayed follow-up
 *    (result status 'ramp_paused' + resumeDelayMs). The monitor's
 *    stuck_sending threshold (default 120 min) should stay above the
 *    ramp retry interval so a paused ramp does not page.
 *
 * 5. COPY SNAPSHOT: before the first message of a run leaves, the
 *    approved copy SET (per-segment SEA-88 variants, or one ''-segment
 *    row for the single shape) is stored durably in
 *    campaign_copy_snapshots (first-write-wins per campaign run). This
 *    is what turns computeSendDiff's copyChanged from always-null into a
 *    real comparison, and it is also what a retried job renders from --
 *    the copy that already left is the copy the rest of the run gets.
 *
 * The copy that sends is the copy a human approved: read back from the
 * resolved campaign_approval item -- the single draft trio or the
 * SEA-88 per-segment variants, shape-validated by the SAME
 * campaignApprovalOf the card uses -- byte for byte, selected per
 * recipient segment (copyForRecipient) and rendered with the same
 * renderMergeFields the approval card previewed.
 *
 * Campaign status: approved -> sending -> sent; markCampaignSent is
 * guarded on zero queued rows so a paused ramp can never stamp 'sent'
 * early, and the monitor's stuck_sending watches 'sending'.
 */

/** Env var holding the Resend API key; unset = sending disabled (logged
 * skip, same posture as the Gmail and Mindbody gates). */
export const RESEND_API_KEY_VAR = "RESEND_API_KEY";

/** Env var holding the From header, e.g.
 * "Sealevel Hot Yoga <hello@mail.sealevelhotyoga.com>". Must be on the
 * verified sending subdomain; unset = sending disabled (logged skip). */
export const CAMPAIGN_FROM_EMAIL_VAR = "CAMPAIGN_FROM_EMAIL";

/** Ramp/batch/pacing configuration, env-overridable with sane defaults. */
export interface SendCampaignConfig {
  /** Max provider-accepted sends per trailing 24h, across ALL campaigns
   * (domain warmup budget). Env: CAMPAIGN_SEND_RAMP_PER_DAY. */
  rampPerDay: number;
  /** Recipients claimed + mailed per batch (block re-check granularity).
   * Env: CAMPAIGN_SEND_BATCH_SIZE. */
  batchSize: number;
  /** Milliseconds between individual Resend requests (rate limit; Resend
   * default allowance is 2 req/s). Env: CAMPAIGN_SEND_INTERVAL_MS. */
  sendIntervalMs: number;
  /** Minutes before a ramp-paused run resumes.
   * Env: CAMPAIGN_SEND_RAMP_RETRY_MINUTES. */
  rampRetryMinutes: number;
}

export const DEFAULT_SEND_CONFIG: SendCampaignConfig = {
  rampPerDay: 200,
  batchSize: 25,
  sendIntervalMs: 600,
  rampRetryMinutes: 60,
};

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[campaigns.send] ignoring ${name}="${raw}" (not a positive number); using ${fallback}`,
    );
    return fallback;
  }
  return value;
}

export function sendConfigFromEnv(): SendCampaignConfig {
  const d = DEFAULT_SEND_CONFIG;
  return {
    rampPerDay: numFromEnv("CAMPAIGN_SEND_RAMP_PER_DAY", d.rampPerDay),
    batchSize: Math.min(
      numFromEnv("CAMPAIGN_SEND_BATCH_SIZE", d.batchSize),
      100,
    ),
    sendIntervalMs: numFromEnv("CAMPAIGN_SEND_INTERVAL_MS", d.sendIntervalMs),
    rampRetryMinutes: numFromEnv(
      "CAMPAIGN_SEND_RAMP_RETRY_MINUTES",
      d.rampRetryMinutes,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * dedupe_key derivation (0011 design point 2)                        *
 * ------------------------------------------------------------------ */

/** US (U+001F) joins the three inputs: cannot occur in a bigint's decimal
 * text and is excluded from `step` by the 0011 CHECK, so the encoding is
 * injective (see the migration's design point 2 for the collision this
 * prevents). */
const US = "\u001f";

/** The step label for a run: 'initial' for run 1, 'initial#N' for a
 * deliberate re-send (run_seq bump), per the 0011 run_seq note. */
export function stepForRun(runSeq: number): string {
  return runSeq > 1 ? `initial#${runSeq}` : "initial";
}

/** dedupe_key = sha256(campaign_id US contact_id US step), hex. */
export function deriveDedupeKey(
  campaignId: string,
  contactId: string,
  step: string,
): string {
  return createHash("sha256")
    .update(`${campaignId}${US}${contactId}${US}${step}`)
    .digest("hex");
}

/* ------------------------------------------------------------------ *
 * Copy selection (the SEA-88 variants seam)                          *
 * ------------------------------------------------------------------ */

/**
 * The variants seam, now live (SEA-88 landed): every recipient's copy
 * is selected HERE, the one chokepoint between the stored per-run copy
 * set and the renderer.
 *
 * Selection, in order:
 *   1. the variant whose segment matches the recipient's frozen-snapshot
 *      segment (the briefed per-segment case);
 *   2. the '' base variant (the un-briefed single-copy shape; also the
 *      graceful landing for any segment a briefed set does not cover);
 *   3. deterministic fallback: the FIRST variant of the set (the stored
 *      set is ordered segment-ascending, so this is stable across
 *      retries). An unmatched segment must NEVER dead-letter the run --
 *      a recipient the human approved mailing gets the closest approved
 *      copy, and the mismatch is the audience/plan drift's problem to
 *      surface, not the send's to amplify.
 * The variants array is never empty (copyVariantsOf yields at least the
 * '' entry, and briefed payloads validate non-empty), but an empty set
 * throws rather than mailing nothing.
 */
export function copyForRecipient(
  variants: readonly CopySnapshotVariant[],
  recipient: SendRecipient,
): { subject: string; body: string } {
  const match =
    variants.find((v) => v.segment === recipient.segment) ??
    variants.find((v) => v.segment === "") ??
    variants[0];
  if (!match) {
    throw new Error("campaigns.send: empty copy-variant set (bug)");
  }
  return { subject: match.subject, body: match.body };
}

/* ------------------------------------------------------------------ *
 * The Resend mailer                                                  *
 * ------------------------------------------------------------------ */

/** One outbound message as handed to the mailer. */
export interface OutboundMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}

export type MailerResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * The provider surface the send loop depends on. sendOne throws only on
 * RETRYABLE trouble (network failure, 429, 5xx) so the BullMQ job fails
 * and retries with the same idempotency keys; a definitive rejection
 * (4xx validation) returns { ok: false } and marks that one send failed
 * without sinking the rest of the run.
 */
export interface Mailer {
  sendOne(
    message: OutboundMessage,
    idempotencyKey: string,
  ): Promise<MailerResult>;
}

export const RESEND_API_BASE = "https://api.resend.com";

/** Production mailer over the Resend HTTP API. baseUrl is injectable so
 * the offline smoke can point it at a local mock server. */
export function resendMailer(
  apiKey: string,
  baseUrl: string = RESEND_API_BASE,
  fetchImpl: typeof fetch = fetch,
): Mailer {
  return {
    async sendOne(message, idempotencyKey): Promise<MailerResult> {
      const response = await fetchImpl(`${baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          headers: message.headers,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { id?: unknown };
        if (typeof data.id !== "string" || data.id.length === 0) {
          throw new Error("Resend accepted the send but returned no id");
        }
        return { ok: true, id: data.id };
      }
      const bodyText = await response.text().catch(() => "");
      if (response.status === 429 || response.status >= 500) {
        // Retryable: throw so BullMQ retries the whole job; unclaimed and
        // still-queued rows are re-attempted under the same idempotency
        // keys, so the retry cannot double-send.
        throw new Error(
          `Resend ${response.status} (retryable): ${bodyText.slice(0, 300)}`,
        );
      }
      return {
        ok: false,
        error: `Resend ${response.status}: ${bodyText.slice(0, 300)}`,
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * The send run                                                       *
 * ------------------------------------------------------------------ */

export interface SendCampaignDeps {
  store: CampaignSendStore;
  /** null = RESEND_API_KEY unset (logged skip). */
  mailer: Mailer | null;
  /** null = CAMPAIGN_FROM_EMAIL unset (logged skip). */
  fromEmail: string | null;
  /** null = unsubscribe unconfigured (REFUSE, loudly). */
  unsubscribe: { secret: string; baseUrl: string } | null;
  config: SendCampaignConfig;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export function defaultSendCampaignDeps(): SendCampaignDeps {
  const apiKey = process.env[RESEND_API_KEY_VAR]?.trim() || null;
  const fromEmail = process.env[CAMPAIGN_FROM_EMAIL_VAR]?.trim() || null;
  const secret = unsubscribeSecret();
  const baseUrl = unsubscribeBaseUrl();
  return {
    store: pgCampaignSendStore(),
    mailer: apiKey ? resendMailer(apiKey) : null,
    fromEmail,
    unsubscribe: secret && baseUrl ? { secret, baseUrl } : null,
    config: sendConfigFromEnv(),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  };
}

export interface SendCampaignResult {
  status: "sent" | "ramp_paused" | "skipped" | "refused";
  reason?: string;
  campaignId: string | null;
  campaignKey: string;
  /** The campaign row's run_seq (for the resume enqueue's jobId). */
  runSeq: number | null;
  /** Recipients newly mailed by THIS run. */
  sentNow: number;
  /** Recipients newly recorded as skipped_suppressed by THIS run. */
  skippedSuppressedNow: number;
  /** Recipients newly recorded as failed by THIS run. */
  failedNow: number;
  /** Recipients whose rows were already terminal (retry no-ops). */
  alreadyDone: number;
  /** Recipients still owed a send when the run stopped (ramp pause). */
  remaining: number;
  /** Delay before the worker should re-enqueue (ramp_paused only). */
  resumeDelayMs?: number;
  /** The done-when line, verbatim. */
  summary: string;
}

function refusal(
  campaignKey: string,
  campaignId: string | null,
  status: "skipped" | "refused",
  reason: string,
  summary: string,
): SendCampaignResult {
  return {
    status,
    reason,
    campaignId,
    campaignKey,
    runSeq: null,
    sentNow: 0,
    skippedSuppressedNow: 0,
    failedNow: 0,
    alreadyDone: 0,
    remaining: 0,
    summary,
  };
}

/** The unsubscribe footer appended to every outgoing body. Plain text,
 * one line, no preference maze. Exported for the smoke. */
export function unsubscribeFooter(url: string): string {
  return `\n\nTo stop receiving these emails, unsubscribe with one click: ${url}`;
}

/**
 * Run (or resume) the send for one approved campaign. Idempotent end to
 * end: safe under BullMQ retries and the delayed re-enqueue after a ramp
 * pause. Throws on state that must dead-letter loudly (unknown campaign,
 * campaign in a non-sendable status, no approved copy, retryable
 * provider trouble).
 */
export async function sendCampaign(
  campaignKey: string,
  deps: SendCampaignDeps = defaultSendCampaignDeps(),
): Promise<SendCampaignResult> {
  const { store, config, log } = deps;

  const campaign = await store.getCampaignByKey(campaignKey);
  if (!campaign) {
    throw new Error(`campaigns.send: no campaign with key '${campaignKey}'`);
  }
  if (campaign.status === "sent") {
    const summary = `campaign '${campaignKey}' is already sent; nothing to do`;
    log(`[campaigns.send] ${summary}`);
    return refusal(campaignKey, campaign.id, "skipped", "already_sent", summary);
  }
  if (campaign.status !== "approved" && campaign.status !== "sending") {
    // draft / pending_approval / cancelled: never sendable from here. A
    // cancelled campaign's queued job must die loudly, not mail anyone.
    throw new Error(
      `campaigns.send: campaign '${campaignKey}' is '${campaign.status}', not approved/sending; refusing`,
    );
  }

  // Config gates, all BEFORE the status flip so a skipped/refused run
  // leaves the campaign 'approved' where the monitor's overdue-scheduled
  // condition can see it.
  if (!deps.unsubscribe) {
    const summary =
      `REFUSING to send campaign '${campaignKey}': unsubscribe links cannot be generated ` +
      `(${UNSUBSCRIBE_TOKEN_SECRET_VAR} / ${UNSUBSCRIBE_BASE_URL_VAR} unset). ` +
      `Never send without a working unsubscribe (CAN-SPAM).`;
    log(`[campaigns.send] ${summary}`);
    return refusal(
      campaignKey,
      campaign.id,
      "refused",
      "unsubscribe_unconfigured",
      summary,
    );
  }
  if (!deps.mailer) {
    const summary = `campaigns.send skipped for '${campaignKey}': ${RESEND_API_KEY_VAR} is not configured`;
    log(`[campaigns.send] ${summary}`);
    return refusal(
      campaignKey,
      campaign.id,
      "skipped",
      "resend_unconfigured",
      summary,
    );
  }
  if (!deps.fromEmail) {
    const summary = `campaigns.send skipped for '${campaignKey}': ${CAMPAIGN_FROM_EMAIL_VAR} is not configured`;
    log(`[campaigns.send] ${summary}`);
    return refusal(
      campaignKey,
      campaign.id,
      "skipped",
      "from_unconfigured",
      summary,
    );
  }

  // The copy a human approved, byte for byte. Its absence for an
  // approved campaign is state corruption; dead-letter loudly.
  const approvedCopy = await store.getApprovedDraftCopy(
    campaign.id,
    campaign.runSeq,
  );
  if (!approvedCopy) {
    throw new Error(
      `campaigns.send: campaign '${campaignKey}' (run ${campaign.runSeq}) has no approved campaign_approval item to read copy from`,
    );
  }

  const flipped = await store.markCampaignSending(campaign.id);
  if (flipped === null) {
    throw new Error(
      `campaigns.send: campaign '${campaignKey}' left approved/sending underneath the send; refusing`,
    );
  }

  // Durable copy snapshot BEFORE anything leaves -- the run's full copy
  // set, one row per SEA-88 variant (or one ''-segment row for the
  // single shape), first-write-wins per (run, segment). What it stores
  // is what this run renders from (a retried job with a divergent item
  // -- impossible post-approval, but belts and braces -- still sends
  // the snapshotted copy).
  const copySet = await store.insertCopySnapshot({
    campaignId: campaign.id,
    runSeq: campaign.runSeq,
    variants: copyVariantsOf(approvedCopy),
  });

  const recipients = await store.listSendRecipients(campaign.id);
  const step = stepForRun(campaign.runSeq);
  const dayMs = 24 * 60 * 60 * 1000;

  let sentNow = 0;
  let skippedNow = 0;
  let failedNow = 0;
  let alreadyDone = 0;
  let index = 0;

  while (index < recipients.length) {
    // Ramp budget, re-read per batch: global across campaigns (the
    // warmup protects the domain, not one campaign).
    const sentInWindow = await store.countSentSince(
      new Date(deps.now().getTime() - dayMs),
    );
    const budget = config.rampPerDay - sentInWindow;
    if (budget <= 0) {
      const remaining = recipients.length - index;
      const resumeDelayMs = config.rampRetryMinutes * 60 * 1000;
      const summary =
        `campaign '${campaignKey}' ramp-paused: 24h send budget exhausted ` +
        `(${sentInWindow}/${config.rampPerDay} sent in window), ${remaining} recipients remaining; ` +
        `resuming in ${config.rampRetryMinutes} min`;
      log(`[campaigns.send] ${summary}`);
      return {
        status: "ramp_paused",
        reason: "ramp_budget_exhausted",
        campaignId: campaign.id,
        campaignKey,
        runSeq: campaign.runSeq,
        sentNow,
        skippedSuppressedNow: skippedNow,
        failedNow,
        alreadyDone,
        remaining,
        resumeDelayMs,
        summary,
      };
    }

    const batch = recipients.slice(
      index,
      index + Math.min(config.batchSize, budget),
    );
    index += batch.length;

    // THE send-time re-check: fresh suppression + consent state for this
    // batch, immediately before it is mailed.
    const blocks = await store.sendTimeBlocks(batch.map((r) => r.contactId));

    for (const recipient of batch) {
      const dedupeKey = deriveDedupeKey(campaign.id, recipient.contactId, step);
      const block = blocks.get(recipient.contactId);
      const blockedReason = !block
        ? "contact row no longer readable at send time"
        : block.suppressed
          ? "address is on the suppressions list at send time"
          : block.consentState !== "subscribed"
            ? block.consentState === null
              ? "consent ledger is empty at send time (an empty ledger is not consent)"
              : `latest consent event is '${block.consentState}' at send time`
            : null;

      if (blockedReason !== null) {
        const claimed = await store.claimSend({
          campaignId: campaign.id,
          contactId: recipient.contactId,
          email: recipient.email,
          step,
          dedupeKey,
          status: "skipped_suppressed",
          detail: blockedReason,
        });
        if (claimed.inserted) skippedNow += 1;
        else alreadyDone += 1;
        continue;
      }

      const claimed = await store.claimSend({
        campaignId: campaign.id,
        contactId: recipient.contactId,
        email: recipient.email,
        step,
        dedupeKey,
        status: "queued",
      });
      if (!claimed.inserted && claimed.status !== "queued") {
        // Retry no-op: this recipient's outcome is already recorded
        // (sent / failed / skipped_suppressed). The dedupe_key guard did
        // its job; move on.
        alreadyDone += 1;
        continue;
      }

      // Render: the recipient's segment variant from the snapshotted
      // copy set (base/first fallback, never a dead-letter), merge
      // fields resolved exactly as the approval card previewed, plus
      // the signed one-click unsubscribe.
      const recipientCopy = copyForRecipient(copySet.variants, recipient);
      const url = unsubscribeUrl(
        deps.unsubscribe.baseUrl,
        campaign.id,
        recipient.contactId,
        deps.unsubscribe.secret,
      );
      const message: OutboundMessage = {
        from: deps.fromEmail,
        to: recipient.email,
        subject: renderMergeFields(recipientCopy.subject, {
          email: recipient.email,
          firstName: recipient.firstName,
        }),
        text:
          renderMergeFields(recipientCopy.body, {
            email: recipient.email,
            firstName: recipient.firstName,
          }) + unsubscribeFooter(url),
        headers: {
          "List-Unsubscribe": `<${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };

      const result = await deps.mailer.sendOne(message, dedupeKey);
      if (result.ok) {
        await store.markSendSent(claimed.id, result.id, deps.now());
        sentNow += 1;
      } else {
        await store.markSendFailed(claimed.id, result.error);
        failedNow += 1;
        log(
          `[campaigns.send] send to ${recipient.email} failed permanently: ${result.error}`,
        );
      }
      await deps.sleep(config.sendIntervalMs);
    }
  }

  const completed = await store.markCampaignSent(campaign.id);
  const summary =
    `campaign '${campaignKey}' (run ${campaign.runSeq}): ${sentNow} sent, ` +
    `${skippedNow} skipped as suppressed at send time, ${failedNow} failed, ` +
    `${alreadyDone} already recorded; status ${completed ? "sent" : "sending (queued rows remain)"}`;
  log(`[campaigns.send] ${summary}`);
  return {
    status: "sent",
    campaignId: campaign.id,
    campaignKey,
    runSeq: campaign.runSeq,
    sentNow,
    skippedSuppressedNow: skippedNow,
    failedNow,
    alreadyDone,
    remaining: 0,
    summary,
  };
}
