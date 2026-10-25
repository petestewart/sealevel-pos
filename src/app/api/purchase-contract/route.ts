import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import {
  CONTRACT_PURPOSE,
  contractOverrideLine,
  contractRequiresSignature,
} from "@/lib/approval";
import {
  requireSession,
  spendCompToken,
  teacherLogTag,
  verifyCompToken,
} from "@/lib/auth";
import { termsSha256 } from "@/lib/contractscene";
import { insertContractReceipt } from "@/lib/db";
import {
  beginFinalisation,
  consumeRequest,
  displayState,
  loadRequest,
  releaseFinalisation,
} from "@/lib/display";
import { fileFormulaNote } from "@/lib/formulanote";
import { dryRunState, mindbodyHttpStatus } from "@/lib/mindbody";

import {
  clientPaymentProfile,
  contractStartProblem,
  contractWithRawTerms,
  houseClientId,
  purchaseContract,
  roundToCents,
  studioDayKey,
} from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * POST /api/purchase-contract -- the membership sale (T30). Fires only
 * from the contract dialog's explicit tap; nothing here auto-charges,
 * and NOTHING auto-retries.
 *
 * Body: { contractId: number, clientId: string, test?: boolean,
 *         expectedFirstTotal?: number, startDate?: string }
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
 * - A membership starting TODAY sends FirstPaymentOccurs: Instant with
 *   StartDate omitted (it defaults to today on Mindbody's clock).
 * - T99: `startDate` (a studio `YYYY-MM-DD`) is the teacher's chosen
 *   day. It is refused here, in words, when it is not a real day, is in
 *   the past, or is more than a year ahead, whatever the browser
 *   thought; today's own key is normalized away, so the request shape
 *   for "starts today" is byte for byte what it was before T99. A
 *   chosen day rides BOTH the rehearsal and the purchase, so the figure
 *   the dialog shows and the figure charged come from the same dates,
 *   and the proration is entirely Mindbody's (sale.yml:1866).
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
 *
 * T49: the REAL purchase runs as the signed-in teacher when there is
 * one, with the one loud fallback (a 4xx refusal of the teacher is a
 * refusal at the gate, nothing charged, so the service-account retry is
 * safe); the Test rehearsal stays on the service account like every
 * other read-shaped call.
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
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad hears only the 401 and never a validation detail
   * or a Mindbody read made on its behalf. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
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
  /* T99: the chosen start date. Absent, or today's own key, is today's
   * behaviour exactly. A bad one never reaches Mindbody. */
  const rawStart = payload?.startDate;
  let startDate: string | null = null;
  if (typeof rawStart === "string" && rawStart.trim()) {
    const key = rawStart.trim();
    const problem = contractStartProblem(key);
    if (problem) {
      return NextResponse.json(
        { error: problem, stage: "startDate" },
        { status: 400 },
      );
    }
    startDate = key === studioDayKey() ? null : key;
  } else if (rawStart !== undefined && rawStart !== null) {
    return NextResponse.json(
      { error: "startDate must be a YYYY-MM-DD day." },
      { status: 400 },
    );
  }
  /* The first-payment figure the dialog's confirm button displayed, when
   * the browser had one. Compared against the fresh rehearsal below: a
   * tap agrees to the words on the button, so a price that has moved
   * since must refuse and re-render, never charge silently. */
  const expectedFirstTotal =
    typeof payload?.expectedFirstTotal === "number" &&
    Number.isFinite(payload.expectedFirstTotal)
      ? payload.expectedFirstTotal
      : null;

  /* =================================================================
   * T205 (Phase 2.5 item 6): the customer's signature on the contract,
   * when the studio has asked for one.
   *
   * The setting is `contract_requires_signature` in app_settings (with
   * POS_CONTRACT_REQUIRES_SIGNATURE as the no-database fallback, and it
   * defaults ON), and this is the ONLY place it is enforced: the
   * browser's copy decides what the dialog draws and nothing else.
   *
   * With the setting on, a LIVE purchase must carry EITHER
   *
   *   `displayRequestId`, naming a completed, unconsumed, unexpired
   *   `contract` request for THIS client, THIS contract and THIS start
   *   day, whose recorded sha256 of the raw terms equals the sha256 of
   *   the terms as Mindbody serves them NOW, OR
   *
   *   `signatureOverride: { token }`, the D5 override: the signed-in
   *   teacher's own PIN, minted with purpose "contract", spent once, and
   *   filed on the client with their name.
   *
   * The `Test: true` rehearsal is exempt and always was: it commits
   * nothing, it is the call whose Total the student is shown, and
   * requiring a signature to price a contract would be a loop.
   *
   * Everything here is decided BEFORE the purchase, for the same reason
   * T203 decides its approval early: a refusal that costs a charge is
   * not a refusal. The request is CLAIMED here (`beginFinalisation`, so
   * two tabs cannot spend one signature) and SPENT only once the
   * purchase has answered; a refused or thrown purchase leaves it
   * spendable, because the student signed this contract and a retry of
   * the same contract must not need them again.
   * ================================================================= */
  const signatureRule = test
    ? { on: false, source: "env" as const }
    : await contractRequiresSignature();
  /** The signature this purchase rides on, from the SERVER's own store. */
  let signature: {
    png: Buffer;
    sha256: string;
    agreedAt: string;
    requestId: string;
  } | null = null;
  /** The teacher whose PIN stood in for it, when one did. */
  let overrideTeacher: ReturnType<typeof verifyCompToken> = null;
  /** The contract as it reads now: its name for the record, its raw
   *  terms for the hash. Read once, lazily, and only when the rule is
   *  on. */
  let contractNow: Awaited<ReturnType<typeof contractWithRawTerms>> = null;
  let contractRead = false;
  const readContract = async () => {
    if (contractRead) return contractNow;
    contractRead = true;
    try {
      contractNow = await contractWithRawTerms(contractId as number);
    } catch {
      /* A read that failed is not evidence the wording changed. The
       * signature path refuses on it (it has nothing to compare); the
       * override path simply files a less specific sentence. */
      contractNow = null;
    }
    return contractNow;
  };

  if (signatureRule.on) {
    const overrideAsk: unknown = payload?.signatureOverride;
    if (overrideAsk !== undefined && overrideAsk !== null) {
      const token = (overrideAsk as { token?: unknown })?.token;
      /* T94 review's rule: the token's own PURPOSE and this teacher's
       * own id. A PIN typed to approve a sale, to discount one or to
       * override a pass does not sell a membership unsigned. */
      overrideTeacher =
        typeof token === "string"
          ? verifyCompToken(token, CONTRACT_PURPOSE)
          : null;
      if (overrideTeacher !== null && overrideTeacher.id !== session.staffId) {
        overrideTeacher = null;
      }
      if (overrideTeacher === null || !spendCompToken(token as string)) {
        return NextResponse.json(
          {
            error:
              "Enter your PIN to sell this membership without a signature.",
            reason: "teacher",
          },
          { status: 401 },
        );
      }
    }
    if (overrideTeacher === null) {
      const askedId: unknown = payload?.displayRequestId;
      const wanted =
        typeof askedId === "string" && askedId.trim().length > 0
          ? askedId.trim()
          : null;
      const refuse = (error: string) =>
        NextResponse.json(
          { error, stage: "signature", reason: "signature" },
          { status: 409 },
        );
      if (wanted === null) {
        /* No signature and no PIN. Which sentence depends on whether
         * there is a screen to sign on at all: with none, the design is
         * explicit that the studio should NOTICE, so the purchase asks
         * for the PIN every time and says why. */
        const screen = await displayState();
        return refuse(
          screen.paired && screen.connected
            ? "The customer has not signed this contract on the customer screen."
            : "No customer screen is paired, so this membership needs your " +
                "PIN to sell without a signature.",
        );
      }
      const held = await loadRequest(wanted);
      if (
        held === null ||
        held.kind !== "contract" ||
        held.status !== "completed" ||
        Date.now() >= held.expiresAt
      ) {
        return refuse(
          "The customer has not signed this contract on the customer screen.",
        );
      }
      if (held.consumedAt !== null) {
        return refuse(
          "That signature has already been used on a membership. Ask them again.",
        );
      }
      if (String(held.private.clientId ?? "") !== clientId) {
        return refuse(
          "That signature was for a different customer. Ask them again.",
        );
      }
      if (Number(held.private.contractId ?? NaN) !== contractId) {
        return refuse(
          "That signature was for a different membership. Ask them again.",
        );
      }
      const signedStart =
        typeof held.private.startDate === "string"
          ? held.private.startDate
          : null;
      if (signedStart !== startDate) {
        return refuse(
          "That signature was for a different start date. Ask them again.",
        );
      }
      /* The wording, as it reads NOW. The studio edits these terms in
       * Mindbody's rich text editor, so a membership must never be sold
       * against a signature taken on words that have since changed. */
      const fresh = await readContract();
      if (fresh === null) {
        return refuse(
          "The membership's terms could not be re-read from Mindbody, so " +
            "the signature cannot be checked against them. Try again.",
        );
      }
      if (
        String(held.private.termsSha256 ?? "") !== termsSha256(fresh.rawTerms)
      ) {
        return refuse(
          "The contract wording changed while they were reading it. Ask them again.",
        );
      }
      const rawPng =
        typeof held.result?.signaturePng === "string"
          ? held.result.signaturePng
          : "";
      const png = Buffer.from(rawPng, "base64");
      if (rawPng.length === 0 || png.byteLength === 0) {
        return refuse(
          "That signature could not be read. Ask them to sign again.",
        );
      }
      /* Claimed synchronously: two answers arriving together cannot both
       * spend one signature. Released in the finally below, whatever
       * happens after this point. */
      if (!beginFinalisation(held.id)) {
        return refuse("That signature is already being used on a membership.");
      }
      /* T205 review: the checks above ran before the claim, across two
       * awaits, so a second purchase naming the same id could have read
       * "unconsumed" while the first was still selling, and then win the
       * claim the moment the first released it. Re-read under the claim;
       * a signature spent in the meantime is refused here, not sold. */
      const underClaim = await loadRequest(held.id);
      if (
        underClaim === null ||
        underClaim.status !== "completed" ||
        underClaim.consumedAt !== null
      ) {
        releaseFinalisation(held.id);
        return refuse(
          "That signature has already been used on a membership. Ask them again.",
        );
      }
      signature = {
        png,
        sha256: createHash("sha256").update(png).digest("hex"),
        agreedAt:
          typeof held.result?.agreedAt === "string"
            ? held.result.agreedAt
            : new Date().toISOString(),
        requestId: held.id,
      };
    }
  }

  /** One receipt per live purchase attempt that reached Mindbody, and
   *  only one. With no database the row is skipped and the log line
   *  below carries the same facts. */
  let receiptFiled = false;
  const fileReceipt = async (saleOutcome: string): Promise<void> => {
    if (test || receiptFiled) return;
    if (!signatureRule.on && signature === null && overrideTeacher === null) {
      /* The rule is off and nobody signed anything: there is no
       * signature question to keep a record of. */
      return;
    }
    receiptFiled = true;
    const named = await readContract();
    const landed = await insertContractReceipt({
      clientId,
      contractId: contractId as number,
      contractName: named?.summary.name ?? null,
      termsSha256: named === null ? null : termsSha256(named.rawTerms),
      signature:
        signature === null
          ? null
          : { sha256: signature.sha256, png: signature.png },
      overriddenByStaffId:
        overrideTeacher === null ? null : String(overrideTeacher.id),
      agreedAt: signature?.agreedAt ?? null,
      startDate: startDate ?? studioDayKey(),
      saleOutcome,
    });
    console.log(
      `[contract-signature] ${saleOutcome} client=${clientId} ` +
        `contract=${contractId} start=${startDate ?? "today"} ` +
        `signature=${signature === null ? "none" : signature.sha256.slice(0, 12)} ` +
        `${teacherLogTag(overrideTeacher)} receipt=${landed ? "row" : "log-only"}`,
    );
  };

  /** Spend the signature. AFTER the purchase answered, never before: a
   *  refusal must leave it usable for a retry of the same contract, and
   *  a spent one can never be spent twice. */
  const spendSignature = async (): Promise<void> => {
    if (signature === null) return;
    const spent = await consumeRequest(signature.requestId);
    if (spent === null) {
      console.warn(
        `[contract-signature] request ${signature.requestId} could not be ` +
          "spent after the purchase; it will expire on its own",
      );
    }
  };

  /** The D5 override's record on the client, filed the way T45/T62 file
   *  a comp's reason and T203 files an approval override. Never on a
   *  suppressed purchase: nothing happened to record. */
  const fileOverrideNote = async (): Promise<string | null> => {
    if (overrideTeacher === null) return null;
    const named = await readContract();
    const filed = await fileFormulaNote({
      session,
      clientId,
      note: contractOverrideLine(
        named?.summary.name ?? "membership",
        overrideTeacher.name,
      ),
      route: "/api/purchase-contract signature-note",
      logTag: "[contract-signature]",
    });
    return filed.via;
  };

  try {
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

    /* T89: dry run can now be the server's or this browser's, so the label
     * asks for the decision rather than reading POS_DRY_RUN itself. */
    const suppressionKind = async () =>
      (await dryRunState()).on ? "dry-run" : "write-guard";

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
        startDate,
      });
    } catch (err) {
      await fileReceipt(`refused: rehearsal ${errMessage(err)}`);
      return NextResponse.json(
        { error: errMessage(err), stage: "rehearsal" },
        { status: 502 },
      );
    }
    if (rehearsed.suppressed) {
      /* The rehearsal never left the building, so the real write would
       * not either. Nothing was charged; no total exists. */
      await fileReceipt("suppressed");
      await spendSignature();
      return NextResponse.json({
        ok: false,
        suppressed: await suppressionKind(),
      });
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
      await fileReceipt(`refused: repriced at ${rehearsedTotal.toFixed(2)}`);
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
      const run = await runAsActor(session, "/api/purchase-contract", (actor) =>
        purchaseContract({
          contractId: contractId as number,
          clientId,
          lastFour: card.lastFour,
          test: false,
          startDate,
          /* T205: the signature, base64 from the server's own store and
           * never from the browser, on the REAL call only. Mindbody files
           * it under the client's documents (sale.yml:6246). */
          ...(signature === null
            ? {}
            : { clientSignature: signature.png.toString("base64") }),
          actor,
        }),
      );
      const outcome = run.result;
      if (outcome.suppressed) {
        await fileReceipt("suppressed");
        await spendSignature();
        return NextResponse.json({
          ok: false,
          suppressed: outcome.suppressed,
          ...actorFields(run),
        });
      }
      await fileReceipt("completed");
      await spendSignature();
      /* The override's record, after the membership exists: a note filed
       * for a purchase that then failed would name a sale nobody made. */
      const noteVia = await fileOverrideNote();
      return NextResponse.json({
        ok: true,
        clientContractId: outcome.clientContractId,
        total: outcome.totals?.total ?? rehearsed.totals?.total ?? null,
        ...(signature === null ? {} : { signedOnDisplay: true }),
        ...(overrideTeacher === null
          ? {}
          : {
              signatureOverride: {
                teacher: overrideTeacher.name,
                noteVia,
              },
            }),
        ...actorFields(run),
      });
    } catch (err) {
      /* T50 review: a dead teacher token is refused at the gate, so no
       * contract started; the sign-in gate says so. */
      const gone = staffSessionEndedResponse(err);
      if (gone) {
        await fileReceipt("refused: staff session ended");
        return gone;
      }
      const ambiguous = isAmbiguous(err);
      await fileReceipt(
        ambiguous
          ? `ambiguous: ${errMessage(err)}`
          : `refused: ${errMessage(err)}`,
      );
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
  } finally {
    /* T202's rule: the claim is released whatever happened, consumed or
     * not. A signature left unspent by a refusal stays spendable for a
     * retry of the same contract, which is the whole point of claiming
     * rather than consuming up front. */
    if (signature !== null) releaseFinalisation(signature.requestId);
  }
}
