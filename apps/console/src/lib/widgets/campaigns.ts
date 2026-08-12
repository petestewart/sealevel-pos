import { campaignCounts } from "../campaigns";
import type { Widget } from "./types";

/**
 * Campaigns widget (SEA-90): the overview card for the campaigns engine
 * (automation-suite doc, Option 3). Surfaces the two states a human cares
 * about at a glance: campaigns waiting on an approval and campaigns
 * currently sending, via one indexed GROUP BY. Reads Postgres server-side
 * through @ai-manager/core; never imported by client components.
 */
export const campaignsWidget: Widget = {
  id: "campaigns",
  domain: "campaigns",
  icon: "megaphone",
  requires: "campaigns:view",
  detailRoute: "/campaigns",
  summary: async () => {
    const { pendingApproval, sending } = await campaignCounts();
    return {
      count: pendingApproval + sending,
      breakdown: [
        { label: `${pendingApproval} pending approval`, tone: "pending" },
        { label: `${sending} sending`, tone: "accent" },
      ],
      // Sending needs no human; only a waiting approval calls for one.
      status: pendingApproval > 0 ? "attention" : "ok",
    };
  },
};
