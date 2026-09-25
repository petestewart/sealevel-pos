import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import { parseCardInput, saveClientCard } from "@/lib/clientcard";

export const dynamic = "force-dynamic";

/**
 * T84: add or replace the card on file (Pete: "we need to add the ability
 * to add a card on file").
 *
 * `POST /client/updateclient` with `Client.ClientCreditCard` and nothing
 * else; there is no add-card endpoint (docs/mindbody-openapi/client.yml,
 * ClientCreditCard at 7365). The write goes through mindbody() with the
 * client id in the options, so dry run and the POS_WRITE_CLIENT_IDS guard
 * both apply and are reported as suppressed rather than as a card that is
 * now on file.
 *
 * A teacher's write, the T49/T50 rule: behind the device session and a
 * signed-in teacher, under their token, with the one loud fallback to the
 * studio account (`actorFallback`, rendered in amber).
 *
 * The card number: validated here (digits, length, Luhn) because a
 * browser's checks are a courtesy and not a rule, sent once, and then
 * gone. It is not returned, not logged, and not recorded in the dev call
 * log (src/lib/calllog.ts redacts it in both directions). The answer is
 * the card as MINDBODY holds it after the save -- last four, type, expiry
 * -- read back rather than echoed, so the profile shows what is on file.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad never gets as far as sending a card number. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  try {
    const body = await request.json();
    const clientId =
      typeof body?.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    const parsed = parseCardInput(body);
    if (parsed.input === null) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    /* T114: which record the read-back shows when two share the id. The
     * WRITE still goes by client id, and Mindbody resolves it. */
    const uniqueId =
      typeof body?.uniqueId === "number" &&
      Number.isInteger(body.uniqueId) &&
      body.uniqueId > 0
        ? (body.uniqueId as number)
        : null;
    const run = await runAsActor(session, "/api/client-card", (actor) =>
      saveClientCard(clientId, parsed.input, actor, new Date(), uniqueId),
    );
    return NextResponse.json({
      ok: true,
      suppressed: run.result.suppressed,
      card: run.result.card,
      ...actorFields(run),
    });
  } catch (err) {
    /* The teacher's token died under this write: the session is already
     * ended and nothing was written. 401 reason "staff" brings the gate
     * back. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
