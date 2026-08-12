import type { CampaignFact } from "./fallAnnouncement.js";
import {
  FALL_ANNOUNCEMENT_AUDIENCE_VIEW,
  FALL_ANNOUNCEMENT_CAMPAIGN_KEY,
  fallAnnouncementDraftRequest,
  unverifiedFallFacts,
} from "./fallAnnouncement.js";
import type { SegmentedDraftRequest } from "./draftVariants.js";

/**
 * Campaign brief registry (SEA-88 integration): the one place that maps
 * a campaigns.key to its per-segment drafting brief. campaigns.draft
 * resolves the key here; a hit means the briefed fan-out path (one copy
 * variant per audience segment, facts from the brief), a miss means
 * exactly the original single-draft flow. Adding a future briefed
 * campaign is ONE entry here plus its brief module, never a new code
 * path in draftCampaign.ts.
 */
export interface CampaignBriefEntry {
  /** The reviewable per-segment brief (SegmentedDraftRequest). */
  request: () => SegmentedDraftRequest;
  /**
   * Facts still awaiting human verification. campaigns.draft REFUSES to
   * draft this campaign while any remain: a draft over unverified
   * schedule claims is exactly the email this project must never send.
   */
  unverifiedFacts: () => CampaignFact[];
  /** Where the facts live (repo-relative), for the refusal message. */
  factsFile: string;
}

/** key -> brief. Registration, not special-casing. */
export const CAMPAIGN_BRIEFS: Readonly<Record<string, CampaignBriefEntry>> = {
  [FALL_ANNOUNCEMENT_CAMPAIGN_KEY]: {
    request: fallAnnouncementDraftRequest,
    unverifiedFacts: unverifiedFallFacts,
    factsFile: "packages/core/src/campaigns/fallAnnouncement.ts",
  },
};

/** Look a campaign's brief up by key; null = un-briefed (single draft). */
export function resolveCampaignBrief(
  campaignKey: string,
): CampaignBriefEntry | null {
  return CAMPAIGN_BRIEFS[campaignKey] ?? null;
}

/* ------------------------------------------------------------------ *
 * Campaign row seeds (operational data, NOT a migration)              *
 * ------------------------------------------------------------------ */

/** A campaign row as `npm run campaign:seed` inserts it. Campaign rows
 * are operational data (the operator or console owns them), so seeding
 * is an idempotent script, deliberately not a numbered migration. */
export interface CampaignSeed {
  key: string;
  name: string;
  audienceView: string;
}

export const CAMPAIGN_SEEDS: readonly CampaignSeed[] = [
  {
    key: FALL_ANNOUNCEMENT_CAMPAIGN_KEY,
    name: "Fall 2026 schedule announcement",
    audienceView: FALL_ANNOUNCEMENT_AUDIENCE_VIEW,
  },
];

/** Seed row by key, for the seed script and its smoke. */
export function campaignSeedByKey(key: string): CampaignSeed | null {
  return CAMPAIGN_SEEDS.find((s) => s.key === key) ?? null;
}
