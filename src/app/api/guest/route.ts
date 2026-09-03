import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
  type ActorFallback,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { fetchPasses } from "@/lib/clientcontext";
import { fileFormulaNote } from "@/lib/formulanote";
import {
  ignoredPassMessage,
  isGuestPass,
  judgeGuestPass,
  type GuestPassVerdict,
} from "@/lib/guestpass";
import { mindbodyHttpStatus } from "@/lib/mindbody";
import {
  bookClientIntoClass,
  setSignedIn,
  setVisitService,
  visitPayment,
} from "@/lib/roster";

export const dynamic = "force-dynamic";

/**
 * T59c: a member's guest pass checks a guest in. Mechanism A (Pete,
 * 2026-09-03): the GUEST's visit is booked or paid with the MEMBER's
 * Guest Pass id, so Mindbody's own records read as staff enter them
 * today (the guest's visit on the guest pass, the member's on the
 * membership), one write consumes the pass, and reversal is the
 * existing cancel-visit or a pass change on the guest's row.
 *
 * Body: `{memberClientId, guestClientId, classId, clientServiceId,
 * guestVisitId?, memberVisitId?, className?, classStartsAt?,
 * memberName?, guestName?}`. The names and the class caption are for the
 * Formula Notes only; the browser has them on the rows already, and a
 * lookup here would be a metered call spent on a caption.
 *
 * The steps, in order, each through mindbody() with the RELEVANT client
 * id in the options (the guest's writes carry the guest's id, the
 * member's the member's, so the write guard judges each one) and as the
 * signed-in teacher via runAsActor:
 *
 *   1. Re-read the member's passes and confirm `clientServiceId` is a
 *      guest pass of theirs with a session left; otherwise 409 and
 *      nothing written. The browser's cached list is a hint, not proof.
 *   2. The guest: a guest already booked in this class (`guestVisitId`)
 *      gets `updateclientvisit {ClientServiceId}` then `{SignedIn}`; a
 *      guest not in the class is booked with the pass id on the ONE
 *      `addclienttoclass` call and then signed in, unless the booking
 *      already came back signed in (T19). This is the write Mindbody
 *      may refuse (the spec calls ClientServiceId "on the client's
 *      account", class.yml:3370): a refusal answers 409 `{step: "guest",
 *      refused: true, error}` with Mindbody's exact words and nothing
 *      else written, so Pete's probe reports the truth and mechanism B
 *      stays a small change here rather than a redesign.
 *   2b. T62: the pass, READ BACK. Pete's live probe (2026-09-04) found
 *      Mindbody accepting the member's pass id and paying the guest's
 *      visit with the guest's own pass, silently; the app said "done".
 *      So between the first write and the sign-in, the visit's pass
 *      (the booking answer's ServiceId, else a `/class/classvisits`
 *      re-read) and the member's pass count (re-read) are compared with
 *      what was sent (judgeGuestPass). An ignored id answers 409
 *      `{step: "guest", refused: true, ignored: true, error}` naming the
 *      pass Mindbody used, with the guest NOT signed in and nothing else
 *      written: the sheet offers "Remove from class", which gives the
 *      guest's own session back. The mechanism that replaces A is still
 *      open (Pete is finding out how the front desk does it); this
 *      makes the step honest without changing the calls it makes.
 *   3. The member: signed in when the browser says they are not yet
 *      (`memberVisitId`); skipped otherwise. A failure here is a
 *      partial, reported as such: the guest landed, the member did not.
 *   4. Formula Notes on both (T45's write, src/lib/formulanote.ts),
 *      after a guest step that REALLY landed: bounded, never fatal.
 *
 * There is no transaction across these, so every answer says exactly
 * what did and did not land, per step: "done" | "suppressed" |
 * "skipped" | {error}. Suppression by dry run or the write guard is
 * never success (`suppressed: true` on the answer, and the step says
 * which), and nothing is retried automatically.
 *
 * Switching to mechanism B (guest booked with free entry, the member's
 * own visit moved onto the pass) would change step 2 to omit the
 * ClientServiceId and step 3 to call setVisitService on the member's
 * visit before setSignedIn; the guards, the notes and the answer's
 * shape stay.
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

/** Whether Mindbody's refusal of the guest step reads as the pass id
 *  being refused: any 4xx on this step counts (the request was refused
 *  at the gate and provably did not process), and the wording is kept
 *  verbatim for the probe. */
