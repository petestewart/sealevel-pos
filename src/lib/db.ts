import { Pool } from "pg";

import type { BundleLine, CounterBundle } from "./bundles";

/**
 * The database (T29), and its charter, which is enforced here rather than
 * assumed:
 *
 *   THE DATABASE HOLDS WHAT MINDBODY HAS NO HOME FOR, AND NEVER A COPY OF
 *   WHAT IT DOES. Waiver receipts, bundle config, banner text, promo
 *   entitlements: yes. Clients, classes, passes, prices, visits: never, at
 *   any point, for any reason including speed. The client index was already
 *   deleted once for exactly this reason (see CLAUDE.md); a table makes
 *   rebuilding it tempting in a way in-memory caching did not. A schema
 *   change that mirrors a Mindbody entity is a charter violation, not a
 *   convenience.
 *
 * The other iron rule: THE APP RUNS FULLY WITHOUT DATABASE_URL. Every
 * helper in this file returns a fallback-signaling value (null / false /
 * unavailable) instead of throwing, and every caller degrades to the
 * pre-T29 behavior: bundles from src/lib/bundles.ts, waiver receipts to
 * Notes + the server log, banner from POS_BANNER_TEXT, promo entitlements
 * simply absent. A connection error must NEVER take a counter request
 * down; it is logged once per failure kind per process and the feature
 * quietly falls back.
 *
 * Mechanics: a lazy singleton Pool created only when DATABASE_URL is set,
 * and a tiny idempotent migration (plain SQL, CREATE TABLE IF NOT EXISTS
 * plus a schema_version table) run once per process on first use. Nothing
 * here runs at import or at build: `next build` must succeed with no
 * database listening.
 */

/* --- Pool ------------------------------------------------------------ */

function connectionString(): string {
  return (process.env.DATABASE_URL ?? "").trim();
}

/** Whether a database is CONFIGURED. Says nothing about reachability;
 *  helpers find that out per call and degrade. */
export function dbConfigured(): boolean {
  return connectionString().length > 0;
}

/** What /api/config reports as `storage`. */
export function storageMode(): "postgres" | "none" {
  return dbConfigured() ? "postgres" : "none";
}

let pool: Pool | null = null;
let poolKey: string | null = null;

function getPool(): Pool | null {
  const cs = connectionString();
  if (cs.length === 0) return null;
  /* Keyed by the connection string so an env change mid-process (tests,
   * dev restarts of .env) gets a fresh pool rather than a stale one. */
  if (pool && poolKey === cs) return pool;
  if (pool) void pool.end().catch(() => undefined);
  pool = new Pool({
    connectionString: cs,
    max: 5,
    connectionTimeoutMillis: 5_000,
    /* A counter request must never hang on a dead database. */
    query_timeout: 5_000,
  });
  /* An idle client dropping its connection emits 'error' on the pool, and
   * an unhandled 'error' event crashes the process. Swallow and log: the
   * next query gets a fresh client or fails into its fallback. */
  pool.on("error", (err) => logDbError("pool-idle", err));
  poolKey = cs;
  return pool;
}

/* --- Once-per-kind error logging ------------------------------------ */

const loggedKinds = new Set<string>();

/** One log line per failure kind per process: a database that is down
 *  should not turn the server log into a scroll of identical stacks while
 *  every feature is already degrading correctly. */
