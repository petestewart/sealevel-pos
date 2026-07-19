import type { Queue } from "bullmq";

import { gmailPollCron } from "../gmail/config.js";
import type { Job } from "../jobs/types.js";

/** A declarative cron schedule: one repeatable job on the queue. */
export interface ScheduleSpec {
  /** Stable scheduler id — upserts are keyed on it. */
  id: string;
  /** Cron pattern (five fields), e.g. every 5 minutes. */
  pattern: string;
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
      { pattern: spec.pattern },
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