function isRefusal(err: unknown): boolean {
  const status = mindbodyHttpStatus(err);
  if (status !== null) return status < 500;
  return /service|pricing option|pass/i.test(errMessage(err));
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

  /* Step 1: the pass, re-read. The browser's cached list is what showed
   * the action, and a list from ten minutes ago can hold a pass another
   * screen has since spent. Reads stay on the service account. */
  let pass: { name: string; remaining: number | null; expires: string | null };
  try {
    const passes = await fetchPasses(memberClientId);
    const found = passes.find((p) => p.id === clientServiceId) ?? null;
    if (
      found === null ||
      !isGuestPass(found.name) ||
      found.remaining === null ||
      found.remaining <= 0
    ) {
      return NextResponse.json(
        {
          error: "No guest pass with sessions left",
          step: "pass",
          found: found === null ? null : { name: found.name, remaining: found.remaining },
        },
        { status: 409 },
      );
    }
    pass = { name: found.name, remaining: found.remaining, expires: found.expires };
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read the member's passes: ${errMessage(err)}`, step: "pass" },
      { status: 502 },
    );
  }

  const fallbacks: ActorFallback[] = [];
  const noteFallback = (outcome: { actorFallback: ActorFallback | null }) => {
    if (outcome.actorFallback) fallbacks.push(outcome.actorFallback);
  };
  const steps: { guest: StepOutcome; member: StepOutcome; notes: StepOutcome } = {
    guest: "skipped",
    member: "skipped",
    notes: "skipped",
  };
  let visitId: number | null = guestVisitId;
  /* Set the moment the step's FIRST write has an answer (sent or
   * suppressed): a refusal after that is a partial, not a clean 409. */
  let landed = false;

  /* T62: what the read-back after the guest's first write found. Null
   * until there was a write to read back. "unverified" (both reads
   * failed) is reported on the sheet in amber, never dressed as
   * confirmed. */
  let verification: PassVerification | null = null;
  const ignoredResponse = (v: PassVerification, visit: number, bookedHere: boolean) => {
    const error = ignoredPassMessage({
      guestName: guestName ?? "the guest",
      memberName: memberName ?? "the member",
      ownPass: v.ownPass,
    });
    console.warn(
      `[guest] ignored member=${memberClientId} guest=${guestClientId} ` +
        `service=${clientServiceId} class=${classId} visit=${visit} ` +
        `paidWith=${v.visitServiceId ?? "none"} remaining=${v.remaining}: ${JSON.stringify(error)}`,
    );
    return NextResponse.json(
      {
        error,
        step: "guest",
        refused: true,
        ignored: true,
        guestVisitId: visit,
        /* Whether this flow created the visit: the sheet offers removal
         * for a visit it made or one now on the guest's own pass, and
         * only Close for a booking that was there before and is
         * unchanged (nothing to give back). */
        bookedHere,
        ownPass: v.ownPass,
        ...fallbackFields(fallbacks),
      },
      { status: 409 },
    );
  };

  /* Step 2: the guest. */
  try {
    if (guestVisitId !== null) {
      const paid = await runAsActor(session, "/api/guest visit-payment", (actor) =>
        setVisitService(guestVisitId, clientServiceId, guestClientId, actor),
      );
      noteFallback(paid);
      landed = true;
      if (paid.result.suppressed) {
        steps.guest = "suppressed";
      } else {
        /* T62: read back before the sign-in. updateclientvisit answers
         * with no pass on the visit, so this is the class's visit list
         * plus the member's pass count. */
        verification = await verifyPass({
          classId,
          visitId: guestVisitId,
          sent: clientServiceId,
          memberClientId,
          remainingBefore: pass.remaining ?? 0,
          fromAnswer: null,
        });
        if (verification.verdict === "ignored") {
          return ignoredResponse(verification, guestVisitId, false);
        }
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
          clientServiceId,
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
        /* T62: the booking answer carries the pass Mindbody applied
         * (ServiceId); when it does, that is one read fewer. */
        verification = await verifyPass({
          classId,
          visitId: newVisitId,
          sent: clientServiceId,
          memberClientId,
          remainingBefore: pass.remaining ?? 0,
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
        if (booked.result.signedIn === true) {
          /* T19: an after-start booking can come back already signed
           * in; a second SignedIn write would be idempotent, but a call
           * for nothing is a metered call for nothing. */
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
      /* The first write of the step refused: nothing else was written.
       * (A refusal of the follow-up sign-in after a booking that landed
       * is a partial, reported below, not a 409.) */
      console.warn(
        `[guest] refused member=${memberClientId} guest=${guestClientId} ` +
          `service=${clientServiceId} class=${classId}: ${JSON.stringify(error)}`,
      );
      return NextResponse.json(
        { error, step: "guest", refused: true, ...fallbackFields(fallbacks) },
        { status: 409 },
      );
    }
    steps.guest = { error };
  }

  /* A refused or failed guest step ends the flow: signing the member in
   * and noting a guest visit that did not happen would be two writes
   * about nothing. The answer says so; the member's own check-in is one
   * tap on their row. T59c review: `landed` rides along, because a
   * failure AFTER the first write is a visit already on the pass (the
   * booking or the pass change went through, the sign-in did not), and
   * the sheet must say so rather than read as nothing having happened. */
  if (typeof steps.guest === "object") {
    return NextResponse.json(
      {
        ok: false,
        error: steps.guest.error,
        step: "guest",
        landed,
        guestVisitId: visitId,
        suppressed: false,
        steps,
        notes: { guest: null, member: null },
        pass,
        ...verifiedFields(verification),
        ...fallbackFields(fallbacks),
      },
      { status: 502 },
    );
  }

  /* Step 3: the member. */
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

  /* Step 4: the notes, only after a guest visit that really landed
   * (T45's rule: a note records a thing that happened). */
  const notes: { guest: number | null; member: number | null } = {
    guest: null,
    member: null,
  };
  if (steps.guest === "done") {
    const when = [className ?? "class", noteDate(classStartsAt)]
      .filter(Boolean)
      .join(" ");
    const [g, m] = await Promise.all([
      fileFormulaNote({
        session,
        clientId: guestClientId,
        note: `Guest of ${memberName ?? "a member"}, guest pass, ${when}.`,
        route: "/api/guest formula-note",
        logTag: "[guest]",
      }),
      fileFormulaNote({
        session,
        clientId: memberClientId,
        note: `Guest pass used for ${guestName ?? "a guest"}, ${when}.`,
        route: "/api/guest formula-note",
        logTag: "[guest]",
      }),
    ]);
    notes.guest = g.id;
    notes.member = m.id;
    /* One line for the sheet: each note's failure named, and the same
     * message once when both failed the same way. */
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
    steps.guest === "suppressed" ||
    steps.member === "suppressed" ||
    steps.notes === "suppressed";
  console.log(
    `[guest] member=${memberClientId} guest=${guestClientId} class=${classId} ` +
      `service=${clientServiceId} visit=${visitId ?? "none"} ` +
      `guest=${stepTag(steps.guest)} member=${stepTag(steps.member)} notes=${stepTag(steps.notes)}`,
  );
  return NextResponse.json({
    ok: true,
    suppressed,
    steps,
    notes,
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
  /** The pass on the visit as read back; null when the visit carries
   *  none or could not be read. */
  visitServiceId: number | null;
  /** The name of the pass Mindbody used instead, for the sheet: null
   *  when the visit was read and carries none; undefined when it could
   *  not be read at all. */
  ownPass: string | null | undefined;
  /** "1->0", "1->1", "1->gone", "?" for the log line. */
  remaining: string;
  /** Why it is unverified, when it is. */
  detail: string | null;
}

/**
 * T62: the read-back. Two reads, in parallel: the visit's pass (skipped
 * when the booking answer already named it) and the member's pass list
 * (ShowActiveOnly, so a spent one-session pass is simply gone, T57).
 * Each failure is caught here and judged as "not known"; judgeGuestPass
 * decides from what IS known. Reads stay on the service account.
 */
async function verifyPass(opts: {
  classId: number;
  visitId: number;
  sent: number;
  memberClientId: string;
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
    fetchPasses(opts.memberClientId).then(
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

/** The first fallback, in the shape every write route answers with
 *  (actorFields): several steps may each have fallen back, and one
 *  amber line naming the teacher and the reason is what the UI shows. */
function fallbackFields(fallbacks: ActorFallback[]): Record<string, unknown> {
  return actorFields({
    actorFallback: fallbacks[0] ?? null,
    staffSessionEnded: false,
  });
}
