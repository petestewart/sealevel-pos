import { extractAddress } from "../gmail/parse.js";
import { getPool } from "./client.js";

/**
 * Spam learning store (GH-96): the persistent, inspectable list of
 * human-confirmed spam senders and domains. When an operator confirms an
 * item is spam, recordSpamSignal saves the sender AND its domain here;
 * inbound ingestion calls matchesSpamSignal on every new message so mail
 * from a known-spam sender is pre-flagged (or auto-trashed) without the
 * operator having to catch it again. Simple and auditable by design -- the
 * operator can list and delete signals; there is no opaque model.
 */

export type SpamSignalKind = "sender" | "domain";

export interface SpamSignal {
  id: string;
  kind: SpamSignalKind;
  value: string;
  reason: string | null;
  hit_count: number;
  created_at: Date;
  last_seen_at: Date;
  created_by: string | null;
}

/** Bare, lowercased email address from a From header value, or "". */
function normalizeAddress(from: string | undefined): string {
  return extractAddress(from).toLowerCase();
}

/** Domain (after the last @) of an address, or "" when there is none. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

/**
 * Record a confirmed-spam sender. Saves the full sender address and,
 * separately, its domain, so future mail from either the same person or the
 * same domain matches. Upserts on (kind, value): a repeat confirmation
 * bumps hit_count and last_seen_at rather than duplicating. Domain-only
 * senders (no address) record just what is available. Never throws on a
 * malformed address; it simply records nothing.
 */
export async function recordSpamSignal(
  from: string | undefined,
  by: { id: string; name: string },
  reason?: string,
): Promise<void> {
  const address = normalizeAddress(from);
  if (!address) return;
  const domain = domainOf(address);

  const rows: Array<{ kind: SpamSignalKind; value: string }> = [
    { kind: "sender", value: address },
  ];
  // Only add a domain signal when it is a real domain and distinct.
  if (domain && domain !== address) {
    rows.push({ kind: "domain", value: domain });
  }

  const pool = getPool();
  for (const row of rows) {
    await pool.query(
      `INSERT INTO spam_signals (kind, value, reason, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, value) DO UPDATE
         SET hit_count = spam_signals.hit_count + 1,
             last_seen_at = now(),
             reason = COALESCE(EXCLUDED.reason, spam_signals.reason)`,
      [row.kind, row.value, reason ?? null, by.name],
    );
  }
}

/**
 * Whether an inbound sender matches a known-spam signal. Checks the exact
 * sender address first, then its domain. Returns the matched signal (for
 * logging / display) or null. Read-only and total; safe to call on every
 * ingested message.
 */
export async function matchesSpamSignal(
  from: string | undefined,
): Promise<SpamSignal | null> {
  const address = normalizeAddress(from);
  if (!address) return null;
  const domain = domainOf(address);

  const { rows } = await getPool().query<SpamSignal>(
    `SELECT * FROM spam_signals
     WHERE (kind = 'sender' AND value = $1)
        OR (kind = 'domain' AND value = $2)
     ORDER BY kind = 'sender' DESC
     LIMIT 1`,
    [address, domain],
  );
  return rows[0] ?? null;
}

/** All spam signals, most recently seen first (for the settings UI). */
export async function listSpamSignals(limit = 200): Promise<SpamSignal[]> {
  const { rows } = await getPool().query<SpamSignal>(
    `SELECT * FROM spam_signals ORDER BY last_seen_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Remove a spam signal (operator un-learns a sender). Returns true if removed. */
export async function deleteSpamSignal(id: string): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM spam_signals WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}
