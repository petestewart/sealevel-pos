import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
  type ActorFallback,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { fetchPasses, type PassInfo } from "@/lib/clientcontext";
import { boundedDb, DB_MARKER_WAIT_MS, insertGuestVisit } from "@/lib/db";
import { fileFormulaNote } from "@/lib/formulanote";
import {
  ignoredPassMessage,
  isGuestPass,
  judgeGuestPass,
  pickNewGuestPass,
  type GuestPassVerdict,
} from "@/lib/guestpass";
import {
  findGuestPassSale,
  guestPassLine,
  isZeroTotal,
  rehearseGuestPass,
  returnSale,
  sellGuestPass,
} from "@/lib/guestsale";
import { mindbodyHttpStatus, target } from "@/lib/mindbody";
import { studioDate } from "@/lib/notesig";
import {
  bookClientIntoClass,
  setSignedIn,
  setVisitService,
  visitPayment,
} from "@/lib/roster";
import { guestPassOption } from "@/lib/sale";

export const dynamic = "force-dynamic";

/**
 * T63: a member's guest pass checks a guest in, the way the front desk
 * does it in Mindbody's own POS (Pete's screens, 2026-09-04). Mechanism
 * A (T59c: the member's pass id on the guest's visit) is dead: Mindbody
 * takes the id and pays the visit with something else without a word,
 * which T62 detects and answers 409. What replaces it:
 *
 *   1. SELL the GUEST a $0 "Guest Pass (for auto-debit members only)":
 *      the option found by name in the services catalog (never a
 *      hardcoded id), rehearsed with `Test: true` first (T45's idiom),
 *      and sold for real ONLY when the rehearsed total is exactly 0.00,
 *      paid with the Comp stub at $0. No PayerClientId (that needs a
 *      stored "Pays for" relationship), SendEmail false. Money-shaped
 *      even at $0, so it inherits sale.ts's discipline: one flight, a
 *      4xx is a clean refusal, a 5xx or a dead transport is AMBIGUOUS
 *      ("the sale may have gone through; check the guest's purchases
 *      before trying again") and is never retried. The new pass id is
 *      read back off the guest's account (the checkout answer carries
 *      no ClientService): a guest pass not on the list read before the
 *      sale, else the newest by PaymentDate.
 *   2. BOOK the guest with that pass id and sign them in, or move an
 *      already-booked guest's visit onto it and sign them in. T62's
 *      read-back stays: the visit's ServiceId must equal the new pass
 *      id, else 409 ignored (it should never fire now; the honesty
 *      does not depend on that).
 *   3. RETIRE the MEMBER's Guest Pass by RETURNING the sale it came
 *      from, and only by return (Pete's hard rule, T63): the sale is
 *      found through /sale/sales and returned ONLY when it holds exactly
 *      one item, that item is the Guest Pass, its total is $0.00 and it
 *      carries no card, stored-card, account, gift-card or cash payment
 *      (judgeGuestPassSale). Otherwise, or when Mindbody refuses, the
 *      pass is NOT retired and the answer says so in amber; the guest's
 *      check-in stands. No expiry fallback, no updateclientservice,
 *      ever. The member's passes are read after and the count reported.
 *   4. The MEMBER's sign-in, when their row was not in (unchanged).
 *   5. RECORDS as T62 left them: the Formula Note with the signed Notes
 *      fallback on both profiles, and the `guest_visits` marker.
 *
 * Order: sell, book, sign in the guest, return, sign in the member,
 * records. A failure stops the sequence and the answer says what
 * landed, step by step: "done" | "suppressed" | "skipped" | {error}.
 * Every write goes through mindbody() with the RELEVANT client id in
 * the options (the guest's writes with the guest's id, the member's
 * with the member's) and under the signed-in teacher via runAsActor;
 * dry run and the write guard are reported per step, never as success.
 * Nothing is retried automatically. Reads stay on the service account.
 *
 * Body: `{memberClientId, guestClientId, classId, clientServiceId,
 * guestVisitId?, memberVisitId?, className?, classStartsAt?,
 * memberName?, guestName?}`, `clientServiceId` being the MEMBER's Guest
 * Pass (the one to retire). The names and the class caption are for the
 * records and the return reason only; the browser has them on the rows
 * already, and a lookup here would be a metered call spent on a caption.
 */

type StepOutcome = "done" | "suppressed" | "skipped" | { error: string };

const NAME_MAX = 120;

