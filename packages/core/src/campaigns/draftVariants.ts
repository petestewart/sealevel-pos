/**
 * Segment-variant drafting layer (SEA-88): one campaign, per-segment copy
 * variants. Pure data + pure functions, no LLM and no DB.
 *
 * SEAM with SEA-83 (campaigns.draft, built in parallel): this module owns
 * everything BEFORE a draft job runs. It turns a campaign's reviewable
 * content brief (a SegmentedDraftRequest) plus buildAudience's per-segment
 * counts into one SegmentDraftJob per non-empty segment. SEA-83's draft
 * job consumes a SegmentDraftJob as its input: the brief tells the model
 * what may be said to that bucket, the copy rules carry the house rules
 * (no em dashes in outgoing copy, per CLAUDE.md), and the recipient count
 * lets the job report scope. Nothing here imports from, or depends on,
 * the SEA-83 branch.
 */

/** Copy guidance for ONE audience segment. All strings are reviewable
 * content, not code: they end up in front of the drafting model. */
export interface SegmentVariant {
  /** The segment label exactly as the analytics view emits it. */
  segment: string;
  /** Who this bucket is, in one sentence (for the reviewer and model). */
  audience: string;
  /** Per-segment copy guidance lines, including the segment's own
   * vinyasa framing where the campaign calls for one. */
  framing: readonly string[];
}

/** A draft request with N segment variants: the campaign-level brief. */
export interface SegmentedDraftRequest {
  /** campaigns.key of the row this brief drafts for. */
  campaignKey: string;
  /** The analytics view the audience (and its segment labels) come from. */
  audienceView: string;
  /** What the email is about, one line. */
  subjectTheme: string;
  /** Facts every variant may state. Copy must not claim anything that is
   * not in here or in the variant's framing. */
  sharedFacts: readonly string[];
  /** House rules applied to every variant's copy. */
  copyRules: readonly string[];
  variants: readonly SegmentVariant[];
  /** Variant used when the view emits a label the brief does not know.
   * Must name one of `variants`. A facts-only view should never surprise
   * us, but a send-week view change must degrade to safe generic copy,
   * not crash the draft run or email the wrong framing. */
  fallbackSegment: string;
}

/** One per-segment drafting job: the unit SEA-83's campaigns.draft
 * consumes. Self-contained on purpose (brief fields are copied in) so a
 * queued job stays valid even if the in-repo brief moves on. */
export interface SegmentDraftJob {
  campaignKey: string;
  /** The segment label from the audience (may be unknown to the brief). */
  segment: string;
  /** Recipients in this segment per the audience build/dry-run. */
  recipients: number;
  /** The variant drafting this segment (the fallback for unknowns). */
  variant: SegmentVariant;
  subjectTheme: string;
  sharedFacts: readonly string[];
  copyRules: readonly string[];
}

export interface VariantPlan {
  jobs: SegmentDraftJob[];
  /** Brief variants with no recipients this run (no job fanned out). */
  emptySegments: string[];
  /** Audience labels the brief did not know; drafted via the fallback. */
  unknownSegments: string[];
}

/**
 * THE canonical no-em-dash character class (SEA-88 integration): em dash
 * plus its lookalikes (horizontal bar, two-em/three-em dash). En dash
 * (U+2013) stays legal: ranges like 6–7pm are fine. Defined HERE (the
 * dependency-free module) and re-exported by draftCampaign.ts so every
 * layer checks the exact same characters; do not fork this class.
 */
export const EM_DASH_RE = /[—―⸺⸻]/;

/** True when the text violates the no-em-dash convention (CLAUDE.md:
 * no em dashes in any outgoing user-facing copy). */
export function containsEmDash(text: string): boolean {
  return EM_DASH_RE.test(text);
}

/** Every copy-bearing string in the request that contains an em dash
 * (or lookalike; the superset class above, one character class
 * everywhere). House rule (CLAUDE.md): no em dashes in outgoing
 * user-facing copy, and guidance that contains one gets echoed into
 * drafts, so the brief itself must be clean. */
export function findEmDashes(request: SegmentedDraftRequest): string[] {
  const copyStrings = [
    request.subjectTheme,
    ...request.sharedFacts,
    ...request.copyRules,
    ...request.variants.flatMap((v) => [v.audience, ...v.framing]),
  ];
  return copyStrings.filter((s) => containsEmDash(s));
}

/**
 * Fan a campaign brief out into one draft job per audience segment.
 *
 * `segmentCounts` is buildAudience's per-segment recipient count
 * (BuildAudienceResult.segmentCounts, from a dry-run or a real build).
 * Jobs come out in brief-variant order, then unknown labels in sorted
 * order, so the plan is deterministic for smokes and for review.
 */
export function planSegmentVariants(
  request: SegmentedDraftRequest,
  segmentCounts: Record<string, number>,
): VariantPlan {
  const dashed = findEmDashes(request);
  if (dashed.length > 0) {
    throw new Error(
      `planSegmentVariants: em dash in copy guidance (house rule: none in outgoing copy): ${JSON.stringify(dashed[0])}`,
    );
  }
  const byLabel = new Map(request.variants.map((v) => [v.segment, v]));
  if (byLabel.size !== request.variants.length) {
    throw new Error("planSegmentVariants: duplicate segment labels in brief");
  }
  const fallback = byLabel.get(request.fallbackSegment);
  if (!fallback) {
    throw new Error(
      `planSegmentVariants: fallbackSegment '${request.fallbackSegment}' is not one of the brief's variants`,
    );
  }

  const jobs: SegmentDraftJob[] = [];
  const emptySegments: string[] = [];
  const unknownSegments: string[] = [];
  const job = (
    segment: string,
    recipients: number,
    variant: SegmentVariant,
  ): SegmentDraftJob => ({
    campaignKey: request.campaignKey,
    segment,
    recipients,
    variant,
    subjectTheme: request.subjectTheme,
    sharedFacts: request.sharedFacts,
    copyRules: request.copyRules,
  });

  for (const variant of request.variants) {
    const count = segmentCounts[variant.segment] ?? 0;
    if (count > 0) jobs.push(job(variant.segment, count, variant));
    else emptySegments.push(variant.segment);
  }
  const unknown = Object.keys(segmentCounts)
    .filter((label) => !byLabel.has(label) && (segmentCounts[label] ?? 0) > 0)
    .sort();
  for (const label of unknown) {
    unknownSegments.push(label);
    jobs.push(job(label, segmentCounts[label]!, fallback));
  }

  // The fan-out identity: every audience recipient is covered by exactly
  // one job, so per-variant sends reconcile against the audience build.
  const covered = jobs.reduce((a, j) => a + j.recipients, 0);
  const total = Object.values(segmentCounts).reduce((a, b) => a + b, 0);
  if (covered !== total) {
    throw new Error(
      `planSegmentVariants: fan-out does not reconcile (${covered} covered != ${total} audience)`,
    );
  }
  return { jobs, emptySegments, unknownSegments };
}
