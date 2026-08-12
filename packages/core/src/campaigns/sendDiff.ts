import { pgSendDiffStore, type SendDiffStore } from "../db/sendDiff.js";
import {
  SEND_DIFF_SAMPLE_LIMIT,
  type PriorCopy,
  type PriorSendInfo,
  type RecipientDelta,
  type SendDiff,
} from "./sendDiffTypes.js";
export type { PriorCopy } from "./sendDiffTypes.js";

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
 * Copy comparison (completed by SEA-84): the send job snapshots the copy
 * it sends (subject + body, per campaign run) into
 * campaign_copy_snapshots (0018) before the first message of a run
 * leaves. This function compares the CURRENT draft copy -- passed in by
 * the caller (the draft job knows the copy it just wrote), or read back
 * from the run's campaign_approval item -- against the newest stored
 * snapshot, and copyChanged is a real boolean whenever both sides exist.
 * The null ("unknown") path deliberately survives for pre-snapshot
 * history (runs sent before 0018 stored nothing durable) and for a diff
 * computed before the current run has any draft.
 */

/** Injectable dependencies; production callers pass nothing. */
export interface SendDiffDeps {
  store: SendDiffStore;
}

function defaultDeps(): SendDiffDeps {
  return { store: pgSendDiffStore() };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A single draft/sent copy pair. */
export interface CopyPair {
  subject: string;
  body: string;
}

/** One current-copy variant (mirrors PriorCopyVariant; '' segment = the
 * single-copy shape). */
export interface CurrentCopyVariant extends CopyPair {
  segment: string;
}

/** The current draft copy in either shape: the SEA-83 single trio or
 * the SEA-88 per-segment variants set. */
export type CurrentCopy = CopyPair | { variants: CurrentCopyVariant[] };

/** Whether two copies differ, whitespace-trimmed (a retoucher's stray
 * trailing newline is not a copy change; any wording change is). */
export function copyDiffers(prior: CopyPair, current: CopyPair): boolean {
  return (
    prior.subject.trim() !== current.subject.trim() ||
    prior.body.trim() !== current.body.trim()
  );
}

/** Normalize either copy shape to a segment-keyed map ('' = single). */
function copyMapOf(
  copy: CurrentCopy | PriorCopy,
): Map<string, CopyPair> {
  const map = new Map<string, CopyPair>();
  if ("variants" in copy) {
    for (const v of copy.variants) {
      map.set(v.segment, { subject: v.subject, body: v.body });
    }
  } else {
    map.set("", { subject: copy.subject, body: copy.body });
  }
  return map;
}

/** Human label for a segment key ('' = the base single copy). */
function segmentLabel(segment: string): string {
  return segment === "" ? "base" : segment;
}

/**
 * The copy-comparison verdict for one (priorCopy, currentCopy) pairing,
 * PER SEGMENT: copyChanged = true iff any segment's trimmed
 * subject/body differs OR the segment set itself changed (a variant
 * added or removed is a copy change -- someone will receive different
 * mail than last run). copySummary names the changed segments. Exported
 * for the smoke and for withCurrentCopy.
 */
export function compareCopy(
  priorCopy: PriorCopy | null,
  currentCopy: CurrentCopy | null,
): { copyChanged: boolean | null; copySummary: string } {
  if (!priorCopy) {
    return {
      copyChanged: null,
      copySummary:
        "copy comparison unavailable: no stored prior copy (the prior send predates copy snapshots)",
    };
  }
  if (!currentCopy) {
    return {
      copyChanged: null,
      copySummary: `prior copy is stored (run ${priorCopy.runSeq}); no current draft exists yet to compare against`,
    };
  }
  const prior = copyMapOf(priorCopy);
  const current = copyMapOf(currentCopy);
  const added = [...current.keys()].filter((s) => !prior.has(s)).sort();
  const removed = [...prior.keys()].filter((s) => !current.has(s)).sort();
  const edited = [...current.keys()]
    .filter((s) => prior.has(s) && copyDiffers(prior.get(s)!, current.get(s)!))
    .sort();

  if (added.length === 0 && removed.length === 0 && edited.length === 0) {
    return {
      copyChanged: false,
      copySummary: `copy is identical to the stored run ${priorCopy.runSeq} copy (all ${prior.size} segment${prior.size === 1 ? "" : "s"})`,
    };
  }
  const parts: string[] = [];
  if (edited.length > 0) {
    parts.push(`edited: ${edited.map(segmentLabel).join(", ")}`);
  }
  if (added.length > 0) {
    parts.push(`segments added: ${added.map(segmentLabel).join(", ")}`);
  }
  if (removed.length > 0) {
    parts.push(`segments removed: ${removed.map(segmentLabel).join(", ")}`);
  }
  return {
    copyChanged: true,
    copySummary: `copy CHANGED versus the stored run ${priorCopy.runSeq} copy (${parts.join("; ")})`,
  };
}

/** Human label for the summary line's copy clause. */
function copyLabel(copyChanged: boolean | null): string {
  return copyChanged === null ? "unknown" : copyChanged ? "CHANGED" : "unchanged";
}

/** Build the one-line summary from its parts (kept in one place so
 * withCurrentCopy rebuilds it identically). */
function buildSummary(options: {
  campaignKey: string;
  sentCount: number;
  when: string;
  added: number;
  dropped: number;
  currentCount: number;
  copyChanged: boolean | null;
}): string {
  return (
    `vs last send of '${options.campaignKey}' (${options.sentCount} sent, ${options.when}): ` +
    `${options.added} added, ${options.dropped} dropped, ` +
    `${options.currentCount} now in audience; copy: ${copyLabel(options.copyChanged)}`
  );
}

/**
 * Re-run the copy comparison on an existing diff with a KNOWN current
 * copy: the draft job calls this at create-approval time, when the
 * model's actual subject/body exist, so the approval card's copyChanged
 * reflects the exact draft the human is deciding. Pure; returns a new
 * diff, never mutates.
 */
export function withCurrentCopy(diff: SendDiff, currentCopy: CurrentCopy): SendDiff {
  const verdict = compareCopy(diff.priorCopy ?? null, currentCopy);
  const when = diff.priorSend.sentAt
    ? diff.priorSend.sentAt.toISOString()
    : "unknown time";
  return {
    ...diff,
    copyChanged: verdict.copyChanged,
    copySummary: verdict.copySummary,
    summary: buildSummary({
      campaignKey: diff.campaignKey,
      sentCount: diff.priorSend.sentCount,
      when,
      added: diff.recipientsAdded.count,
      dropped: diff.recipientsDropped.count,
      currentCount: diff.currentAudienceCount,
      copyChanged: verdict.copyChanged,
    }),
  };
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
  options: {
    /** The current draft copy when the caller already holds it (the
     * draft job); omitted = read the run's campaign_approval item. */
    currentCopy?: CurrentCopy;
  } = {},
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

  // The copy comparison (SEA-84): stored prior copy vs the current
  // draft. Either side can honestly be missing; compareCopy says so.
  const priorCopy = await deps.store.getLatestCopySnapshot(campaign.id);
  const currentCopy =
    options.currentCopy ??
    (await deps.store.getDraftCopy(campaign.id, campaign.runSeq));
  const verdict = compareCopy(priorCopy, currentCopy);

  const when = latestSentAt ? latestSentAt.toISOString() : "unknown time";
  const summary = buildSummary({
    campaignKey,
    sentCount: priorSend.sentCount,
    when,
    added: added.size,
    dropped: dropped.size,
    currentCount: current.size,
    copyChanged: verdict.copyChanged,
  });

  return {
    campaignKey: campaign.key,
    recipientsAdded: toDelta(added),
    recipientsDropped: toDelta(dropped),
    copyChanged: verdict.copyChanged,
    copySummary: verdict.copySummary,
    priorCopy,
    currentAudienceCount: current.size,
    priorSend,
    summary,
  };
}
