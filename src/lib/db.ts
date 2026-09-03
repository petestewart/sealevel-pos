import { Pool } from "pg";

import type { BundleLine, CounterBundle } from "./bundles";

/**
 * The database (T29), and its charter, which is enforced here rather than
 * assumed:
 *
 *   THE DATABASE HOLDS WHAT MINDBODY HAS NO HOME FOR, AND NEVER A COPY OF
 *   WHAT IT DOES. Waiver receipts, bundle config, banner text, promo
 *   entitlements, teacher PINs: yes. Clients, classes, passes, prices, visits: never, at
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

/* --- Dead-database cooldown ------------------------------------------ */

/**
 * A configured-but-unreachable database must not tax the counter. The
 * timeouts bound any single attempt at 5s, but /api/config and
 * /api/catalog read the database per request, and a black-holed host
 * (stopped Railway service, dropped firewall) would otherwise cost every
 * one of those requests its own 5s probe. So a connection-level failure
 * puts the whole layer on a cooldown: for the next 30s every helper falls
 * back instantly, then one request probes again. Query-level errors (a
 * unique violation on rename, say) are not outages and set no cooldown.
 */
const RETRY_COOLDOWN_MS = 30_000;
let unavailableUntil = 0;

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08006", // connection_failure
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|terminat|connect/i.test(message);
}

/* --- Once-per-kind error logging ------------------------------------ */

const loggedKinds = new Set<string>();

/** One log line per failure kind per process: a database that is down
 *  should not turn the server log into a scroll of identical stacks while
 *  every feature is already degrading correctly. */
