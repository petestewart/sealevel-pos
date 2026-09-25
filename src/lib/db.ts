import { Pool } from "pg";

import type { BundleLine, CounterBundle } from "./bundles";
import type { ClientWriteEntry } from "./clientaudit";

/**
 * The database (T29), and its charter, which is enforced here rather than
 * assumed:
 *
 *   THE DATABASE HOLDS WHAT MINDBODY HAS NO HOME FOR, AND NEVER A COPY OF
 *   WHAT IT DOES. Waiver receipts, bundle config, banner text, promo
 *   entitlements, teacher PINs, our own audit of our writes to a client
 *   (T116, only the fields we changed): yes. Clients, classes, passes, prices, visits: never, at
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
  {
    /* T78: staff sessions, so a deploy restart does not sign every
     * teacher out (T77 was the symptom). The session is OURS: the
     * pairing of a browser's opaque cookie id with the teacher it is
     * signed in as, which Mindbody has no home for. `staff_id` and
     * `name` are the handle and the label as it read, like
     * teacher_pins. `token_enc` is the teacher's Mindbody token
     * ENCRYPTED under a key derived from POS_SESSION_SECRET
     * (src/lib/staffcrypto.ts); the clear token is never in a row, and
     * without the secret no row is written at all. `expires_at` is
     * issued_at plus the two hours of T64; an expired row reads as no
     * session and is swept. Rows are deleted on sign-out and expiry,
     * since a dead session is nothing anyone needs back. */
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS staff_sessions (
        id          text PRIMARY KEY,
        staff_id    text NOT NULL,
        name        text NOT NULL,
        token_enc   text NOT NULL,
        issued_at   timestamptz NOT NULL,
        expires_at  timestamptz NOT NULL
      );
    `,
  },
  {
    /* T79: a comp is a 100% discount, and a discount may be partial
     * (Pete: "if it's $100 sale i should be able to comp $60 of it and
     * they pay $40"). Three nullable, additive columns beside the
     * existing ones: `discount_amount` is the dollars taken off the
     * pre-tax subtotal (the server-side spread's sum), `discount_percent`
     * the percent chosen when the teacher chose one (100 for the whole
     * sale; null for a dollar amount), and `sale_total` what the client
     * actually paid, Mindbody's grand total after the discount and tax.
     * `total_cents` keeps its T43 meaning, the amount on the studio.
     * Rows from before read null in all three. The T49 idiom: ADD
     * COLUMN IF NOT EXISTS, so a deployed database at 8 runs only this. */
    version: 9,
    sql: `
      ALTER TABLE comp_receipts
        ADD COLUMN IF NOT EXISTS discount_amount numeric,
        ADD COLUMN IF NOT EXISTS discount_percent numeric,
        ADD COLUMN IF NOT EXISTS sale_total numeric;
    `,
  },
  {
    /* The PIN's length, so the discount dialog's PIN step can submit
     * itself on the last digit (Pete: "I should not have to click
     * Done"). Only the length, never the digits; rows from before read
     * null and keep the Done button. */
    version: 10,
    sql: `
      ALTER TABLE teacher_pins
        ADD COLUMN IF NOT EXISTS pin_length smallint;
    `,
  },
  {
    /* PINs need not be unique (Pete: "there's no reason to force PINs
     * to be unique"). They had to be while the discount gate found the
     * teacher BY the PIN; since T50 every teacher is signed in, so the
     * gate checks the PIN against the signed-in teacher's own row and
     * two teachers may choose the same digits. `pin_lookup` stays as a
     * column, no longer unique and no longer read. */
    version: 11,
    sql: `
      ALTER TABLE teacher_pins
        DROP CONSTRAINT IF EXISTS teacher_pins_pin_lookup_key;
    `,
  },
  {
    /* T116: every write this app makes to a client record (Pete, after a
     * student's notes and alert were found blank and the in-memory call
     * log had gone with a restart). The charter holds, narrowly: this is
     * OUR audit of OUR actions, which Mindbody has no home for. A row
     * holds the handles (client id, UniqueId, staff ids), the teacher's
     * name as it read, and for each field the write CHANGED its value
     * before and after (`changes`, jsonb). Never the rest of the client
     * record, never the client's name, never a card: a card's entry is
     * the sentence "card replaced, last four 1234" and nothing else. No
     * UPDATE and no DELETE anywhere: a record that can be edited is not
     * one. */
    version: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS client_writes (
        id            bigserial PRIMARY KEY,
        at            timestamptz NOT NULL,
        client_id     text NOT NULL,
        unique_id     bigint,
        kind          text NOT NULL,
        changes       jsonb NOT NULL,
        outcome       text NOT NULL,
        http_status   integer,
        error         text,
        teacher_id    text,
        teacher_name  text,
        actor_id      text,
        route         text,
        target        text NOT NULL,
        site_id       text,
        note          text,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS client_writes_client_at_idx
        ON client_writes (client_id, at DESC);
    `,
  },
  {
    /* T200: the customer-facing display (docs/design/customer-display.md).
     * Both tables are charter-clean: they hold what Mindbody has no home
     * for and never a copy of what it does. `displays` is the pairing of
     * a studio-owned iPad with this counter, which exists nowhere else;
     * `display_requests` is the scene a teacher put on it and the result
     * the student handed back, which lives only long enough for the
     * teacher's iPad to finalise it (30 minutes) and is then expired. No
     * client, class, pass, price or visit is stored here: a request's
     * payload carries a first name and what the student may already see
     * on the screen in front of them, and nothing is ever read back out
     * of it as a fact about Mindbody.
     *
     * `initiator` is "teacher" or "display" (the self-serve sign-up,
     * built later); `status` is pending / completed / refused /
     * cancelled / expired. `consumed_at` is the one-finalisation handle:
     * a result may be spent once, by the teacher's iPad, and never
     * again. Nullable and additive throughout, and a deployed database
     * at 11 runs only this block. */
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS displays (
        id            text PRIMARY KEY,
        name          text,
        paired_at     timestamptz NOT NULL DEFAULT now(),
        last_seen_at  timestamptz
      );
      CREATE TABLE IF NOT EXISTS display_requests (
        id                      text PRIMARY KEY,
        display_id              text NOT NULL,
        kind                    text NOT NULL,
        initiator               text NOT NULL,
        payload                 jsonb,
        status                  text NOT NULL,
        result                  jsonb,
        requested_by_staff_id   text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        completed_at            timestamptz,
        consumed_at             timestamptz,
        expires_at              timestamptz NOT NULL
      );
    `,
  },
  {
    /* T202: the waiver signature, beside the text hash it already
     * carries. Charter-clean, and the reasoning is worth stating: this
     * image is OUR artifact, captured on OUR screen, which Mindbody has
     * no field for (a waiver has no signature anywhere on the client;
     * only a contract does). So the database is the ORIGINAL and the
     * copy uploaded to the client's documents is the copy. Additive,
     * nullable, and every row written before this one stays exactly as
     * it is: a counter agreement carries no signature and never will. */
    version: 14,
    sql: `
      ALTER TABLE waiver_receipts
        ADD COLUMN IF NOT EXISTS signature_sha256 text;
      ALTER TABLE waiver_receipts
        ADD COLUMN IF NOT EXISTS signature_png bytea;
    `,
  },
  {
    /* T205: the contract signature's receipt. OURS, on the charter's
     * own terms: Mindbody records that a contract was bought and (when
     * it accepts ClientSignature) keeps the image on the client's
     * documents page, but it does not record WHICH WORDING was agreed
     * to. The studio edits those terms in Mindbody's rich text editor,
     * so "the membership Sam signed" is only answerable from a hash of
     * the text as it stood at that moment, beside the artifact that was
     * drawn on it -- or, when a teacher sold it with their PIN instead,
     * beside their staff id and no signature at all.
     *
     * Nothing here duplicates Mindbody: no price, no card, no client
     * detail beyond the id, and no claim about the contract's state. One
     * row per LIVE purchase attempt that reached Mindbody. Additive, and
     * a deployed database at 13 runs only this block. */
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS contract_receipts (
        id                      bigserial PRIMARY KEY,
        client_id               text NOT NULL,
        contract_id             integer NOT NULL,
        contract_name           text,
        terms_sha256            text,
        signature_sha256        text,
        signature_png           bytea,
        overridden_by_staff_id  text,
        agreed_at               timestamptz,
        start_date              text,
        sale_outcome            text NOT NULL,
        created_at              timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS contract_receipts_client_idx
        ON contract_receipts (client_id);
    `,
  },
  {
    /* Sandbox sign-in (Pete, 2026-09-20): the sandbox's ONE staff login is
     * also the app's service account, and Mindbody refuses to issue a
     * second token for a user who already holds one. A session opened
     * with the service account's own login is flagged so the service
     * reads can borrow its token when an issue is refused. Additive,
     * default false; rows from before read as ordinary teachers. */
    version: 16,
    sql: `
      ALTER TABLE staff_sessions
        ADD COLUMN IF NOT EXISTS is_service boolean NOT NULL DEFAULT false;
    `,
  },
  {
    /* T210: which Mindbody SITE the token in this row was issued for.
     * A staff token belongs to the site that issued it, and Mindbody
     * answers "Delegated staff does not belong to the subscriber." when
     * one is used against another site -- which is what a counter
     * restarted with a different MINDBODY_TARGET was doing with a
     * persisted session (T89's switch ends every session, but an
     * environment change at restart never ran it). Nullable, because
     * rows written before this migration cannot be told apart: they
     * read as UNKNOWN and are never loaded for any site, which costs
     * one sign-in on the deploy that adds this column and nothing
     * afterwards. Not a secret: the site id is already on
     * /api/config. */
    version: 17,
    sql: `
      ALTER TABLE staff_sessions
        ADD COLUMN IF NOT EXISTS site_id text;
    `,
  },
  {
    /* The two series, merged (T212's merge of main's T116). Main's
     * client_writes shipped as migration 12 while this branch's five
     * (the displays, the receipt signatures, contract receipts, the
     * service flag and the session's site) were also numbered 12 to 16.
     * Main keeps 12, because a deployed database may already have run it;
     * the branch's five are 13 to 17. A database that ran the branch's
     * OLD numbering (max 16) skips the new 12 and would never get
     * client_writes, so this re-asserts it. Every statement here and in
     * 13 to 17 is IF NOT EXISTS, so a database that has it all already
     * does nothing. */
    version: 18,
    sql: `
      CREATE TABLE IF NOT EXISTS client_writes (
        id            bigserial PRIMARY KEY,
        at            timestamptz NOT NULL,
        client_id     text NOT NULL,
        unique_id     bigint,
        kind          text NOT NULL,
        changes       jsonb NOT NULL,
        outcome       text NOT NULL,
        http_status   integer,
        error         text,
        teacher_id    text,
        teacher_name  text,
        actor_id      text,
        route         text,
        target        text NOT NULL,
        site_id       text,
        note          text,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS client_writes_client_at_idx
        ON client_writes (client_id, at DESC);
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
  /** T202: the signature captured on the customer display, when there
   *  was one. Absent for a counter agreement, which has no signature to
   *  keep and must keep reading exactly as it did. */
  signature?: { sha256: string; png: Buffer } | null,
): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO waiver_receipts
         (client_id, agreed_at, text_sha256, signature_sha256, signature_png)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        clientId,
        agreedAtIso,
        textSha256,
        signature?.sha256 ?? null,
        signature?.png ?? null,
      ],
    );
    return true;
  } catch (err) {
    logDbError("waiver-receipt-insert", err);
    return false;
  }
}

/* --- Contract receipts (T205) ---------------------------------------- */

/**
 * The durable record of one membership sale's SIGNATURE: which wording
 * was agreed to (the hash of the raw terms as they were read), the
 * artifact that was drawn on it, or the staff id of the teacher who sold
 * it on their own PIN instead. Written once per LIVE purchase attempt
 * that reached Mindbody, whatever the answer was: a refusal is exactly
 * the case where somebody later asks what happened.
 *
 * Returns whether the row landed; false is "the log line already has
 * it", never a failure of the purchase. Never throws.
 */
export async function insertContractReceipt(receipt: {
  clientId: string;
  contractId: number;
  contractName: string | null;
  termsSha256: string | null;
  signature: { sha256: string; png: Buffer } | null;
  overriddenByStaffId: string | null;
  agreedAt: string | null;
  /** The studio `YYYY-MM-DD` the membership starts on, "today" when the
   *  teacher chose none. A string, because that is what the counter and
   *  Mindbody both speak here (CLAUDE.md, site-local datetimes). */
  startDate: string;
  /** completed / suppressed / a refusal in words. */
  saleOutcome: string;
}): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO contract_receipts
         (client_id, contract_id, contract_name, terms_sha256,
          signature_sha256, signature_png, overridden_by_staff_id,
          agreed_at, start_date, sale_outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        receipt.clientId,
        receipt.contractId,
        receipt.contractName,
        receipt.termsSha256,
        receipt.signature?.sha256 ?? null,
        receipt.signature?.png ?? null,
        receipt.overriddenByStaffId,
        receipt.agreedAt,
        receipt.startDate,
        receipt.saleOutcome.slice(0, 500),
      ],
    );
    return true;
  } catch (err) {
    logDbError("contract-receipt-insert", err);
    return false;
  }
}

/**
 * T205: the newest contract receipt for a client that carries a
 * SIGNATURE, for the profile card's one line. Our own row, the same
 * reading the waiver's line gets; the PNG is deliberately not selected
 * and is never rendered back into the POS.
 */
export async function latestSignedContractReceipt(
  clientId: string,
): Promise<{ agreedAt: Date; contractName: string | null } | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT agreed_at, contract_name
         FROM contract_receipts
        WHERE client_id = $1
          AND signature_sha256 IS NOT NULL
          AND agreed_at IS NOT NULL
        ORDER BY agreed_at DESC LIMIT 1`,
      [clientId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      agreedAt: new Date(r.agreed_at),
      contractName: r.contract_name === null ? null : String(r.contract_name),
    };
  } catch (err) {
    logDbError("contract-receipt-read", err);
    return null;
  }
}

