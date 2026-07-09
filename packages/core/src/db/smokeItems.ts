import { loadEnv } from "../env.js";
import { getPool, closePool } from "./client.js";
import {
  createItem,
  listItems,
  countItemsByStatus,
  DEFAULT_PAGE_SIZE,
} from "./items.js";

/**
 * GH-27 smoke: exercises listItems pagination boundaries and
 * countItemsByStatus against the local docker compose Postgres
 * (DATABASE_URL). Seeds 30 items of a throwaway type, checks page
 * ordering/sizing, page-beyond-end, empty-status results, and per-status
 * counts, then deletes the seeded rows. Exits non-zero on any failure.
 */

const SMOKE_TYPE = `smoke_gh27_${Date.now()}`;
const SEED_COUNT = 30;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`smokeItems: ${msg}`);
}

async function main(): Promise<void> {
  loadEnv();
  const pool = getPool();

  try {
    for (let i = 0; i < SEED_COUNT; i++) {
      await createItem({
        type: SMOKE_TYPE,
        status: "pending_approval",
        payload: { seq: i },
      });
    }

    // Page 1: default page size, newest first.
    const page1 = await listItems({ type: SMOKE_TYPE });
    assert(
      page1.length === DEFAULT_PAGE_SIZE,
      `page 1 expected ${DEFAULT_PAGE_SIZE} rows, got ${page1.length}`,
    );
    const seqs = page1.map((it) => it.payload.seq as number);
    assert(
      seqs.every((s, i) => i === 0 || s <= seqs[i - 1]!),
      `page 1 not newest-first: ${seqs.join(",")}`,
    );

    // Page 2: the remainder, no overlap with page 1.
    const page2 = await listItems({ type: SMOKE_TYPE, page: 2 });
    assert(
      page2.length === SEED_COUNT - DEFAULT_PAGE_SIZE,
      `page 2 expected ${SEED_COUNT - DEFAULT_PAGE_SIZE} rows, got ${page2.length}`,
    );
    const ids1 = new Set(page1.map((it) => it.id));
    assert(
      page2.every((it) => !ids1.has(it.id)),
      "page 2 overlaps page 1",
    );

    // Page beyond the end: empty, not an error.
    const page99 = await listItems({ type: SMOKE_TYPE, page: 99 });
    assert(page99.length === 0, `page beyond end expected [], got ${page99.length}`);

    // Custom page size.
    const small = await listItems({ type: SMOKE_TYPE, pageSize: 7, page: 5 });
    assert(small.length === 2, `page 5 of size 7 expected 2 rows, got ${small.length}`);

    // Status with no matching rows: empty, not an error.
    const empty = await listItems({ type: SMOKE_TYPE, status: "resolved" });
    assert(empty.length === 0, `empty status expected [], got ${empty.length}`);

    // Invalid page rejected.
    let threw = false;
    try {
      await listItems({ type: SMOKE_TYPE, page: 0 });
    } catch {
      threw = true;
    }
    assert(threw, "page: 0 should throw");

    // Counts: one GROUP BY query, scoped by type.
    const counts = await countItemsByStatus({ type: SMOKE_TYPE });
    assert(
      counts.pending_approval === SEED_COUNT,
      `expected ${SEED_COUNT} pending_approval, got ${counts.pending_approval}`,
    );
    assert(
      counts.open === 0 && counts.unassigned === 0 && counts.resolved === 0,
      `expected zero counts for other statuses, got ${JSON.stringify(counts)}`,
    );

    console.log("items pagination + counts: ok");
  } finally {
    await pool.query(`DELETE FROM items WHERE type = $1`, [SMOKE_TYPE]);
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
