import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import { readBirthDate } from "@/lib/birthdate";
import {
  createClient,
  isDuplicateClientError,
  readTextOptInStuck,
  requiredClientFields,
  type NewClientInput,
} from "@/lib/clients";
import {
  beginFinalisation,
  loadRequest,
  releaseFinalisation,
} from "@/lib/display";
import { readSignupResult } from "@/lib/displaysignup";
import { fileFormulaNote } from "@/lib/formulanote";
import { getWaiver } from "@/lib/waiver";
import { finaliseWaiver } from "@/lib/waiverfinalise";

export const dynamic = "force-dynamic";

/**
 * T59b: a new client signed up at the counter. Pete: "first name, last
 * name, email, phone. Nothing else." The email opt-in rides the same
 * form as T53's two checkboxes.
 *
 * GET: what Mindbody requires of a new client here
 * (`/client/requiredclientfields`), read once when the form opens, and
 * which of those the form has no input for. A read, behind the device
 * session, on the service account like every read.
 *
 * POST: the create. Same guard order as every write: the device session,
 * then the T50 sign-in (no teacher, no write, 401 `reason: "staff"`),
 * then the body. Under the teacher's own token with the one loud
 * fallback (runAsActor), through mindbody() so dry run and the write
 * guard apply; with no client id to name, the guard suppresses every
 * create, and the answer says so. A duplicate (Mindbody's rule: same
 * first, last and email) is answered in plain words with a 409, so the
 * teacher searches for the existing person instead of making a second.
 *
 * T204: the same route finishes a SELF-SERVE sign-up. The body may
 * carry a `displayRequestId`, which is a HANDLE and nothing else: the
 * form is still the body's (the teacher may fix "jon" to "John" before
 * tapping Create, and reading the name back is the whole point of the
 * tap), while the consent as the student answered it and the signature
 * they drew come from the server's own store. On success, and with no
 * second tap, the same route continues into the waiver finalisation for
 * the client id that now exists (src/lib/waiverfinalise.ts, shared with
 * /api/waiver-agree). A duplicate leaves the request UNCONSUMED, so the
 * sign-up stays in the tray while the teacher searches for the person
 * who already exists.
 *
 * T206: the body may also carry a `birthDate` (`YYYY-MM-DD`), which
 * both forms ask for only when the site's own required list names it
 * (src/lib/birthdate.ts). On the display path it is the TEACHER's value
 * that is sent, like the name: the modal is prefilled from the stored
 * sign-up and the teacher may correct it before Create.
 *
 * Body: { firstName, lastName: string (1..60); email?: string;
 *         phone?: string; birthDate?: string; sendAccountEmails,
 *         sendPromotionalEmails: boolean; displayRequestId?: string }
 * Answer: { ok, clientId, client, suppressed, waiver?, textOptInStuck?,
 *           ...actorFields }
 */

const NAME_MAX = 60;
const CONTACT_MAX = 100;
/* Plausible, not RFC-complete: something, an @, something with a dot.
 * Mindbody validates the address itself and says so. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/* Digits with the punctuation people type around them: spaces, dots,
 * dashes, brackets, a leading plus. At least seven digits. */
const PHONE_RE = /^\+?[\d\s().-]+$/;

