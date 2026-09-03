import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import {
  CONSENT_EMAIL_FLAGS,
  updateClientConsent,
  type ConsentFlags,
} from "@/lib/clients";

export const dynamic = "force-dynamic";

/**
 * T53: the counter's email opt-in. Pete: "we should also use the
 * opportunity to get clients to opt-in to emails. a teacher can ask them
 * if they want to opt in to emails and receive an email receipt."
 *
 * Body: { clientId: string, sendAccountEmails?: boolean,
 *         sendPromotionalEmails?: boolean, sendScheduleEmails?: boolean }
 * At least one flag, each a boolean. ONE `POST /client/updateclient`
 * carrying the id and exactly the flags given (the gate sends what its
 * two checkboxes say, ticked or not, so an unticked box is an explicit
 * false rather than "unchanged"), see src/lib/clients.ts
 * updateClientConsent for the envelope and why the text flags are not
 * accepted here at all.
 *
 * The write is the sale's, so it runs like one: behind the device
 * session and the T50 sign-in, under the teacher's own token with the
 * one loud fallback, through mindbody() with the client id in the
 * options so dry run and the write guard apply. It fires BEFORE pay
 * mode, never between the Charge tap and the charge, and its answer
 * never gates the sale: a refusal here is shown and stepped past.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read. */
  const staff = requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  try {
    const payload = await request.json();
    const clientId: unknown = payload?.clientId;
    if (typeof clientId !== "string" || !clientId.trim()) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    const flags: ConsentFlags = {};
    const fromBody: Record<(typeof CONSENT_EMAIL_FLAGS)[number], unknown> = {
      SendAccountEmails: payload?.sendAccountEmails,
      SendPromotionalEmails: payload?.sendPromotionalEmails,
      SendScheduleEmails: payload?.sendScheduleEmails,
    };
    for (const key of CONSENT_EMAIL_FLAGS) {
      const v = fromBody[key];
      if (v === undefined) continue;
      if (typeof v !== "boolean") {
        return NextResponse.json(
          { error: `${key[0]!.toLowerCase()}${key.slice(1)} must be a boolean` },
          { status: 400 },
        );
      }
      flags[key] = v;
    }
    if (Object.keys(flags).length === 0) {
      return NextResponse.json(
        {
          error:
            "at least one of sendAccountEmails, sendPromotionalEmails, " +
            "sendScheduleEmails is required",
        },
        { status: 400 },
      );
    }
    const run = await runAsActor(session, "/api/client-consent", (actor) =>
      updateClientConsent(clientId.trim(), flags, actor),
    );
    return NextResponse.json({ ok: true, ...run.result, ...actorFields(run) });
  } catch (err) {
    /* T50 review: the teacher's token died under this write; the gate
     * comes back and the opt-in is simply not saved. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
