/**
 * T242: which of a client's own passes Mindbody would accept for ONE
 * visit, so the roster's "Pay and check in" dialog can offer them before
 * it offers a purchase.
 *
 * Pete, 2026-11-17: "when the client has a pass and they have not paid
 * for a class ... there should be an option to use one of their exisiting
 * passes when they have one." A pass can be current and still not cover
 * the class (another program, a membership restriction), and those rules
 * live in Mindbody, so they are not rebuilt here. Each candidate is asked
 * of Mindbody instead, the way T221 asks per pass: the same write the
 * teacher's tap will make, `POST /client/updateclientvisit` with
 * `{VisitId, ClientServiceId}`, carrying `Test: true` (client.yml
 * UpdateClientVisitRequest: "input information is validated, but not
 * committed"), one per candidate, in parallel, on the service account.
 *
 * Only a 4xx about the REQUEST hides a pass. A suppressed check (dry run,
 * the write guard: `Test` rides a POST, so mindbody() suppresses it like
 * any write, as it does T221's Test pricing), a 5xx, a dead transport and
 * a refusal of the CALLER (a permission the service account lacks says
 * nothing about the pass) all leave it SHOWN: a check that cannot answer
 * must never send a student holding a pass to the till. The real write's
 * refusal, in Mindbody's own words, is the backstop.
 *
 * `Test` on this endpoint has never been watched live. If Mindbody
 * IGNORED it, every check would be a real assignment, so the FIRST time a
 * check answers 200 in a process, the visit is read before and after
 * (`visitPayment`, the class's own visit list): an unpaid visit that came
 * back carrying a pass means Test was not honoured. That is logged
 * loudly, reported to the screen, and every later open in this process
 * skips the checks and shows every current pass with classes left (the
 * ticket's own fallback). Once a verification finds the visit untouched,
 * the process trusts Test and stops reading.
 *
 * Reads plus Test calls only: nothing in this file commits anything.
 */
import { isGuestPass } from "./guestpass";
import { fetchPasses, type PassInfo } from "./clientcontext";
import { isActorRefusal, mindbody, mindbodyHttpStatus } from "./mindbody";
import { visitPayment } from "./roster";
import { plainRefusal } from "./sale";

export interface VisitPass {
  /** `ClientService.Id`, what `/api/visit-payment` takes. */
  id: number;
  name: string;
  remaining: number | null;
  count: number | null;
  expires: string | null;
}

export interface VisitPasses {
  /** The passes to offer, in the order Mindbody listed them. */
  passes: VisitPass[];
  /** Candidates Mindbody refused for this visit, with its sentence (for
   *  the log and the drawer; the screen shows only what is offered). */
  hidden: { id: number; name: string; reason: string }[];
  /** Candidates whose check settled nothing (suppressed, 5xx,
   *  transport, a refusal of the caller): shown. */
  unknown: number;
  /** How the checks went: `checked` (Mindbody answered), `suppressed`
   *  (every check was held back by dry run or the write guard),
   *  `ignored` (this process found Test not honoured, so nothing was
   *  asked), or `none` (no candidates). */
  tested: "checked" | "suppressed" | "ignored" | "none";
  /** True only on the open that found Test was ignored: the visit was
   *  unpaid before the checks and carries a pass after them. */
  testIgnoredNow?: boolean;
}

/** A current pass worth asking about: it can be written with (an id),
 *  it is not a guest pass (T69: a guest pass checks in a guest, never the
 *  member), and it has a class left (or Mindbody keeps no count). */
export function candidatePasses(passes: readonly PassInfo[]): VisitPass[] {
  return passes
    .filter(
      (p): p is PassInfo & { id: number } =>
        p.id !== null &&
        !isGuestPass(p.name) &&
        (p.remaining === null || p.remaining > 0),
    )
    .map((p) => ({
      id: p.id,
      name: p.name,
      remaining: p.remaining,
      count: p.count,
      expires: p.expires,
    }));
}

const G = globalThis as typeof globalThis & {
  __posVisitPassTest?: "unverified" | "honoured" | "ignored";
};
function testState(): "unverified" | "honoured" | "ignored" {
  return (G.__posVisitPassTest ??= "unverified");
}

type Outcome =
  | { kind: "ok" }
  | { kind: "suppressed" }
  | { kind: "unknown" }
  | { kind: "refused"; reason: string };

async function testOne(
  clientId: string,
  visitId: number,
  clientServiceId: number,
): Promise<Outcome> {
  try {
    const res = await mindbody<{ DryRun?: boolean; WriteSuppressed?: boolean }>(
      "/client/updateclientvisit",
      {
        method: "POST",
        body: { VisitId: visitId, ClientServiceId: clientServiceId, Test: true },
        /* The payload names no client, so the write guard reads this. */
        clientId,
      },
    );
    if (res?.DryRun || res?.WriteSuppressed) return { kind: "suppressed" };
    return { kind: "ok" };
  } catch (err) {
    const status = mindbodyHttpStatus(err);
    if (status !== null && status < 500 && !isActorRefusal(err)) {
      return {
        kind: "refused",
        reason: plainRefusal(err instanceof Error ? err.message : String(err)),
      };
    }
    return { kind: "unknown" };
  }
}

