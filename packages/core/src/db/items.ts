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
}

export async function createItem(input: CreateItemInput): Promise<Item> {
  const { rows } = await getPool().query<Item>(
    `INSERT INTO items (type, domain, status, audience, assignee, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.type,
      input.domain ?? null,
      input.status ?? "open",
      input.audience ?? null,
      input.assignee ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return rows[0]!;
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
