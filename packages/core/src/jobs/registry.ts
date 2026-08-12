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
