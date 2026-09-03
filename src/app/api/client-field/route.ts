import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";

import {
  EDITABLE_CLIENT_FIELDS,
  updateClientField,
  type EditableClientField,
} from "@/lib/clients";
import { signEntries, studioDate } from "@/lib/notesig";

export const dynamic = "force-dynamic";

/**
 * Save ONE free-text field on a client record: `POST /client/updateclient`
 * with the surgical `{Client: {Id, <field>}, CrossRegionalUpdate: false}`
 * payload (spec-verified in src/lib/clients.ts -- Id and the one field and
 * nothing else, because updateclient overwrites whatever fields the
 * payload carries).
 *
 * The field whitelist -- exactly Notes | RedAlert | YellowAlert -- is
 * enforced HERE, server-side: a browser cannot name any other field, so
 * this route can never be steered into a Liability write or a rename.
 *
 * The write goes through the mindbody() client, so dry run and the
 * POS_WRITE_CLIENT_IDS guard both apply; a suppressed save is reported as
 * such rather than pretending the edit stuck.
 *
 * T58: the entries are signed HERE, with the staff session's name and
 * the studio's date, never with a name the browser sent. `value` is
 * the draft as the editor showed it (signature tags stripped) and
 * `previous` the raw text the edit started from; an entry the teacher
 * left alone keeps whatever signature it had, everything else is
 * signed by them (src/lib/notesig.ts). The response carries the raw
 * text that was written as `value`, so the browser's local state can
 * hold exactly what Mindbody now holds.
 */
export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read, so a
   * signed-out iPad hears only the 401 and never a validation detail
   * or a Mindbody read made on its behalf. */
  const staff = requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;
  /* A Mindbody write like the rest: behind the device session (T44
   * review put a teacher gate here too; T48 removed that layer). */
  try {
    const { clientId, field, value, previous } = await request.json();
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json(
        { error: "clientId (string) is required" },
        { status: 400 },
      );
    }
    if (
      typeof field !== "string" ||
      !(EDITABLE_CLIENT_FIELDS as readonly string[]).includes(field)
    ) {
      return NextResponse.json(
        {
          error: `field must be one of: ${EDITABLE_CLIENT_FIELDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (typeof value !== "string") {
      return NextResponse.json(
        { error: "value (string, may be empty) is required" },
        { status: 400 },
      );
    }
    if (previous !== undefined && typeof previous !== "string") {
      return NextResponse.json(
        { error: "previous (string) is optional but must be a string" },
        { status: 400 },
      );
    }
    /* T58: the session's name, not a name from the body. A missing
     * `previous` signs every entry, which is what a fresh field wants. */
    const signed = signEntries(
      value,
      typeof previous === "string" ? previous : null,
      session.name,
      studioDate(),
    );
    /* T49: as the signed-in teacher when there is one, with the one
     * loud fallback. The signature stays the teacher's either way: it
     * says who wrote the note, and the fallback only changes whose
     * token carried it. */
    const run = await runAsActor(session, "/api/client-field", (actor) =>
      updateClientField(clientId, field as EditableClientField, signed, actor),
    );
    return NextResponse.json({
      ok: true,
      value: signed,
      ...run.result,
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
