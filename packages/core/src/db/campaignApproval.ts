import { getPool } from "./client.js";
import type { Queryable } from "./campaignContacts.js";
import type { Item } from "./items.js";

/**
 * Campaign approval persistence (SEA-83), over the SEA-80 schema
 * (migrations/0011_campaigns.sql) and the items backbone. No new
 * migration: the campaign_approval item is an ordinary items row, and the
 * campaigns table already carries status / approved_by / approved_at.
 *
 * The approval is the email_reply pattern's sibling: two events joined by
 * durable state. Event one, campaigns.draft files ONE campaign_approval
 * item per campaign (pending_approval) and moves the campaign to
 * pending_approval. Event two, an operator decides the item in the
 * console; decideCampaignApproval below resolves the item AND flips the
 * campaign row in one transaction, so the item's audit trail and the
 * campaign's status can never disagree.
 *
 * Approval STOPS at the status flip. The send job is SEA-84 (not built);
 * see onCampaignApproved in campaigns/draftCampaign.ts for the seam.
 */

/** One frozen-snapshot recipient with the contact fields the card needs. */
export interface SnapshotRecipient {
  contactId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  segment: string;
  snapshotAt: Date;
}

/**
 * The frozen campaign_audience snapshot joined to contacts, in a
 * deterministic order (contact id) so "the sample recipient" is stable
 * across retries of the draft job. Contacts are joined even if since
 * soft-deleted: the snapshot is history and must stay readable (the 0011
 * RESTRICT design), and the card shows who was frozen, not who survives.
 */
export async function listSnapshotRecipients(
  db: Queryable,
  campaignId: string,
): Promise<SnapshotRecipient[]> {
  const result = await db.query(
    `SELECT a.contact_id, c.email, c.first_name, c.last_name,
            coalesce(a.segment, 'default') AS segment, a.snapshot_at
     FROM campaign_audience a
     JOIN contacts c ON c.id = a.contact_id
     WHERE a.campaign_id = $1
     ORDER BY a.contact_id`,
    [campaignId],
  );
  return (
    result.rows as Array<{
      contact_id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      segment: string;
      snapshot_at: Date;
    }>
  ).map((r) => ({
    contactId: String(r.contact_id),
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    segment: r.segment,
    snapshotAt: r.snapshot_at,
  }));
}

/**
 * Move a campaign to pending_approval when its approval item is filed.
 * Guarded: only a 'draft' campaign moves; a campaign already
 * pending_approval is a fine no-op (a retried draft job), and anything
 * further along (approved/sending/sent/cancelled) is refused so a stale
 * re-draft can never yank an approved campaign back. Returns the status
 * the campaign ended up in, or null when the campaign is beyond approval.
 */
export async function markCampaignPendingApproval(
  db: Queryable,
  campaignId: string,
): Promise<string | null> {
  const result = await db.query(
    `UPDATE campaigns SET status = 'pending_approval'
     WHERE id = $1 AND status IN ('draft', 'pending_approval')
     RETURNING status`,
    [campaignId],
  );
  const row = result.rows[0] as { status: string } | undefined;
  return row?.status ?? null;
}

/** The two decisions a campaign_approval item can carry. */
export type CampaignDecision = "approved" | "rejected";

/**
 * Decision audit record written into the item payload under `decision`,
 * the exact shape the email_reply flow writes (console lib/approvals
 * DecisionRecord) so the console's decided views and any future learning
 * pass read one field for every item type.
 */
export interface CampaignDecisionRecord {
  action: CampaignDecision;
  by: { id: string; name: string };
  at: string;
  edited: boolean;
}

export type CampaignDecisionOutcome =
  | {
      /** Both rows updated and committed. */
      status: "decided";
      item: Item;
      campaign: { id: string; key: string; status: string };
    }
  | {
      /** The item was no longer pending (another operator decided). */
      status: "stale_item";
    }
  | {
      /**
       * The item was pending but the CAMPAIGN was not pending_approval
       * (cancelled underneath, or state drifted). Rolled back: the item
       * stays pending so the mismatch is visible, never half-recorded.
       */
      status: "campaign_conflict";
      campaignStatus: string | null;
    };

