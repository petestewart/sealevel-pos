import type {
  AudienceCandidate,
  AudienceEntry,
  AudienceStore,
  CampaignRow,
} from "../db/campaignAudience.js";
import type { BuildAudienceDeps } from "./buildAudience.js";
import type { ExclusionReason } from "./buildAudience.js";

/**
 * Audience fixture set (SEA-86): synthetic but realistic personas with
 * KNOWN-CORRECT outcomes, run against the REAL buildAudience filter
 * chain (in-memory store + mocked analytics client -- no MCP server, no
 * Postgres, no LLM anywhere near this path). This is the harness that
 * lets agent-written audience code be trusted without reading every
 * line: if a change to the filter chain alters any persona's fate, the
 * suite fails naming the persona.
 *
 * TO ADD A PERSONA (do this for every audience bug found): append ONE
 * entry to AUDIENCE_PERSONAS below. Give it a fresh analyticsClientId
 * and contactId (uniqueness is asserted at runtime), say what real-world
 * situation it models in `description`, and declare its expected fate.
 * Nothing else needs editing -- the runner derives the store contents,
 * the view rows, and the assertions from the entries.
 *
 * Fates, mirroring the filter chain's contract:
 *   - recipient        -- passes every filter; asserted present in the
 *                         recipient list with the exact email.
 *   - excluded(reason) -- dropped by the chain for EXACTLY this reason
 *                         (first-matching-reason-wins, so the reason is
 *                         part of the expectation, not a detail).
 *   - not_in_view      -- the analytics view never returns the client
 *                         (e.g. a lapsed customer against the
 *                         post-first-visit view); asserted absent from
 *                         BOTH recipients and exclusions. The view's own
 *                         membership logic lives in sealevel-analytics;
 *                         this fate documents the boundary, it does not
 *                         re-test the SQL.
 */

/** The segment label the mocked view stamps on every row it returns. */
export const FIXTURE_SEGMENT = "post_first_visit";

export type PersonaFate =
  | { fate: "recipient"; email: string }
  | { fate: "excluded"; reason: ExclusionReason; detailPattern?: RegExp }
  | { fate: "not_in_view" };

export interface AudiencePersona {
  /** Short unique handle; failure messages name it. */
  name: string;
  /** The real-world situation this persona models. */
  description: string;
  /**
   * Contact rows this persona contributes to the store (as the SEA-81
   * sync + reconciliation would have left them). Empty for a persona
   * that exists only on the analytics side (unmappable).
   */
  contacts: AudienceCandidate[];
  /** Whether the persona's client_id appears in the audience view. */
  inView: boolean;
  /** The analytics client id the view row (if any) carries. */
  analyticsClientId: string;
  expected: PersonaFate;
}

/**
 * The personas. Every audience bug ever found earns a new entry here so
 * it can never regress silently.
 */
