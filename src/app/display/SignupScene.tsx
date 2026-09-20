"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import WaiverScene from "./WaiverScene";

import { birthDateRequired, readBirthDate } from "@/lib/birthdate";

import type { SignupPayload } from "@/lib/displaysignup";

/**
 * "New here? Sign up", as the student does it (T204, Phase 2.5 item 5;
 * design "Self-serve" and "Scene 3").
 *
 * One scene with steps, the student holding the iPad the whole way:
 * their four fields and the two opt-in boxes, then the studio's waiver
 * with the same pad and the same scroll rule T202 put on it (this IS
 * that component, given a different heading and told where to send the
 * signature), then a thank you the display itself takes down.
 *
 * Text fields are fine here. The "no amount in a text field" rule is
 * about money; this is the one screen where the student, not a teacher,
 * is typing about themselves, and the OS keyboard is what they expect.
 * The scene is an ordinary page column rather than a fixed modal, so
 * Safari scrolls the focused field above the keyboard itself: T98's
 * --vvh/--vv-bot band is the POS page's hook and is NOT mounted on
 * /display, and nothing here depends on it.
 *
 * T206: a fifth field, "Birth date", appears when and only when the
 * site's own required list asks for one (Pete's first drive ended in
 * Mindbody's "The following are required: Birthday"). The list is on
 * the payload the server built; on a site that does not ask, the form
 * is D4's four fields and the stored result is unchanged.
 *
 * THIS COMPONENT WRITES NOTHING TO MINDBODY, and sends no client id and
 * no staff id: it POSTs /api/display/complete with the form, the two
 * consent answers and the signature, and the teacher's own Create is
 * what makes the client and files the release.
 */

/** A touch reaches the server at most this often: the abandon clock
 *  only needs to know the student is still here, not every keystroke. */
