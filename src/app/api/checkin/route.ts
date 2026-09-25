import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import { setSignedIn } from "@/lib/roster";
import {
  claimWaiverOverride,
  fileWaiverOverrideNote,
  releaseWaiverOverride,
  waiverOverrideFields,
} from "@/lib/waiverguard";

export const dynamic = "force-dynamic";

/**
 * The only write this app performs in Phase 1. It moves no money, it is
 * idempotent (setting SignedIn to a value it already holds is harmless),
 * and it reverses, which is what makes the undo in the UI real rather
 * than a race against a delayed send.
 *
 * T49: runs as the signed-in teacher when there is one, so Mindbody's
 * sign-in record names them; a refusal of the teacher's token falls
 * back once to the service account and says so (`actorFallback`).
 *
 * T211: an optional `waiverOverride: {token, reason}` may ride along,
 * which is a teacher's own PIN (purpose `waiver`) and their words for
 * why a student with no released waiver is being checked in anyway. It
 * is verified and spent BEFORE any Mindbody call and filed on the
 * client AFTER the check-in landed. Without the field nothing changes,
 * and the field never marks the waiver signed: the next tap on that
 * student meets the same dialog.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad hears only the 401 and never a validation detail
   * or a Mindbody read made on its behalf. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  try {
    const { visitId, signedIn, clientId, waiverOverride } =
      await request.json();
    if (typeof visitId !== "number") {
      return NextResponse.json(
        { error: "visitId (number) is required" },
        { status: 400 },
      );
    }
    const signingIn = signedIn !== false;
    /* T211: an override authorizes going PAST the waiver gate, and the
     * gate is on the way in. A check-OUT meets no waiver dialog at all,
     * so an override on one is a body that does not mean anything;
     * refused in words rather than quietly spent. */
    if (waiverOverride !== undefined && waiverOverride !== null && !signingIn) {
      return NextResponse.json(
        { error: "a waiver override has no meaning on a check-out" },
        { status: 400 },
      );
    }
    /* T211: the whole override check -- shape, purpose, this teacher's
     * own id, spent once -- before anything reaches Mindbody. */
    const claim = claimWaiverOverride(waiverOverride, session, "checkin");
    if (!claim.ok) return claim.denied;
    const override = claim.override;
    /* The override is about a CLIENT, and the note below is filed on
     * one, so a body that overrides without naming who is refused
     * rather than writing a record nowhere. */
    if (override !== null && (typeof clientId !== "string" || !clientId)) {
      releaseWaiverOverride(override);
      return NextResponse.json(
        { error: "clientId (string) is required with a waiver override" },
        { status: 400 },
      );
    }
    const run = await runAsActor(session, "/api/checkin", (actor) =>
      setSignedIn(
        visitId,
        signingIn,
        typeof clientId === "string" ? clientId : undefined,
        actor,
      ),
    );
    const { suppressed } = run.result;
    /* `suppressed` says the write never reached Mindbody (dry run or the
     * write guard). Still ok:true -- the guards working is not an error
     * -- but the caller must not chain anything that assumes a session
     * was really consumed (T26's renewal offer). */
    if (suppressed && override !== null) {
      /* Nothing was written, so nothing was authorized: the PIN goes
       * back and no record is filed about a check-in that did not
       * happen. Mirrors T202's suppressed release. */
      releaseWaiverOverride(override);
      return NextResponse.json({ ok: true, suppressed, ...actorFields(run) });
    }
    const filed =
      override === null
        ? null
        : await fileWaiverOverrideNote({
            session,
            clientId: clientId as string,
            override,
            /* T211 review: this is the one tap made with a queue at the
             * door and a row that spins until the answer. Three seconds
             * for the record, then answer; the line may still land. */
            waitMs: 3_000,
          });
    return NextResponse.json({
      ok: true,
      suppressed,
      ...waiverOverrideFields(override, filed),
      ...actorFields(run),
    });
  } catch (err) {
    /* T50 review: the teacher's token died under this write (the
     * session is already ended, nothing ran): 401 reason "staff", so
     * the gate comes back. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
