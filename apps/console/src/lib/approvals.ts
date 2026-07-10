import { cache } from "react";
import "./env";
import {
  countItemsByStatus,
  getPool,
  listItems,
  type Item,
  type ItemStatusCounts,
} from "@ai-manager/core";

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
 * Browsers submit textarea content with CRLF line endings; drafts are
 * stored with LF. Normalize before comparing or persisting so a
 * round-tripped, untouched draft stays byte-identical (GH-40).
 */
function normalizeEdits(edits: DraftEdits): DraftEdits {
  return {
    subject: edits.subject.replace(/\r\n/g, "\n"),
    body: edits.body.replace(/\r\n/g, "\n"),
  };
}

/** Payload draft fields as stored. */
function draftOf(item: Item): DraftEdits {
  const payload = item.payload as Record<string, unknown>;
  return {
    subject: String(payload["draft_subject"] ?? ""),
    body: String(payload["draft_body"] ?? ""),
  };
}

function sameDraft(a: DraftEdits, b: DraftEdits): boolean {
  return a.subject === b.subject && a.body === b.body;
}

async function pendingItemOrThrow(id: string, caller: string): Promise<Item> {
  const { rows } = await getPool().query<Item>(
    `SELECT * FROM items WHERE id = $1 AND status = 'pending_approval'`,
    [id],
  );
  const item = rows[0];
  if (!item) {
    throw new Error(`${caller}: no pending_approval item with id ${id}`);
  }
  return item;
}

/**
 * Items awaiting a human decision, newest first, one page at a time
 * (GH-27: no unbounded item query remains; page size defaults to
 * DEFAULT_PAGE_SIZE in @ai-manager/core). Wrapped in React cache() so the
 * nav shell (pending pill) and the approvals page share one query per
 * request instead of hitting Postgres twice.
 */
export const pendingApprovals = cache(
  async (page = 1): Promise<Item[]> =>
    listItems({ status: "pending_approval", page }),
);

/**
 * Per-status item counts in one GROUP BY query (GH-27). Shared by the nav
 * pending pill and the dashboard items widget via React cache(), and the
 * backing store for the future sidebar count pills (A1b).
 */
export const itemStatusCounts = cache(
  async (): Promise<ItemStatusCounts> => countItemsByStatus(),
);

/**
 * A resolved email_reply item counts as "rejected" only when its decision
 * says so; everything else resolved counts as approved. This is the SQL
 * form of the ONE canonical classifier `classifyDecision` (lib/itemView.ts)
 * -- the two are kept byte-for-byte equivalent so the sidebar counts, the
 * decision-inbox queries, inbox membership, row tone, and the decided
 * detail title can never disagree on an edge case (e.g. a partial
 * `{action:"rejected"}` with no by/at is rejected in BOTH). Any change to
 * the rule must be made in both places together.
 *
 *   bare string 'rejected'                -> first clause  -> rejected
 *   object with action='rejected'         -> second clause -> rejected
 *     (->> yields NULL for a bare string / missing key, so only an
 *      explicit action='rejected' matches; partials still match)
 *   everything else resolved              -> coalesce false -> approved
 */
const REJECTED_SQL = `(
  (jsonb_typeof(payload->'decision') = 'string' AND payload->>'decision' = 'rejected')
  OR payload->'decision'->>'action' = 'rejected'
)`;

export type DecisionAction = "approved" | "rejected";

/** Per-decision counts of resolved email replies. */
export interface DecisionCounts {
  approved: number;
  rejected: number;
}

/**
 * Count resolved email replies per decision in one GROUP BY query. Powers
 * the Approved / Rejected sidebar count pills (A1b), alongside
 * itemStatusCounts which powers the Pending pill. React cache() so the
 * sidebar and any inbox page share one query per request.
 *
 * FUTURE (not now): this scans all resolved email_reply rows and
 * classifies each via the jsonb decision expression. Once production
 * volume warrants it, a partial expression index on
 * (status='resolved' AND type='email_reply') keyed by the decision
 * classification would keep both this count and decidedItems() cheap. Do
 * not add it before real volume data exists -- premature indexing on an
 * empty table is guesswork.
 */
export const decisionCounts = cache(async (): Promise<DecisionCounts> => {
  const { rows } = await getPool().query<{ rejected: boolean; count: string }>(
    `SELECT coalesce(${REJECTED_SQL}, false) AS rejected, count(*)::text AS count
     FROM items
     WHERE status = 'resolved' AND type = 'email_reply'
     GROUP BY 1`,
  );
  const counts: DecisionCounts = { approved: 0, rejected: 0 };
  for (const row of rows) {
    counts[row.rejected ? "rejected" : "approved"] = Number(row.count);
  }
  return counts;
});