/* --- Client writes (T116) -------------------------------------------- */

/** One `client_writes` row as the drawer reads it: the entry as written. */
export type ClientWriteRow = ClientWriteEntry;

/**
 * The durable half of a client write's record (src/lib/clientaudit.ts,
 * which has already put the same entry on the console). Returns whether
 * the row landed; false is "the console line has it", never a failure of
 * the write, which has already happened by the time this runs.
 */
export async function insertClientWrite(
  entry: ClientWriteEntry,
): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO client_writes
         (at, client_id, unique_id, kind, changes, outcome, http_status,
          error, teacher_id, teacher_name, actor_id, route, target,
          site_id, note)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15)`,
      [
        entry.at,
        entry.clientId,
        entry.uniqueId,
        entry.kind,
        JSON.stringify(entry.changes),
        entry.outcome,
        entry.httpStatus,
        entry.error,
        entry.teacherId === null ? null : String(entry.teacherId),
        entry.teacherName,
        entry.actorId === null ? null : String(entry.actorId),
        entry.route,
        entry.target,
        entry.siteId,
        entry.note,
      ],
    );
    return true;
  } catch (err) {
    logDbError("client-write-insert", err);
    return false;
  }
}

/** Recent rows, newest first, for one client or all of them; null when
 *  the store did not answer (no database, or down), so the caller can
 *  say where its list came from. */
export async function listClientWrites(
  clientId: string | null,
  limit: number,
): Promise<ClientWriteRow[] | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    const res = await p.query(
      clientId === null
        ? `SELECT * FROM client_writes ORDER BY at DESC, id DESC LIMIT $1`
        : `SELECT * FROM client_writes WHERE client_id = $2
           ORDER BY at DESC, id DESC LIMIT $1`,
      clientId === null ? [n] : [n, clientId],
    );
    return res.rows.map(
      (r): ClientWriteRow => ({
        at: new Date(r.at).toISOString(),
        clientId: String(r.client_id),
        uniqueId: r.unique_id === null ? null : Number(r.unique_id),
        kind: r.kind,
        changes: Array.isArray(r.changes) ? r.changes : [],
        outcome: r.outcome,
        httpStatus: r.http_status === null ? null : Number(r.http_status),
        error: r.error ?? null,
        teacherId: r.teacher_id === null ? null : Number(r.teacher_id),
        teacherName: r.teacher_name ?? null,
        actorId: r.actor_id === null ? null : Number(r.actor_id),
        route: r.route ?? null,
        target: String(r.target),
        siteId: r.site_id ?? null,
        note: r.note ?? null,
      }),
    );
  } catch (err) {
    logDbError("client-write-read", err);
    return null;
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
  /** T45: the reason as data, beside the rendered `reason` line. T79
   *  dropped the Teacher kind and its `for_staff_*` columns from the
   *  insert; the columns stay, null on every new row. */
  kind: string;
  detail: string | null;
  /** The Formula Note Mindbody filed for this comp, when one was. */
  formulaNoteId: number | null;
  /** T79: the discount in dollars off the pre-tax subtotal, the chosen
   *  percent (null for a dollar amount), and what the client paid. */
  discountAmount: number;
  discountPercent: number | null;
  saleTotal: number;
}): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO comp_receipts
         (sale_id, client_id, total_cents, items, reason, target, suppressed,
          teacher_id, teacher_name, kind, detail, formula_note_id, cart_id,
          discount_amount, discount_percent, sale_total)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16)`,
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
        receipt.formulaNoteId,
        receipt.cartId,
        receipt.discountAmount,
        receipt.discountPercent,
        receipt.saleTotal,
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
 * T62 review: a database that is black-holed (the host drops packets
 * rather than refusing) costs the FIRST call after each 30s cooldown the
 * full 5s connect timeout, measured at 5022ms on a roster read. The
 * roster is the counter's hot path and the marker is a caption, so a
 * marker read or write waits at most `ms` for the database and then
 * takes its fallback; the attempt itself runs on, so a connection that
 * fails still sets the cooldown and a slow one still lands its row.
 */
