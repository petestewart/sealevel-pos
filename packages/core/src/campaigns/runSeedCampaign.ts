import { loadEnv } from "../env.js";
import { closePool, getPool } from "../db/client.js";
import { campaignSeedByKey, CAMPAIGN_SEEDS } from "./campaignBriefs.js";

/**
 * Idempotent campaign-row seeder (SEA-88):
 *
 *   npm run campaign:seed -- --key fall-announcement-2026
 *
 * Inserts the campaign row from the typed CAMPAIGN_SEEDS registry if no
 * row with that key exists; an existing row is left completely alone
 * (campaign rows are OPERATIONAL DATA owned by the operator/console,
 * which is why this is a script and not a numbered migration). Re-running
 * is always safe. Needs DATABASE_URL.
 */
loadEnv();

function fail(message: string): never {
  console.error(`[campaign:seed] ERROR: ${message}`);
  console.error("usage: npm run campaign:seed -- --key <key>");
  console.error(
    `known keys: ${CAMPAIGN_SEEDS.map((s) => s.key).join(", ")}`,
  );
  process.exit(2);
}

const i = process.argv.indexOf("--key");
const key = i >= 0 ? process.argv[i + 1] : undefined;
if (!key) fail("missing --key <key>");

const seed = campaignSeedByKey(key);
if (!seed) fail(`no seed registered for key '${key}'`);

try {
  const pool = getPool();
  // ON CONFLICT (key) DO NOTHING against the campaigns_key_idx unique
  // index: concurrent or repeated runs land exactly one row.
  const inserted = await pool.query(
    `INSERT INTO campaigns (key, name, audience_view, created_by)
     VALUES ($1, $2, $3, 'campaign:seed')
     ON CONFLICT (key) DO NOTHING
     RETURNING id`,
    [seed.key, seed.name, seed.audienceView],
  );
  if (inserted.rows.length > 0) {
    console.log(
      `[campaign:seed] created campaign '${seed.key}' (id ${(inserted.rows[0] as { id: string }).id}, audience_view ${seed.audienceView})`,
    );
  } else {
    const existing = await pool.query(
      `SELECT id, name, audience_view, status, run_seq FROM campaigns WHERE key = $1`,
      [seed.key],
    );
    const row = existing.rows[0] as {
      id: string;
      name: string;
      audience_view: string;
      status: string;
      run_seq: number;
    };
    console.log(
      `[campaign:seed] campaign '${seed.key}' already exists (id ${row.id}, status ${row.status}, run ${row.run_seq}); left untouched`,
    );
    if (row.audience_view !== seed.audienceView) {
      console.warn(
        `[campaign:seed] WARNING: existing audience_view '${row.audience_view}' differs from the seed's '${seed.audienceView}'. Not changing operational data; reconcile by hand if the seed is right.`,
      );
    }
  }
} finally {
  await closePool();
}