export const AUDIENCE_PERSONAS: readonly AudiencePersona[] = [
  {
    name: "active-regular",
    description:
      "attends weekly, opted in via Mindbody, clean 1:1 reconciliation: the plain happy path",
    contacts: [
      {
        contactId: "1001",
        analyticsClientId: "9001",
        email: "active.regular@example.com",
        isAmbiguous: false,
        ambiguousReason: null,
        consentState: "subscribed",
        suppressed: false,
      },
    ],
    inView: true,
    analyticsClientId: "9001",
    expected: { fate: "recipient", email: "active.regular@example.com" },
  },
  {
    name: "lapsed-six-monther",
    description:
      "last visit six months ago, still subscribed; the post-first-visit view does not return lapsed clients, so the fate is decided upstream at the view boundary",
    contacts: [
      {
        contactId: "1002",
        analyticsClientId: "9002",
        email: "lapsed@example.com",
        isAmbiguous: false,
        ambiguousReason: null,
        consentState: "subscribed",
        suppressed: false,
      },
    ],
    inView: false,
    analyticsClientId: "9002",
    expected: { fate: "not_in_view" },
  },
  {
    name: "first-visit-yesterday",
    description:
      "brand-new customer, first class yesterday, opted in at signup: exactly who the post-first-visit campaign is for",
    contacts: [
      {
        contactId: "1003",
        analyticsClientId: "9003",
        email: "first.visit@example.com",
        isAmbiguous: false,
        ambiguousReason: null,
        consentState: "subscribed",
        suppressed: false,
      },
    ],
    inView: true,
    analyticsClientId: "9003",
    expected: { fate: "recipient", email: "first.visit@example.com" },
  },
  {
    name: "unsubscribed-contact",
    description:
      "qualified for the view but the latest consent_events row is 'unsubscribed'; must never be mailed regardless of what analytics says",
    contacts: [
      {
        contactId: "1004",
        analyticsClientId: "9004",
        email: "opted.out@example.com",
        isAmbiguous: false,
        ambiguousReason: null,
        consentState: "unsubscribed",
        suppressed: false,
      },
    ],
    inView: true,
    analyticsClientId: "9004",
    expected: {
      fate: "excluded",
      reason: "unsubscribed",
      detailPattern: /'unsubscribed'/,
    },
  },
  {
    name: "ambiguous-collision",
    description:
      "two Mindbody client records collided on one address during sync; the loser was flagged is_ambiguous and no audience may guess which record is the person",
    contacts: [
      {
        contactId: "1005",
        analyticsClientId: "9005",
        email: "shared.address@example.com",
        isAmbiguous: true,
        ambiguousReason:
          "sync-dupe: duplicate mb_client_id 4242 in Mindbody pull",
        consentState: "subscribed",
        suppressed: false,
      },
    ],
    inView: true,
    analyticsClientId: "9005",
    expected: {
      fate: "excluded",
      reason: "ambiguous",
      detailPattern: /^sync-dupe:/,
    },
  },
  {
    name: "no-email-contact",
    description:
      "front-desk-created Mindbody record with no email address; the schema forbids this on live rows but the audience must never trust that from a distance",
    contacts: [
      {
        contactId: "1006",
        analyticsClientId: "9006",
        email: "",
        isAmbiguous: false,
        ambiguousReason: null,
        consentState: "subscribed",
        suppressed: false,
      },
    ],
    inView: true,
    analyticsClientId: "9006",
    expected: {
      fate: "excluded",
      reason: "no_email",
      detailPattern: /no email address/,
    },
  },
  {
    name: "unmappable-client",
    description:
      "the analytics view returns a client_id that resolves to zero live contacts (SEA-81 reconciliation found no confident match); there is nobody to mail",
    contacts: [],
    inView: true,
    analyticsClientId: "9007",
    expected: {
      fate: "excluded",
      reason: "unmappable",
      detailPattern: /no live contact carries this analytics_client_id/,
    },
  },
];

/* ------------------------------------------------------------------ *
 * Runner plumbing: derive store + mocked analytics from the personas.  *
 * ------------------------------------------------------------------ */

/** In-memory AudienceStore over the personas' contact rows. */
export class FixtureAudienceStore implements AudienceStore {
  candidates: AudienceCandidate[];
  campaigns = new Map<string, CampaignRow>();
  snapshots: Array<{
    campaignId: string;
    entries: AudienceEntry[];
    snapshotAt: Date;
  }> = [];

  constructor(personas: readonly AudiencePersona[] = AUDIENCE_PERSONAS) {
    this.candidates = personas.flatMap((p) => p.contacts);
  }

  async listAudienceCandidates(): Promise<AudienceCandidate[]> {
    return this.candidates;
  }
  async getCampaignByKey(key: string): Promise<CampaignRow | null> {
    return this.campaigns.get(key) ?? null;
  }
  async replaceAudienceSnapshot(
    campaignId: string,
    entries: AudienceEntry[],
    snapshotAt: Date,
  ): Promise<void> {
    this.snapshots = this.snapshots.filter((s) => s.campaignId !== campaignId);
    this.snapshots.push({ campaignId, entries, snapshotAt });
  }
  async countAudience(campaignId: string): Promise<number> {
    return (
      this.snapshots.find((s) => s.campaignId === campaignId)?.entries.length ??
      0
    );
  }
}

/** The view rows the mocked analytics client serves: one per in-view
 * persona, in run_sql shape ({ client_id, segment }). */
export function fixtureViewRows(
  personas: readonly AudiencePersona[] = AUDIENCE_PERSONAS,
): Array<Record<string, unknown>> {
  return personas
    .filter((p) => p.inView)
    .map((p) => ({ client_id: p.analyticsClientId, segment: FIXTURE_SEGMENT }));
}

/** Full BuildAudienceDeps over the personas: mocked pageSelect serving
 * fixtureViewRows in pages, FixtureAudienceStore, silent log, fixed
 * clock outside the analytics blackout window. */
export function fixtureDeps(
  store: FixtureAudienceStore,
  personas: readonly AudiencePersona[] = AUDIENCE_PERSONAS,
): BuildAudienceDeps {
  const viewRows = fixtureViewRows(personas);
  return {
    pageSelect: async function* () {
      for (let i = 0; i < viewRows.length; i += 200) {
        yield viewRows.slice(i, i + 200);
      }
    } as typeof import("../tools/analytics.js").pageSelect,
    store,
    log: () => {},
    now: () => new Date("2026-08-11T19:00:00Z"), // 12:00 PT, outside blackout
  };
}