export async function GET(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  try {
    const fields = await requiredClientFields();
    return NextResponse.json(fields);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function cleanName(v: unknown, label: string): string | NextResponse {
  if (typeof v !== "string" || !v.trim()) return bad(`${label} is required.`);
  const name = v.trim().replace(/\s+/g, " ");
  if (name.length > NAME_MAX) {
    return bad(`${label} is too long (${NAME_MAX} characters at most).`);
  }
  return name;
}

export async function POST(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  /* T50: no staff session, no write. Before the body is read. */
  const staff = await requireActor(request);
  if (staff.denied) return staff.denied;
  const { session } = staff;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return bad("A JSON body is required.");
  }
  const firstName = cleanName(payload?.firstName, "First name");
  if (firstName instanceof NextResponse) return firstName;
  const lastName = cleanName(payload?.lastName, "Last name");
  if (lastName instanceof NextResponse) return lastName;

  let email: string | null = null;
  if (payload?.email !== undefined && payload?.email !== null) {
    if (typeof payload.email !== "string") return bad("email must be a string.");
    const e = payload.email.trim();
    if (e) {
      if (e.length > CONTACT_MAX || !EMAIL_RE.test(e)) {
        return bad("That email address does not look right.");
      }
      email = e;
    }
  }
  let phone: string | null = null;
  if (payload?.phone !== undefined && payload?.phone !== null) {
    if (typeof payload.phone !== "string") return bad("phone must be a string.");
    const ph = payload.phone.trim();
    if (ph) {
      const digits = ph.replace(/\D/g, "");
      if (ph.length > CONTACT_MAX || !PHONE_RE.test(ph) || digits.length < 7) {
        return bad("That phone number does not look right.");
      }
      phone = ph;
    }
  }
  /* T206: the fifth field, when the site asks for one. Validated
   * whenever it is sent and never required here: which sites demand it
   * is Mindbody's own list, and Mindbody's refusal names it in words. */
  const birth = readBirthDate(payload?.birthDate);
  if (!birth.ok) {
    return bad(
      birth.error === "birthDate must be a string"
        ? "birthDate must be a string."
        : `${birth.error[0]?.toUpperCase() ?? ""}${birth.error.slice(1)}.`,
    );
  }
  for (const key of ["sendAccountEmails", "sendPromotionalEmails"] as const) {
    if (typeof payload?.[key] !== "boolean") {
      return bad(`${key} must be a boolean.`);
    }
  }
  const input: NewClientInput = {
    firstName,
    lastName,
    email,
    phone,
    sendAccountEmails: payload.sendAccountEmails,
    sendPromotionalEmails: payload.sendPromotionalEmails,
    ...(birth.value === null ? {} : { birthDate: birth.value }),
  };

  /* T204: the sign-up the customer screen took, when this Create is
   * finishing one. Claimed synchronously for the WHOLE create plus
   * waiver (T202 review's rule: no await between the check and the
   * mark), and released in the finally below whatever happens. */
  let claimed: string | null = null;
  const handle =
    typeof payload?.displayRequestId === "string"
      ? payload.displayRequestId.trim()
      : "";
  let signed:
    | { requestId: string; png: Buffer; sha256: string; agreedAt: string }
    | null = null;
  let waiverSha = "";
  let textWanted = false;

  try {
    if (handle.length > 0) {
      if (!beginFinalisation(handle)) {
        return NextResponse.json(
          { error: "That sign-up is already being created.", inFlight: true },
          { status: 409 },
        );
      }
      claimed = handle;
      const held = await loadRequest(handle);
      if (
        held === null ||
        held.kind !== "register" ||
        held.initiator !== "display" ||
        held.status !== "completed" ||
        held.consumedAt !== null ||
        Date.now() >= held.expiresAt
      ) {
        return NextResponse.json(
          {
            error:
              "That sign-up is no longer waiting. Ask them to sign up again on the customer screen, or create them here.",
          },
          { status: 409 },
        );
      }
      /* Review fix (T204): the stored result is re-read against the
       * moment it was STORED, not now. Its `agreedAt` window is an
       * hour (T202's reader) and a sign-up waits in the tray for four,
       * so anchoring this to Date.now() made every sign-up older than
       * an hour unfinishable while it still showed in the tray and in
       * search. It was already validated as fresh when the student
       * tapped agree; what is checked here is the shape. */
      /* The stored result is read for its SHAPE here, with no
       * required-field list: what the site demands was checked when the
       * student answered, and the birth date that reaches Mindbody is
       * the teacher's own (the body above), which they may have
       * corrected. A site whose list changed in between must not strand
       * a sign-up that is already signed. */
      const stored = readSignupResult(
        held.result ?? {},
        held.completedAt ?? Date.now(),
      );
      if (!stored.ok) {
        return NextResponse.json(
          { error: `That sign-up could not be read (${stored.error}).` },
          { status: 409 },
        );
      }
      /* The wording the student actually read, against the wording the
       * studio serves NOW. An edit in between means nobody agreed to
       * what is on file, so nothing is written -- the same rule
       * /api/waiver-agree applies to a signature from the display. */
      const waiver = await getWaiver();
      if (held.private.textSha256 !== waiver.sha256) {
        return NextResponse.json(
          {
            error:
              "The waiver text changed while they were signing up. Ask them to read and sign it again.",
          },
          { status: 409 },
        );
      }
      waiverSha = waiver.sha256;
      signed = {
        requestId: held.id,
        png: stored.png,
        /* Hashed from the BYTES here, never read off the stored
         * result: the receipt's figure names what was actually filed. */
        sha256: createHash("sha256").update(stored.png).digest("hex"),
        agreedAt: stored.value.agreedAt,
      };
      /* The consent is the STUDENT's answer, as recorded, not whatever
       * the teacher's browser sent back with the form. Each box sets
       * all three flags of its channel; the text ones ride the create
       * because that is the one call that may honour them (D-B3). */
      textWanted = stored.value.consent.text;
      input.sendAccountEmails = stored.value.consent.email;
      input.sendPromotionalEmails = stored.value.consent.email;
      input.sendScheduleEmails = stored.value.consent.email;
      input.sendAccountTexts = textWanted;
      input.sendPromotionalTexts = textWanted;
      input.sendScheduleTexts = textWanted;
    }

    const run = await runAsActor(session, "/api/client-create", (actor) =>
      createClient(input, actor),
    );
    const client = run.result.client;
    if (signed === null || client === null) {
      /* T59b's answer, unchanged. A suppressed create has no client id,
       * so there is nothing to release a waiver against and the
       * sign-up is deliberately left unconsumed. */
      return NextResponse.json({
        ok: true,
        clientId: client?.id ?? null,
        client,
        suppressed: run.result.suppressed,
        ...actorFields(run),
      });
    }

    /* D-B3, as far as it can be answered without the probe having run:
     * did the text flags stick? A read back of the client we just made,
     * on the service account like every read. */
    const textOptInStuck = textWanted
      ? await readTextOptInStuck(client.id)
      : null;

    /* The waiver, for the client who now exists, with no second tap.
     * Every rule is waiverfinalise.ts's and is shared with
     * /api/waiver-agree: the release under the teacher's token, the
     * receipt row with the signature, the best-effort document upload,
     * the Notes line, and the handle spent LAST. */
    const waiver = await finaliseWaiver({
      clientId: client.id,
      session,
      route: "/api/client-create",
      waiverSha256: waiverSha,
      signed,
      currentNotes: client.notes ?? "",
    });

    /* The text opt-in Mindbody did not keep is never silently dropped:
     * it becomes a T62-signed entry in the client's Notes so a human can
     * set it. Only on EVIDENCE (`false`, read back), never on a read
     * that could not answer. Filed after the waiver's own Notes append,
     * since the helper reads the field before writing it whole. */
    let textNoted = false;
    if (textWanted && textOptInStuck === false) {
      const note = await fileFormulaNote({
        session,
        clientId: client.id,
        note:
          "Asked for text messages when signing up on the customer screen. " +
          "Mindbody did not keep the text opt-in, so please set it by hand on their profile.",
        route: "/api/client-create",
        logTag: "[signup]",
      });
      textNoted = note.via !== null;
    }

    return NextResponse.json({
      ok: true,
      clientId: client.id,
      client: waiver.notes === null ? client : { ...client, notes: waiver.notes },
      suppressed: run.result.suppressed,
      textOptInStuck,
      textNoted,
      waiver: {
        signed: true,
        agreed: waiver.agreed,
        suppressed: waiver.suppressed,
        documentFiled: waiver.documentFiled,
        documentReason: waiver.documentReason,
        receiptNoted: waiver.receiptNoted,
        receiptReason: waiver.receiptReason,
        signatureSha256: waiver.signatureSha256,
      },
      ...actorFields(run),
    });
  } catch (err) {
    /* T50 review: the teacher's token died under this write; the gate
     * comes back and nothing was created. */
    const gone = staffSessionEndedResponse(err);
    if (gone) return gone;
    if (isDuplicateClientError(err)) {
      return NextResponse.json(
        {
          error:
            "Mindbody already has a client with this name and email. " +
            "Search for them instead.",
          duplicate: true,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  } finally {
    if (claimed !== null) releaseFinalisation(claimed);
  }
}
