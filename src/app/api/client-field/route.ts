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
import {
  BEFORE_READ_MS,
  COURTESY_READ_MS,
  isBlankText,
  readClientBefore,
} from "@/lib/clientaudit";
import { signEntries, studioDate } from "@/lib/notesig";

export const dynamic = "force-dynamic";

/** The field in the words the refusal uses. */
const FIELD_WORDS: Record<EditableClientField, string> = {
  Notes: "notes",
  RedAlert: "red alert",
  YellowAlert: "yellow alert",
};

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
 *
 * T116: the field is read fresh from Mindbody before the write, for the
 * record (src/lib/clientaudit.ts) and for one refusal: a save that would
 * turn text into nothing answers 409 `reason: "blank"` unless the body
 * carries `confirmBlank: true`, which the editor sends only after asking.
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
  /* A Mindbody write like the rest: behind the device session (T44
   * review put a teacher gate here too; T48 removed that layer). */
  try {
    const { clientId, field, value, previous, confirmBlank, uniqueId } =
      await request.json();
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
    const editable = field as EditableClientField;
    const wantedUnique =
      typeof uniqueId === "number" && Number.isInteger(uniqueId) && uniqueId > 0
        ? uniqueId
        : null;
    /* T116: what Mindbody holds NOW, read fresh on the server and never
     * taken from the browser. It is the record's "before", and it is
     * what the blank check below is decided on. */
    /* T116 review: the longer wait only for a clear, where the read is
     * the gate; any other save waits the courtesy bound and goes out. */
    const before = await readClientBefore(
      clientId,
      wantedUnique,
      [editable],
      isBlankText(signed) ? BEFORE_READ_MS : COURTESY_READ_MS,
    );
    const held = before.ok ? before.values[editable] : null;
    /* T116 (Pete: "yes"): a save that turns non-empty text into nothing
     * is refused unless the teacher was asked and said so. A read that
     * could not say what is on file counts as text being there: a blank
     * written over text nobody could see is exactly the accident this
     * exists to stop. The browser asks in words and resends with
     * `confirmBlank: true`. */
    if (
      isBlankText(signed) &&
      (!before.ok || !isBlankText(held)) &&
      confirmBlank !== true
    ) {
      console.warn(
        `[client-write] blank refused client=${clientId} field=${editable} ` +
          `staff=${session.staffId}: ${
            before.ok ? "text on file" : `before unknown (${before.reason})`
          }; asking the teacher`,
      );
      return NextResponse.json(
        {
          error: before.ok
            ? `This would clear the ${FIELD_WORDS[editable]} on file.`
            : `Mindbody could not say what the ${FIELD_WORDS[editable]} ` +
              `holds now (${before.reason}), so clearing it needs a yes.`,
          reason: "blank",
          field: editable,
          onFile: before.ok && typeof held === "string" ? held : null,
        },
        { status: 409 },
      );
    }
    /* T116: the screen started from different text than Mindbody holds
     * (a row whose notes had not loaded, or another save since). Not
     * refused, since the brief is the blank case, but written into the
     * record, where it is the first thing anyone investigating a lost
     * note will want to know. */
    const stale =
      before.ok &&
      typeof previous === "string" &&
      (typeof held === "string" ? held : "").trim() !== previous.trim();
    /* T49: as the signed-in teacher when there is one, with the one
     * loud fallback. The signature stays the teacher's either way: it
     * says who wrote the note, and the fallback only changes whose
     * token carried it. */
    const run = await runAsActor(session, "/api/client-field", (actor) =>
      updateClientField(clientId, editable, signed, actor, {
        kind: "field",
        before,
        uniqueId: wantedUnique,
        note: [
          stale ? "the screen started from different text than Mindbody held" : "",
          isBlankText(signed) && confirmBlank === true
            ? "cleared after the teacher confirmed"
            : "",
        ]
          .filter(Boolean)
          .join("; ") || null,
      }),
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
