import { getPool } from "./client.js";

/**
 * Helpers for the items backbone (ARCHITECTURE.md "Data layer" and
 * "Assignment & routing"). Lifecycle: open -> resolved. Two additional
 * statuses cover the core flows: 'unassigned' (needs a human owner, e.g.
 * inbound email before triage) and 'pending_approval' (a draft awaiting
 * approval in the console).
 */

export type ItemStatus = "open" | "unassigned" | "pending_approval" | "resolved";

export interface Item {
  id: string;
  type: string;
  domain: string | null;
  status: ItemStatus;
  audience: string | null;
  assignee: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  resolved_at: Date | null;
}

export interface CreateItemInput {
  type: string;
  domain?: string;
  status?: Exclude<ItemStatus, "resolved">;
  audience?: string;
  assignee?: string;
  payload?: Record<string, unknown>;
  /**
   * Natural key for retry-safe creation (ARCHITECTURE.md "retry-safe
   * outbound / dedupe on a natural key"), e.g. an inbound email's
   * messageId. When set, it is stored in payload.dedupe_key and the
   * insert is skipped if an unresolved item of the same type already
   * carries the key; the existing row is returned instead. This makes
   * job retries after a mid-run failure no-ops instead of duplicates.
   */
  dedupeKey?: string;
}

export interface CreateItemResult {
  item: Item;
  /** False when a dedupe hit returned an existing row instead of inserting. */
  created: boolean;
}

