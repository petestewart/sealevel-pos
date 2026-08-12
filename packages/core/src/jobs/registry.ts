import type { Job } from "./types.js";
import { campaignDraft } from "../campaigns/draftCampaign.js";
import { emailDraft } from "./emailDraft.js";
import { heartbeat } from "./heartbeat.js";
import { itemRevise } from "./itemRevise.js";

/**
 * The job registry. The core reads from it, so there are no per-job core
 * edits: adding = new file + one entry here; removing = delete or
 * enabled: false.
 */
export const JOBS: Job[] = [
  heartbeat,
  emailDraft,
  itemRevise,
  campaignDraft,
].filter((j) => j.enabled);

export const jobById = new Map(JOBS.map((j) => [j.id, j]));

/**
 * Register feature-module jobs (SEA-101). Core cannot import
 * packages/features without a dependency cycle, so the worker entry point
 * calls this with the feature packages' job exports. Ordering is
 * load-bearing: registration must happen BEFORE registerSchedules runs,
 * because the schedule sweep prunes any scheduler not derived from JOBS
 * at that moment — a job registered after the sweep would have its
 * repeatable schedule deleted, not merely missed.
 *
 * Mutates JOBS and jobById in place so every importer holding a
 * reference (runJob's jobById lookup, cronSchedulesFromJobs(JOBS)) sees
 * the registered jobs without re-importing. Disabled jobs are skipped,
 * matching the static registry's filter; a duplicate id throws, since two
 * jobs answering the same queue name would race each other's payloads.
 */
export function registerJobs(jobs: Job[]): void {
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (jobById.has(job.id)) {
      throw new Error(`registerJobs: duplicate job id "${job.id}"`);
    }
    JOBS.push(job);
    jobById.set(job.id, job);
  }
}
