import pg from "pg";
import { requireEnv } from "../env.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/**
 * Shared Postgres connection pool, created lazily from DATABASE_URL.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  }
  return pool;
}

/** Close the shared pool (for scripts and graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
