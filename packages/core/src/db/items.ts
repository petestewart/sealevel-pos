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

export interface ListItemsFilter {
  status?: ItemStatus;
  type?: string;
  /** Filter by assignee; pass null for the unassigned queue (assignee IS NULL). */
  assignee?: string | null;
}

export async function listItems(filter: ListItemsFilter = {}): Promise<Item[]> {
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
  const sql = `SELECT * FROM items${
    where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
  } ORDER BY created_at DESC, id DESC`;
  const { rows } = await getPool().query<Item>(sql, params);
  return rows;
}