export function boundedDb<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export const DB_MARKER_WAIT_MS = 750;

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

/** One teacher's PIN row by staff id, for the discount gate: the PIN is
 *  checked against the SIGNED-IN teacher, never looked up on its own.
 *  `available` says whether the store answered at all. */
export async function findTeacherPinByStaff(
  staffId: string,
): Promise<
  | { available: false }
  | { available: true; row: null }
  | { available: true; row: { staffId: string; name: string; pinHash: string } }
> {
  try {
    const p = await ready();
    if (!p) return { available: false };
    const res = await p.query(
      `SELECT staff_id, name, pin_hash FROM teacher_pins WHERE staff_id = $1`,
      [staffId],
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

/** Whether this staff id has a PIN (T80): true, false, or null when
 *  there is no database or it failed, which means PINs are unavailable
 *  rather than unset. One indexed read on the primary key; it never
 *  throws, and it never reads the hash or the lookup value, so nothing
 *  derived from a PIN leaves this function. */
export async function teacherPinExists(
  staffId: string,
): Promise<boolean | null> {
  const info = await teacherPinInfo(staffId);
  return info === null ? null : info.exists;
}

/** Whether a teacher has a PIN and, when recorded, how many digits it
 *  has. Null when the database is absent or failed. */
export async function teacherPinInfo(
  staffId: string,
): Promise<{ exists: boolean; length: number | null } | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT pin_length FROM teacher_pins WHERE staff_id = $1`,
      [staffId],
    );
    const row = res.rows[0] as { pin_length: number | null } | undefined;
    if (!row) return { exists: false, length: null };
    const n = Number(row.pin_length);
    return { exists: true, length: Number.isInteger(n) && n > 0 ? n : null };
  } catch (err) {
    logDbError("teacher-pin-read", err);
    return null;
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
  pinLength: number;
}): Promise<TeacherPinWrite> {
  try {
    const p = await ready();
    if (!p) return { ok: false, reason: "unavailable" };
    await p.query(
      `INSERT INTO teacher_pins (staff_id, name, pin_hash, pin_lookup, set_via, pin_length)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (staff_id) DO UPDATE
         SET name = excluded.name, pin_hash = excluded.pin_hash,
             pin_lookup = excluded.pin_lookup, set_via = excluded.set_via,
             pin_length = excluded.pin_length, set_at = now()`,
      [row.staffId, row.name, row.pinHash, row.pinLookup, row.setVia, row.pinLength],
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

/* --- Staff sessions (T78) -------------------------------------------- */

/** One persisted staff session. `tokenEnc` is ciphertext; the caller
 *  (src/lib/staffsession.ts) holds the key and never this file. */
export interface StaffSessionRow {
  id: string;
  staffId: string;
  name: string;
  tokenEnc: string;
  issuedAt: Date;
  expiresAt: Date;
  /** The session was opened with the SERVICE ACCOUNT's own login. */
  isService: boolean;
  /** T210: the Mindbody site id the token was issued for. Null for a
   *  row written before migration 16, which reads as unknown and is
   *  never loaded for any site. */
  siteId: string | null;
}

/** Writes a fresh session's row. Returns whether it landed; false is
 *  "this session lives in memory only until it ends", never a failure
 *  of the sign-in. */
export async function insertStaffSession(row: StaffSessionRow): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO staff_sessions
         (id, staff_id, name, token_enc, issued_at, expires_at, is_service, site_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.staffId,
        row.name,
        row.tokenEnc,
        row.issuedAt,
        row.expiresAt,
        row.isService,
        row.siteId,
      ],
    );
    return true;
  } catch (err) {
    logDbError("staff-session-insert", err);
    return false;
  }
}

/** The row an id names, when it is still inside its two hours; null
 *  when missing, expired, or the store did not answer (the caller
 *  cannot tell which, and treats every null as "no session"). */
export async function findStaffSession(
  id: string,
  now = new Date(),
): Promise<StaffSessionRow | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT id, staff_id, name, token_enc, issued_at, expires_at, is_service, site_id
       FROM staff_sessions WHERE id = $1 AND expires_at > $2`,
      [id, now],
    );
    const r = res.rows[0];
    if (!r) return null;
    return rowOf(r);
  } catch (err) {
    logDbError("staff-session-read", err);
    return null;
  }
}

