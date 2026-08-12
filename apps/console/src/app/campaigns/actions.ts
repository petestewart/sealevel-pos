"use server";

import { revalidatePath } from "next/cache";
import {
  decideCampaignApproval,
  onCampaignApproved,
  type CampaignDecision,
} from "@ai-manager/core";
import { requireCampaignDecider } from "../../lib/requireDecider";

/**
 * Server actions for campaign approval (SEA-83). Auth is enforced twice:
 * Clerk middleware protects the route, and each action re-checks the
 * session and the campaigns:decide permission (owner + operator, NOT
 * viewer, NOT campaigns:view) before touching the database.
 *
 * The decision is the email_reply pattern's two-events-joined-by-durable-
 * state: core decideCampaignApproval resolves the campaign_approval item
 * AND flips campaigns.status in ONE transaction (approve: pending_approval
 * -> approved with approved_by/approved_at; reject: back to draft). A
 * concurrent decision or a campaign that moved on underneath surfaces as
 * an inline stale message, never a half-recorded state.
 *
 * After the decision commits, approval triggers the SEA-84 send: core
 * onCampaignApproved enqueues campaigns.send (immediately, or as a
 * delayed job for campaigns.send_at). It never throws; a failed enqueue
 * is logged and caught by the campaign monitor's overdue_scheduled
 * condition.
 */

export interface CampaignActionState {
  error: string | null;
  /** True when the conflict is stale state (decided elsewhere / campaign
   * moved on); the card renders a Refresh affordance. */
  stale?: boolean;
}

function requireString(formData: FormData, field: string): string {
  const value = formData.get(field);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value;
}

async function decideCampaign(
  formData: FormData,
  action: CampaignDecision,
): Promise<CampaignActionState> {
  const decider = await requireCampaignDecider();
  const id = requireString(formData, "id");
  const outcome = await decideCampaignApproval(id, action, decider);
  switch (outcome.status) {
    case "decided": {
      if (action === "approved") {
        // SEA-84: enqueue the send (immediate, or delayed to send_at).
        // Never throws; the approval is already committed.
        await onCampaignApproved(outcome.campaign);
      }
      revalidatePath("/", "layout");
      return { error: null };
    }
    case "stale_item":
      // No revalidate: keep the stale card mounted with the inline
      // message (the GH-31 pattern); the Refresh affordance is the
      // operator's resync.
      return {
        error:
          "This campaign approval was already decided by another operator. Refresh to see the latest.",
        stale: true,
      };
    case "campaign_conflict":
      return {
        error: `The campaign is no longer awaiting approval${
          outcome.campaignStatus ? ` (it is now ${outcome.campaignStatus})` : ""
        }, so nothing was decided. Refresh to see the latest.`,
        stale: true,
      };
  }
}

export async function approveCampaignAction(
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  return decideCampaign(formData, "approved");
}

export async function rejectCampaignAction(
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  return decideCampaign(formData, "rejected");
}
