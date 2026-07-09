import type { Job } from "./types.js";
import { heartbeat } from "./heartbeat.js";

/**
 * The job registry. The core reads from it, so there are no per-job core
 * edits: adding = new file + one entry here; removing = delete or
 * enabled: false.
 */
export const JOBS: Job[] = [heartbeat].filter((j) => j.enabled);

export const jobById = new Map(JOBS.map((j) => [j.id, j]));