export async function createItem(
  input: CreateItemInput,
): Promise<CreateItemResult> {
  const columns = [
    input.type,
    input.domain ?? null,
    input.status ?? "open",
    input.audience ?? null,
    input.assignee ?? null,
  ];

  if (input.dedupeKey === undefined) {
    const { rows } = await getPool().query<Item>(
      `INSERT INTO items (type, domain, status, audience, assignee, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [...columns, JSON.stringify(input.payload ?? {})],
    );
    return { item: rows[0]!, created: true };
  }

  // Race-safe dedupe: the partial unique index
  // items_dedupe_key_unresolved_idx (migration 0004) enforces at most one
  // unresolved item per (type, dedupe_key) DB-wide; ON CONFLICT DO NOTHING
  // makes concurrent inserts lose quietly, then we return the survivor.
  const payload = { ...(input.payload ?? {}), dedupe_key: input.dedupeKey };
  const pool = getPool();
  const { rows: inserted } = await pool.query<Item>(
    `INSERT INTO items (type, domain, status, audience, assignee, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (type, (payload->>'dedupe_key'))
       WHERE status <> 'resolved' AND payload->>'dedupe_key' IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [...columns, JSON.stringify(payload)],
  );
  if (inserted[0]) return { item: inserted[0], created: true };

  const { rows: existing } = await pool.query<Item>(
    `SELECT * FROM items
     WHERE type = $1 AND status <> 'resolved' AND payload->>'dedupe_key' = $2
     LIMIT 1`,
    [input.type, input.dedupeKey],
  );
  const item = existing[0];
  if (!item) {
    // The conflicting row was resolved/removed between the two statements;
    // extremely unlikely, but fail loudly rather than return nothing.
    throw new Error(
      `createItem: dedupe conflict for type=${input.type} key=${input.dedupeKey} but no surviving row found`,
    );
  }
  return { item, created: false };
}

/**
 * Create an email_reply item that is ALREADY resolved as "no reply needed"
 * (GH-115). The classifier decided before any draft existed, so the item is
 * born in its terminal state: it never enters the pending approval queue,
 * but stays a first-class, auditable row (the "AI suggests, human confirms"
 * posture files it reviewably instead of deleting it). The caller supplies
 * the full payload including the decision record
 * ({action:"no_reply_needed", by, at, reason, tier}).
 *
 * Dedupe: the partial unique index (migration 0004) only guards UNRESOLVED
 * items, so a resolved insert cannot lean on ON CONFLICT. Instead any
 * existing email_reply carrying the same dedupe_key (any status) short-
 * circuits the insert and is returned. The remaining race window (two
 * concurrent inserts) is already closed upstream by the deterministic
 * BullMQ jobId per source message (jobs/dispatch.ts).
 */
export async function createNoReplyItem(input: {
  payload: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<CreateItemResult> {
  const pool = getPool();
  if (input.dedupeKey !== undefined) {
    const { rows: existing } = await pool.query<Item>(
      `SELECT * FROM items
       WHERE type = 'email_reply' AND payload->>'dedupe_key' = $1
       LIMIT 1`,
      [input.dedupeKey],
    );
    if (existing[0]) return { item: existing[0], created: false };
  }
  const payload =
    input.dedupeKey === undefined
      ? input.payload
      : { ...input.payload, dedupe_key: input.dedupeKey };
  const { rows } = await pool.query<Item>(
    `INSERT INTO items (type, domain, status, payload, resolved_at)
     VALUES ('email_reply', 'email', 'resolved', $1, now())
     RETURNING *`,
    [JSON.stringify(payload)],
  );
  return { item: rows[0]!, created: true };
}

/**
 * Assign (or reassign) an unresolved item; pass null to unassign. Status
 * follows the assignment: unassigning moves the item to 'unassigned' (so
 * it shows in the unassigned queue), and assigning a currently-unassigned
 * item moves it to 'open'. Resolved stays terminal.
 */
export async function assignItem(
  id: string,
  assignee: string | null,
): Promise<Item> {
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET assignee = $2::text,
         status = CASE
           WHEN $2::text IS NULL THEN 'unassigned'
           WHEN status = 'unassigned' THEN 'open'
           ELSE status
         END
     WHERE id = $1 AND status <> 'resolved'
     RETURNING *`,
    [id, assignee],
  );
  const item = rows[0];
  if (!item) throw new Error(`assignItem: no unresolved item with id ${id}`);
  return item;
}

/** A user reference stored in assignment audit entries. */
export interface AssigneeRef {
  id: string;
  name: string;
}

/**
 * Assign, re-assign, or unassign an item with an audit trail (GH-79).
 *
 * Differences from assignItem (which serves the open/unassigned worklist
 * lifecycle): the status transition is confined to that lifecycle -- a
 * pending_approval item KEEPS its status when assigned or unassigned
 * (assignment on an approval item is routing metadata, not a state
 * change; flipping it to 'unassigned' would silently drop it from the
 * pending inbox, the GH-4 class of bug). Resolved and archived items are
 * not assignable.
 *
 * Concurrency: the UPDATE is guarded on the caller's last-seen assignee
 * (IS NOT DISTINCT FROM, so null == null), the same stale-action pattern
 * the decide flow uses. A lost race, a resolved/archived item, or a
 * missing id all return null; callers surface an inline stale message.
 *
 * Audit: payload.assignee_name mirrors the display name for rendering;
 * payload.assignment_history appends {at, by, from, to} with user refs
 * ({id, name}) or null for unassigned ends. History is unbounded by
 * design: assignments are rare, and the trail is the point.
 */
export async function assignItemAudited(
  id: string,
  to: AssigneeRef | null,
  by: AssigneeRef,
  expectedAssignee: string | null,
): Promise<Item | null> {
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET assignee = $2::text,
         status = CASE
           WHEN status IN ('open', 'unassigned') THEN
             CASE WHEN $2::text IS NULL THEN 'unassigned' ELSE 'open' END
           ELSE status
         END,
         payload = (payload - 'assignee_name')
           || CASE
                WHEN $2::text IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('assignee_name', $3::text)
              END
           || jsonb_build_object(
                'assignment_history',
                coalesce(payload->'assignment_history', '[]'::jsonb)
                  || jsonb_build_array(jsonb_build_object(
                       'at', to_jsonb(now()),
                       'by', jsonb_build_object('id', $4::text, 'name', $5::text),
                       'from', CASE
                         WHEN assignee IS NULL THEN 'null'::jsonb
                         ELSE jsonb_build_object(
                           'id', assignee,
                           'name', coalesce(payload->>'assignee_name', assignee)
                         )
                       END,
                       'to', CASE
                         WHEN $2::text IS NULL THEN 'null'::jsonb
                         ELSE jsonb_build_object('id', $2::text, 'name', $3::text)
                       END
                     ))
              )
     WHERE id = $1
       AND status <> 'resolved'
       AND NOT (payload ? 'archived')
       AND assignee IS NOT DISTINCT FROM $6::text
     RETURNING *`,
    [id, to?.id ?? null, to?.name ?? null, by.id, by.name, expectedAssignee],
  );
  return rows[0] ?? null;
}

/**
 * Thrown by reopenItem when the partial unique dedupe index
 * (items_dedupe_key_unresolved_idx, migration 0004) blocks the reopen:
 * another unresolved item of the same type already carries the same
 * dedupe_key, so un-resolving this one would create a duplicate.
 */
export class ReopenConflictError extends Error {
  constructor(id: string) {
    super(
      `reopenItem: cannot reopen item ${id}; an unresolved item with the same type and dedupe key already exists`,
    );
    this.name = "ReopenConflictError";
  }
}

function isDedupeViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  // Only the dedupe index counts; any other unique_violation is a real bug
  // and must propagate rather than masquerade as a reopen conflict.
  return code === "23505" && constraint === "items_dedupe_key_unresolved_idx";
}

/**
 * Reopen a resolved item back into the approval queue: status returns to
 * 'pending_approval', resolved_at is cleared, and the prior decision (if
 * any) is preserved by appending it to payload.decision_history before
 * removing payload.decision. Guarded UPDATE matching only status =
 * 'resolved' and not archived (payload.archived, GH-55), so reopening a
 * non-resolved, archived, or nonexistent item throws instead of silently
 * rewriting state or resurrecting a removed item from a stale form.
 *
 * Throws ReopenConflictError when the partial unique dedupe index rejects
 * the transition (an unresolved twin with the same type + dedupe_key
 * exists); callers should surface that as a user-facing message.
 */
export async function reopenItem(id: string): Promise<Item> {
  let rows: Item[];
  try {
    ({ rows } = await getPool().query<Item>(
      `UPDATE items
       SET status = 'pending_approval',
           resolved_at = NULL,
           payload = (payload - 'decision') || jsonb_build_object(
             'decision_history',
             coalesce(payload->'decision_history', '[]'::jsonb) ||
               CASE WHEN payload ? 'decision'
                    THEN jsonb_build_array(payload->'decision')
                    ELSE '[]'::jsonb END
           )
       WHERE id = $1 AND status = 'resolved' AND NOT (payload ? 'archived')
       RETURNING *`,
      [id],
    ));
  } catch (err) {
    if (isDedupeViolation(err)) throw new ReopenConflictError(id);
    throw err;
  }
  const item = rows[0];
  if (!item) throw new Error(`reopenItem: no resolved item with id ${id}`);
  return item;
}

/** Terminal transition: any unresolved status -> resolved. Idempotent-safe: resolving twice throws. */
export async function resolveItem(id: string): Promise<Item> {
  const { rows } = await getPool().query<Item>(
    `UPDATE items
     SET status = 'resolved', resolved_at = now()
     WHERE id = $1 AND status <> 'resolved'
     RETURNING *`,
    [id],
  );
  const item = rows[0];
  if (!item) throw new Error(`resolveItem: no unresolved item with id ${id}`);
  return item;
}

/** Default rows per page for listItems (QA-ROADMAP Wave A / A5). */
export const DEFAULT_PAGE_SIZE = 25;

export interface ListItemsFilter {
  status?: ItemStatus;
  type?: string;
  /** Filter by assignee; pass null for the unassigned queue (assignee IS NULL). */
  assignee?: string | null;
  /** 1-based page number; defaults to 1. */
  page?: number;
  /** Rows per page; defaults to DEFAULT_PAGE_SIZE (25). */
  pageSize?: number;
}

/**
 * List items newest first (created_at DESC, id DESC as tiebreaker),
 * ALWAYS paginated: every call is bounded by pageSize (default 25), so no
 * unbounded item query exists anywhere (GH-27). A page beyond the end
 * returns []. For totals, use countItemsByStatus rather than fetching
 * rows.
 */
export async function listItems(filter: ListItemsFilter = {}): Promise<Item[]> {
  const page = filter.page ?? 1;
  const pageSize = filter.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`listItems: page must be a positive integer, got ${page}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(
      `listItems: pageSize must be a positive integer, got ${pageSize}`,
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.type !== undefined) {
    params.push(filter.type);
    where.push(`type = $${params.length}`);
  }
  if (filter.assignee !== undefined) {
    if (filter.assignee === null) {
      where.push("assignee IS NULL");
    } else {
      params.push(filter.assignee);
      where.push(`assignee = $${params.length}`);
    }
  }
  params.push(pageSize, (page - 1) * pageSize);
  const sql = `SELECT * FROM items${
    where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
  } ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await getPool().query<Item>(sql, params);
  return rows;
}

/**
 * Fetch a single item by id, or null if none exists. Used by the inbox
 * detail pane (A1c/GH-29) to resolve a deep-linked ?item=<id> that lies
 * beyond the loaded page of list rows, without loading every page. The
 * caller is responsible for validating the item belongs to the inbox it
 * was requested from.
 */
export async function getItemById(id: string): Promise<Item | null> {
  const { rows } = await getPool().query<Item>(
    `SELECT * FROM items WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Per-status item counts; statuses with no rows are present as 0. */
export type ItemStatusCounts = Record<ItemStatus, number>;

const ALL_STATUSES: readonly ItemStatus[] = [
  "open",
  "unassigned",
  "pending_approval",
  "resolved",
];

/**
 * Count items per status in ONE query (GROUP BY status). Powers the nav
 * pending pill, sidebar count pills, and the dashboard items widget
 * without pulling rows. Optional type filter for per-domain counts.
 */
export async function countItemsByStatus(
  filter: { type?: string } = {},
): Promise<ItemStatusCounts> {
  const params: unknown[] = [];
  let whereSql = "";
  if (filter.type !== undefined) {
    params.push(filter.type);
    whereSql = ` WHERE type = $${params.length}`;
  }
  const { rows } = await getPool().query<{ status: ItemStatus; count: string }>(
    `SELECT status, count(*)::text AS count FROM items${whereSql} GROUP BY status`,
    params,
  );
  const counts = Object.fromEntries(
    ALL_STATUSES.map((s) => [s, 0]),
  ) as ItemStatusCounts;
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}
