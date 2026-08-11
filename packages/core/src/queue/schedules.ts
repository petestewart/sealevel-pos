import type { Queue } from "bullmq";

import { gmailPollCron } from "../gmail/config.js";
import type { Job } from "../jobs/types.js";

/** A declarative cron schedule: one repeatable job on the queue. */
export interface ScheduleSpec {
  /** Stable scheduler id — upserts are keyed on it. */
  id: string;
  /** Cron pattern (five fields), e.g. every 5 minutes. */
  pattern: string;
  /**
   * IANA timezone the pattern is evaluated in (BullMQ RepeatOptions.tz).
   * Omitted = server time (UTC on Railway). Set it when a schedule is
   * pinned to a wall-clock constraint, e.g. the contact sync's 05:00
   * America/Los_Angeles, which must stay clear of the 02:30 PT analytics
   * rebuild across DST shifts.
   */
  tz?: string;
  /** Job name each occurrence is enqueued under. */
  jobName: string;
  /** Payload for each occurrence. */
  data?: unknown;
}

/**
 * Register the full set of repeatable (cron) schedules for a queue,
 * idempotently: each spec is upserted by id (safe to run on every boot),
 * and schedulers no longer in the list are removed so the queue always
 * matches the declared set.
 */
export async function registerSchedules(
  queue: Queue,
  schedules: ScheduleSpec[],
): Promise<void> {
  for (const spec of schedules) {
    await queue.upsertJobScheduler(
      spec.id,
      { pattern: spec.pattern, ...(spec.tz ? { tz: spec.tz } : {}) },
      { name: spec.jobName, data: spec.data },
    );
  }
  const declared = new Set(schedules.map((s) => s.id));
  const existing = await queue.getJobSchedulers();
  for (const scheduler of existing) {
    if (!declared.has(scheduler.key)) {
      await queue.removeJobScheduler(scheduler.key);
    }
  }
}

/** The BullMQ job name (and schedule id) for the inbound Gmail poll. */
export const EMAIL_INGEST_JOB = "email.ingest";

/**
 * The inbound Gmail ingestion schedule (GH-95). Registered on every boot;
 * it runs harmlessly (no-op) until Gmail is configured, then starts pulling
 * mail with no redeploy. Cadence from GMAIL_POLL_CRON (default every 2 min).
 */
export function emailIngestSchedule(): ScheduleSpec {
  return {
    id: EMAIL_INGEST_JOB,
    pattern: gmailPollCron(),
    jobName: EMAIL_INGEST_JOB,
  };
}

/** The schedule id for the nightly learning-loop mine (GH-127). */
export const LEARNING_MINE_SCHEDULE_ID = "learning.mine.nightly";

/** Default nightly cadence: a quiet hour, after the day's decisions. */
export const DEFAULT_LEARNING_MINE_CRON = "45 3 * * *";

/**
 * The nightly learning-loop schedule (GH-127): the baseline trigger of
 * the hybrid design (nightly cron + decision-count threshold + manual
 * "Mine lessons now"). Patterns need a batch window: one edit is noise,
 * four of five is a lesson, so per-event mining would either propose from
 * n=1 or re-scan everything. Registered on every boot like the Gmail
 * poll; the job runs harmlessly (a logged skip) until enough operator
 * decisions accumulate. Cadence from LEARNING_MINE_CRON.
 */
export function learningMineSchedule(): ScheduleSpec {
  return {
    id: LEARNING_MINE_SCHEDULE_ID,
    pattern: process.env.LEARNING_MINE_CRON || DEFAULT_LEARNING_MINE_CRON,
    jobName: "learning.mine",
  };
}

/** The BullMQ job name (and schedule id stem) for the nightly Mindbody
 * contact sync (SEA-81). */
export const CAMPAIGNS_SYNC_CONTACTS_JOB = "campaigns.sync_contacts";

/** The schedule id for the nightly contact sync. */
export const CAMPAIGNS_SYNC_SCHEDULE_ID = "campaigns.sync_contacts.nightly";

/**
 * Default cadence: 05:00 America/Los_Angeles (the spec's `0 5 * * *` PT) --
 * safely clear of the 02:00-03:30 PT analytics-mirror rebuild blackout,
 * and after the mirror's own nightly refresh so the reconciliation reads
 * yesterday-fresh data. The tz pin keeps that true across DST.
 */
export const DEFAULT_CAMPAIGNS_SYNC_CRON = "0 5 * * *";

/**
 * The nightly contact sync schedule (SEA-81): pure code, no brain. Runs
 * harmlessly (a logged skip) until the Mindbody API credentials are
 * configured, same boot-registration pattern as the Gmail poll and the
 * learning miner. Cadence override via CAMPAIGNS_SYNC_CRON (still PT).
 */
export function campaignsSyncContactsSchedule(): ScheduleSpec {
  return {
    id: CAMPAIGNS_SYNC_SCHEDULE_ID,
    pattern: process.env.CAMPAIGNS_SYNC_CRON || DEFAULT_CAMPAIGNS_SYNC_CRON,
    tz: "America/Los_Angeles",
    jobName: CAMPAIGNS_SYNC_CONTACTS_JOB,
  };
}

/**
 * Derive repeatable schedules from the registry's cron triggers (GH-95):
 * reads Job.triggers -- the path that had been declared and never read --
 * so any job with a `{kind:"cron", expr}` trigger auto-registers a
 * repeatable job that dispatches to the brain, no per-schedule wiring. A
 * job with multiple cron triggers gets one schedule per trigger.
 */
export function cronSchedulesFromJobs(jobs: Job[]): ScheduleSpec[] {
  const specs: ScheduleSpec[] = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    const crons = job.triggers.filter(
      (t): t is { kind: "cron"; expr: string } => t.kind === "cron",
    );
    crons.forEach((trigger, i) => {
      specs.push({
        id: crons.length > 1 ? `${job.id}#${i}` : job.id,
        pattern: trigger.expr,
        jobName: job.id,
      });
    });
  }
  return specs;
}
