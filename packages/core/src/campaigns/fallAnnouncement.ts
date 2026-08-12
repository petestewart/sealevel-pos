import type {
  SegmentedDraftRequest,
  SegmentVariant,
} from "./draftVariants.js";

/**
 * Fall 2026 schedule announcement (SEA-88): the campaign's content facts
 * and per-segment drafting brief, as reviewable data.
 *
 * THIS FILE IS THE CANONICAL HOME OF THE CAMPAIGN'S SCHEDULE CLAIMS.
 * docs/campaigns/fall-announcement-2026.md is the human-readable review
 * copy of the same content; if they disagree, fix both. Every fact
 * carries a verification status: nothing marked needs_verification may
 * ship in the SEA-89 send until Pete confirms it against the actual
 * Mindbody fall schedule.
 *
 * Copy house rule (CLAUDE.md): NO EM DASHES anywhere in this file's
 * strings. They flow into outgoing copy; planSegmentVariants enforces
 * this at fan-out time and the smoke enforces it at CI time.
 */

/** The campaign row this brief belongs to (campaigns.key / audience_view).
 * No migration needed: campaign rows are data, inserted by the operator
 * or console; audience_view is passed through by SEA-82's buildAudience. */
export const FALL_ANNOUNCEMENT_CAMPAIGN_KEY = "fall-announcement-2026";
export const FALL_ANNOUNCEMENT_AUDIENCE_VIEW = "v_campaign_fall_announcement";

/** The segment labels v_campaign_fall_announcement emits, in the view's
 * precedence order (lapsed_recent wins over affinity buckets). */
export const FALL_ANNOUNCEMENT_SEGMENTS = [
  "lapsed_recent",
  "vinyasa_curious",
  "hot_only",
  "generalist",
] as const;

export type FallAnnouncementSegment =
  (typeof FALL_ANNOUNCEMENT_SEGMENTS)[number];

export type FactStatus = "confirmed" | "needs_verification";

export interface CampaignFact {
  /** The claim, phrased so it can go into copy verbatim if needed. */
  fact: string;
  /** confirmed = grounded in a live source; needs_verification = from
   * the SEA-88 ticket, Pete must confirm before the SEA-89 send. */
  status: FactStatus;
  /** Where the claim comes from, for the fact-checker. */
  source: string;
}

/** The schedule claims the announcement is allowed to make. */
export const FALL_2026_SCHEDULE_FACTS: readonly CampaignFact[] = [
  {
    fact: "The fall schedule adds roughly 25 new weekly classes.",
    status: "needs_verification",
    source:
      "SEA-88 ticket. Confirm the exact count against the published Mindbody fall schedule before sending.",
  },
  {
    fact: "A new 4pm class slot is added on weekdays.",
    status: "needs_verification",
    source:
      "SEA-88 ticket. Confirm days and class types for the 4pm slot before sending.",
  },
  {
    fact: "The 5pm evening classes move to 5:30pm.",
    status: "needs_verification",
    source:
      "SEA-88 ticket. Current Mindbody schedule shows 5pm 60-minute classes Fri through Sun; confirm which days shift.",
  },
  {
    fact:
      "The studio now runs two rooms, so classes at overlapping times are both really happening; an overlap on the schedule is not a mistake or a conflict.",
    status: "needs_verification",
    source:
      "SEA-88 ticket; the upstairs room plan is documented in the studio wiki (operations). Confirm the second room is live for fall before sending.",
  },
  {
    fact:
      "Vinyasa is new to the studio this fall, with its own dedicated program of classes.",
    status: "confirmed",
    source:
      "Studio wiki (operations: vinyasa program in the upstairs room, fall 2026) and the live Mindbody schedule, which already lists Hot Vinyasa Flow on Mondays at 8am.",
  },
  {
    fact: "Regular hot 26 and 2 classes continue as always, at 60 and 90 minutes.",
    status: "confirmed",
    source: "Live Mindbody schedule (checked 2026-08-12).",
  },
] as const;

