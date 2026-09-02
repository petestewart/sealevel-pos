import { NextResponse } from "next/server";

import { requireSession, requireTeacher } from "@/lib/auth";
import { isDryRun, mindbodyHttpStatus } from "@/lib/mindbody";

import {
  clientPaymentProfile,
  houseClientId,
  purchaseContract,
  roundToCents,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * POST /api/purchase-contract -- the membership sale (T30). Fires only
 * from the contract dialog's explicit tap; nothing here auto-charges,
 * and NOTHING auto-retries.
 *
 * Body: { contractId: number, clientId: string, test?: boolean,
 *         expectedFirstTotal?: number }
 *
 * `expectedFirstTotal` is the figure the dialog's confirm button showed;
 * a real purchase whose fresh rehearsal prices differently refuses with
 * stage "reprice" (409) instead of charging a number the teacher never
 * saw.
 *
 * `test: true` is the dialog's rehearsal: POST /sale/purchasecontract
 * with Test: true (sale.yml:6219, "validates input information, but
 * does not commit it"), which is where the dialog's authoritative
 * first-payment total comes from. A real purchase (`test` absent or
 * false) rehearses server-side FIRST and only then commits, the same
 * two-step posture as /api/checkout -- a contract Mindbody will not
 * accept fails before any charge is attempted.
 *
 * Hard rules, all from the schema reading recorded on purchaseContract
 * in src/lib/sale.ts:
 * - A REAL client is required. The house client never rides a contract:
 *   an autopay on the walk-in account would be a standing charge
 *   against nobody.
 * - Payment is the stored card, addressed by LastFour (StoredCardInfo,
 *   sale.yml:5189-5196, is `{ LastFour }` and nothing else). The card
 *   is re-read server-side at purchase time; no card or an expired one
 *   is a refusal with the reason, before any Mindbody write.
 * - FirstPaymentOccurs: Instant, StartDate omitted (defaults to today
 *   on Mindbody's clock). The counter sells memberships that start and
 *   charge now.
 *
 * The response never lies about an outcome (same contract as
 * /api/checkout):
 * - 200 { ok: true, ... }          purchased; clientContractId and the
 *                                  charged total attached.
 * - 200 { ok: true, test: true }   rehearsal passed; totals attached.
 * - 200 { ok: false, suppressed }  dry run or the write guard. Rendered
 *                                  amber, NEVER as a sale.
 * - 4xx/502 { error, stage }       a definite refusal with Mindbody's
 *                                  reason.
 * - `ambiguous: true` on an error  transport death or a 5xx answer: the
 *                                  purchase MAY exist; the UI must say
 *                                  so and must not invite a retry.
 */

/** Same reading as /api/checkout: only a definite 4xx refusal may be
 *  reported as "nothing was charged". */
function isAmbiguous(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const status = mindbodyHttpStatus(err);
  return status !== null && status >= 500;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const gate = requireTeacher(request);
  if (!gate.ok) return gate.denied;
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const contractId: unknown = payload?.contractId;
  if (!Number.isInteger(contractId)) {
    return NextResponse.json(
      { error: "contractId (integer) is required" },
      { status: 400 },
    );
  }
  const clientId =
    typeof payload?.clientId === "string" && payload.clientId.trim()
      ? payload.clientId.trim()
      : null;
  if (!clientId) {
    return NextResponse.json(
      {
        error:
          "A membership needs a client attached to the sale. The house " +
          "client never rides a contract.",
      },
      { status: 400 },
    );
  }
  /* The house client is refused BY ID, not just by the UI never sending
   * it: an autopay on the walk-in account is a standing charge against
   * nobody, and this route is the last gate before the write. */
  const house = houseClientId();
  if (house !== null && clientId === house) {
    return NextResponse.json(
      {
        error:
          "That is the house walk-in client. A membership must be sold " +
          "to the real client's own account.",
      },
      { status: 400 },
    );
  }
  const test = payload?.test === true;
  /* The first-payment figure the dialog's confirm button displayed, when
   * the browser had one. Compared against the fresh rehearsal below: a
   * tap agrees to the words on the button, so a price that has moved
   * since must refuse and re-render, never charge silently. */
  const expectedFirstTotal =
    typeof payload?.expectedFirstTotal === "number" &&
    Number.isFinite(payload.expectedFirstTotal)
      ? payload.expectedFirstTotal
      : null;

  /* The stored card, re-read at purchase time -- the browser's snapshot
   * is never the basis for a money decision. The schema demands exactly
   * one payment source (sale.yml:6261-6283) and the counter implements
   * StoredCardInfo, so no usable card is a refusal here, before any
   * write. A failure of the read itself is a failed READ; nothing has
   * been charged. */
  let profile;
  try {
    profile = await clientPaymentProfile(clientId);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not read the client's payment profile: ${errMessage(err)} Nothing was charged.`,
        stage: "method",
      },
      { status: 502 },
    );
  }
  const card = profile.card;
  if (!card) {
    return NextResponse.json(
      {
        error:
          "No card on file for this client. A membership charges the " +
          "stored card; add a card in Mindbody first.",
        stage: "method",
      },
      { status: 409 },
    );
  }
  if (card.expired) {
    return NextResponse.json(
      {
        error: `The card on file (ending ${card.lastFour}) is expired.`,
        stage: "method",
      },
      { status: 409 },
    );
  }

  const suppressionKind = () => (isDryRun() ? "dry-run" : "write-guard");

  /* Step 1, always: the Test: true rehearsal. For a `test` request this
   * IS the whole job; for a real purchase it is the validation gate and
   * the source of the total the dialog restates. */
  let rehearsed;
  try {
    rehearsed = await purchaseContract({
      contractId: contractId as number,
      clientId,
      lastFour: card.lastFour,
      test: true,
    });
  } catch (err) {
    return NextResponse.json(
      { error: errMessage(err), stage: "rehearsal" },
      { status: 502 },
    );
  }
  if (rehearsed.suppressed) {
    /* The rehearsal never left the building, so the real write would
     * not either. Nothing was charged; no total exists. */
    return NextResponse.json({ ok: false, suppressed: suppressionKind() });
  }
  if (test) {
    return NextResponse.json({
      ok: true,
      test: true,
      totals: rehearsed.totals,
    });
  }

  /* The price-drift gate: when the dialog said what its button showed
   * and this rehearsal has a number, they must agree to the cent. A
   * rehearsal with NO total cannot be checked (whether Test returns
   * Totals at all is on the sandbox probe list); Mindbody then prices
   * the real call itself, as it always does. */
  const rehearsedTotal = rehearsed.totals?.total ?? null;
  if (
    expectedFirstTotal !== null &&
    rehearsedTotal !== null &&
    roundToCents(rehearsedTotal) !== roundToCents(expectedFirstTotal)
  ) {
    return NextResponse.json(
      {
        error:
          `The first payment now prices at ${rehearsedTotal.toFixed(2)}, ` +
          `not the ${expectedFirstTotal.toFixed(2)} the button showed. ` +
          "Nothing was charged; confirm against the new amount.",
        stage: "reprice",
        total: rehearsedTotal,
      },
      { status: 409 },
    );
  }

  /* Step 2: the real purchase. ONE call, no auto-retry in any shape; a
   * refusal renders Mindbody's reason, a 5xx or dead transport is
   * honest ambiguity. */
  try {
    const outcome = await purchaseContract({
      contractId: contractId as number,
      clientId,
      lastFour: card.lastFour,
      test: false,
    });
    if (outcome.suppressed) {
      return NextResponse.json({ ok: false, suppressed: outcome.suppressed });
    }
    return NextResponse.json({
      ok: true,
      clientContractId: outcome.clientContractId,
      total: outcome.totals?.total ?? rehearsed.totals?.total ?? null,
    });
  } catch (err) {
    const ambiguous = isAmbiguous(err);
    return NextResponse.json(
      {
        error: ambiguous
          ? "The membership purchase did not answer. The contract MAY " +
            "have been started. Check the client's account in Mindbody " +
            "for the contract (or the dev drawer) before trying again."
          : errMessage(err),
        stage: "purchase",
        ambiguous,
      },
      { status: 502 },
    );
  }
}