/**
 * Resolved email replies for one decision inbox (Approved or Rejected),
 * newest decision first, always paginated (GH-27: no unbounded item
 * query). A page beyond the end returns [].
 */
export async function decidedItems(
  action: DecisionAction,
  page = 1,
  pageSize = 25,
): Promise<Item[]> {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(
      `decidedItems: page must be a positive integer, got ${page}`,
    );
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(
      `decidedItems: pageSize must be a positive integer, got ${pageSize}`,
    );
  }
  const { rows } = await getPool().query<Item>(
    `SELECT * FROM items
     WHERE status = 'resolved' AND type = 'email_reply'
       AND ${action === "rejected" ? "" : "NOT "}coalesce(${REJECTED_SQL}, false)
     ORDER BY resolved_at DESC NULLS LAST, id DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize],
  );
  return rows;
}

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
  if (edits !== undefined) {
    // No-op save hygiene (GH-40): a Save & approve whose content matches
    // the stored draft byte-for-byte (after CRLF normalization) must not
    // mark the draft edited or capture original_draft.
    edits = normalizeEdits(edits);
    const current = await pendingItemOrThrow(id, "decideItem");
    if (sameDraft(edits, draftOf(current))) edits = undefined;
  }

  const record: DecisionRecord = {
    action: decision,
    by: decidedBy,
    at: new Date().toISOString(),
    edited: edits !== undefined,
  };

  const { rows } = await getPool().query<Item>(
    edits === undefined
      ? // If the draft was edited earlier (Save edits), the decision audit
        // must still say edited: true even on a plain Approve, so the
        // edited flag is read back from payload.draft_edited in SQL.
        `UPDATE items
         SET payload = payload || jsonb_build_object(
               'decision',
               jsonb_set(
                 $2::jsonb, '{edited}',
                 to_jsonb(coalesce((payload->>'draft_edited')::boolean, false))
               )
             ),
             status = 'resolved',
             resolved_at = now()
         WHERE id = $1 AND status = 'pending_approval'
         RETURNING *`
      : // original_draft is only captured on the FIRST edit; a Save edits
        // followed by Save & approve must not overwrite the true original.
        `UPDATE items
         SET payload = payload
               || CASE WHEN payload ? 'original_draft' THEN '{}'::jsonb
                  ELSE jsonb_build_object(
                    'original_draft', jsonb_build_object(
                      'draft_subject', payload->'draft_subject',
                      'draft_body', payload->'draft_body'
                    )
                  ) END
               || jsonb_build_object(
                    'decision', $2::jsonb,
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

/**
 * Save draft edits WITHOUT deciding (GH-25): persist the edited
 * subject/body into the payload, capture the original draft under
 * `original_draft` on the first edit only, and mark the draft edited for
 * later audit (payload.draft_edited). No decision is recorded and the
 * status is untouched; the same guarded WHERE (status =
 * 'pending_approval') keeps this from racing a concurrent decision --
 * once someone approves or rejects, a late Save edits fails loudly
 * instead of mutating a resolved item's audit trail.
 */
export async function saveDraftEdits(
  id: string,
  edits: DraftEdits,
): Promise<Item> {
  // No-op save hygiene (GH-40): skip the write entirely when the
  // CRLF-normalized content is byte-identical to the stored draft, so an
  // untouched Save edits never sets draft_edited, captures
  // original_draft, or rewrites line endings.
  edits = normalizeEdits(edits);
  const current = await pendingItemOrThrow(id, "saveDraftEdits");
  if (sameDraft(edits, draftOf(current))) return current;

  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = payload
           || CASE WHEN payload ? 'original_draft' THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'original_draft', jsonb_build_object(
                  'draft_subject', payload->'draft_subject',
                  'draft_body', payload->'draft_body'
                )
              ) END
           || jsonb_build_object(
                'draft_subject', $2::text,
                'draft_body', $3::text,
                'draft_edited', true
              )
     WHERE id = $1 AND status = 'pending_approval'
     RETURNING *`,
    [id, edits.subject, edits.body],
  );
  const item = rows[0];
  if (!item) {
    throw new Error(`saveDraftEdits: no pending_approval item with id ${id}`);
  }
  return item;
}
