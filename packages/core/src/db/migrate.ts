import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "../env.js";
import { getPool, closePool } from "./client.js";

/**
 * Minimal SQL-file migration runner.
 *
 * Migrations live in packages/core/migrations as NNNN_name.sql files,
 * applied in filename order. Applied migrations are tracked in the
 * schema_migrations table; re-running is a no-op (idempotent). Each
 * migration runs inside its own transaction, and the whole run holds a
 * Postgres advisory lock so concurrent deploys cannot race.
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

// Arbitrary fixed key for pg_advisory_lock, unique to this app's migrations.
const MIGRATION_LOCK_KEY = 720_260_708;

export async function runMigrations(): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${String(err)}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    client.release();
  }
  return applied;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  loadEnv();
  runMigrations()
    .then((applied) => {
      if (applied.length === 0) {
        console.log("Migrations: up to date, nothing to apply.");
      } else {
        for (const name of applied) console.log(`Applied ${name}`);
      }
      return closePool();
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closePool();
    });
}
