import { pgSendDiffStore, type SendDiffStore } from "../db/sendDiff.js";
import {
  SEND_DIFF_SAMPLE_LIMIT,
  type PriorSendInfo,
  type RecipientDelta,
  type SendDiff,
} from "./sendDiffTypes.js";

/**
 * campaigns.send_diff (SEA-86): "what changes about this send versus the
 * last one of this campaign key". Pure read; renders on the SEA-83
 * approval card and via `npm run send-diff -- --campaign <key>`.
 *
 * Two sides of the comparison:
 *   prior   -- the immutable campaign_sends rows of the campaign row
 *              (the durable record of who was actually mailed; see
 *              db/sendDiff.ts for why campaign_audience cannot serve --
 *              it is replaced wholesale on every rebuild). "A prior send
 *              exists" means at least one send row has left 'queued'
 *              (sent / failed / skipped_suppressed); a campaign whose
 *              rows are all still queued is mid-flight, not history, and
 *              this returns null the same as a first send.
 *   current -- the frozen campaign_audience snapshot, resolved to the
 *              live contact addresses that an enqueue would mail today.
 *
 * Recipient identity is the lowercased EMAIL ADDRESS on both sides
 * (schema design point 3: the address is the durable identity, contact
 * ids churn). recipientsDropped compares against addresses the prior
 * send ACTUALLY MAILED (status = 'sent'): an address that was recorded
 * but skipped as suppressed last time and is absent now was never
 * "dropped" from anyone's inbox, though it is still visible in the
 * priorSend counts.
 *
 * Copy comparison: no durable artifact stores the last-sent subject/body
 * yet -- the campaigns table has no copy columns and the send job is
 * SEA-84 -- so copyChanged is null ("unknown") with a copySummary saying
 * why. SEA-84 REQUIREMENT: the send job must snapshot the copy it sends
 * (subject + body, per campaign run) into a durable row; once it does,
 * this function compares the current draft copy against that snapshot
 * and copyChanged becomes a real boolean.
 */

/** Injectable dependencies; production callers pass nothing. */
export interface SendDiffDeps {
  store: SendDiffStore;
}

function defaultDeps(): SendDiffDeps {
  return { store: pgSendDiffStore() };
}

const COPY_UNKNOWN_SUMMARY =
  "copy comparison unavailable: nothing durable stores the last-sent copy yet (SEA-84's send job must snapshot subject/body per run before this can be a real comparison)";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Exact count + bounded ascending sample from a set of addresses. */
function toDelta(emails: ReadonlySet<string>): RecipientDelta {
  const sorted = [...emails].sort();
  return {
    count: sorted.length,
    sample: sorted.slice(0, SEND_DIFF_SAMPLE_LIMIT),
    sampleLimit: SEND_DIFF_SAMPLE_LIMIT,
  };
}

/**
 * Compute the diff for a campaign key. Returns null when the campaign
 * has no prior send (nothing to diff against: this is the first send).
 * Throws on an unknown key -- a missing campaign is a caller bug, never
 * a silent "no diff".
 */
export async function computeSendDiff(
  campaignKey: string,
  deps: SendDiffDeps = defaultDeps(),
): Promise<SendDiff | null> {
  const campaign = await deps.store.getCampaignByKey(campaignKey);
  if (!campaign) {
    throw new Error(`campaigns.send_diff: no campaign with key '${campaignKey}'`);
  }

  const sendRows = await deps.store.listCampaignSendRows(campaign.id);
  const terminal = sendRows.filter((r) => r.status !== "queued");
  if (terminal.length === 0) {
    // First send (or a run still entirely queued): no prior send exists.
    return null;
  }

  // Distinct addresses per prior outcome; 'sent' is what "last time's
  // recipients" means for the drop comparison.
  const priorSent = new Set<string>();
  const priorFailed = new Set<string>();
  const priorSkipped = new Set<string>();
  let latestSentAt: Date | null = null;
  for (const row of terminal) {
    const email = normalizeEmail(row.email);
    if (row.status === "sent") {
      priorSent.add(email);
      if (row.sentAt && (!latestSentAt || row.sentAt > latestSentAt)) {
        latestSentAt = row.sentAt;
      }
    } else if (row.status === "failed") {
      priorFailed.add(email);
    } else {
      priorSkipped.add(email);
    }
  }

  const current = new Set(
    (await deps.store.listAudienceEmails(campaign.id)).map(normalizeEmail),
  );

  const added = new Set([...current].filter((e) => !priorSent.has(e)));
  const dropped = new Set([...priorSent].filter((e) => !current.has(e)));

  const priorSend: PriorSendInfo = {
    campaignId: campaign.id,
    runSeq: campaign.runSeq,
    sentAt: latestSentAt,
    sentCount: priorSent.size,
    skippedSuppressedCount: priorSkipped.size,
    failedCount: priorFailed.size,
  };

  const when = latestSentAt ? latestSentAt.toISOString() : "unknown time";
  const summary =
    `vs last send of '${campaignKey}' (${priorSend.sentCount} sent, ${when}): ` +
    `${added.size} added, ${dropped.size} dropped, ` +
    `${current.size} now in audience; copy: unknown`;

  return {
    campaignKey: campaign.key,
    recipientsAdded: toDelta(added),
    recipientsDropped: toDelta(dropped),
    copyChanged: null,
    copySummary: COPY_UNKNOWN_SUMMARY,
    currentAudienceCount: current.size,
    priorSend,
    summary,
  };
}
