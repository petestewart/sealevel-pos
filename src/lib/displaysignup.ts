/**
 * The self-serve sign-up scene's payload and its result (T204, Phase
 * 2.5 item 5; design docs/design/customer-display.md "Self-serve" and
 * "Scene 3").
 *
 * Two shapes and the rules that go with them, beside T201's ticket and
 * T202's waiver for the same reason:
 *
 * 1. **The payload is built by the SERVER.** Which fields Mindbody
 *    requires of a new client here, and the studio's waiver as
 *    `getWaiver()` served it. The display is told neither a client id
 *    (there is no client yet) nor the waiver's sha256, which lives on
 *    the request's server-only half like T202's.
 * 2. **The result is a form, two consent answers and a signature**, and
 *    all three are checked at /api/display/complete while the student is
 *    still standing there, rather than found to be useless later by the
 *    create that was meant to use them. The signature goes through
 *    T202's own reader, so one PNG rule covers both scenes.
 *
 * Nothing in this file calls Mindbody, and nothing in it may: it is
 * imported by the DISPLAY's components as well as by the routes.
 */

import { readWaiverResult } from "./displaywaiver";

/** What the display renders. */
export interface SignupPayload {
  /** Mindbody's own names for the fields a new client must fill in here
   *  (`/client/requiredclientfields`), so the form can insist on them
   *  before the student hands the iPad back rather than after. */
  requiredFields: string[];
  /** The studio's waiver, as plain text, for step 2. */
  waiverText: string;
}

/** What the student hands back. */
export interface SignupResult {
  form: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
  };
  /** The two boxes, both ticked by default on the screen (D4). `email`
   *  sets T53's three Send*Emails flags and `text` the three
   *  Send*Texts flags, on the CREATE, which is the one call that may
   *  honour the text ones (D-B3). */
  consent: { email: boolean; text: boolean };
  signaturePng: string;
  agreedAt: string;
}

const NAME_MAX = 60;
const CONTACT_MAX = 100;
/* The same two shapes /api/client-create already insists on, so a form
 * this passes is a form that route will take. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]+$/;

export function readSignupPayload(
  value: unknown,
): { ok: true; value: SignupPayload } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  const text = typeof raw.waiverText === "string" ? raw.waiverText.trim() : "";
  if (text.length === 0) return { ok: false, error: "waiverText is required" };
  const required = Array.isArray(raw.requiredFields)
    ? raw.requiredFields
        .filter((f): f is string => typeof f === "string" && f.trim() !== "")
        .map((f) => f.trim().slice(0, 40))
        .slice(0, 40)
    : [];
  return { ok: true, value: { requiredFields: required, waiverText: text } };
}

/**
 * The student's answer, field by field. Anything else they sent is
 * dropped rather than stored, and a name, an address or a moment that
 * does not hold up is a plain sentence on their screen.
 */
export function readSignupResult(
  value: unknown,
  now = Date.now(),
):
  | { ok: true; value: SignupResult; png: Buffer }
  | { ok: false; status: number; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "expected a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  const form =
    raw.form !== null && typeof raw.form === "object" && !Array.isArray(raw.form)
      ? (raw.form as Record<string, unknown>)
      : null;
  if (form === null) return { ok: false, status: 400, error: "form is required" };

  const name = (key: "firstName" | "lastName", label: string) => {
    const v = typeof form[key] === "string" ? (form[key] as string).trim().replace(/\s+/g, " ") : "";
    if (v.length === 0) return { error: `${label} is required` };
    if (v.length > NAME_MAX) return { error: `${label} is too long` };
    return { value: v };
  };
  const first = name("firstName", "First name");
  if (first.error !== undefined) {
    return { ok: false, status: 400, error: first.error };
  }
  const last = name("lastName", "Last name");
  if (last.error !== undefined) {
    return { ok: false, status: 400, error: last.error };
  }

  let email: string | null = null;
  const rawEmail = typeof form.email === "string" ? form.email.trim() : "";
  if (rawEmail.length > 0) {
    if (rawEmail.length > CONTACT_MAX || !EMAIL_RE.test(rawEmail)) {
      return { ok: false, status: 400, error: "that email does not look right" };
    }
    email = rawEmail;
  }
  let phone: string | null = null;
  const rawPhone = typeof form.phone === "string" ? form.phone.trim() : "";
  if (rawPhone.length > 0) {
    const digits = rawPhone.replace(/\D/g, "");
    if (
      rawPhone.length > CONTACT_MAX ||
      !PHONE_RE.test(rawPhone) ||
      digits.length < 10
    ) {
      return { ok: false, status: 400, error: "that phone number does not look right" };
    }
    phone = rawPhone;
  }

  const consent =
    raw.consent !== null &&
    typeof raw.consent === "object" &&
    !Array.isArray(raw.consent)
      ? (raw.consent as Record<string, unknown>)
      : null;
  if (
    consent === null ||
    typeof consent.email !== "boolean" ||
    typeof consent.text !== "boolean"
  ) {
    return {
      ok: false,
      status: 400,
      error: "consent.email and consent.text must be true or false",
    };
  }

  /* One PNG rule for both scenes: T202's reader, magic bytes, cap and
   * the hour-old window included. */
  const signed = readWaiverResult(raw, now);
  if (!signed.ok) return signed;

  return {
    ok: true,
    value: {
      form: { firstName: first.value, lastName: last.value, email, phone },
      consent: { email: consent.email, text: consent.text },
      signaturePng: signed.value.signaturePng,
      agreedAt: signed.value.agreedAt,
    },
    png: signed.png,
  };
}

/** The form and the consent as the teacher's prefilled modal reads them
 *  back (never the PNG). Null when the stored result is not one this
 *  build wrote. */
export function signupFormOf(
  result: Record<string, unknown> | null,
): { form: SignupResult["form"]; consent: SignupResult["consent"] } | null {
  if (result === null) return null;
  const form =
    result.form !== null &&
    typeof result.form === "object" &&
    !Array.isArray(result.form)
      ? (result.form as Record<string, unknown>)
      : null;
  if (form === null) return null;
  const consent =
    result.consent !== null &&
    typeof result.consent === "object" &&
    !Array.isArray(result.consent)
      ? (result.consent as Record<string, unknown>)
      : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const firstName = str(form.firstName);
  const lastName = str(form.lastName);
  if (firstName === "" && lastName === "") return null;
  return {
    form: {
      firstName,
      lastName,
      email: str(form.email) || null,
      phone: str(form.phone) || null,
    },
    consent: {
      email: (consent as Record<string, unknown>).email === true,
      text: (consent as Record<string, unknown>).text === true,
    },
  };
}
