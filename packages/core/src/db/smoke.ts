import { loadEnv } from "../env.js";
import { getPool, closePool } from "./client.js";
import { createRedis } from "../redis.js";

/**
 * Connectivity smoke check: verifies Postgres (DATABASE_URL) and Redis
 * (REDIS_URL) are reachable. Exits non-zero on failure.
 */
async function main(): Promise<void> {
  loadEnv();

  const { rows } = await getPool().query<{ ok: number }>("SELECT 1 AS ok");
  if (rows[0]?.ok !== 1) throw new Error("Postgres SELECT 1 failed");
  console.log("Postgres: ok");

  const redis = createRedis();
  const pong = await redis.ping();
  if (pong !== "PONG") throw new Error(`Redis ping failed: ${pong}`);
  console.log("Redis: ok");

  redis.disconnect();
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