/** Facts phrased for the drafting model (the strings copy may state). */
const SHARED_FACT_LINES: readonly string[] = FALL_2026_SCHEDULE_FACTS.map(
  (f) => f.fact,
);

const COPY_RULES: readonly string[] = [
  "No em dashes anywhere in the copy. Use commas, periods, or rewrite the sentence.",
  "State only the shared facts and this segment's framing. Do not invent class names, times, teachers, or prices.",
  "Pricing and schedule details beyond these facts come exclusively from the live Mindbody tools, never from memory.",
  "Booking is self-service: link to the schedule, never offer to book for the customer.",
  "Do not narrate the system's knowledge, tools, or access, and do not promise follow-ups.",
  "Because there are two rooms, never describe overlapping class times as a conflict or an either-or choice.",
];

const VARIANTS: readonly SegmentVariant[] = [
  {
    segment: "lapsed_recent",
    audience:
      "Clients who practiced with us in the last year but whose last visit is more than 60 days ago.",
    framing: [
      "Win-back tone: warm, no guilt, no 'we miss you' cliches. Lead with what changed, not with their absence.",
      "The hook is that this is the biggest schedule refresh in years: new classes, new times, a whole new style.",
      "Frame the new 4pm slot and the 5:30pm shift as more ways back in: if the old times stopped fitting their life, the new ones might.",
      "Vinyasa framing for this bucket: a fresh reason to come back that is genuinely new, not the same class they drifted away from.",
    ],
  },
  {
    segment: "vinyasa_curious",
    audience:
      "Active clients who have already taken at least one vinyasa class with us.",
    framing: [
      "They already tried vinyasa here, so talk to them as early adopters, not as newcomers.",
      "Vinyasa framing for this bucket: the program they sampled is growing into a full schedule with more classes and more times each week.",
      "Invite them to bring the rest of their practice along: the new times make it easier to mix vinyasa with everything else.",
    ],
  },
  {
    segment: "hot_only",
    audience:
      "Active clients whose visits in the last year are exclusively hot classes (26 and 2, fusion, hot pilates).",
    framing: [
      "Respect their practice: the heat and the classes they love are not changing, and say so early.",
      "Vinyasa framing for this bucket: a different rhythm in the same heat. Flowing, breath-led movement rather than the fixed sequence, for days they want variety.",
      "The 5:30pm shift matters to evening regulars: name it plainly so nobody shows up at 5pm to a closed door.",
    ],
  },
  {
    segment: "generalist",
    audience:
      "Active clients who mix formats (hot plus yin, sound, or other classes) or practice outside the hot room.",
    framing: [
      "Lead with breadth: more classes across the whole schedule, from hot to yin to the new vinyasa program.",
      "Vinyasa framing for this bucket: a natural addition to a varied practice, sitting between the heat and the stillness they already enjoy.",
      "Two rooms means more of what they like can run side by side, so the schedule is fuller at the times they already come.",
    ],
  },
] as const;

/**
 * The campaign's SegmentedDraftRequest: the single reviewable brief that
 * SEA-83's campaigns.draft consumes (via planSegmentVariants) to produce
 * one copy variant per audience segment.
 */
export function fallAnnouncementDraftRequest(): SegmentedDraftRequest {
  return {
    campaignKey: FALL_ANNOUNCEMENT_CAMPAIGN_KEY,
    audienceView: FALL_ANNOUNCEMENT_AUDIENCE_VIEW,
    subjectTheme:
      "The fall 2026 schedule is here: about 25 new classes, new times, and a brand new vinyasa program.",
    sharedFacts: SHARED_FACT_LINES,
    copyRules: COPY_RULES,
    variants: VARIANTS,
    // A label the brief does not know gets the broadest, safest copy.
    fallbackSegment: "generalist",
  };
}

/** Facts that still need Pete's sign-off before the SEA-89 send. */
export function unverifiedFallFacts(): CampaignFact[] {
  return FALL_2026_SCHEDULE_FACTS.filter(
    (f) => f.status === "needs_verification",
  );
}