function rowOf(r: any): StaffSessionRow {
  return {
    id: String(r.id),
    staffId: String(r.staff_id),
    name: String(r.name),
    tokenEnc: String(r.token_enc),
    issuedAt: r.issued_at as Date,
    expiresAt: r.expires_at as Date,
    isService: r.is_service === true,
    siteId:
      r.site_id === null || r.site_id === undefined ? null : String(r.site_id),
  };
}

/**
 * The newest live session opened with the service account's own login
 * FOR THIS SITE (T210), plus the site ids of the live service rows that
 * were passed over, so the caller can say what it skipped and why.
 * Null means the store did not answer; `{row: null}` means it answered
 * and had nothing usable.
 *
 * Before T210 this took the newest service row whatever site it was
 * issued for, and `staffToken()` then cached it under the CURRENT
 * target's site id: a server restarted onto the other studio borrowed
 * a token the other site had issued and every call under it was refused
 * "Delegated staff does not belong to the subscriber.". A row with no
 * site id (written before migration 16) is unknown, which is not this
 * site either.
 */
export async function findServiceStaffSession(
  siteId: string,
  now = new Date(),
): Promise<{ row: StaffSessionRow | null; skipped: string[] } | null> {
  try {
    const p = await ready();
    if (!p) return null;
    /* T210 review: the site is filtered in SQL, so five newer rows of
     * the other studio (two sites on one Postgres) cannot hide this
     * site's. The rows passed over are read separately, for the log. */
    const res = await p.query(
      `SELECT id, staff_id, name, token_enc, issued_at, expires_at, is_service, site_id
       FROM staff_sessions
       WHERE is_service = true AND expires_at > $1 AND site_id = $2
       ORDER BY issued_at DESC LIMIT 1`,
      [now, siteId],
    );
    const mine = res.rows[0] ? rowOf(res.rows[0]) : null;
    const others = await p.query(
      `SELECT site_id FROM staff_sessions
       WHERE is_service = true AND expires_at > $1
         AND (site_id IS NULL OR site_id <> $2)
       ORDER BY issued_at DESC LIMIT 5`,
      [now, siteId],
    );
    return {
      row: mine,
      skipped: others.rows.map((r: { site_id: string | null }) =>
        typeof r.site_id === "string" ? r.site_id : "(no site recorded)",
      ),
    };
  } catch (err) {
    logDbError("staff-session-read", err);
    return null;
  }
}

