import { NextResponse } from "next/server";

import {
  actorFields,
  runAsActor,
  staffSessionEndedResponse,
} from "./actor";
import {
  spendCompToken,
  unspendCompToken,
  verifyCompToken,
  type TeacherIdentity,
} from "./auth";
import { balanceAgrees, expectedBalance } from "./accountcredit";
import { fileFormulaNote } from "./formulanote";
import { mindbody, mindbodyHttpStatus, target } from "./mindbody";
import {
  NO_CHARGE_PURPOSE,
  noChargeRecordLine,
  noChargeShapeRefusal,
  parseNoChargeCredit,
} from "./nochargecredit";
import {
  clientPaymentProfile,
  creditSaleProblem,
  houseClientId,
  purchaseCredit,
  saleById,
  type NoChargeCreditTender,
} from "./sale";
import type { StaffSession } from "./staffsession";

/**
 * T259's server half: credit given at no charge, from /api/checkout's
 * credit branch (`accountCredit: { amount, noCharge: { token, reason } }`).
 * The pure rules are in ./nochargecredit.ts.
 *
 * The order, every refusal in words:
 *
 *   1. the shape: the credit line alone, no tender, no discount, no code,
 *      no override (noChargeShapeRefusal), then the field itself (an
 *      amount of $0.01 to $200.00, a token, a reason of 3 to 200
 *      characters);
 *   2. a client, never the house client;
 *   3. the token: the `credit` purpose and nothing else, naming THIS
 *      session's teacher (T94's rule), SPENT once, before any Mindbody
 *      call, so a token arriving twice gives credit once;
 *   4. the "Other" payment type, resolved by NAME from /site/paymenttypes;
 *   5. the balance before (a read);
 *   6. a `Test: true` rehearsal, AmountPaid asserted to the cent;
 *   7. ONE real call under the teacher's token, no fallback to the studio
 *      account (a giveaway, like a comp: refused is refused);
 *   8. AmountPaid, the sale read by id holding exactly one line of the
 *      amount, and a fresh balance that rose by it. Any miss is
 *      ambiguous, which T253 holds;
 *   9. the record on the client, the T45/T62 way. A filing that fails
 *      never turns the credit into an error: the answer says so.
 *
 * T113's key and T253's hold sit above this in /api/checkout's POST and
 * apply unchanged. Dry run and the write guard apply to every write; a
 * suppressed write hands the PIN back (unspendCompToken, T211's rule),
 * and so does a READ that failed before anything was sent, since nothing
 * can have been written. A refusal or an error after the first POST
 * still costs the PIN.
 *
 * T203's customer approval does NOT apply: nothing is charged to the
 * customer, so there is nothing for them to approve, and like "Check in
 * free (comp)" it presents nothing on the customer screen. The teacher's
 * own PIN and reason are the authorization, and the record says whose.
 */

/** The site's "Other" payment type, cached per target. */
const OTHER_NAME = "other";
/** Live site 471's id for "Other" (/site/paymenttypes, 2026-11-19), used
 *  ONLY when the list cannot be read. */
const OTHER_FALLBACK_ID = 9;
const OTHER_CACHE_MS = 60 * 60 * 1000;
const otherCache = new Map<string, { id: number; at: number }>();

/**
 * The id of the payment type named "Other", by name, from
 * `GET /site/paymenttypes` (site.yml:508; PaymentType Id and
 * PaymentTypeName, site.yml:2200). Cached an hour per target. A read that
 * fails falls back to 9 and logs it; a read that ANSWERS and lists no
 * active "Other" is a refusal, because then 9 is a guess about a list
 * that has said otherwise.
 */
export async function otherPaymentTypeId(): Promise<
  { id: number; source: "list" | "cache" | "fallback" } | { error: string }