function logDbError(kind: string, err: unknown): void {
  if (isConnectionError(err)) {
    unavailableUntil = Date.now() + RETRY_COOLDOWN_MS;
  }
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
  {
    /* T43: comp receipts. Version 1 has already run on the deployed
     * database and is skipped there, so the table is its own block. The
     * charter holds: the reason is ours (Mindbody's checkout request has
     * no notes field), the sale id is a handle, and `items` is OUR line
     * list of what was given away (type, id, name, quantity, price as
     * charged), a record of the comp rather than a copy of the catalog.
     * No client name: Mindbody has that under the id. */
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS comp_receipts (
        id           serial PRIMARY KEY,
        recorded_at  timestamptz NOT NULL DEFAULT now(),
        sale_id      text,
        client_id    text,
        total_cents  integer NOT NULL,
        items        jsonb NOT NULL,
        reason       text NOT NULL,
        target       text NOT NULL,
        suppressed   boolean NOT NULL
      );
    `,
  },
  {
    /* T44: who comped it. Two nullable columns, additive, so the deployed
     * database at 2 runs only this block. The teacher's Mindbody staff
     * id and the name as it read at the time (a handle plus a label, not
     * a staff table); null on a comp made with no teacher session, which
     * only auth-disabled dev allows. */
    version: 3,
    sql: `
      ALTER TABLE comp_receipts
        ADD COLUMN IF NOT EXISTS teacher_id text,
        ADD COLUMN IF NOT EXISTS teacher_name text;
    `,
  },
  {
    /* T45: the reason as data. `kind` is one of comp.ts's COMP_KINDS,
     * `detail` the optional free text, `for_staff_id` and `for_staff_name`
     * the teacher a teacher comp was for (a handle plus the name as it
     * read, like teacher_id), and `formula_note_id` the Mindbody Formula
     * Note the route filed on the client afterwards, when it did. All
     * nullable and additive: rows from T43 and T44 keep their rendered
     * `reason`, which the route still fills for every new row too. */
    version: 4,
    sql: `
      ALTER TABLE comp_receipts
        ADD COLUMN IF NOT EXISTS kind text,
        ADD COLUMN IF NOT EXISTS detail text,
        ADD COLUMN IF NOT EXISTS for_staff_id text,
        ADD COLUMN IF NOT EXISTS for_staff_name text,
        ADD COLUMN IF NOT EXISTS formula_note_id integer;
    `,
  },
  {
    /* T48: teacher PINs, ours. Pete: "if we are going to do PINs we
     * likely need to store them in our own db." A PIN is something
     * Mindbody has no home for, so the charter holds; `staff_id` is a
     * handle and `name` the label as it read when the PIN was set, like
     * comp_receipts.teacher_name, never a staff table. `pin_hash` is
     * scrypt of the PIN with a per-row salt (src/lib/teacherpins.ts);
     * `pin_lookup` a keyed HMAC of the PIN, UNIQUE, so a check is one
     * indexed read and no two teachers can hold the same PIN (which the
     * last-four-of-a-phone scheme could not promise). `set_via` says how
     * it got there: a Mindbody sign-in in the comp dialog, or the admin
     * route. The PIN itself is stored nowhere. */
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS teacher_pins (
        staff_id    text PRIMARY KEY,
        name        text NOT NULL,
        pin_hash    text NOT NULL,
        pin_lookup  text NOT NULL UNIQUE,
        set_at      timestamptz NOT NULL DEFAULT now(),
        set_via     text NOT NULL
      );
    `,
  },
  {
    /* T49: the cart GUID beside the sale id. `sale_id` has always held
     * ShoppingCart.Id, a GUID; from T49 it holds the numeric Sale.Id
     * when the lookup after a real checkout finds one (the number on
     * Mindbody's own receipts), else the GUID as before, and `cart_id`
     * keeps the GUID either way. Additive and nullable: rows from before
     * carry their GUID in sale_id and null here. */
    version: 6,
    sql: `
      ALTER TABLE comp_receipts
        ADD COLUMN IF NOT EXISTS cart_id text;
    `,
  },
  {
    /* T62: whose guest a visit was. Mindbody's visit carries the pass's
     * name ("Guest Pass") and nothing about whose pass it was, so after
     * a reload the guest's row read as anyone's; the page's memory of it
     * (T59c's `guestBy`) went with the class view. The charter holds:
     * this is a fact Mindbody has no home for, and the row is ids plus
     * the two names the roster needs to render "Guest of Pete Stewart"
     * (labels as they read at the time, like comp_receipts.teacher_name),
     * never the pass, the price, the class or the visit itself. Written
     * only after the guest's visit REALLY landed on the member's pass
     * (not suppressed, not ignored); read per roster load by visit id.
     * No DELETE: a visit that is cancelled simply never matches again. */
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS guest_visits (
        visit_id          bigint PRIMARY KEY,
        class_id          bigint NOT NULL,
        guest_client_id   text NOT NULL,
        member_client_id  text NOT NULL,
        member_name       text NOT NULL,
        guest_name        text NOT NULL,
        staff_id          text,
        created_at        timestamptz DEFAULT now()
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
      /* Two processes sharing one database (a second dev server, a future
       * second Railway instance) must not race the CREATE TABLEs: IF NOT
       * EXISTS does not make concurrent creation safe (duplicate pg_type
       * errors). The transaction-scoped advisory lock serializes them; the
       * loser finds schema_version already advanced and does nothing. */
      await client.query("SELECT pg_advisory_xact_lock(729117)");
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
  if (Date.now() < unavailableUntil) return null;
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

/* --- Comp receipts (T43) --------------------------------------------- */

/** One comp receipt's line: what was given away, in our own words. */
export interface CompReceiptItem {
  type: string;
  id: string;
  name: string | null;
  quantity: number;
  price: number;
}

/**
 * The durable record of a comp: the reason the teacher wrote, the total
 * on the studio, our line list, which target it ran against, and whether
 * the write was suppressed (dry run or the write guard) rather than
 * recorded by Mindbody, and which teacher made it (T44; since T48 the
 * teacher whose PIN the comp dialog took). The route's
 * `[comp]` log line stays exactly as it is (that copy exists even with
 * no database); this row is the record that survives a log rotation.
 * Returns whether the row landed; false is "the log line already has
 * it", never a failure of the comp.
 */
export async function insertCompReceipt(receipt: {
  /** The numeric Sale.Id when found (T49), else the cart GUID. */
  saleId: string | null;
  /** T49: the cart GUID, always, when the sale went out. */
  cartId: string | null;
  clientId: string | null;
  totalCents: number;
  items: readonly CompReceiptItem[];
  reason: string;
  target: string;
  suppressed: boolean;
  teacherId: string | null;
  teacherName: string | null;
  /** T45: the reason as data, beside the rendered `reason` line. */
  kind: string;
  detail: string | null;
  forStaffId: string | null;
  forStaffName: string | null;
  /** The Formula Note Mindbody filed for this comp, when one was. */
  formulaNoteId: number | null;
}): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO comp_receipts
         (sale_id, client_id, total_cents, items, reason, target, suppressed,
          teacher_id, teacher_name, kind, detail, for_staff_id,
          for_staff_name, formula_note_id, cart_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15)`,
      [
        receipt.saleId,
        receipt.clientId,
        receipt.totalCents,
        JSON.stringify(receipt.items),
        receipt.reason,
        receipt.target,
        receipt.suppressed,
        receipt.teacherId,
        receipt.teacherName,
        receipt.kind,
        receipt.detail,
        receipt.forStaffId,
        receipt.forStaffName,
        receipt.formulaNoteId,
        receipt.cartId,
      ],
    );
    return true;
  } catch (err) {
    logDbError("comp-receipt-insert", err);
    return false;
  }
}

/* --- Guest visits (T62) ---------------------------------------------- */

/**
 * The durable "Guest of" marker. Upserted on the visit id: a visit is
 * one guest's, and a repeat write (a retry that landed twice) keeps the
 * latest names. Returns whether the row landed; false is "no database,
 * the page's memory carries it for this class view", never a failure of
 * the check-in.
 */
export async function insertGuestVisit(row: {
  visitId: number;
  classId: number;
  guestClientId: string;
  memberClientId: string;
  memberName: string;
  guestName: string;
  staffId: string | null;
}): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO guest_visits
         (visit_id, class_id, guest_client_id, member_client_id,
          member_name, guest_name, staff_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (visit_id) DO UPDATE
         SET guest_client_id = excluded.guest_client_id,
             member_client_id = excluded.member_client_id,
             member_name = excluded.member_name,
             guest_name = excluded.guest_name,
             staff_id = excluded.staff_id`,
      [
        row.visitId,
        row.classId,
        row.guestClientId,
        row.memberClientId,
        row.memberName,
        row.guestName,
        row.staffId,
      ],
    );
    return true;
  } catch (err) {
    logDbError("guest-visit-insert", err);
    return false;
  }
}