function logDbError(kind: string, err: unknown): void {
  if (loggedKinds.has(kind)) return;
  loggedKinds.add(kind);
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[db] ${kind} failed (falling back, logged once per kind): ${message}`,
  );
}

/* --- Migration ------------------------------------------------------- */

/**
 * Plain SQL, idempotent, run in one transaction. Version 1 creates
 * everything; a future change appends a numbered block gated on the
 * recorded version. No ORM, no migration files: the schema is small
 * enough to read in one screen, which is a feature.
 *
 * promo_entitlements carries the granularity schema from the T29 board
 * notes verbatim: kind + display name; percent-off or fixed amount-off;
 * granted/expires (an expired grant renders greyed, never vanishes, so no
 * deletes); item scope as jsonb (all, categories, specific per-site item
 * ids, products-only or passes-only -- OUR scoping vocabulary, since we
 * compute the per-line DiscountAmount, not Mindbody); per-redemption
 * quantity scope; maxUses/usesSoFar consumed only on a real successful
 * charge; optional minimum spend and stacking guards. The table ships
 * with T29; the POS flow that reads it is its own future ticket.
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS waiver_receipts (
        id           bigserial PRIMARY KEY,
        client_id    text NOT NULL,
        agreed_at    timestamptz NOT NULL,
        text_sha256  text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS waiver_receipts_client_idx
        ON waiver_receipts (client_id);

      CREATE TABLE IF NOT EXISTS promo_entitlements (
        id                        bigserial PRIMARY KEY,
        client_id                 text NOT NULL,
        kind                      text NOT NULL,
        display_name              text NOT NULL,
        percent_off               numeric,
        amount_off_cents          integer,
        granted_at                timestamptz NOT NULL DEFAULT now(),
        expires_at                timestamptz,
        max_uses                  integer NOT NULL DEFAULT 1,
        uses_so_far               integer NOT NULL DEFAULT 0,
        item_scope                jsonb,
        max_items_per_redemption  integer,
        min_spend_cents           integer,
        stackable                 boolean NOT NULL DEFAULT false,
        created_at                timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS promo_entitlements_client_idx
        ON promo_entitlements (client_id);

      CREATE TABLE IF NOT EXISTS bundles (
        id          bigserial PRIMARY KEY,
        name        text NOT NULL UNIQUE,
        lines       jsonb NOT NULL,
        enabled     boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key         text PRIMARY KEY,
        value       text NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];

let migrated: Promise<boolean> | null = null;

/** Runs the migration once per process. A failure clears the memo so the
 *  next request retries (the database may have come up since), while the
 *  once-per-kind log keeps the retries quiet. Resolves false on failure
 *  rather than throwing, so callers stay on the fallback path. */
function ensureMigrated(p: Pool): Promise<boolean> {
  if (migrated) return migrated;
  migrated = (async () => {
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version     integer PRIMARY KEY,
          applied_at  timestamptz NOT NULL DEFAULT now()
        );
      `);
      const res = await client.query(
        "SELECT coalesce(max(version), 0) AS v FROM schema_version",
      );
      const current: number = Number(res.rows[0]?.v ?? 0);
      for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        await client.query(m.sql);
        await client.query(
          "INSERT INTO schema_version (version) VALUES ($1)",
          [m.version],
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  })().catch((err) => {
    logDbError("migrate", err);
    migrated = null;
    return false;
  });
  return migrated;
}

/** The shared preamble of every helper: a configured, migrated pool, or
 *  null meaning "fall back". */
async function ready(): Promise<Pool | null> {
  const p = getPool();
  if (!p) return null;
  const ok = await ensureMigrated(p);
  return ok ? p : null;
}

/* --- Waiver receipts ------------------------------------------------- */

/**
 * The durable half of a waiver receipt: full sha256, exact moment, client
 * id. The Notes append in /api/waiver-agree stays exactly as it is (that
 * copy is what staff see in Mindbody; this row is the record that survives
 * a notes edit). Returns whether the row landed; the caller treats false
 * as "the log line already has it", never as a failure of the agreement.
 */
export async function insertWaiverReceipt(
  clientId: string,
  agreedAtIso: string,
  textSha256: string,
): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO waiver_receipts (client_id, agreed_at, text_sha256)
       VALUES ($1, $2, $3)`,
      [clientId, agreedAtIso, textSha256],
    );
    return true;
  } catch (err) {
    logDbError("waiver-receipt-insert", err);
    return false;
  }
}

/* --- Bundles --------------------------------------------------------- */

/** A bundles row as the admin surface sees it. `lines` is stored jsonb
 *  and validated on the way IN (validateBundleLines in bundles.ts), so it
 *  is trusted on the way out. */
export interface BundleRow {
  id: number;
  name: string;
  lines: BundleLine[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function toBundleRow(r: {
  id: string | number;
  name: string;
  lines: BundleLine[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}): BundleRow {
  return {
    id: Number(r.id),
    name: r.name,
    lines: r.lines,
    enabled: r.enabled,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * The catalog's view: enabled bundles, in creation order, shaped exactly
 * like src/lib/bundles.ts config so the client resolver cannot tell the
 * difference. Returns null when the table should NOT take over -- no
 * database, a query failure, or a table with no rows at all -- and the
 * catalog serves the code config. A non-empty table whose every row is
 * disabled returns [], which is an admin's deliberate "no bundles", not a
 * fallback.
 */
export async function enabledDbBundles(): Promise<CounterBundle[] | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT id, name, lines, enabled, created_at, updated_at
       FROM bundles ORDER BY id`,
    );
    if (res.rows.length === 0) return null;
    return res.rows
      .filter((r) => r.enabled)
      .map((r) => ({ name: r.name as string, lines: r.lines as BundleLine[] }));
  } catch (err) {
    logDbError("bundles-read", err);
    return null;
  }
}

