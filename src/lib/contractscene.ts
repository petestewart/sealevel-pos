import { createHash } from "node:crypto";

import { plainText } from "./richtext";
import {
  clientPaymentProfile,
  contractStartProblem,
  contractWithRawTerms,
  purchaseContract,
  studioDayKey,
} from "./sale";

import type { ContractPayload } from "./displaycontract";

/**
 * T205: the contract scene, built ENTIRELY on the server.
 *
 * This is the one place in the customer-display feature that reads
 * Mindbody, and it reads only. The design's rule is that nothing under
 * `src/app/display` or `src/app/api/display` writes, and nothing here
 * does: it reads the contract (for its name, its terms and its autopay
 * line), reads the client's stored card (which the rehearsal's schema
 * demands), and runs the SAME `Test: true` rehearsal the teacher's
 * dialog already runs, so the figure in front of the student is the
 * server's own and not a number a browser relayed.
 *
 * Two halves come back:
 *
 * - the PAYLOAD, which the display renders: words only, no ids, no
 *   hashes, no client id;
 * - the PRIVATE half, which stays on the request and is read back by
 *   /api/purchase-contract when it finalises: the client id, the
 *   contract id, the start date, the sha256 of the RAW terms as they
 *   were read, and the rehearsed total in cents.
 *
 * The terms are hashed RAW, as Mindbody served them, and rendered as
 * PLAIN TEXT (T99). The hash is what catches a studio that edited the
 * wording while the student was reading it; the plain text is what the
 * student actually agreed to, and it is never injected as HTML anywhere.
 */

/** Dollars, as the counter writes them. */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** The studio's own day, in words a student reads. `null` is today. */
export function startsOnWords(startDate: string | null): string {
  if (startDate === null) return "today";
  const at = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return startDate;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(at);
}

/** How often the autopay charges, in words. The same reading of the
 *  schema as the teacher's dialog (AutopaySchedule, sale.yml:4757;
 *  AutopayTriggerType, 5494), deliberately worded the same, so the two
 *  screens in front of the two people say the same thing. */
export function frequencyWords(c: {
  autopayTriggerType: string | null;
  autopaySchedule: {
    frequencyType: string | null;
    frequencyValue: number | null;
    frequencyTimeUnit: string | null;
  } | null;
}): string | null {
  if (c.autopayTriggerType === "PricingOptionRunsOutOrExpires") {
    return "each time the included pass runs out or expires";
  }
  const s = c.autopaySchedule;
  /* Never invent a cadence. A shape this cannot word is one the
   * teacher's dialog already refuses to sell (scheduleProblem). */
  if (!s) return null;
  if (s.frequencyType === "MonthToMonth") return "monthly";
  const n = s.frequencyValue ?? 1;
  if (s.frequencyTimeUnit === "Monthly") {
    return n === 1 ? "monthly" : `every ${n} months`;
  }
  if (s.frequencyTimeUnit === "Weekly") {
    return n === 1 ? "weekly" : `every ${n} weeks`;
  }
  if (s.frequencyTimeUnit === "Yearly") {
    return n === 1 ? "yearly" : `every ${n} years`;
  }
  return null;
}

export interface ContractSceneBuild {
  payload: ContractPayload;
  private: {
    clientId: string;
    contractId: number;
    /** The normalized start day: a studio `YYYY-MM-DD`, or null for
     *  today, exactly as /api/purchase-contract normalizes it. */
    startDate: string | null;
    termsSha256: string;
    /** The rehearsed first payment in whole cents, or null when the
     *  rehearsal was suppressed or priced no total. */
    firstTotalCents: number | null;
  };
}

/**
 * Build it, or say in a plain sentence why this membership cannot be put
 * in front of a student. Every refusal here happens BEFORE anything
 * reaches the display: a blank or half-priced contract scene is worse
 * than no scene at all, because the teacher's dialog is still there.
 */
export async function buildContractScene(input: {
  clientId: string;
  contractId: number;
  startDate: string | null;
  clientFirstName: string | null;
}): Promise<
  | { ok: true; value: ContractSceneBuild }
  | {
      ok: false;
      status: number;
      error: string;
      /** T206: a machine-readable name for the one refusal that is not
       *  about the SCREEN at all. A membership with no terms written in
       *  Mindbody has nothing to sign, wherever the customer display is,
       *  and the teacher's dialog must say so rather than reporting a
       *  screen that is working perfectly well as not connected (Pete's
       *  contract attempt: "The customer screen is not connected." above a
       *  sub-line about missing terms, with the header mark green). */
      reason?: "noterms";
    }
