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

/** The BullMQ job name for the on-demand audience build (SEA-82). Not
 * scheduled: a build is enqueued deliberately per campaign, with
 * { campaignKey } in the job data. */
export const CAMPAIGNS_BUILD_AUDIENCE_JOB = "campaigns.build_audience";

/**
 * Default cadence: 06:15 America/Los_Angeles -- clear of the corrected
 * analytics-mirror rebuild blackout (SEA-105: observed D1 imports land
 * 04:00-05:32 PT, guarded 02:15-06:00), and after the mirror's refresh so
 * the reconciliation reads yesterday-fresh data. The original 05:00 PT
 * default sat inside the real rebuild window; the sync's reconciliation
 * pass reads the mirror, so it had to move with the corrected guard. The
 * tz pin keeps this true across DST.
 */
export const DEFAULT_CAMPAIGNS_SYNC_CRON = "15 6 * * *";

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

/** The BullMQ job name for the campaign health monitor (SEA-92). */
export const CAMPAIGNS_MONITOR_JOB = "campaigns.monitor";

/** The schedule id for the campaign health monitor. */
export const CAMPAIGNS_MONITOR_SCHEDULE_ID = "campaigns.monitor.15min";

/**
 * Default cadence: every 15 minutes. Frequent enough that a stuck send or
 * a complaint spike surfaces within one operator coffee break; the
 * dedupe table (campaign_alert_state, migration 0015) keeps a persistent
 * condition from paging on every run.
 */
export const DEFAULT_CAMPAIGNS_MONITOR_CRON = "*/15 * * * *";

/**
 * The campaign health-check schedule (SEA-92): pure code, no brain.
 * Complaint rate, hard bounce rate, stuck sends, zero-recipient runs;
 * alerts through the Novu path with dedupe. Runs harmlessly (a logged
 * skip) until DATABASE_URL is configured, same boot-registration pattern
 * as the Gmail poll and the contact sync. Cadence override via
 * CAMPAIGNS_MONITOR_CRON.
 */
export function campaignsMonitorSchedule(): ScheduleSpec {
  return {
    id: CAMPAIGNS_MONITOR_SCHEDULE_ID,
    pattern: process.env.CAMPAIGNS_MONITOR_CRON || DEFAULT_CAMPAIGNS_MONITOR_CRON,
    jobName: CAMPAIGNS_MONITOR_JOB,
  };
}

/** The BullMQ job name for the payroll stuck-row sweeper (SEA-111). */
export const PAYROLL_MONITOR_JOB = "payroll.monitor";

/** The schedule id for the payroll stuck-row sweeper. */
export const PAYROLL_MONITOR_SCHEDULE_ID = "payroll.monitor.30min";

/**
 * Default cadence: every 30 minutes. A push normally completes in
 * seconds, so a row stuck past the sweeper's threshold is unambiguous;
 * the sweep has no dedupe state (deliberately, see payroll/monitor.ts),
 * so the cadence is also the re-page interval for an unresolved stuck
 * row. Half the campaign monitor's noise, still fast enough that a
 * parked money row summons a human within the hour.
 */
export const DEFAULT_PAYROLL_MONITOR_CRON = "*/30 * * * *";

/**
 * The payroll stuck-row sweep schedule (SEA-111 fix 2b): pure code, no
 * brain. Any payroll_invoices row sitting 'queued' or 'pushing' past
 * the threshold alerts through the Novu path, the net that does not
 * depend on any handler firing. Runs harmlessly (a logged skip) until
 * DATABASE_URL is configured, same boot-registration pattern as the
 * campaign monitor. Cadence override via PAYROLL_MONITOR_CRON.
 */
export function payrollMonitorSchedule(): ScheduleSpec {
  return {
    id: PAYROLL_MONITOR_SCHEDULE_ID,
    pattern: process.env.PAYROLL_MONITOR_CRON || DEFAULT_PAYROLL_MONITOR_CRON,
    jobName: PAYROLL_MONITOR_JOB,
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
      (t): t is { kind: "cron"; expr: string; tz?: string } =>
        t.kind === "cron",
    );
    crons.forEach((trigger, i) => {
      specs.push({
        id: crons.length > 1 ? `${job.id}#${i}` : job.id,
        pattern: trigger.expr,
        ...(trigger.tz ? { tz: trigger.tz } : {}),
        jobName: job.id,
      });
    });
  }
  return specs;
}