/** Drops one session's row (sign-out, a dead token, expiry). Returns
 *  whether the store answered; a row already gone is still true. */
export async function deleteStaffSession(id: string): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(`DELETE FROM staff_sessions WHERE id = $1`, [id]);
    return true;
  } catch (err) {
    logDbError("staff-session-delete", err);
    return false;
  }
}

/** Deletes EVERY row and answers their `token_enc` values, for the T89
 *  target switch: a token issued by one site is useless against the
 *  other, so switching signs everyone out and revokes what it can.
 *  Null when the store did not answer, which the caller reports rather
 *  than swallows: the Map is cleared either way, so nobody stays signed
 *  in on this process. */
export async function deleteAllStaffSessions(): Promise<string[] | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `DELETE FROM staff_sessions RETURNING token_enc`,
    );
    return res.rows.map((r) => String(r.token_enc));
  } catch (err) {
    logDbError("staff-session-clear", err);
    return null;
  }
}

/** Deletes every expired row and answers their `token_enc` values, so
 *  the caller can revoke the tokens with Mindbody; null when the store
 *  did not answer. */
export async function sweepStaffSessions(
  now = new Date(),
): Promise<string[] | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `DELETE FROM staff_sessions WHERE expires_at <= $1 RETURNING token_enc`,
      [now],
    );
    return res.rows.map((r) => String(r.token_enc));
  } catch (err) {
    logDbError("staff-session-sweep", err);
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
 * Edit / enable / disable by id. There is deliberately no DELETE on
 * bundles: disable is the safe verb, and a disabled bundle keeps its
 * name and lines for the day it is wanted back. (Settings and staff
 * sessions delete, because a cleared banner and an ended sign-in are
 * nothing anyone needs back.)
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

/** T74: whether a setting can be written right now (a database is
 *  configured, reachable and migrated). getSetting cannot tell "unset"
 *  from "unavailable", and the shelf admin surface must say honestly
 *  which one it is facing before it offers a Save. */
export async function dbAvailable(): Promise<boolean> {
  try {
    return (await ready()) !== null;
  } catch (err) {
    logDbError("availability", err);
    return false;
  }
}

/** Null when unset OR unavailable; the caller cannot and should not tell
 *  the difference, because both mean "use the env fallback". */
export async function getSetting(key: string): Promise<string | null> {
  return (await readSetting(key)).value;
}

/**
 * The same read, with the one thing `getSetting` throws away: whether the
 * store ANSWERED. T89's target is the one setting where the difference
 * matters, because "no row" and "the store is down" have opposite safe
 * answers there: forgetting a stored sandbox on a deployment whose
 * environment names the studio would point a counter at the real studio
 * without anyone asking. Every other setting keeps the simpler rule.
 */
export async function readSetting(
  key: string,
): Promise<{ answered: boolean; value: string | null }> {
  try {
    const p = await ready();
    if (!p) return { answered: false, value: null };
    const res = await p.query(
      "SELECT value FROM app_settings WHERE key = $1",
      [key],
    );
    const value = res.rows[0]?.value;
    return {
      answered: true,
      value: typeof value === "string" && value.length > 0 ? value : null,
    };
  } catch (err) {
    logDbError("settings-read", err);
    return { answered: false, value: null };
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

/* --- The customer display (T200) ------------------------------------- */

export interface DisplayRow {
  id: string;
  name: string | null;
  pairedAt: Date;
  lastSeenAt: Date | null;
}

/** A display request as a row: the scene a teacher put up and the result
 *  the student handed back. `payload` and `result` are jsonb, validated
 *  on the way IN (a plain JSON object, size-capped, in src/lib/display.ts)
 *  and trusted on the way out, the bundles idiom. */
export interface DisplayRequestRow {
  id: string;
  displayId: string;
  kind: string;
  initiator: string;
  payload: unknown;
  status: string;
  result: unknown;
  requestedByStaffId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
}

/** Records a pairing. Upsert on the id so a re-pair of the same iPad is
 *  one row. False is "no database", never a failure of the pairing: the
 *  hub holds it in memory either way and a restart then costs a re-pair,
 *  which the display says on its own screen. */
export async function upsertDisplay(row: {
  id: string;
  name: string | null;
  pairedAt: Date;
}): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO displays (id, name, paired_at, last_seen_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (id) DO UPDATE
         SET name = excluded.name, paired_at = excluded.paired_at`,
      [row.id, row.name, row.pairedAt],
    );
    return true;
  } catch (err) {
    logDbError("display-upsert", err);
    return false;
  }
}

/** The newest paired display, which IS the display (one counter). Null
 *  for none and for a store that did not answer alike: both mean "this
 *  process knows of no paired display but what is in memory". */
export async function latestDisplay(): Promise<DisplayRow | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT id, name, paired_at, last_seen_at
       FROM displays ORDER BY paired_at DESC LIMIT 1`,
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      name: r.name === null ? null : String(r.name),
      pairedAt: r.paired_at as Date,
      lastSeenAt: (r.last_seen_at as Date | null) ?? null,
    };
  } catch (err) {
    logDbError("display-read", err);
    return null;
  }
}

/** Stamps the heartbeat. Throttled by the caller, since a heartbeat is
 *  every 15s and a row write is not free. */
export async function touchDisplay(id: string, at: Date): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(`UPDATE displays SET last_seen_at = $2 WHERE id = $1`, [
      id,
      at,
    ]);
    return true;
  } catch (err) {
    logDbError("display-touch", err);
    return false;
  }
}