> {
  const { clientId, contractId } = input;
  /* The start day, checked by the SAME gate the purchase uses, and
   * normalized the same way: today's own key is today. */
  let startDate: string | null = null;
  if (input.startDate !== null) {
    const problem = contractStartProblem(input.startDate);
    if (problem) return { ok: false, status: 400, error: problem };
    startDate = input.startDate === studioDayKey() ? null : input.startDate;
  }

  let found;
  try {
    found = await contractWithRawTerms(contractId);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `The membership could not be read from Mindbody (${
        err instanceof Error ? err.message : String(err)
      }).`,
    };
  }
  if (found === null) {
    return {
      ok: false,
      status: 404,
      error: "The studio does not sell that membership any more.",
    };
  }
  const terms = plainText(found.rawTerms).trim();
  if (terms.length === 0) {
    return {
      ok: false,
      status: 409,
      reason: "noterms",
      error:
        "This membership has no terms written in Mindbody, so there is " +
        "nothing for the customer to sign. Sell it with your PIN, or add " +
        "the terms in Mindbody.",
    };
  }

  /* The card, because the rehearsal's schema demands exactly one payment
   * source and the counter implements StoredCardInfo. A read, not a
   * charge; the teacher's dialog has already refused the sale for a
   * missing or expired card, and this says the same thing if it has
   * not. */
  let lastFour: string;
  try {
    const profile = await clientPaymentProfile(clientId);
    if (!profile.card) {
      return {
        ok: false,
        status: 409,
        error:
          "No card on file for this client. A membership charges the " +
          "stored card; add a card in Mindbody first.",
      };
    }
    if (profile.card.expired) {
      return {
        ok: false,
        status: 409,
        error: `The card on file (ending ${profile.card.lastFour}) is expired.`,
      };
    }
    lastFour = profile.card.lastFour;
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Could not read the client's payment profile: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  /* The rehearsal, Test: true, with NO signature on it (that is D-B2's
   * open question and this is the call whose Total the screen shows).
   * A suppressed rehearsal is not a failure: dry run and the write guard
   * mean no figure exists, and the scene says "as quoted at the counter"
   * rather than inventing one. */
  let firstTotalCents: number | null = null;
  try {
    const rehearsed = await purchaseContract({
      contractId,
      clientId,
      lastFour,
      test: true,
      startDate,
    });
    if (!rehearsed.suppressed && rehearsed.totals?.total !== null) {
      const total = rehearsed.totals?.total;
      if (typeof total === "number" && Number.isFinite(total)) {
        firstTotalCents = Math.round(total * 100);
      }
    }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Mindbody refused the rehearsal: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const c = found.summary;
  const recurring =
    c.autopayEnabled &&
    c.recurringPaymentTotal !== null &&
    c.recurringPaymentTotal > 0
      ? c.recurringPaymentTotal
      : null;
  const cadence = recurring === null ? null : frequencyWords(c);
  const autopay =
    recurring !== null && cadence !== null
      ? `Then ${usd(recurring)} ${cadence}.`
      : null;
  const when = startsOnWords(startDate);
  const firstPayment =
    firstTotalCents === null
      ? null
      : `${usd(firstTotalCents / 100)} ${
          startDate === null ? "today" : `today, and it starts ${when}`
        }`;

  return {
    ok: true,
    value: {
      payload: {
        contractName: plainText(c.name).slice(0, 120) || "Membership",
        terms,
        startsOn: when,
        firstPayment,
        autopay,
        clientFirstName: input.clientFirstName,
      },
      private: {
        clientId,
        contractId,
        startDate,
        termsSha256: createHash("sha256").update(found.rawTerms).digest("hex"),
        firstTotalCents,
      },
    },
  };
}

/** The hash the purchase compares against, taken the same way here and
 *  there: over the RAW `AgreementTerms` string, whatever is in it. */
export function termsSha256(rawTerms: string): string {
  return createHash("sha256").update(rawTerms).digest("hex");
}
