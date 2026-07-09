import type { Queue } from "bullmq";

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
