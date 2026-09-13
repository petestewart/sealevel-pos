import { NextResponse } from "next/server";

import {
  actorFields,
  requireActor,
  runAsActor,
  staffSessionEndedResponse,
} from "@/lib/actor";
import { requireSession } from "@/lib/auth";
import {
  createClient,
  isDuplicateClientError,
  requiredClientFields,
  type NewClientInput,
} from "@/lib/clients";

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
 * Body: { firstName, lastName: string (1..60); email?: string;
 *         phone?: string; sendAccountEmails, sendPromotionalEmails:
 *         boolean }
 * Answer: { ok, clientId, client, suppressed, ...actorFields }
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
  const staff = requireActor(request);
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
  };

  try {
    const run = await runAsActor(session, "/api/client-create", (actor) =>
      createClient(input, actor),
    );
    return NextResponse.json({
      ok: true,
      clientId: run.result.client?.id ?? null,
      client: run.result.client,
      suppressed: run.result.suppressed,
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
  }
}