/**
 * Minimal pool/client surface decideCampaignApproval needs, structural so
 * the offline smoke can drive every branch (guards, rollback, ordering)
 * through an in-memory fake. Production passes nothing and gets the
 * shared pg pool (pg.Pool satisfies this structurally).
 */
export interface TransactionClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}
export interface TransactionPool {
  connect(): Promise<TransactionClient>;
}

/**
 * Decide a campaign_approval item and flip the campaign row, atomically.
 *
 * ONE transaction, two guarded UPDATEs:
 *
 * 1. items: pending_approval -> resolved with the decision audit, guarded
 *    on status AND type, so a double click or approve-racing-reject loses
 *    cleanly (stale_item) exactly like decideItem does for email replies.
 * 2. campaigns: pending_approval -> 'approved' (stamping approved_by +
 *    approved_at, satisfying the 0011 pairing CHECK) or, on reject,
 *    pending_approval -> 'draft' (back to the drafting board: the
 *    audience can be rebuilt and campaigns.draft re-fired; 'cancelled'
 *    remains a deliberate operator act elsewhere, not a side effect of
 *    rejecting one draft). Guarded on status = 'pending_approval'; a miss
 *    rolls the WHOLE transaction back (campaign_conflict), so the item
 *    can never claim a decision the campaign row does not carry.
 *
 * Approval stops here. Nothing is enqueued: the send job is SEA-84 (see
 * onCampaignApproved).
 */
export async function decideCampaignApproval(
  itemId: string,
  action: CampaignDecision,
  by: { id: string; name: string },
  pool: TransactionPool = getPool(),
): Promise<CampaignDecisionOutcome> {
  const record: CampaignDecisionRecord = {
    action,
    by,
    at: new Date().toISOString(),
    edited: false,
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const itemResult = await client.query(
      `UPDATE items
       SET payload = payload || jsonb_build_object('decision', $2::jsonb),
           status = 'resolved',
           resolved_at = now()
       WHERE id = $1 AND type = 'campaign_approval'
         AND status = 'pending_approval'
       RETURNING *`,
      [itemId, JSON.stringify(record)],
    );
    const item = itemResult.rows[0] as Item | undefined;
    if (!item) {
      await client.query("ROLLBACK");
      return { status: "stale_item" };
    }

    const campaignId = (item.payload as Record<string, unknown>)["campaign_id"];
    if (typeof campaignId !== "string" || campaignId.length === 0) {
      // A campaign_approval item without its campaign pointer is malformed;
      // refuse rather than resolve an item that flips nothing.
      await client.query("ROLLBACK");
      return { status: "campaign_conflict", campaignStatus: null };
    }

    const campaignResult = await client.query(
      action === "approved"
        ? // approved_by + approved_at together (the 0011 pairing CHECK).
          `UPDATE campaigns
           SET status = 'approved', approved_by = $2, approved_at = now()
           WHERE id = $1 AND status = 'pending_approval'
           RETURNING id, key, status`
        : `UPDATE campaigns
           SET status = 'draft'
           WHERE id = $1 AND status = 'pending_approval'
           RETURNING id, key, status`,
      action === "approved" ? [campaignId, by.id] : [campaignId],
    );
    const campaign = campaignResult.rows[0] as
      | { id: string; key: string; status: string }
      | undefined;
    if (!campaign) {
      await client.query("ROLLBACK");
      const current = await client.query(
        `SELECT status FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      return {
        status: "campaign_conflict",
        campaignStatus:
          (current.rows[0] as { status: string } | undefined)?.status ?? null,
      };
    }

    await client.query("COMMIT");
    return {
      status: "decided",
      item,
      campaign: {
        id: String(campaign.id),
        key: campaign.key,
        status: campaign.status,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