/** One marker as the roster needs it: the guest it belongs to (checked
 *  against the visit's client, so a stale row can never caption someone
 *  else's visit) and the member's name to render. */
export interface GuestVisitMarker {
  guestClientId: string;
  memberName: string;
}

/**
 * The markers for one roster load, keyed by visit id: ONE query for all
 * the visits the roster returns. An empty map for an empty list, no
 * database, or a failed read; the caller renders no captions and the
 * page's own memory (T59c) still covers the class view.
 */
export async function guestMarkersForVisits(
  visitIds: readonly number[],
): Promise<Map<number, GuestVisitMarker>> {
  const out = new Map<number, GuestVisitMarker>();
  if (visitIds.length === 0) return out;
  try {
    const p = await ready();
    if (!p) return out;
    const res = await p.query(
      `SELECT visit_id, guest_client_id, member_name
       FROM guest_visits WHERE visit_id = ANY($1::bigint[])`,
      [visitIds],
    );
    for (const r of res.rows) {
      out.set(Number(r.visit_id), {
        guestClientId: String(r.guest_client_id),
        memberName: String(r.member_name),
      });
    }
    return out;
  } catch (err) {
    logDbError("guest-visit-read", err);
    return out;
  }
}

/* --- Teacher PINs (T48) ---------------------------------------------- */

/** One enrolled PIN's row, minus the secrets. */
export interface TeacherPinRow {
  staffId: string;
  name: string;
  setAt: string;
  setVia: string;
}

/** The row whose lookup value matches, with its hash for the caller to
 *  verify, or null when there is none OR no database: the caller falls
 *  back (the dev env list) or refuses, and cannot tell which from here.
 *  `available` says whether the store answered at all. */
export async function findTeacherPin(
  lookup: string,
): Promise<
  | { available: false }
  | { available: true; row: null }
  | { available: true; row: { staffId: string; name: string; pinHash: string } }
> {
  try {
    const p = await ready();
    if (!p) return { available: false };
    const res = await p.query(
      `SELECT staff_id, name, pin_hash FROM teacher_pins WHERE pin_lookup = $1`,
      [lookup],
    );
    const r = res.rows[0];
    if (!r) return { available: true, row: null };
    return {
      available: true,
      row: { staffId: String(r.staff_id), name: r.name, pinHash: r.pin_hash },
    };
  } catch (err) {
    logDbError("teacher-pin-read", err);
    return { available: false };
  }
}

export type TeacherPinWrite =
  | { ok: true }
  | { ok: false; reason: "taken" | "unavailable" };

/** Set or replace one teacher's PIN. A lookup value another teacher
 *  already holds is refused as `taken` (the UNIQUE constraint, read back
 *  by name), so the same PIN can never name two people. */
export async function upsertTeacherPin(row: {
  staffId: string;
  name: string;
  pinHash: string;
  pinLookup: string;
  setVia: string;
}): Promise<TeacherPinWrite> {
  try {
    const p = await ready();
    if (!p) return { ok: false, reason: "unavailable" };
    await p.query(
      `INSERT INTO teacher_pins (staff_id, name, pin_hash, pin_lookup, set_via)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (staff_id) DO UPDATE
         SET name = excluded.name, pin_hash = excluded.pin_hash,
             pin_lookup = excluded.pin_lookup, set_via = excluded.set_via,
             set_at = now()`,
      [row.staffId, row.name, row.pinHash, row.pinLookup, row.setVia],
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("teacher_pins_pin_lookup_key")) {
      /* Not an outage: no cooldown, no once-per-kind log. */
      return { ok: false, reason: "taken" };
    }
    logDbError("teacher-pin-write", err);
    return { ok: false, reason: "unavailable" };
  }
}

/** Who has a PIN, for the admin route. Null means unavailable. */
export async function listTeacherPins(): Promise<TeacherPinRow[] | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT staff_id, name, set_at, set_via FROM teacher_pins ORDER BY name`,
    );
    return res.rows.map((r) => ({
      staffId: String(r.staff_id),
      name: r.name as string,
      setAt: (r.set_at as Date).toISOString(),
      setVia: r.set_via as string,
    }));
  } catch (err) {
    logDbError("teacher-pin-read", err);
    return null;
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