/** Admin listing: every row, disabled included. Null means unavailable. */
export async function listBundleRows(): Promise<BundleRow[] | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT id, name, lines, enabled, created_at, updated_at
       FROM bundles ORDER BY id`,
    );
    return res.rows.map(toBundleRow);
  } catch (err) {
    logDbError("bundles-read", err);
    return null;
  }
}

export type BundleWriteResult =
  | { ok: true; row: BundleRow }
  | { ok: false; error: string; status: number };

/** Create. Lines arrive ALREADY validated by validateBundleLines; this
 *  only owns the uniqueness rule and the fallback discipline. */
export async function createBundle(
  name: string,
  lines: BundleLine[],
): Promise<BundleWriteResult> {
  try {
    const p = await ready();
    if (!p) {
      return { ok: false, error: "no database configured", status: 503 };
    }
    const res = await p.query(
      `INSERT INTO bundles (name, lines)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, lines, enabled, created_at, updated_at`,
      [name, JSON.stringify(lines)],
    );
    const row = res.rows[0];
    if (!row) {
      return {
        ok: false,
        error: `a bundle named "${name}" already exists`,
        status: 409,
      };
    }
    return { ok: true, row: toBundleRow(row) };
  } catch (err) {
    logDbError("bundles-write", err);
    return { ok: false, error: "database write failed", status: 503 };
  }
}

/**
 * Edit / enable / disable by id. There is deliberately no DELETE anywhere
 * in this file: disable is the safe verb, and a disabled bundle keeps its
 * name and lines for the day it is wanted back.
 */
export async function updateBundle(
  id: number,
  patch: { name?: string; lines?: BundleLine[]; enabled?: boolean },
): Promise<BundleWriteResult> {
  try {
    const p = await ready();
    if (!p) {
      return { ok: false, error: "no database configured", status: 503 };
    }
    const res = await p.query(
      `UPDATE bundles SET
         name = coalesce($2, name),
         lines = coalesce($3::jsonb, lines),
         enabled = coalesce($4, enabled),
         updated_at = now()
       WHERE id = $1
       RETURNING id, name, lines, enabled, created_at, updated_at`,
      [
        id,
        patch.name ?? null,
        patch.lines ? JSON.stringify(patch.lines) : null,
        patch.enabled ?? null,
      ],
    );
    const row = res.rows[0];
    if (!row) {
      return { ok: false, error: `no bundle with id ${id}`, status: 404 };
    }
    return { ok: true, row: toBundleRow(row) };
  } catch (err) {
    logDbError("bundles-write", err);
    /* A unique violation on rename lands here too; 503 would lie. */
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("bundles_name_key")) {
      return { ok: false, error: "that name is already taken", status: 409 };
    }
    return { ok: false, error: "database write failed", status: 503 };
  }
}

/* --- App settings ---------------------------------------------------- */

/** Key for the studio banner. The one setting shipping with T29. */
export const BANNER_SETTING_KEY = "banner_text";

/** Null when unset OR unavailable; the caller cannot and should not tell
 *  the difference, because both mean "use the env fallback". */
export async function getSetting(key: string): Promise<string | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      "SELECT value FROM app_settings WHERE key = $1",
      [key],
    );
    const value = res.rows[0]?.value;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (err) {
    logDbError("settings-read", err);
    return null;
  }
}

/** Set (non-empty) or clear (null/empty deletes the row, so the env
 *  fallback takes over rather than an empty override). */
export async function setSetting(
  key: string,
  value: string | null,
): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    const trimmed = (value ?? "").trim();
    if (trimmed.length === 0) {
      await p.query("DELETE FROM app_settings WHERE key = $1", [key]);
    } else {
      await p.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE
           SET value = excluded.value, updated_at = now()`,
        [key, trimmed],
      );
    }
    return true;
  } catch (err) {
    logDbError("settings-write", err);
    return false;
  }
}