/** Read the visit back after a Test check answered 200 on a visit that
 *  was unpaid: true when it now carries a pass (Test was ignored). */
async function verifyUntouched(
  clientId: string,
  visitId: number,
  classId: number,
): Promise<boolean> {
  try {
    const after = await visitPayment(classId, visitId);
    if (after === null) return false;
    if (after.clientServiceId !== null) {
      G.__posVisitPassTest = "ignored";
      console.error(
        `[visit-passes] TEST IGNORED: visit ${visitId} for client ${clientId} ` +
          `was unpaid before a Test check and now carries pass ` +
          `${after.clientServiceId} (${after.pricingOption ?? "unnamed"}). ` +
          `updateclientvisit did not honour Test: true. Later opens show ` +
          `every current pass unchecked.`,
      );
      return true;
    }
    G.__posVisitPassTest = "honoured";
    console.log(
      `[visit-passes] Test verified: visit ${visitId} still unpaid after a ` +
        `Test check; updateclientvisit honours Test`,
    );
    return false;
  } catch {
    /* Unverified stays unverified; the next open tries again. */
    return false;
  }
}

export async function usablePassesForVisit(input: {
  clientId: string;
  visitId: number;
  /** The class the visit is in, for the one-time Test verification. */
  classId: number | null;
}): Promise<VisitPasses> {
  const { clientId, visitId, classId } = input;
  const candidates = candidatePasses(await fetchPasses(clientId));
  if (candidates.length === 0) {
    return { passes: [], hidden: [], unknown: 0, tested: "none" };
  }
  if (testState() === "ignored") {
    console.warn(
      `[visit-passes] client ${clientId} visit ${visitId}: Test was found ` +
        `ignored by updateclientvisit earlier in this process, so ` +
        `${candidates.length} current pass(es) are shown unchecked`,
    );
    return { passes: candidates, hidden: [], unknown: 0, tested: "ignored" };
  }
  /* The one-time verification: read the visit first, while it is still
   * unpaid, so "after" has something to be compared with. */
  let before: number | null | undefined;
  const verify = testState() === "unverified" && classId !== null;
  if (verify) {
    try {
      const v = await visitPayment(classId, visitId);
      before = v === null ? undefined : v.clientServiceId;
    } catch {
      before = undefined;
    }
  }
  /* Until this process has seen Test honoured, ONE candidate is asked
   * alone and the visit read back before the rest are asked: if Test is
   * ignored, that costs one real assignment rather than one per pass. */
  let outcomes: Outcome[];
  let testIgnoredNow = false;
  if (verify && before === null) {
    const first = candidates[0] as VisitPass;
    const firstOutcome = await testOne(clientId, visitId, first.id);
    if (firstOutcome.kind === "ok") {
      testIgnoredNow = await verifyUntouched(clientId, visitId, classId as number);
    }
    const rest = testIgnoredNow
      ? candidates.slice(1).map((): Outcome => ({ kind: "unknown" }))
      : await Promise.all(
          candidates.slice(1).map((p) => testOne(clientId, visitId, p.id)),
        );
    outcomes = [firstOutcome, ...rest];
  } else {
    outcomes = await Promise.all(
      candidates.map((p) => testOne(clientId, visitId, p.id)),
    );
  }
  const passes: VisitPass[] = [];
  const hidden: VisitPasses["hidden"] = [];
  let unknown = 0;
  let suppressed = 0;
  candidates.forEach((p, i) => {
    const o = outcomes[i];
    if (o?.kind === "refused") {
      hidden.push({ id: p.id, name: p.name, reason: o.reason });
      return;
    }
    if (o?.kind === "suppressed") suppressed += 1;
    if (o?.kind === "unknown" || o?.kind === "suppressed") unknown += 1;
    passes.push(p);
  });
  const tested: VisitPasses["tested"] = testIgnoredNow
    ? "ignored"
    : suppressed === candidates.length
      ? "suppressed"
      : "checked";
  console.log(
    `[visit-passes] client ${clientId} visit ${visitId}: ` +
      `${candidates.length} candidate(s), shown [${passes.map((p) => p.id).join(", ")}], ` +
      `hidden [${hidden.map((h) => `${h.id}: ${h.reason}`).join("; ")}]` +
      (unknown > 0 ? `, unsettled ${unknown}` : "") +
      ` (${tested})`,
  );
  return {
    passes,
    hidden,
    unknown,
    tested,
    ...(testIgnoredNow ? { testIgnoredNow: true } : {}),
  };
}