/** Unpair: the row goes, and with it any request that named it. A
 *  display nobody paired holds nothing anybody needs back. */
export async function deleteDisplay(id: string): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(`DELETE FROM display_requests WHERE display_id = $1`, [id]);
    await p.query(`DELETE FROM displays WHERE id = $1`, [id]);
    return true;
  } catch (err) {
    logDbError("display-delete", err);
    return false;
  }
}

export async function insertDisplayRequest(
  row: DisplayRequestRow,
): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `INSERT INTO display_requests
         (id, display_id, kind, initiator, payload, status, result,
          requested_by_staff_id, created_at, completed_at, consumed_at,
          expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.displayId,
        row.kind,
        row.initiator,
        row.payload === null ? null : JSON.stringify(row.payload),
        row.status,
        row.result === null ? null : JSON.stringify(row.result),
        row.requestedByStaffId,
        row.createdAt,
        row.completedAt,
        row.consumedAt,
        row.expiresAt,
      ],
    );
    return true;
  } catch (err) {
    logDbError("display-request-insert", err);
    return false;
  }
}

/** The outcome of a request: its status, its result, and when it
 *  finished. Separate from the insert so the hot path (present) writes
 *  once and the answer writes once. */
export async function updateDisplayRequest(update: {
  id: string;
  status: string;
  result: unknown;
  completedAt: Date | null;
}): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `UPDATE display_requests
         SET status = $2, result = $3, completed_at = $4
       WHERE id = $1`,
      [
        update.id,
        update.status,
        update.result === null ? null : JSON.stringify(update.result),
        update.completedAt,
      ],
    );
    return true;
  } catch (err) {
    logDbError("display-request-update", err);
    return false;
  }
}

/**
 * T201: a live ticket's payload is REPLACED in place as the cart changes,
 * so the row follows the scene rather than growing one row per keystroke.
 * Charter-clean for the same reason the insert is: the payload is what a
 * student can already read on the screen in front of them, and nothing
 * Mindbody holds.
 */
export async function updateDisplayRequestPayload(
  id: string,
  payload: unknown,
  expiresAt: Date,
): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(
      `UPDATE display_requests
         SET payload = $2, expires_at = $3
       WHERE id = $1 AND status = 'pending'`,
      [id, JSON.stringify(payload), expiresAt],
    );
    return true;
  } catch (err) {
    logDbError("display-request-payload", err);
    return false;
  }
}

/** Spends a result: the one finalisation. False when no row moved (it
 *  was consumed already, or there is no database), which the caller
 *  reads as "not mine to spend" only alongside its own memory.
 *
 *  Review fix (T204): the result is CLEARED in the same statement. A
 *  result is a handle for one finalisation and not a record (the design
 *  doc's rule), and a spent sign-up's row otherwise kept the student's
 *  email, phone and signature until the sweep, which for a sign-up is
 *  four hours away. Nothing reads a result after it is spent: every
 *  reader (liveSignup, pendingSignups, the create route) requires
 *  consumed_at to be null. */
export async function consumeDisplayRequest(id: string): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    const res = await p.query(
      `UPDATE display_requests SET consumed_at = now(), result = NULL
       WHERE id = $1 AND consumed_at IS NULL`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    logDbError("display-request-consume", err);
    return false;
  }
}

/** The display's live request after a restart: the newest one still
 *  inside its 30 minutes that nobody has finalised. */
export async function findLiveDisplayRequest(
  displayId: string,
  now = new Date(),
): Promise<DisplayRequestRow | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT id, display_id, kind, initiator, payload, status, result,
              requested_by_staff_id, created_at, completed_at, consumed_at,
              expires_at
       FROM display_requests
       WHERE display_id = $1 AND expires_at > $2 AND consumed_at IS NULL
         AND status IN ('pending', 'completed', 'refused')
       ORDER BY created_at DESC LIMIT 1`,
      [displayId, now],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      displayId: String(r.display_id),
      kind: String(r.kind),
      initiator: String(r.initiator),
      payload: r.payload ?? null,
      status: String(r.status),
      result: r.result ?? null,
      requestedByStaffId:
        r.requested_by_staff_id === null
          ? null
          : String(r.requested_by_staff_id),
      createdAt: r.created_at as Date,
      completedAt: (r.completed_at as Date | null) ?? null,
      consumedAt: (r.consumed_at as Date | null) ?? null,
      expiresAt: r.expires_at as Date,
    };
  } catch (err) {
    logDbError("display-request-read", err);
    return null;
  }
}