function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

function optionalInt(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** "9/3/26" from a site-local class start ("2026-09-03T09:00:00"): the
 *  string is already studio wall time (CLAUDE.md), so the date is read
 *  off it, never through Date and a timezone. */
function noteDate(startsAt: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startsAt ?? "");
  if (!m) return "";
  return `${Number(m[2])}/${Number(m[3])}/${m[1]!.slice(2)}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mindbody's wording ends in a period; inside a sentence of ours it
 *  loses it, so "refused: ... option. Nothing" does not read "option..". */
function reasonOf(err: unknown): string {
  return errMessage(err).replace(/\.\s*$/, "");
}

/** Whether Mindbody's refusal of a write reads as the request being
 *  refused at the gate: any 4xx (the request provably did not process),
 *  with the wording kept verbatim. */
function isRefusal(err: unknown): boolean {
  const status = mindbodyHttpStatus(err);
  if (status !== null) return status < 500;
  return /service|pricing option|pass|client|item/i.test(errMessage(err));
}

/** The checkout route's posture for a money write that did not answer
 *  cleanly: a dead transport (fetch's TypeError), a timeout, or a 5xx
 *  may have processed before failing. Never "nothing was sold". */
function isAmbiguous(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const status = mindbodyHttpStatus(err);
  return status !== null && status >= 500;
}

export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad hears only the 401 and never a validation detail
   * or a Mindbody read made on its behalf. */
  const staff = requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "The request was not JSON." }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json({ error: "The request was not an object." }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;
  const memberClientId = body["memberClientId"];
  const guestClientId = body["guestClientId"];
  const classId = body["classId"];
  const clientServiceId = body["clientServiceId"];
  if (typeof memberClientId !== "string" || !memberClientId) {
    return NextResponse.json(
      { error: "memberClientId (string) is required" },
      { status: 400 },
    );
  }
  if (typeof guestClientId !== "string" || !guestClientId) {
    return NextResponse.json(
      { error: "guestClientId (string) is required" },
      { status: 400 },
    );
  }
  if (memberClientId === guestClientId) {
    return NextResponse.json(
      { error: "A member cannot be their own guest." },
      { status: 400 },
    );
  }
  if (typeof classId !== "number" || !Number.isInteger(classId)) {
    return NextResponse.json(
      { error: "classId (number) is required" },
      { status: 400 },
    );
  }
  if (typeof clientServiceId !== "number" || !Number.isInteger(clientServiceId)) {
    return NextResponse.json(
      { error: "clientServiceId (number) is required" },
      { status: 400 },
    );
  }
  const guestVisitId = optionalInt(body["guestVisitId"]);
  const memberVisitId = optionalInt(body["memberVisitId"]);
  if (guestVisitId === undefined || memberVisitId === undefined) {
    return NextResponse.json(
      { error: "guestVisitId and memberVisitId must be numbers when given" },
      { status: 400 },
    );
  }
  const className = optionalText(body["className"], NAME_MAX);
  const classStartsAt = optionalText(body["classStartsAt"], 40);
  const memberName = optionalText(body["memberName"], NAME_MAX);
  const guestName = optionalText(body["guestName"], NAME_MAX);
  if (
    className === undefined ||
    classStartsAt === undefined ||
    memberName === undefined ||
    guestName === undefined
  ) {
    return NextResponse.json(
      { error: "className, classStartsAt, memberName and guestName must be strings when given" },
      { status: 400 },
    );
  }
  const guestLabel = guestName ?? "the guest";
  const memberLabel = memberName ?? "the member";

  /* Step 0: three reads, together. The member's pass, re-read: the
   * browser's cached list is what showed the action, and a list from
   * ten minutes ago can hold a pass another screen has since returned.
   * The guest's passes BEFORE the sale, so the new one can be told from
   * any they had (a failure here is not fatal: the newest PaymentDate
   * decides instead). And the Guest Pass option from the catalog. */
  let pass: {
    name: string;
    remaining: number | null;
    expires: string | null;
    productId: number | null;
    paymentDate: string | null;
  };
  let guestBefore: ReadonlySet<number> | null = null;
  let option: Awaited<ReturnType<typeof guestPassOption>>;
  try {
    const [passes, before, found] = await Promise.all([
      fetchPasses(memberClientId),
      fetchPasses(guestClientId).then(
        (list) => new Set(list.map((p) => p.id).filter((id): id is number => id !== null)),
        (err: unknown) => {
          console.log(`[guest] guest pass pre-read failed: ${errMessage(err)}`);
          return null;
        },
      ),
      guestPassOption(isGuestPass),
    ]);
    const mine = passes.find((p) => p.id === clientServiceId) ?? null;
    if (
      mine === null ||
      !isGuestPass(mine.name) ||
      mine.remaining === null ||
      mine.remaining <= 0
    ) {
      return NextResponse.json(
        {
          error: "No guest pass with sessions left",
          step: "pass",
          found: mine === null ? null : { name: mine.name, remaining: mine.remaining },
        },
        { status: 409 },
      );
    }
    pass = {
      name: mine.name,
      remaining: mine.remaining,
      expires: mine.expires,
      productId: mine.productId,
      paymentDate: mine.paymentDate,
    };
    guestBefore = before;
    option = found;
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read the passes or the catalog: ${errMessage(err)}`, step: "pass" },
      { status: 502 },
    );
  }
  if (option === null) {
    return NextResponse.json(
      {
        error:
          "The studio's catalog has no Guest Pass pricing option to sell, so nothing was written.",
        step: "catalog",
      },
      { status: 409 },
    );
  }

  const fallbacks: ActorFallback[] = [];
  const noteFallback = (outcome: { actorFallback: ActorFallback | null }) => {
    if (outcome.actorFallback) fallbacks.push(outcome.actorFallback);
  };
  const steps: {
    sale: StepOutcome;
    guest: StepOutcome;
    return: StepOutcome;
    member: StepOutcome;
    notes: StepOutcome;
  } = {
    sale: "skipped",
    guest: "skipped",
    return: "skipped",
    member: "skipped",
    notes: "skipped",
  };
  /** What the sheet says about the guest's sale. */
  const sale: { cartId: string | null; product: string; guestPassId: number | null } = {
    cartId: null,
    product: option.name,
    guestPassId: null,
  };
  /** What the sheet says about the member's pass after the flow. */
  const memberPass: {
    /** The verdict or Mindbody's refusal, when the pass was not
     *  returned; the sheet's amber line quotes it. */
    reason: string | null;
    returnSaleId: number | null;
    /** ReturnSaleResponse.Amount, as reported. */
    returnedAmount: number | null;
    /** The Guest Pass sessions still on the member's account after the
     *  flow, as re-read: 0 when the pass has left the active list. Null
     *  when the re-read failed. */
    remaining: number | null;
  } = { reason: null, returnSaleId: null, returnedAmount: null, remaining: null };
  let visitId: number | null = guestVisitId;
  /* Set the moment the guest step's FIRST write has an answer (sent or
   * suppressed): a refusal after that is a partial, not a clean 409. */
  let landed = false;
  let verification: PassVerification | null = null;

  const line = guestPassLine(option);
  const logLine = (outcome: string, extra = "") =>
    console.log(
      `[guest] ${target()} member=${memberClientId} guest=${guestClientId} class=${classId} ` +
        `memberPass=${clientServiceId} product=${option!.productId} outcome=${outcome}${extra}`,
    );

  /* Step 1: the guest's $0 Guest Pass. Rehearsal first, on the service
   * account like every rehearsal; the real sale only at exactly $0.00. */
  let newPass: (PassInfo & { id: number }) | null = null;
  try {
    const priced = await rehearseGuestPass(line, guestClientId);
    if (priced.suppressed) {
      steps.sale = "suppressed";
    } else if (!isZeroTotal(priced.grandTotal)) {
      const amount = priced.grandTotal ?? 0;
      logLine("refused", ` priced=${amount.toFixed(2)}`);
      return NextResponse.json(
        {
          error:
            `Mindbody priced the Guest Pass at $${amount.toFixed(2)} for ${guestLabel}, ` +
            `not $0.00. Nothing was sold or written.`,
          step: "sale",
          refused: true,
          priced: amount,
        },
        { status: 409 },
      );
    }
  } catch (err) {
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    logLine("rehearsal-failed", ` error=${JSON.stringify(errMessage(err))}`);
    return NextResponse.json(
      {
        error: `Mindbody would not price the Guest Pass for ${guestLabel}: ${reasonOf(err)}. Nothing was written.`,
        step: "sale",
        refused: isRefusal(err),
      },
      { status: isRefusal(err) ? 409 : 502 },
    );
  }
  if (steps.sale !== "suppressed") {
    let sold: Awaited<ReturnType<typeof sellGuestPass>>;
    try {
      /* T45's comp posture: a comp under a teacher's token that Mindbody
       * refuses is REFUSED, never redone as the service account. */
      const outcome = await runAsActor(
        session,
        "/api/guest sale",
        (actor) => sellGuestPass(line, guestClientId, actor),
        { fallback: false },
      );
      sold = outcome.result;
    } catch (err) {
      const gone = staffSessionEndedResponse(err);
      if (gone) return gone;
      const ambiguous = isAmbiguous(err);
      logLine(ambiguous ? "ambiguous" : "refused", ` error=${JSON.stringify(errMessage(err))}`);
      return NextResponse.json(
        {
          error: ambiguous
            ? `The Guest Pass sale for ${guestLabel} did not answer (${reasonOf(err)}). ` +
              `It MAY have gone through: check ${guestLabel}'s purchases in Mindbody before trying again. ` +
              `Nothing else was written.`
            : `Mindbody refused the $0 Guest Pass sale for ${guestLabel}: ${reasonOf(err)}. Nothing was written.`,
          step: "sale",
          refused: !ambiguous,
          ambiguous,
        },
        { status: ambiguous ? 502 : 409 },
      );
    }
    if (sold.suppressed) {
      steps.sale = "suppressed";
    } else {
      steps.sale = "done";
      sale.cartId = sold.saleId;
      if (sold.grandTotal !== null && !isZeroTotal(sold.grandTotal)) {
        /* Cannot happen after a $0 rehearsal, and if it ever does the
         * fact belongs in the log and on the sheet, not swallowed. */
        console.warn(
          `[guest] the real sale answered a total of ${sold.grandTotal} after a $0 rehearsal (cart ${sold.saleId})`,
        );
      }
      /* The new pass, off the guest's account. */
      try {
        const after = await fetchPasses(guestClientId);
        newPass = pickNewGuestPass(after, guestBefore);
        sale.guestPassId = newPass?.id ?? null;
      } catch (err) {
        console.log(`[guest] guest pass re-read failed: ${errMessage(err)}`);
      }
      if (newPass === null) {
        logLine("sold-not-found", ` cart=${sale.cartId}`);
        return NextResponse.json(
          {
            ok: false,
            error:
              `The $0 Guest Pass was sold to ${guestLabel} (cart ${sale.cartId ?? "unknown"}) but could not be ` +
              `found on their account, so they were not booked. Book them from their row, or check their passes in Mindbody.`,
            step: "guest",
            landed: false,
            guestVisitId: visitId,
            suppressed: false,
            steps,
            sale,
            memberPass,
            notes: { guest: null, member: null },
            pass,
            ...verifiedFields(null),
            ...fallbackFields(fallbacks),
          },
          { status: 502 },
        );
      }
    }
  }

  const ignoredResponse = (v: PassVerification, visit: number, bookedHere: boolean) => {
    const error = ignoredPassMessage({
      guestName: guestLabel,
      memberName: memberLabel,
      ownPass: v.ownPass,
    });
    console.warn(
      `[guest] ignored member=${memberClientId} guest=${guestClientId} ` +
        `service=${newPass?.id ?? "none"} class=${classId} visit=${visit} ` +
        `paidWith=${v.visitServiceId ?? "none"} remaining=${v.remaining}: ${JSON.stringify(error)}`,
    );
    return NextResponse.json(
      {
        error,
        step: "guest",
        refused: true,
        ignored: true,
        guestVisitId: visit,
        bookedHere,
        ownPass: v.ownPass,
        sale,
        steps,
        memberPass,
        ...fallbackFields(fallbacks),
      },
      { status: 409 },
    );
  };

  /* T62: the durable "Guest of" marker, written the moment the
   * read-back confirms the visit is on the guest's new pass (before the
   * sign-in, which is a separate write that can fail on its own): the
   * fact recorded is whose guest they are. Best effort by the charter. */
  const marker = async (visit: number) => {
    const ok = await boundedDb<boolean | "slow">(
      insertGuestVisit({
        visitId: visit,
        classId,
        guestClientId,
        memberClientId,
        memberName: memberName ?? "a member",
        guestName: guestName ?? "a guest",
        staffId: session ? String(session.staffId) : null,
      }),
      DB_MARKER_WAIT_MS,
      "slow",
    );
    if (ok === "slow") {
      console.log(`[guest] marker not confirmed in ${DB_MARKER_WAIT_MS}ms: visit=${visit}`);
    } else if (!ok) {
      console.log(`[guest] marker not stored (no database): visit=${visit}`);
    }
  };

  /* Step 2: the guest, on their new pass. With the sale suppressed there
   * is no pass id to book with, so the step is suppressed with it. */
  if (newPass === null) {
    steps.guest = "suppressed";
  } else {
    const passId = newPass.id;
    const remainingBefore = newPass.remaining ?? 1;
    try {
      if (guestVisitId !== null) {
        const paid = await runAsActor(session, "/api/guest visit-payment", (actor) =>
          setVisitService(guestVisitId, passId, guestClientId, actor),
        );
        noteFallback(paid);
        landed = true;
        if (paid.result.suppressed) {
          steps.guest = "suppressed";
        } else {
          verification = await verifyPass({
            classId,
            visitId: guestVisitId,
            sent: passId,
            ownerClientId: guestClientId,
            remainingBefore,
            fromAnswer: null,
          });
          if (verification.verdict === "ignored") {
            return ignoredResponse(verification, guestVisitId, false);
          }
          if (verification.verdict === "landed") await marker(guestVisitId);
          const signed = await runAsActor(session, "/api/guest checkin", (actor) =>
            setSignedIn(guestVisitId, true, guestClientId, actor),
          );
          noteFallback(signed);
          steps.guest = signed.result.suppressed ? "suppressed" : "done";
        }
      } else {
        const booked = await runAsActor(session, "/api/guest book", (actor) =>
          bookClientIntoClass({
            clientId: guestClientId,
            classId,
            clientServiceId: passId,
            actor,
          }),
        );
        noteFallback(booked);
        landed = true;
        if (booked.result.suppressed) {
          steps.guest = "suppressed";
        } else if (booked.result.visitId === null) {
          steps.guest = {
            error: "Mindbody booked the guest but returned no visit id, so they could not be signed in.",
          };
        } else {
          const newVisitId = booked.result.visitId;
          visitId = newVisitId;
          verification = await verifyPass({
            classId,
            visitId: newVisitId,
            sent: passId,
            ownerClientId: guestClientId,
            remainingBefore,
            fromAnswer:
              booked.result.serviceId === null
                ? null
                : {
                    clientServiceId: booked.result.serviceId,
                    pricingOption: booked.result.serviceName,
                  },
          });
          if (verification.verdict === "ignored") {
            return ignoredResponse(verification, newVisitId, true);
          }
          if (verification.verdict === "landed") await marker(newVisitId);
          if (booked.result.signedIn === true) {
            /* T19: an after-start booking can come back already signed
             * in; a second SignedIn write would be a call for nothing. */
            steps.guest = "done";
          } else {
            const signed = await runAsActor(session, "/api/guest checkin", (actor) =>
              setSignedIn(newVisitId, true, guestClientId, actor),
            );
            noteFallback(signed);
            steps.guest = signed.result.suppressed ? "suppressed" : "done";
          }
        }
      }
    } catch (err) {
      const gone = staffSessionEndedResponse(err);
      if (gone) return gone;
      const error = errMessage(err);
      if (!landed && isRefusal(err)) {
        /* The first write of the step refused: the guest holds their $0
         * pass and nothing else was written. */
        console.warn(
          `[guest] refused member=${memberClientId} guest=${guestClientId} ` +
            `service=${passId} class=${classId}: ${JSON.stringify(error)}`,
        );
        return NextResponse.json(
          {
            error,
            step: "guest",
            refused: true,
            sale,
            steps,
            memberPass,
            ...fallbackFields(fallbacks),
          },
          { status: 409 },
        );
      }
      steps.guest = { error };
    }
  }

  /* A failed guest step ends the flow: the member's pass is not
   * returned for a visit that did not happen, and signing the member in
   * and noting it would be two writes about nothing. The answer says
   * exactly what landed (T59c review: `landed` rides along, because a
   * failure AFTER the first write is a visit on the pass with no
   * sign-in, and the sheet must say so). */
  if (typeof steps.guest === "object") {
    logLine("guest-failed", ` error=${JSON.stringify(steps.guest.error)}`);
    return NextResponse.json(
      {
        ok: false,
        error: steps.guest.error,
        step: "guest",
        landed,
        guestVisitId: visitId,
        suppressed: false,
        steps,
        sale,
        memberPass,
        notes: { guest: null, member: null },
        pass,
        ...verifiedFields(verification),
        ...fallbackFields(fallbacks),
      },
      { status: 502 },
    );
  }

  /* Step 3: the member's Guest Pass, retired by return and only by
   * return. Only after a guest step that really landed: a suppressed
   * guest step leaves the pass where it is, and says so. */
  const when = [className ?? "class", noteDate(classStartsAt)].filter(Boolean).join(" ");
  if (steps.guest === "done") {
    const reason = `Guest pass redeemed for ${guestLabel} ${noteDate(classStartsAt) || studioDate()}`;
    try {
      if (pass.productId === null) {
        throw new Error("the pass carries no product id to match a sale on");
      }
      const found = await findGuestPassSale({
        memberClientId,
        productId: pass.productId,
        paymentDate: pass.paymentDate,
      });
      if (!found.returnable) {
        memberPass.reason = found.reason;
        steps.return = { error: found.reason };
        console.log(
          `[guest] not returned member=${memberClientId} pass=${clientServiceId} ` +
            `window=${found.window.start}..${found.window.end} sales=${found.sales}: ${JSON.stringify(found.reason)}`,
        );
      } else {
        const returned = await runAsActor(session, "/api/guest return", (actor) =>
          returnSale({ saleId: found.saleId, reason, memberClientId, actor }),
        );
        noteFallback(returned);
        if (returned.result.suppressed) {
          steps.return = "suppressed";
        } else {
          steps.return = "done";
          memberPass.returnSaleId = returned.result.returnSaleId;
          memberPass.returnedAmount = returned.result.amount;
          if (returned.result.amount !== null && !isZeroTotal(returned.result.amount)) {
            /* The judge only lets a $0 sale through, so this is Mindbody
             * disagreeing with its own listing. Loud, and on the sheet. */
            console.warn(
              `[guest] RETURN AMOUNT ${returned.result.amount} on sale ${found.saleId} for member ${memberClientId}; the judge saw $0.00`,
            );
          }
          console.log(
            `[guest] returned member=${memberClientId} sale=${found.saleId} ` +
              `returnSale=${returned.result.returnSaleId ?? "none"} amount=${returned.result.amount ?? "none"}`,
          );
        }
      }
    } catch (err) {
      const gone = staffSessionEndedResponse(err);
      if (gone) return gone;
      memberPass.reason = errMessage(err);
      steps.return = { error: errMessage(err) };
      console.warn(
        `[guest] return failed member=${memberClientId} pass=${clientServiceId}: ${JSON.stringify(errMessage(err))}`,
      );
    }
    /* The pass as it stands now, whatever happened above: the count the
     * sheet reports is Mindbody's, not an inference from the return. */
    try {
      const after = await fetchPasses(memberClientId);
      const still = after.find((p) => p.id === clientServiceId) ?? null;
      memberPass.remaining = still === null ? 0 : (still.remaining ?? null);
    } catch (err) {
      console.log(`[guest] member pass re-read failed: ${errMessage(err)}`);
    }
  } else {
    memberPass.reason = "the guest's Guest Pass was not sold, so there was nothing to redeem";
  }

  /* Step 4: the member. */
  if (memberVisitId !== null) {
    try {
      const signed = await runAsActor(session, "/api/guest member-checkin", (actor) =>
        setSignedIn(memberVisitId, true, memberClientId, actor),
      );
      noteFallback(signed);
      steps.member = signed.result.suppressed ? "suppressed" : "done";
    } catch (err) {
      const gone = staffSessionEndedResponse(err);
      if (gone) return gone;
      steps.member = { error: errMessage(err) };
    }
  }

  /* Step 5: the records, only after a guest visit that really landed
   * (T45's rule: a note records a thing that happened). */
  const notes: { guest: number | null; member: number | null } = {
    guest: null,
    member: null,
  };
  const noteVia: {
    guest: "formula" | "notes" | null;
    member: "formula" | "notes" | null;
  } = { guest: null, member: null };
  if (steps.guest === "done") {
    const [g, m] = await Promise.all([
      fileFormulaNote({
        session,
        clientId: guestClientId,
        note: `Guest of ${memberLabel}, guest pass, ${when}.`,
        route: "/api/guest formula-note",
        logTag: "[guest]",
      }),
      fileFormulaNote({
        session,
        clientId: memberClientId,
        note: `Guest pass redeemed for ${guestLabel}, ${when}.`,
        route: "/api/guest formula-note",
        logTag: "[guest]",
      }),
    ]);
    notes.guest = g.id;
    notes.member = m.id;
    noteVia.guest = g.via;
    noteVia.member = m.via;
    const errors = [
      g.error === null ? null : `guest: ${g.error}`,
      m.error === null ? null : `member: ${m.error}`,
    ].filter((e): e is string => e !== null);
    const errorLine =
      g.error !== null && g.error === m.error ? `both: ${g.error}` : errors.join("; ");
    steps.notes =
      errors.length > 0
        ? { error: errorLine }
        : g.suppressed || m.suppressed
          ? "suppressed"
          : "done";
  }

  const suppressed =
    steps.sale === "suppressed" ||
    steps.guest === "suppressed" ||
    steps.return === "suppressed" ||
    steps.member === "suppressed" ||
    steps.notes === "suppressed";
  logLine(
    "answered",
    ` visit=${visitId ?? "none"} guestPass=${newPass?.id ?? "none"} cart=${sale.cartId ?? "none"} ` +
      `sale=${stepTag(steps.sale)} guest=${stepTag(steps.guest)} return=${stepTag(steps.return)} ` +
      `member=${stepTag(steps.member)} notes=${stepTag(steps.notes)} memberRemaining=${memberPass.remaining ?? "?"}`,
  );
  return NextResponse.json({
    ok: true,
    suppressed,
    steps,
    sale,
    memberPass,
    notes,
    noteVia,
    pass,
    guestVisitId: visitId,
    ...verifiedFields(verification),
    ...fallbackFields(fallbacks),
  });
}

