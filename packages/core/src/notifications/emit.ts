import { Novu } from "@novu/api";

import type { Item } from "../db/items.js";

/**
 * Notifications (ARCHITECTURE.md "Notifications — adopt Novu").
 *
 * On item creation/state change we emit a typed event to Novu; Novu routes
 * it per user, per event type, per channel (digest, quiet hours) via its
 * workflow + subscriber preference config. The differential routing intent
 * (Pete: SMS instant, Alison: email digest) is recorded locally in the
 * notification_prefs table (migration 0003) and enforced dashboard-side in
 * Novu; see docs/novu.md.
 *
 * The whole module is a no-op when NOVU_SECRET_KEY is unset so local dev
 * and tests never require a Novu account.
 */

/** Typed item event names. One wired in v1; extend as events are added. */
export type ItemEventType = "item.pending_approval";

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

export interface EmitResult {
  /** True when a Novu trigger was actually sent. */
  sent: boolean;
  /** Why nothing was sent (no-op path) or the send failed. */
  reason?: string;
}

/**
 * Novu workflow identifier per event type. Identity by default; if the
 * Novu dashboard rejects or rewrites the dotted identifier when creating
 * the workflow (it slugifies to kebab-case in some flows), create the
 * workflow with the kebab-case id and change this mapping only.
 */
export const WORKFLOW_IDS: Record<ItemEventType, string> = {
  "item.pending_approval": "item.pending_approval",
};

/** Signature of the low-level trigger call; injectable for tests. */
export type TriggerFn = (args: {
  workflowId: string;
  subscriberIds: string[];
  payload: ItemEventPayload;
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
  if (!process.env.NOVU_SECRET_KEY && trigger === defaultTrigger) {
    console.log(
      `[notifications] NOVU_SECRET_KEY unset; skipping ${eventType} for item ${item.id}`,
    );
    return { sent: false, reason: "NOVU_SECRET_KEY unset" };
  }

  const subscriberIds = configuredSubscriberIds();
  if (subscriberIds.length === 0) {
    return { sent: false, reason: "no subscribers configured" };
  }

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

  try {
    await trigger({ workflowId: WORKFLOW_IDS[eventType], subscriberIds, payload });
    return { sent: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[notifications] failed to emit ${eventType}: ${reason}`);
    return { sent: false, reason };
  }
}
