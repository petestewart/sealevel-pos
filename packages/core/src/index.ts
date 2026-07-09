/**
 * @ai-manager/core — shared core (brain, queue, tools, jobs, db).
 * Remaining modules land in later Phase 0 tickets
 * (see ARCHITECTURE.md "Repo structure").
 */
export const CORE_PACKAGE = "@ai-manager/core";

export { loadEnv, requireEnv } from "./env.js";
export { getPool, closePool } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export { createRedis } from "./redis.js";