/** Expired rows go, results and all: a result is a handle for one
 *  finalisation, not a record (the design doc's rule). */
export async function sweepDisplayRequests(
  now = new Date(),
): Promise<boolean> {
  try {
    const p = await ready();
    if (!p) return false;
    await p.query(`DELETE FROM display_requests WHERE expires_at <= $1`, [now]);
    return true;
  } catch (err) {
    logDbError("display-request-sweep", err);
    return false;
  }
}

/**
 * T204: every self-serve sign-up waiting for a teacher, newest last.
 * Completed, unconsumed and inside its four hours; anything else is
 * either spent, refused or gone. The tray reads this beside the hub's
 * own memory, which is what makes a signature and a typed name survive
 * a restart between the student tapping agree and the teacher creating
 * them.
 */
export async function listSelfServeSignups(
  now = new Date(),
  limit = 50,
): Promise<DisplayRequestRow[]> {
  try {
    const p = await ready();
    if (!p) return [];
    const res = await p.query(
      `SELECT id, display_id, kind, initiator, payload, status, result,
              requested_by_staff_id, created_at, completed_at, consumed_at,
              expires_at
         FROM display_requests
        WHERE kind = 'register' AND initiator = 'display'
          AND status = 'completed' AND consumed_at IS NULL
          AND expires_at > $1
        ORDER BY completed_at ASC
        LIMIT $2`,
      [now, limit],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      displayId: String(r.display_id),
      kind: String(r.kind),
      initiator: String(r.initiator),
      payload: r.payload ?? null,
      status: String(r.status),
      result: r.result ?? null,
      requestedByStaffId:
        r.requested_by_staff_id === null ? null : String(r.requested_by_staff_id),
      createdAt: new Date(r.created_at),
      completedAt: r.completed_at === null ? null : new Date(r.completed_at),
      consumedAt: r.consumed_at === null ? null : new Date(r.consumed_at),
      expiresAt: new Date(r.expires_at),
    }));
  } catch (err) {
    logDbError("display-signups-read", err);
    return [];
  }
}