> {
  const key = target();
  const hit = otherCache.get(key);
  if (hit && Date.now() - hit.at < OTHER_CACHE_MS) {
    return { id: hit.id, source: "cache" };
  }
  let body: any;
  try {
    body = await mindbody("/site/paymenttypes");
  } catch (err) {
    console.warn(
      `[credit-free] ${key} /site/paymenttypes did not answer ` +
        `(${err instanceof Error ? err.message : String(err)}); using the ` +
        `fallback id ${OTHER_FALLBACK_ID} for "Other"`,
    );
    return { id: OTHER_FALLBACK_ID, source: "fallback" };
  }
  const types: unknown[] = Array.isArray(body?.PaymentTypes) ? body.PaymentTypes : [];
  const named = types.filter((t) => {
    const row = t as { PaymentTypeName?: unknown; Active?: unknown; Id?: unknown };
    return (
      typeof row.PaymentTypeName === "string" &&
      row.PaymentTypeName.trim().toLowerCase() === OTHER_NAME &&
      row.Active !== false &&
      Number.isInteger(Number(row.Id)) &&
      Number(row.Id) > 0
    );
  }) as { Id: number }[];
  const first = named[0];
  if (first === undefined) {
    console.warn(
      `[credit-free] ${key} /site/paymenttypes lists no active "Other" ` +
        `(${types.length} types); refusing rather than guessing`,
    );
    return {
      error:
        'Mindbody lists no active payment type named "Other" on this site, ' +
        "so credit cannot be given at no charge from the app. Nothing was given.",
    };
  }
  const id = Number(first.Id);
  if (named.length > 1) {
    console.warn(
      `[credit-free] ${key} several types named "Other" (${named
        .map((n) => n.Id)
        .join(",")}); using ${id}`,
    );
  }
  otherCache.set(key, { id, at: Date.now() });
  console.log(`[credit-free] ${key} "Other" is payment type ${id} (from the list)`);
  return { id, source: "list" };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Only a definite refusal (a 4xx) says nothing was given. */
function isAmbiguous(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const status = mindbodyHttpStatus(err);
  return status !== null && status >= 500;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function giveNoChargeCredit(
  session: StaffSession,
  payload: Record<string, unknown>,
): Promise<NextResponse> {
  const refuse = (error: string, status = 409, extra: Record<string, unknown> = {}) =>
    NextResponse.json({ error, stage: "method", pinKept: true, ...extra }, { status });

  /* 1. The shape, then the field. Nothing spent, nothing sent. */
  const shape = noChargeShapeRefusal(payload);
  if (shape !== null) return refuse(shape);
  const ask = parseNoChargeCredit(payload["accountCredit"]);
  if ("error" in ask) return refuse(ask.error, 400);
  const { amount, reason } = ask;

  /* 2. A real client. */
  const clientId =
    typeof payload["clientId"] === "string" ? payload["clientId"].trim() : "";
  const house = houseClientId();
  if (clientId === "" || (house !== null && clientId === house)) {
    return refuse(
      clientId === ""
        ? "Credit goes on a client's account. Attach the client first. Nothing was given."
        : "The walk-in account is nobody's, so it holds no credit. Attach the " +
            "client the credit is for. Nothing was given.",
    );
  }

  /* 3. The token: its own purpose, this teacher's, spent once. One
   * sentence for every way it is no good, so a caller learns nothing
   * from WHICH it was. */
  const teacher: TeacherIdentity | null = verifyCompToken(ask.token, NO_CHARGE_PURPOSE);
  const pinRefused = () =>
    NextResponse.json(
      {
        error: "Enter your PIN to give credit at no charge. Nothing was given.",
        reason: "teacher",
        stage: "method",
      },
      { status: 401 },
    );
  if (teacher === null || teacher.id !== session.staffId) return pinRefused();
  if (!spendCompToken(ask.token)) return pinRefused();

  const log = (outcome: string, extra = "") =>
    console.log(
      `[credit-free] ${target()} ${outcome} client=${clientId} ` +
        `amount=${amount.toFixed(2)} teacher=${teacher.id} staff=${session.staffId}${extra}`,
    );
  /* Nothing reached Mindbody as a write: the PIN goes back. */
  const handBack = (why: string) => {
    unspendCompToken(ask.token);
    log(`pin-kept-${why}`);
  };

  /* 4. "Other", by name. */
  const other = await otherPaymentTypeId();
  if ("error" in other) {
    handBack("no-other");
    return refuse(other.error);
  }
  log("other-type", ` id=${other.id} source=${other.source}`);

  /* 5. The balance before: every check after the write is measured from
   * it, so a credit it cannot be measured against is not one to give. */
  let startBalance: number;
  try {
    const before = await clientPaymentProfile(clientId);
    if (before.balance === null) {
      handBack("no-balance");
      return refuse(
        "Mindbody reports no account balance for this client, so the credit " +
          "could not be checked afterwards. Nothing was given.",
      );
    }
    startBalance = before.balance;
  } catch (err) {
    handBack("balance-read");
    return refuse(
      `Could not read the client's account balance: ${errMessage(err)} Nothing was given.`,
      502,
    );
  }

  const payment: NoChargeCreditTender = {
    type: "Other",
    amount,
    paymentTypeId: other.id,
  };

  /* 6. The rehearsal, as the service account (T112's rule for every
   * rehearsal). It does NOT prove the payment type (T258: "Comp/Guest"
   * passed Test and was refused for real), so the real answer is checked
   * on its own below. */
  let trial;
  try {
    trial = await purchaseCredit({ clientId, payment, test: true });
  } catch (err) {
    log("refused-rehearsal", ` reason=${JSON.stringify(errMessage(err))}`);
    return NextResponse.json(
      {
        error: `Mindbody refused the credit: ${errMessage(err)} Nothing was given.`,
        stage: "rehearsal",
      },
      { status: 502 },
    );
  }
  if (trial.suppressed) {
    handBack(`suppressed-${trial.suppressed}`);
    return NextResponse.json({ ok: false, suppressed: trial.suppressed, pinKept: true });
  }
  if (
    trial.amountPaid === null ||
    Math.round(trial.amountPaid * 100) !== Math.round(amount * 100) ||
    trial.failures.length > 0 ||
    (trial.clientId !== null && trial.clientId !== clientId)
  ) {
    log(
      "refused-rehearsal-disagrees",
      ` paid=${trial.amountPaid ?? "none"} failures=${trial.failures.length} ` +
        `client=${trial.clientId ?? "none"}`,
    );
    return NextResponse.json(
      {
        error:
          trial.amountPaid === null
            ? "Mindbody did not say what the credit would come to, so it was not given."
            : trial.failures.length > 0
              ? `Mindbody would not take this: ${trial.failures.join(" ")} Nothing was given.`
              : Math.round(trial.amountPaid * 100) !== Math.round(amount * 100)
                ? `Mindbody's rehearsal came to ${usd(trial.amountPaid)}, not the ` +
                  `${usd(amount)} asked, so nothing was given. Check the client's ` +
                  "sales in Mindbody for one still open."
                : "Mindbody's rehearsal named a different client. Nothing was given; this is a bug to report.",
        stage: "rehearsal",
      },
      { status: 409 },
    );
  }

  /* 7. The one real call, under the teacher's token. */
  let sold;
  try {
    sold = (
      await runAsActor(
        session,
        "/api/checkout",
        (actor) => purchaseCredit({ clientId, payment, test: false, actor }),
        { fallback: false },
      )
    ).result;
  } catch (err) {
    const ended = staffSessionEndedResponse(err);
    if (ended) return ended;
    const ambiguous = isAmbiguous(err);
    log(ambiguous ? "unknown" : "refused", ` reason=${JSON.stringify(errMessage(err))}`);
    return NextResponse.json(
      {
        error: ambiguous
          ? `Mindbody did not answer, so ${usd(amount)} of credit may or may not ` +
            "be on the account. Check the account in Mindbody before giving it " +
            "again. Nothing was retried."
          : `Not given: ${errMessage(err)}`,
        stage: "checkout",
        ambiguous,
      },
      { status: 502 },
    );
  }
  if (sold.suppressed) {
    /* The rehearsal went out and this did not; the guard judges by client
     * id, so this should be unreachable. Suppression, never a credit. */
    handBack(`suppressed-${sold.suppressed}`);
    return NextResponse.json({ ok: false, suppressed: sold.suppressed, pinKept: true });
  }
  const saleId = sold.saleId === null ? null : String(sold.saleId);

  /* 8. What Mindbody said, what the sale holds, what the account reads. */
  const problems: string[] = [];
  if (sold.failures.length > 0) {
    problems.push(`Mindbody reported a problem (${sold.failures.join(" ")})`);
  }
  if (sold.amountPaid === null) {
    problems.push("Mindbody did not say what it recorded");
  } else if (Math.round(sold.amountPaid * 100) !== Math.round(amount * 100)) {
    problems.push(`Mindbody recorded ${usd(sold.amountPaid)}, not ${usd(amount)}`);
  }
  if (sold.clientId !== null && sold.clientId !== clientId) {
    problems.push(`Mindbody's answer names client ${sold.clientId}`);
  }
  let linesChecked = false;
  if (sold.saleId !== null) {
    const read = await saleById(sold.saleId);
    if (read.found && read.purchasedItems !== null) {
      linesChecked = true;
      const lineProblem = creditSaleProblem(read.purchasedItems, amount);
      if (lineProblem !== null) problems.push(lineProblem);
    } else {
      console.warn(`[credit-free] sale ${sold.saleId} not readable yet: its lines are unverified`);
    }
  } else {
    problems.push("Mindbody gave no sale id for the credit");
  }
  let after: number | null = null;
  let afterError: string | null = null;
  try {
    after = (await clientPaymentProfile(clientId)).balance;
  } catch (err) {
    afterError = errMessage(err);
  }
  const want = expectedBalance(startBalance, amount) as number;
  if (after === null) {
    problems.push(
      "the balance could not be read back" + (afterError ? ` (${afterError})` : ""),
    );
  } else if (!balanceAgrees(after, want)) {
    problems.push(
      `the account reads ${usd(after)} afterwards, not the ${usd(want)} it ` +
        `should (${usd(startBalance)} plus ${usd(amount)})`,
    );
  }
  const fields = {
    amount,
    purchased: amount,
    saleId,
    balanceBefore: startBalance,
    balanceAfter: after,
    linesChecked,
  };
  if (problems.length > 0) {
    log(
      "unverified",
      ` sale=${saleId ?? "none"} paid=${sold.amountPaid ?? "none"} before=${startBalance} ` +
        `after=${after ?? "none"} problems=${JSON.stringify(problems)}`,
    );
    return NextResponse.json(
      {
        error:
          `The credit answered, but ${problems.join("; ")}. The credit may not ` +
          `be on the account as asked. The sale is ${saleId ?? "not identified"}. ` +
          "Do not give it again: check the account in Mindbody. Nothing was retried.",
        stage: "checkout",
        ambiguous: true,
        saleId,
        total: 0,
        accountCredit: { ...fields, verified: false, noCharge: { teacher: teacher.name } },
      },
      { status: 502 },
    );
  }

  /* 9. The record, the T45/T62 way. It cannot change the outcome. */
  const line = noChargeRecordLine(amount, teacher.name, reason);
  console.log(
    `[credit-free] given client=${clientId} sale=${saleId} teacher=${teacher.id} ` +
      `before=${startBalance} after=${after} reason=${JSON.stringify(reason)}`,
  );
  const filed = await fileFormulaNote({
    session,
    clientId,
    note: line,
    route: "/api/checkout no-charge credit note",
    logTag: "[credit-free]",
  });
  return NextResponse.json({
    ok: true,
    total: 0,
    saleId,
    accountCredit: {
      ...fields,
      verified: true,
      noCharge: {
        teacher: teacher.name,
        reason,
        paymentTypeId: other.id,
        noted: filed.via !== null,
        ...(filed.suppressed ? { noteSuppressed: filed.suppressed } : {}),
        ...(filed.error ? { noteError: filed.error } : {}),
      },
    },
    ...actorFields({ actorFallback: null, staffSessionEnded: false }),
  });
}
