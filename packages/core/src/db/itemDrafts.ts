import { getPool } from "./client.js";
import type { Item } from "./items.js";

/**
 * Draft-revision helpers for email_reply items (GH-36, item.revise job).
 *
 * Kept separate from db/items.ts on purpose: these are the only writers of
 * the draft-revision slice of the item payload (draft_subject, draft_body,
 * draft_revisions, last_answer), and every write is guarded on
 * status = 'pending_approval' so an item decided mid-revision is never
 * mutated. A guard miss throws DraftNotRevisableError; the job surfaces
 * that as a job failure with a clear log line.
 */

/** How many prior drafts payload.draft_revisions retains (most recent kept). */
export const DRAFT_REVISION_LIMIT = 5;

/** Thrown when the guarded write matches no pending email_reply item. */
export class DraftNotRevisableError extends Error {
  constructor(id: string, action: string) {
    super(
      `${action}: no pending_approval email_reply item with id ${id}; ` +
        `it may have been approved, rejected, or resolved while the revision ran`,
    );
    this.name = "DraftNotRevisableError";
  }
}

/**
 * Load an email_reply item that is still pending approval. Throws when the
 * item does not exist, is not an email_reply, or is not pending_approval,
 * so the revise job fails loudly instead of operating on decided state.
 */
export async function getPendingEmailReplyItem(id: string): Promise<Item> {
  const { rows } = await getPool().query<Item>(
    `SELECT * FROM items WHERE id = $1`,
    [id],
  );
  const item = rows[0];
  if (!item) throw new Error(`item.revise: no item with id ${id}`);
  if (item.type !== "email_reply") {
    throw new Error(
      `item.revise: item ${id} has type "${item.type}", expected "email_reply"`,
    );
  }
  if (item.status !== "pending_approval") {
    throw new Error(
      `item.revise: item ${id} has status "${item.status}", expected "pending_approval"`,
    );
  }
  return item;
}

/**
 * Replace the draft on a pending email_reply item. Atomically, in one
 * guarded UPDATE:
 * - pushes the prior { draft_subject, draft_body, revised_at } onto
 *   payload.draft_revisions (kept to the most recent DRAFT_REVISION_LIMIT);
 * - sets the new draft_subject / draft_body;
 * - clears payload.last_answer (a stale answer must not outlive the draft
 *   it described) and payload.sources (KB lookups describe the revision
 *   that made them; a KB-less revision must not inherit them, GH-57);
 * - replaces payload.draft_rationale with the revision's rationale when
 *   one is given, and drops it otherwise (GH-38: a "Why this draft" note
 *   describing the previous draft must not survive onto the new one);
 * - replaces payload.generated_by with the revision's deploy-version stamp
 *   when one is given (GH-122: the stamp describes the current draft);
 * - replaces payload.run_trace with the revision's run trace when one is
 *   given, and drops it otherwise (GH-122: a trace describes the run that
 *   produced the CURRENT draft; it must never outlive that draft).
 *
 * The WHERE clause re-checks status = 'pending_approval' at write time, so
 * an item decided between the job's read and this write is left untouched
 * and DraftNotRevisableError is thrown instead.
 */
export async function reviseEmailReplyDraft(
  id: string,
  draft: {
    subject: string;
    body: string;
    rationale?: string;
    /** KB lookups behind this revision (GH-57); stored at payload.sources. */
    sources?: unknown[];
    /**
     * Deploy-version stamp for this revision (GH-122): which worker build
     * produced the new draft, stored at payload.generated_by so the stamp
     * always describes the CURRENT draft text.
     */
    generatedBy?: { commit: string; at: string };
    /**
     * Run trace for this revision (GH-122): the revise run's tool-call
     * trace, stored at payload.run_trace. Best-effort: when capture
     * failed the prior trace is simply dropped, never left stale.
     */
    runTrace?: unknown;
  },
): Promise<Item> {
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = (payload - 'last_answer' - 'draft_rationale' - 'sources' - 'run_trace')
     || CASE WHEN $5::text IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('draft_rationale', to_jsonb($5::text)) END
     || CASE WHEN $6::jsonb IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('sources', $6::jsonb) END
     || CASE WHEN $7::jsonb IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('generated_by', $7::jsonb) END
     || CASE WHEN $8::jsonb IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('run_trace', $8::jsonb) END
     || jsonb_build_object(
       'draft_subject', to_jsonb($2::text),
       'draft_body', to_jsonb($3::text),
       'draft_revisions',
       (
         SELECT coalesce(jsonb_agg(entry ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(
           coalesce(payload->'draft_revisions', '[]'::jsonb) ||
           jsonb_build_array(jsonb_build_object(
             'draft_subject', payload->'draft_subject',
             'draft_body', payload->'draft_body',
             'revised_at', to_jsonb(now())
           ))
         ) WITH ORDINALITY AS t(entry, ord)
         WHERE ord > greatest(
           0,
           jsonb_array_length(coalesce(payload->'draft_revisions', '[]'::jsonb))
             + 1 - $4::int
         )
       )
     )
     WHERE id = $1 AND type = 'email_reply' AND status = 'pending_approval'
     RETURNING *`,
    [
      id,
      draft.subject,
      draft.body,
      DRAFT_REVISION_LIMIT,
      draft.rationale ?? null,
      draft.sources && draft.sources.length > 0
        ? JSON.stringify(draft.sources)
        : null,
      draft.generatedBy ? JSON.stringify(draft.generatedBy) : null,
      draft.runTrace ? JSON.stringify(draft.runTrace) : null,
    ],
  );
  const item = rows[0];
  if (!item) throw new DraftNotRevisableError(id, "reviseEmailReplyDraft");
  return item;
}

/**
 * Record an answer to an operator question about a pending draft. Writes
 * payload.last_answer = { question, answer, at } and touches nothing else;
 * the draft fields are deliberately left alone. Same pending_approval
 * guard as reviseEmailReplyDraft.
 */
export async function recordDraftAnswer(
  id: string,
  qa: { question: string; answer: string },
): Promise<Item> {
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET payload = payload || jsonb_build_object(
       'last_answer', jsonb_build_object(
         'question', to_jsonb($2::text),
         'answer', to_jsonb($3::text),
         'at', to_jsonb(now())
       )
     )
     WHERE id = $1 AND type = 'email_reply' AND status = 'pending_approval'
     RETURNING *`,
    [id, qa.question, qa.answer],
  );
  const item = rows[0];
  if (!item) throw new DraftNotRevisableError(id, "recordDraftAnswer");
  return item;
}

/**
 * Attach a run's token usage to an item (GH-62): payload.usage holds the
 * LATEST run (easy display), payload.usage_runs accumulates every run
 * (draft + each revision) so per-item cost is never lost. Bounded in
 * practice: one draft plus DRAFT_REVISION_LIMIT-capped revisions.
 * Deliberately NOT guarded on status: usage is post-run metadata about a
 * run that already happened, and the run's item may legitimately have
 * been decided in the meantime. Merging only usage keys cannot disturb
 * draft state. Missing ids are a no-op (the caller logs).
 */
export async function recordItemUsage(
  id: string,
  usage: Record<string, number>,
): Promise<void> {
  await getPool().query(
    `UPDATE items
     SET payload = payload || jsonb_build_object(
       'usage', $2::jsonb,
       'usage_runs',
       coalesce(payload->'usage_runs', '[]'::jsonb)
         || jsonb_build_array($2::jsonb || jsonb_build_object('at', to_jsonb(now())))
     )
     WHERE id = $1`,
    [id, JSON.stringify(usage)],
  );
}
