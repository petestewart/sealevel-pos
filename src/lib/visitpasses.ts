/**
 * T242: which of a client's own passes the roster's "Pay and check in"
 * dialog offers for ONE unpaid visit, before it offers a purchase.
 *
 * Pete, 2026-11-17: "when the client has a pass and they have not paid
 * for a class ... there should be an option to use one of their exisiting
 * passes when they have one."
 *
 * READS ONLY. Nothing here sends a write-shaped call of any kind. The
 * first build asked Mindbody about each pass with a `Test: true`
 * `updateclientvisit`, and the T242 review showed why that was unsafe:
 * nobody has seen Mindbody honour `Test` on that endpoint, and if it does
 * not, every check is a real reassignment of a real student's visit, on
 * the service account, with no teacher named and nobody told. So the
 * list is built from what is already readable:
 *
 * - the client's current passes (`fetchPasses`, `/client/clientservices`
 *   with ShowActiveOnly), less guest passes (T69: a guest pass checks in
 *   a guest, never the member) and passes with no class left;
 * - the class's own visit list (`/class/classvisits`), which says whose
 *   visit this is (a visit that is not this client's is refused, since
 *   this read decides what a teacher is offered to write) and, from the
 *   class's `ClassDescription.Program` (class.yml Class/ClassDescription),
 *   which program the class belongs to;
 * - and each pass's own `Program` (client.yml ClientService). A pass
 *   whose program is KNOWN and differs from the class's KNOWN program is
 *   left out; where either is unknown the pass is kept.
 *
 * Anything else that stops a pass paying for the class (a membership
 * restriction, a rule this does not see) is Mindbody's to say: the real
 * assignment, under the teacher's token, is refused in Mindbody's own
 * words and nobody is checked in. That refusal is the backstop.
 */
import { isGuestPass } from "./guestpass";
import { fetchPasses, type PassInfo } from "./clientcontext";
import { mindbody } from "./mindbody";

export interface VisitPass {
  /** `ClientService.Id`, what `/api/visit-payment` takes. */
  id: number;
  name: string;
  remaining: number | null;
  count: number | null;
  expires: string | null;
}

export type VisitPasses =
  | {
      ok: true;
      /** The passes to offer, in the order Mindbody listed them. */
      passes: VisitPass[];
      /** Current passes left out because their program is not the
       *  class's (for the log; the screen shows only what is offered). */
      otherProgram: { id: number; name: string }[];
      /** The pass this visit ALREADY carries, by name, when it carries
       *  one: the roster the dialog opened from was stale (another iPad,
       *  a reopen a second after a write). Null when the visit is unpaid.
       *  The dialog then writes nothing until the roster is refreshed. */
      alreadyPaidWith: string | null;
    }
  | { ok: false; status: number; error: string };

/** A current pass worth offering at all: an id to write with, not a
 *  guest pass, and a class left (or no count kept). */
export function candidatePasses(passes: readonly PassInfo[]): (VisitPass & {
  programId: number | null;
})[] {
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
      programId: p.programId,
    }));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The class's visit list: who this visit belongs to, what it carries,
 *  and the class's program. One metered read, the roster's own call. */
async function readVisit(
  classId: number,
  visitId: number,
): Promise<{
  found: boolean;
  clientId: string | null;
  paidWith: string | null;
  classProgramId: number | null;
}> {
  const body = await mindbody(`/class/classvisits?ClassId=${classId}`);
  const visits: any[] = body?.Class?.Visits ?? body?.Visits ?? [];
  const visit = visits.find((v) => num(v?.Id) === visitId);
  const classProgramId = num(body?.Class?.ClassDescription?.Program?.Id);
  if (!visit) {
    return { found: false, clientId: null, paidWith: null, classProgramId };
  }
  const owner = visit.ClientId ?? visit.Client?.Id;
  const paidWith = visit.Service?.Name ?? visit.ServiceName ?? null;
  return {
    found: true,
    clientId: owner === undefined || owner === null ? null : String(owner),
    paidWith: typeof paidWith === "string" && paidWith ? paidWith : null,
    classProgramId,
  };
}

export async function usablePassesForVisit(input: {
  clientId: string;
  visitId: number;
  classId: number;
}): Promise<VisitPasses> {
  const { clientId, visitId, classId } = input;
  /* Both reads at once: one round trip. The visit is read whatever the
   * passes say (T242 second review), because whose booking this is and
   * whether it is already paid decide what the dialog may write at all,
   * the purchase view included. */
  const [rawPasses, visit] = await Promise.all([
    fetchPasses(clientId),
    readVisit(classId, visitId),
  ]);
  const candidates = candidatePasses(rawPasses);
  if (!visit.found) {
    return {
      ok: false,
      status: 404,
      error: "That booking is not on this class any more. Refresh the roster.",
    };
  }
  /* Second review: a visit Mindbody names no client for is not taken as
   * this client's. */
  if (visit.clientId === null) {
    return {
      ok: false,
      status: 409,
      error: "Mindbody did not say whose booking this is. Refresh the roster.",
    };
  }
  if (visit.clientId !== clientId) {
    console.warn(
      `[visit-passes] refused: visit ${visitId} on class ${classId} belongs ` +
        `to client ${visit.clientId}, not ${clientId}`,
    );
    return {
      ok: false,
      status: 409,
      error: "That booking belongs to someone else. Refresh the roster.",
    };
  }
  const passes: VisitPass[] = [];
  const otherProgram: { id: number; name: string }[] = [];
  for (const { programId, ...p } of candidates) {
    if (
      visit.classProgramId !== null &&
      programId !== null &&
      programId !== visit.classProgramId
    ) {
      otherProgram.push({ id: p.id, name: p.name });
      continue;
    }
    passes.push(p);
  }
  console.log(
    `[visit-passes] client ${clientId} visit ${visitId}: ` +
      `${candidates.length} current, offered [${passes.map((p) => p.id).join(", ")}]` +
      (otherProgram.length > 0
        ? `, another program [${otherProgram.map((p) => p.id).join(", ")}]`
        : "") +
      (visit.classProgramId === null ? " (class program unknown)" : "") +
      (visit.paidWith !== null ? `, visit already paid with ${visit.paidWith}` : ""),
  );
  return { ok: true, passes, otherProgram, alreadyPaidWith: visit.paidWith };
}