const TOUCH_EVERY_MS = 20_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignupScene(props: {
  requestId: string;
  payload: SignupPayload;
  /** Told when the scene is finished with the screen, with the first
   *  name for the thank you. */
  onDone: (firstName: string | null) => void;
}) {
  const { requestId, payload, onDone } = props;
  const [step, setStep] = useState<1 | 2>(1);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  /* T206: asked ONLY when the site's required list asks for it. Pete's
   * first drive ended in Mindbody's "The following are required:
   * Birthday" with no field on either form to answer it. */
  const [birthDate, setBirthDate] = useState("");
  /* D4, Pete: "Include opt-in to text & emails (checked by default)." */
  const [wantsEmail, setWantsEmail] = useState(true);
  const [wantsText, setWantsText] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lastTouch = useRef(0);

  /** The abandon clock: the student is still here. Throttled, and it
   *  never blocks anything on screen. */
  const touch = useCallback(() => {
    const now = Date.now();
    if (now - lastTouch.current < TOUCH_EVERY_MS) return;
    lastTouch.current = now;
    void fetch("/api/display/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId }),
    }).catch(() => undefined);
  }, [requestId]);

  /* One touch when the scene opens, so a student who reads the form for
   * a while before typing is not cut off at two minutes. */
  useEffect(() => {
    lastTouch.current = 0;
    touch();
  }, [touch]);

  const required = new Set(payload.requiredFields.map((f) => f.toLowerCase()));
  const needsEmail = required.has("email");
  const needsPhone = [...required].some((f) => /^(mobile)?phone$/.test(f));
  const needsBirthDate = birthDateRequired(payload.requiredFields);

  const values = {
    firstName: firstName.trim().replace(/\s+/g, " "),
    lastName: lastName.trim().replace(/\s+/g, " "),
    email: email.trim(),
    phone: phone.trim(),
    birthDate: birthDate.trim(),
  };

  /** The same shapes the server insists on, said here first so the
   *  student is told by the screen they are looking at. */
  const check = (): string | null => {
    if (values.firstName.length === 0) return "Please put in your first name.";
    if (values.firstName.length > 60) return "That first name is too long.";
    if (values.lastName.length === 0) return "Please put in your last name.";
    if (values.lastName.length > 60) return "That last name is too long.";
    if (values.email.length === 0) {
      if (needsEmail) return "The studio needs your email address.";
    } else if (!EMAIL_RE.test(values.email) || values.email.length > 100) {
      return "That email address does not look right.";
    }
    if (values.phone.length === 0) {
      if (needsPhone) return "The studio needs your phone number.";
    } else if (values.phone.replace(/\D/g, "").length < 10) {
      return "That phone number does not look right.";
    }
    if (values.birthDate.length === 0) {
      if (needsBirthDate) return "The studio needs your date of birth.";
    } else {
      /* The same reader the server uses, so the screen says it first. */
      const read = readBirthDate(values.birthDate);
      if (!read.ok) return "That birth date does not look right.";
    }
    return null;
  };

  const next = () => {
    const bad = check();
    setError(bad);
    if (bad === null) {
      touch();
      setStep(2);
    }
  };

  const notNow = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await fetch("/api/display/refuse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          reason: "Customer tapped Not now",
        }),
      });
    } catch {
      /* The hub takes it down either way. */
    }
    setSaving(false);
  };

  /** Step 2's signature comes back here, and the WHOLE sign-up is one
   *  result: the form, the two consent answers and the PNG. */
  const submit = async (signaturePng: string, agreedAt: string) => {
    const res = await fetch("/api/display/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        result: {
          form: {
            firstName: values.firstName,
            lastName: values.lastName,
            email: values.email || null,
            phone: values.phone || null,
            /* Sent only when it was asked for, so a site that does not
               ask stores exactly what it stored before. */
            ...(values.birthDate ? { birthDate: values.birthDate } : {}),
          },
          consent: { email: wantsEmail, text: wantsText },
          signaturePng,
          agreedAt,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
  };

  if (step === 2) {
    return (
      <WaiverScene
        requestId={requestId}
        payload={{ text: payload.waiverText, clientFirstName: values.firstName }}
        heading={
          values.firstName
            ? `Nearly done, ${values.firstName}`
            : "Nearly done"
        }
        notNowLabel="Back"
        onNotNow={() => setStep(1)}
        onSubmit={submit}
        onDone={() => onDone(values.firstName || null)}
      />
    );
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    extra: {
      type?: string;
      inputMode?: "email" | "tel";
      needed?: boolean;
      autoCapitalize?: string;
    } = {},
  ) => (
    <label className="dsignup-field">
      <span>
        {label}
        {extra.needed ? " (needed)" : ""}
      </span>
      <input
        className="dsignup-input"
        type={extra.type ?? "text"}
        inputMode={extra.inputMode}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize={extra.autoCapitalize ?? "words"}
        spellCheck={false}
        value={value}
        disabled={saving}
        onChange={(e) => {
          set(e.target.value);
          setError(null);
          touch();
        }}
      />
    </label>
  );

  return (
    <section className="dsignup" aria-label="Sign up">
      <h1 className="dwaiver-heading">Welcome. Tell us who you are.</h1>
      <p className="dwaiver-lead">
        The front desk will finish it with you in a moment.
      </p>
      <div className="dsignup-fields" onPointerDown={touch}>
        {field("First name", firstName, setFirstName)}
        {field("Last name", lastName, setLastName)}
        {field("Email", email, setEmail, {
          type: "email",
          inputMode: "email",
          needed: needsEmail,
          autoCapitalize: "off",
        })}
        {field("Phone", phone, setPhone, {
          type: "tel",
          inputMode: "tel",
          needed: needsPhone,
          autoCapitalize: "off",
        })}
        {/* T206: the fifth field, and only when Mindbody asks for it.
            A date input, so the student gets the OS picker rather than
            a format to guess at. */}
        {needsBirthDate
          ? field("Birth date", birthDate, setBirthDate, {
              type: "date",
              needed: true,
              autoCapitalize: "off",
            })
          : null}
      </div>
      <div className="dsignup-opts">
        <label className="dsignup-opt">
          <input
            type="checkbox"
            checked={wantsEmail}
            disabled={saving}
            onChange={(e) => {
              setWantsEmail(e.target.checked);
              touch();
            }}
          />
          <span>Email me about my account, the schedule and offers</span>
        </label>
        <label className="dsignup-opt">
          <input
            type="checkbox"
            checked={wantsText}
            disabled={saving}
            onChange={(e) => {
              setWantsText(e.target.checked);
              touch();
            }}
          />
          <span>Text me about my account, the schedule and offers</span>
        </label>
      </div>
      {error ? (
        <p className="dwaiver-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dwaiver-actions">
        <button
          className="dwaiver-button"
          onClick={() => void notNow()}
          disabled={saving}
        >
          Not now
        </button>
        <button
          className="dwaiver-button dwaiver-agree"
          onClick={next}
          disabled={saving}
        >
          Next
        </button>
      </div>
    </section>
  );
}
