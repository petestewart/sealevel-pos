import { cache } from "react";
import "./env";
import {
  campaignOverviewCounts,
  listCampaignSummaries,
  type CampaignOverviewCounts,
  type CampaignStatus,
  type CampaignSummary,
} from "@ai-manager/core";

/**
 * Campaigns console data layer (SEA-90): read-only stats over the SEA-80
 * schema, read through @ai-manager/core like the approvals layer. This
 * begins the Campaigns section alongside the Inbox (automation-suite doc,
 * Option 3: "one section per engine"). Approve/reject is SEA-83 and the
 * segment definitions live in git, so this module stays a pure reader.
 */

export type { CampaignStatus, CampaignSummary };

/** Overview-card counts, deduped per request render. */
export const campaignCounts = cache(
  async (): Promise<CampaignOverviewCounts> => campaignOverviewCounts(),
);

/** All campaigns for the detail list, newest first. */
export const campaignList = cache(
  async (): Promise<CampaignSummary[]> => listCampaignSummaries(),
);

/**
 * Status chip presentation per campaign status, mapped onto the semantic
 * status palette: waiting-on-a-human is amber, in-flight is accent,
 * terminal-good is green, terminal-neutral and draft are muted.
 */
export const CAMPAIGN_STATUS_CHIP: Record<
  CampaignStatus,
  { label: string; chip: string }
> = {
  draft: { label: "Draft", chip: "unassigned" },
  pending_approval: { label: "Pending approval", chip: "pending" },
  approved: { label: "Approved", chip: "approved" },
  sending: { label: "Sending", chip: "sending" },
  sent: { label: "Sent", chip: "approved" },
  cancelled: { label: "Cancelled", chip: "trashed" },
};