/* --- T202: reading our own waiver receipts --------------------------- */

/**
 * The newest waiver receipt for a client that carries a SIGNATURE, for
 * the profile card's one line ("signed on the customer screen on ...").
 * Reading our own row is exactly what the charter permits: the row is
 * ours, Mindbody has no home for it, and nothing about Mindbody's own
 * state is inferred from it. The PNG itself is deliberately NOT selected
 * and is never rendered back into the POS.
 */
export async function latestSignedWaiverReceipt(
  clientId: string,
): Promise<{ agreedAt: Date; signatureSha256: string } | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT agreed_at, signature_sha256
         FROM waiver_receipts
        WHERE client_id = $1 AND signature_sha256 IS NOT NULL
        ORDER BY agreed_at DESC LIMIT 1`,
      [clientId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      agreedAt: new Date(r.agreed_at),
      signatureSha256: String(r.signature_sha256),
    };
  } catch (err) {
    logDbError("waiver-receipt-read", err);
    return null;
  }
}

/**
 * One display request BY ID (T202). T200's reload only ever looked up
 * the display's newest live request, which is right for a restart and
 * wrong for a finalisation: the teacher's iPad names the request it was
 * told about, and that one may no longer be the hub's `current` (a
 * later scene took the screen) or may not be in memory at all (the
 * server restarted between the student tapping Done and the teacher's
 * iPad consuming it, which is the ONE reason this table exists).
 */
export async function findDisplayRequestById(
  id: string,
): Promise<DisplayRequestRow | null> {
  try {
    const p = await ready();
    if (!p) return null;
    const res = await p.query(
      `SELECT id, display_id, kind, initiator, payload, status, result,
              requested_by_staff_id, created_at, completed_at, consumed_at,
              expires_at
         FROM display_requests
        WHERE id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      displayId: String(r.display_id),
      kind: String(r.kind),
      initiator: String(r.initiator),
      payload: r.payload ?? null,
      status: String(r.status),
      result: r.result ?? null,
      requestedByStaffId:
        r.requested_by_staff_id === null
          ? null
          : String(r.requested_by_staff_id),
      createdAt: new Date(r.created_at),
      completedAt: r.completed_at === null ? null : new Date(r.completed_at),
      consumedAt: r.consumed_at === null ? null : new Date(r.consumed_at),
      expiresAt: new Date(r.expires_at),
    };
  } catch (err) {
    logDbError("display-request-find", err);
    return null;
  }
}