/** T62: whether the read-back confirmed the pass. `verified` is false
 *  only when both reads failed (the sheet says so in amber); a
 *  suppressed step has nothing to verify and is null. */
function verifiedFields(v: PassVerification | null): Record<string, unknown> {
  if (v === null) return { verified: null, verifyDetail: null };
  return { verified: v.verdict === "landed", verifyDetail: v.detail };
}

interface PassVerification {
  verdict: GuestPassVerdict;
  visitServiceId: number | null;
  ownPass: string | null | undefined;
  remaining: string;
  detail: string | null;
}

/**
 * T62's read-back, kept: two reads, in parallel, the visit's pass (the
 * booking answer's ServiceId when it carried one, else one
 * `/class/classvisits` read) and the pass owner's list (T63: the GUEST,
 * whose new one-session pass should now be spent and gone from the
 * ShowActiveOnly list). judgeGuestPass decides from what is known.
 */
async function verifyPass(opts: {
  classId: number;
  visitId: number;
  sent: number;
  ownerClientId: string;
  remainingBefore: number;
  fromAnswer: { clientServiceId: number | null; pricingOption: string | null } | null;
}): Promise<PassVerification> {
  const failures: string[] = [];
  const [visit, remaining] = await Promise.all([
    opts.fromAnswer !== null
      ? Promise.resolve(opts.fromAnswer)
      : visitPayment(opts.classId, opts.visitId).then(
          (v) => {
            if (v === null) failures.push("the visit was not on the class list");
            return v;
          },
          (err: unknown) => {
            failures.push(`visit read failed: ${errMessage(err)}`);
            return null;
          },
        ),
    fetchPasses(opts.ownerClientId).then(
      (passes) => {
        const found = passes.find((p) => p.id === opts.sent) ?? null;
        return { before: opts.remainingBefore, after: found ? found.remaining : null };
      },
      (err: unknown) => {
        failures.push(`pass read failed: ${errMessage(err)}`);
        return null;
      },
    ),
  ]);
  const verdict = judgeGuestPass({ sent: opts.sent, visit, remaining });
  return {
    verdict,
    visitServiceId: visit?.clientServiceId ?? null,
    ownPass: visit === null ? undefined : (visit.pricingOption ?? null),
    remaining:
      remaining === null
        ? "?"
        : `${remaining.before}->${remaining.after === null ? "gone" : remaining.after}`,
    detail: verdict === "unverified" ? failures.join("; ") : null,
  };
}

function stepTag(s: StepOutcome): string {
  return typeof s === "string" ? s : "failed";
}

function fallbackFields(fallbacks: ActorFallback[]): Record<string, unknown> {
  return actorFields({
    actorFallback: fallbacks[0] ?? null,
    staffSessionEnded: false,
  });
}
