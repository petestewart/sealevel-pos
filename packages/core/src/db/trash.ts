import { getPool } from "./client.js";
import { ReopenConflictError, type Item } from "./items.js";

/**
 * Trash + spam decisions (GH-115 follow-on, salvaged and modernized from
 * the GH-96 data layer): discard an item as junk without sending any
 * reply. Trashing is a DECISION in the same family as approve / reject /
 * no-reply: the item resolves with a decision audit record
 * (payload.decision = {action:"trashed"|"spam", by, at, edited, reason?},
 * the exact shape decideItem and the no-reply preflight write), and
 * additionally gains payload.trashed = {at, by, reason, prev_status} --
 * the marker every Trash-view query keys on (payload ? 'trashed') and the
 * console's isTrashed() mirrors. Non-destructive throughout: the row, its
 * audit, and its payload stay in the database, same discipline as the
 * archive mechanism (payload.archived, GH-55).
 *
 * prev_status is captured in SQL, atomically with the guard, so restore
 * can return the item exactly where it was.
 */

/** What kind of junk this was: confirmed spam, or merely unwanted mail. */
export type TrashReason = "spam" | "unwanted";

/** The decision actions a trash/spam discard records. */
export type TrashDecisionAction = "trashed" | "spam";

export interface TrashRecord {
  at: string;
  by: { id: string; name: string };
  reason: TrashReason;
  prev_status: string;
  /** Set once the source Gmail message has been moved to Gmail's trash. */
  gmail_trashed?: boolean;
}

/** SQL guard: the item has not been trashed. Mirror in console isTrashed(). */
export const NOT_TRASHED_SQL = `NOT (payload ? 'trashed')`;

/**
 * Trash an active item (pending_approval, open, or unassigned) as junk,
 * recording a decision audit. Atomic guarded UPDATE: only an unresolved,
 * not-yet-trashed, not-archived item qualifies, so a double click or a
 * concurrent decision loses cleanly (returns null) instead of overwriting
 * state. Both records -- the decision (action derives from the kind:
 * "spam" -> "spam", "unwanted" -> "trashed") and the trashed marker with
 * prev_status read from the row's own status column -- are built in ONE
 * statement so the audit can never disagree with the state flip.
 *
 * Returns the updated item (whose payload.email_meta carries the gmailId,
 * so the caller can enqueue the Gmail trash/spam + mark-read job), or
 * null when the guard matched nothing.
 */
export async function trashItem(
  id: string,
  by: { id: string; name: string },
  reason: TrashReason,
  decisionReason?: string,
): Promise<Item | null> {
  const action: TrashDecisionAction = reason === "spam" ? "spam" : "trashed";
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET status = 'resolved',
         resolved_at = now(),
         payload = payload || jsonb_build_object(
           'decision', jsonb_build_object(
             'action', $5::text,
             'by', jsonb_build_object('id', $2::text, 'name', $3::text),
             'at', to_jsonb(now()),
             'edited', false
           ) || CASE WHEN $6::text IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('reason', $6::text) END,
           'trashed', jsonb_build_object(
             'at', to_jsonb(now()),
             'by', jsonb_build_object('id', $2::text, 'name', $3::text),
             'reason', $4::text,
             'prev_status', status
           )
         )
     WHERE id = $1
       AND status IN ('pending_approval', 'open', 'unassigned')
       AND ${NOT_TRASHED_SQL}
       AND NOT (payload ? 'archived')
     RETURNING *`,
    [id, by.id, by.name, reason, action, decisionReason ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Mark that the source Gmail message for a trashed item has been moved to
 * Gmail's trash (set by the worker after the Gmail call). Best-effort
 * metadata; unguarded on status.
 */
export async function markGmailTrashed(id: string): Promise<void> {
  await getPool().query(
    `UPDATE items
     SET payload = jsonb_set(payload, '{trashed,gmail_trashed}', 'true'::jsonb)
     WHERE id = $1 AND payload ? 'trashed'`,
    [id],
  );
}

function isDedupeViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return code === "23505" && constraint === "items_dedupe_key_unresolved_idx";
}

/**
 * Restore a trashed item to the status it had before trashing
 * (payload.trashed.prev_status), removing the trashed marker and moving
 * the trash/spam decision onto payload.decision_history -- the same
 * preserve-the-audit shape reopenItem uses. Guarded on being trashed so a
 * double restore or a race loses cleanly (returns null). prev_status is
 * validated against the allowed set; anything unexpected falls back to
 * 'pending_approval' so a restore can never write an invalid status.
 *
 * Throws ReopenConflictError when the partial unique dedupe index rejects
 * the transition (an unresolved twin with the same type + dedupe_key
 * exists, e.g. the email was re-ingested after the trash); callers
 * surface that as a user-facing message.
 */
export async function restoreTrashedItem(id: string): Promise<Item | null> {
  let rows: Item[];
  try {
    ({ rows } = await getPool().query<Item>(
      `UPDATE items
       SET status = CASE
             WHEN payload->'trashed'->>'prev_status'
                  IN ('pending_approval', 'open', 'unassigned')
             THEN payload->'trashed'->>'prev_status'
             ELSE 'pending_approval'
           END::text,
           resolved_at = NULL,
           payload = (payload - 'trashed' - 'decision') || jsonb_build_object(
             'decision_history',
             coalesce(payload->'decision_history', '[]'::jsonb) ||
               CASE WHEN payload ? 'decision'
                    THEN jsonb_build_array(payload->'decision')
                    ELSE '[]'::jsonb END
           )
       WHERE id = $1 AND payload ? 'trashed'
       RETURNING *`,
      [id],
    ));
  } catch (err) {
    if (isDedupeViolation(err)) throw new ReopenConflictError(id);
    throw err;
  }
  return rows[0] ?? null;
}

/**
 * Trashed items, newest decision first, one page at a time. Powers the
 * Trash view where an operator can review and restore. Ordered like the
 * decision inboxes (resolved_at DESC): trashing sets resolved_at, so the
 * most recently trashed item leads.
 */
export async function listTrashedItems(
  page = 1,
  pageSize = 25,
): Promise<Item[]> {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`listTrashedItems: page must be a positive integer`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`listTrashedItems: pageSize must be a positive integer`);
  }
  const { rows } = await getPool().query<Item>(
    `SELECT * FROM items
     WHERE payload ? 'trashed'
     ORDER BY resolved_at DESC NULLS LAST, id DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize],
  );
  return rows;
}

/** Count of trashed items (the Trash sidebar pill). */
export async function countTrashedItems(): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM items WHERE payload ? 'trashed'`,
  );
  return Number(rows[0]?.count ?? 0);
}
