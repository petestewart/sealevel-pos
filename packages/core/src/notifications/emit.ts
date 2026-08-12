import { Novu } from "@novu/api";

import type { Item } from "../db/items.js";

/**
 * Notifications (ARCHITECTURE.md "Notifications — adopt Novu").
 *
 * On item creation/state change we emit a typed event to Novu; Novu routes
 * it per user, per event type, per channel (digest, quiet hours) via its
 * workflow + subscriber preference config. The differential routing intent
 * (Pete: SMS instant, Alison: email digest) is recorded locally in the
 * notification_prefs table (migrations 0003 and 0015) and enforced
 * dashboard-side in Novu; see docs/novu.md.
 *
 * The whole module is a no-op when NOVU_SECRET_KEY is unset so local dev
 * and tests never require a Novu account.
 */

/**
 * Typed item event names.
 *
 * - item.pending_approval: an item entered pending_approval (v1, GH-era).
 * - campaign_approval: a campaign approval item entered pending_approval
 *   (SEA-92 plumbing; the item type itself lands with SEA-83, which calls
 *   emitItemEvent("campaign_approval", item, actor) and nothing else).
 */
export type ItemEventType = "item.pending_approval" | "campaign_approval";

/**
 * Non-item event names: operational alerts from the campaign monitor
 * (SEA-92). These carry a CampaignAlertPayload, not an item.
 */
export type AlertEventType = "campaign_alert";

/** Every event type this module can emit. */
export type EventType = ItemEventType | AlertEventType;

/** Payload sent to Novu with every item event. */
export interface ItemEventPayload {
  itemId: string;
  itemType: string;
  domain: string | null;
  status: string;
  assignee: string | null;
  /** Who/what caused the event, e.g. "brain", a user id. */
  actor: string | null;
  createdAt: string;
  [key: string]: unknown;
}

/**
 * Payload sent to Novu with every campaign_alert event (SEA-92). detail is
 * the ready-made human line for the SMS/email templates; the structured
 * fields let a template or a later consumer say more.
 */
export interface CampaignAlertPayload {
  alertType:
    | "complaint_rate"
    | "hard_bounce_rate"
    | "stuck_sending"
    | "zero_recipients"
    | "overdue_scheduled";
  /** "campaign" = one campaign's numbers; "rolling" = across campaigns
   * over the monitor's rolling window. */
  scope: "campaign" | "rolling";
  campaignId: string | null;
  campaignKey: string | null;
  /** Observed rate (fraction, e.g. 0.0012) for rate alerts, else null. */
  rate: number | null;
  /** Configured threshold the observation crossed, else null. */
  threshold: number | null;
  numerator: number | null;
  denominator: number | null;
  /** One human-readable sentence, no em dashes (project convention). */
  detail: string;
  at: string;
  [key: string]: unknown;
}

/** Any payload this module sends to Novu. */
export type EventPayload = ItemEventPayload | CampaignAlertPayload;

export interface EmitResult {
  /** True when a Novu trigger was actually sent. */
  sent: boolean;
  /** Why nothing was sent (no-op path) or the send failed. */
  reason?: string;
}

/**
 * Novu workflow identifier per event type. Identity by default; if the
 * Novu dashboard rejects or rewrites an identifier when creating the
 * workflow (it slugifies dotted ids to kebab-case in some flows), create
 * the workflow with the id the dashboard accepts and change the one
 * mapping here.
 */
export const WORKFLOW_IDS: Record<EventType, string> = {
  "item.pending_approval": "item.pending_approval",
  campaign_approval: "campaign_approval",
  campaign_alert: "campaign_alert",
};

/** Signature of the low-level trigger call; injectable for tests. */
export type TriggerFn = (args: {
  workflowId: string;
  subscriberIds: string[];
  payload: EventPayload;
}) => Promise<void>;

/**
 * Subscriber ids of the two operators, seeded from env. Missing vars are
 * skipped (with a log line) rather than fatal, so a partially configured
 * environment still notifies whoever is configured.
 */
function configuredSubscriberIds(): string[] {
  const ids: string[] = [];
  for (const name of ["NOVU_SUBSCRIBER_PETE", "NOVU_SUBSCRIBER_ALISON"]) {
    const value = process.env[name];
    if (value) ids.push(value);
    else console.warn(`[notifications] ${name} unset; skipping subscriber`);
  }
  return ids;
}

const defaultTrigger: TriggerFn = async ({ workflowId, subscriberIds, payload }) => {
  const novu = new Novu({ secretKey: process.env.NOVU_SECRET_KEY });
  await novu.trigger({
    workflowId,
    to: subscriberIds.map((subscriberId) => ({ subscriberId })),
    payload,
  });
};

/**
 * Shared emit core: no-op without a key, skip without subscribers, and
 * never throw (notification delivery must not fail the operation that
 * produced the event; failures are logged and reported in the result).
 */
async function emitEvent(
  eventType: EventType,
  payload: EventPayload,
  describe: string,
  trigger: TriggerFn,
): Promise<EmitResult> {
  if (!process.env.NOVU_SECRET_KEY && trigger === defaultTrigger) {
    console.log(
      `[notifications] NOVU_SECRET_KEY unset; skipping ${eventType} for ${describe}`,
    );
    return { sent: false, reason: "NOVU_SECRET_KEY unset" };
  }

  const subscriberIds = configuredSubscriberIds();
  if (subscriberIds.length === 0) {
    return { sent: false, reason: "no subscribers configured" };
  }

  try {
    await trigger({ workflowId: WORKFLOW_IDS[eventType], subscriberIds, payload });
    return { sent: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[notifications] failed to emit ${eventType}: ${reason}`);
    return { sent: false, reason };
  }
}

/**
 * Emit a typed item event to Novu. Never throws: notification delivery
 * must not fail the operation that produced the item, so failures are
 * logged and reported in the result instead.
 */
export async function emitItemEvent(
  eventType: ItemEventType,
  item: Item,
  actor?: string,
  trigger: TriggerFn = defaultTrigger,
): Promise<EmitResult> {
  const payload: ItemEventPayload = {
    itemId: String(item.id),
    itemType: item.type,
    domain: item.domain,
    status: item.status,
    assignee: item.assignee,
    actor: actor ?? null,
    createdAt: item.created_at instanceof Date
      ? item.created_at.toISOString()
      : String(item.created_at),
  };
  return emitEvent(eventType, payload, `item ${item.id}`, trigger);
}

/**
 * Emit a campaign monitoring alert to Novu (SEA-92). Same never-throw
 * posture as emitItemEvent; the monitor decides WHETHER to alert (dedupe,
 * thresholds), this decides only HOW.
 */
export async function emitCampaignAlert(
  payload: CampaignAlertPayload,
  trigger: TriggerFn = defaultTrigger,
): Promise<EmitResult> {
  const where =
    payload.scope === "campaign"
      ? `campaign ${payload.campaignKey ?? payload.campaignId ?? "?"}`
      : "rolling window";
  return emitEvent(
    "campaign_alert",
    payload,
    `${payload.alertType} (${where})`,
    trigger,
  );
}
