import "./env";
import { getPool, listItems, type Item } from "@ai-manager/core";

/**
 * Approval inbox data layer (ARCHITECTURE.md "Approvals: a durable state
 * machine, not a long wait").
 *
 * v1 locked decision: nothing auto-sends. Approving an item only records the
 * decision and flips the item's status; the acting side (Job B, which emits
 * the event and performs the outbound action via an idempotent tool) is a
 * later ticket. Rejection likewise just records and closes.
 */

export type Decision = "approved" | "rejected";

/** Items awaiting a human decision, newest first. */
export async function pendingApprovals(): Promise<Item[]> {
  return listItems({ status: "pending_approval" });
}

/**
 * Record a decision on a pending item and resolve it, atomically.
 *
 * The decision (who, what, when) is written into the item payload so the
 * audit trail lives on the items backbone. Recording the decision and the
 * terminal status flip happen in ONE guarded UPDATE matching only
 * status = 'pending_approval': concurrent decisions (a double-click, or
 * approve racing reject) cannot both pass the guard, so exactly one
 * decision wins and the loser fails loudly instead of overwriting the
 * audit trail.
 *
 * When Job B lands, the decision event will be emitted from here as well;
 * for now the state change is the whole effect (nothing auto-sends in v1).
 */
export async function decideItem(
  id: string,
  decision: Decision,
  decidedBy: string,
): Promise<Item> {
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = payload || jsonb_build_object(
           'decision', $2::text,
           'decided_by', $3::text,
           'decided_at', now()
         ),
         status = 'resolved',
         resolved_at = now()
     WHERE id = $1 AND status = 'pending_approval'
     RETURNING *`,
    [id, decision, decidedBy],
  );
  const item = rows[0];
  if (!item) {
    throw new Error(`decideItem: no pending_approval item with id ${id}`);
  }
  return item;
}
