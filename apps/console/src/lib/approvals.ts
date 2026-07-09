import { cache } from "react";
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

/**
 * Decision audit record, written into the item payload under `decision`
 * (GH-22): what was decided, who decided it (Clerk user id + display
 * name), when, and whether the draft was edited before approval.
 */
export interface DecisionRecord {
  action: Decision;
  by: { id: string; name: string };
  at: string;
  edited: boolean;
}

/** Edited draft to persist alongside an approval (Save & approve). */
export interface DraftEdits {
  subject: string;
  body: string;
}

/**
 * Items awaiting a human decision, newest first. Wrapped in React cache()
 * so the nav shell (pending pill) and the approvals page share one query
 * per request instead of hitting Postgres twice.
 */
export const pendingApprovals = cache(
  async (): Promise<Item[]> => listItems({ status: "pending_approval" }),
);

/**
 * The most recently resolved email_reply items, newest decision first,
 * for the "Recently decided" section. Ordered by resolved_at (the moment
 * the decision landed), not created_at.
 */
export async function recentlyDecided(limit = 10): Promise<Item[]> {
  const { rows } = await getPool().query<Item>(
    `SELECT * FROM items
     WHERE status = 'resolved' AND type = 'email_reply'
     ORDER BY resolved_at DESC NULLS LAST, id DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Record a decision on a pending item and resolve it, atomically.
 *
 * The decision audit (who, what, when, edited) is written into the item
 * payload so the audit trail lives on the items backbone. When the draft
 * was edited (Save & approve), the edited subject/body replace the draft
 * fields and the original draft is preserved under `original_draft` -- in
 * the SAME statement. Recording the decision and the terminal status flip
 * happen in ONE guarded UPDATE matching only status = 'pending_approval':
 * concurrent decisions (a double-click, or approve racing reject) cannot
 * both pass the guard, so exactly one decision wins and the loser fails
 * loudly instead of overwriting the audit trail.
 *
 * When Job B lands, the decision event will be emitted from here as well;
 * for now the state change is the whole effect (nothing auto-sends in v1).
 */
export async function decideItem(
  id: string,
  decision: Decision,
  decidedBy: { id: string; name: string },
  edits?: DraftEdits,
): Promise<Item> {
  const record: DecisionRecord = {
    action: decision,
    by: decidedBy,
    at: new Date().toISOString(),
    edited: edits !== undefined,
  };

  const { rows } = await getPool().query<Item>(
    edits === undefined
      ? `UPDATE items
         SET payload = payload || jsonb_build_object('decision', $2::jsonb),
             status = 'resolved',
             resolved_at = now()
         WHERE id = $1 AND status = 'pending_approval'
         RETURNING *`
      : `UPDATE items
         SET payload = payload || jsonb_build_object(
               'decision', $2::jsonb,
               'original_draft', jsonb_build_object(
                 'draft_subject', payload->'draft_subject',
                 'draft_body', payload->'draft_body'
               ),
               'draft_subject', $3::text,
               'draft_body', $4::text
             ),
             status = 'resolved',
             resolved_at = now()
         WHERE id = $1 AND status = 'pending_approval'
         RETURNING *`,
    edits === undefined
      ? [id, JSON.stringify(record)]
      : [id, JSON.stringify(record), edits.subject, edits.body],
  );
  const item = rows[0];
  if (!item) {
    throw new Error(`decideItem: no pending_approval item with id ${id}`);
  }
  return item;
}
