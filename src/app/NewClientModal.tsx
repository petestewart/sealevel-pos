"use client";

import { useEffect, useRef, useState } from "react";

import { actorFallbackLine } from "./actornote";

import type { DuplicateMatch } from "./DuplicateModal";

import { readBirthDate } from "@/lib/birthdate";

/**
 * T59b: a new client signed up at the counter. Pete: "first name, last
 * name, email, phone. Nothing else." The email opt-in is T53's consent
 * question asked in the same form, two checkboxes, both off until the
 * person says yes.
 *
 * Opened from the walk-in search's empty state, so the person the
 * teacher just failed to find can be made and booked without leaving
 * the search: on success the modal closes and the new person appears
 * as a search result row, and the existing walk-in path takes over
 * (the waiver dialog fires on booking as it does for any unsigned
 * client, T18). Nothing about them is kept here or in our database;
 * Mindbody owns clients.
 *
 * The T52 modal idiom: the X, the scrim, Escape, one Cancel/Create pair
 * at 64px. Create is single flight. A suppressed write (dry run, the
 * write guard) shows in amber inside the modal and adds no row: a row
 * for a person who does not exist is exactly the lie dry run exists to
 * prevent.
 */

/** The row shape page.tsx's search results carry (its SearchResult),
 *  as the route returns it from src/lib/clients.ts. */
export interface NewClientResult {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  waiverSigned: boolean;
  redAlert: string | null;
  yellowAlert: string | null;
  balance: number | null;
  member: boolean;
  notes: string | null;
  mindbodyId: number | null;
}

interface Props {
  /** Prefill from the search box when it looked like a name. */
  initialFirst: string;
  initialLast: string;
  /** T204: a self-serve sign-up's own typed contact details and the two
   *  consent answers, read back from the server (never from the
   *  display's browser), with the request id that holds the signature.
   *  The teacher may still fix the spelling of a name: the form is the
   *  body's, and only the consent and the signature come from the
   *  stored request. */
  initialEmail?: string;
  initialPhone?: string;
  /** T206: `YYYY-MM-DD` as the student typed it, for the same reason as
   *  the name: the teacher reads it back and may correct it, and what
   *  the body carries is what reaches Mindbody. */
  initialBirthDate?: string;
  signup?: {
    requestId: string;
    consentEmail: boolean;
    consentText: boolean;
    completedAt: string | null;
  };
  /**
   * T208: this form IS review mode's review. Pete, second drive: "i see
   * nothing that says 'review'. the create client modal is there, is
   * that how it's supposed to work? if so, the verbiage and labeling
   * needs to be much better." So the title, the line under it and the
   * button all say what this tap is and what it will do; the form and
   * the route behind it are the same ones.
   */
  review?: boolean;
  /** T208: what Create will do, named on the button: "Create and check
   *  in", "Create and add to waiting list", or plain "Create" when
   *  there is no class on screen for it to do anything with. */
  createLabel?: string;
  /** T208: one amber line at the top, from the duplicate decision's
   *  "Create a new client anyway". */
  notice?: string;
  /**
   * T208: Mindbody refused this as a duplicate. The match is the
   * account it was matched to, or null when the server's one search
   * could not name one -- and the decision is worth opening either way
   * (T208 review), because "Mindbody says they already have an
   * account" with the search offer beats a red line in a form that
   * cannot be made to work.
   *
   * `sent` is the form THIS create carried, which in review mode is the
   * teacher's corrected version and is what the match was computed
   * from; the accept sends it back so the server recomputes from the
   * same words. Returning true means the caller took it and this form
   * should say nothing.
   */
  onDuplicate?: (
    match: DuplicateMatch | null,
    sent: { firstName: string; lastName: string; email: string | null },
  ) => boolean;
  onClose: () => void;
  /** The created person, and the amber line when the write ran as the
   *  studio account (T49's one loud fallback), else null. */
  onCreated: (client: NewClientResult, note: string | null) => void;
}

function CloseIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Mindbody's names for the form's fields, for the required-field read:
 *  which of the site's requirements this form can and cannot meet. T206
 *  adds the birth date, which is the one field this form grows only when
 *  the site asks for it (Pete's first drive: the sign-up ended in "The
 *  following are required: Birthday"). Both spellings, because the
 *  required list says `BirthDate` and the refusal says Birthday. */
const FORM_FIELDS: Record<
  string,
  "firstName" | "lastName" | "email" | "phone" | "birthDate"
> = {
  FirstName: "firstName",
  LastName: "lastName",
  Email: "email",
  MobilePhone: "phone",
  Phone: "phone",
  BirthDate: "birthDate",
  Birthday: "birthDate",
};

/** A readable name for a field Mindbody lists that the form lacks:
 *  "AddressLine1" reads as "address line1", which is enough to tell the
 *  teacher what Mindbody may ask for. */
function readable(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export default function NewClientModal({
  initialFirst,
  initialLast,
  initialEmail,
  initialPhone,
  initialBirthDate,
  signup,
  review,
  createLabel,
  notice,
  onDuplicate,
  onClose,
  onCreated,
}: Props) {
  const [firstName, setFirstName] = useState(initialFirst);
  const [lastName, setLastName] = useState(initialLast);
  const [email, setEmail] = useState(initialEmail ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [birthDate, setBirthDate] = useState(initialBirthDate ?? "");
  /* T204: a sign-up's boxes are the STUDENT's answer, shown as they
   *  were given and not editable here: the server takes the consent
   *  from the request, not from this form, so an editable box would be
   *  a control that does nothing. */
  const [account, setAccount] = useState(signup?.consentEmail ?? false);
  const [promo, setPromo] = useState(signup?.consentEmail ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* The amber notices: a suppressed write, and what Mindbody requires
   * that the form cannot give. */
  const [suppressedNote, setSuppressedNote] = useState<string | null>(null);
  const [required, setRequired] = useState<string[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const inFlight = useRef(false);

  /* Read the site's required fields once per open. The live answer for
   * site 471 is unknown (T59b); the dev drawer records it. A failed read
   * is silent here: Mindbody's refusal on Create is the authoritative
   * answer and comes back in words. */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/client-create")
      .then((r) => r.json())
      .then((body) => {
        if (cancelled || !body || body.error) return;
        setRequired(Array.isArray(body.required) ? body.required : []);
        setMissing(Array.isArray(body.missing) ? body.missing : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    /* Capture, so the search modal underneath does not also close. */
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  /* Which of the form's own fields Mindbody lists as required: those
   * gate Create rather than getting a refusal after the tap. */
  const requiredHere = new Set(
    required.map((f) => FORM_FIELDS[f]).filter((k) => k !== undefined),
  );
  const values = {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: email.trim(),
    phone: phone.trim(),
    birthDate: birthDate.trim(),
  };
  /* T206: the field exists only when the site's list asks for it, so
   * nothing about a site that does not ask changes, here or on the
   * wire. */
  const wantsBirthDate = requiredHere.has("birthDate");
  const ready =
    values.firstName !== "" &&
    values.lastName !== "" &&
    [...requiredHere].every((k) => values[k] !== "");

  async function create() {
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSuppressedNote(null);
    if (wantsBirthDate) {
      const read = readBirthDate(values.birthDate);
      if (!read.ok) {
        inFlight.current = false;
        setBusy(false);
        setError("That birth date does not look right.");
        return;
      }
    }
    try {
      const res = await fetch("/api/client-create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email || null,
          phone: values.phone || null,
          ...(wantsBirthDate && values.birthDate
            ? { birthDate: values.birthDate }
            : {}),
          sendAccountEmails: account,
          sendPromotionalEmails: promo,
          ...(signup ? { displayRequestId: signup.requestId } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        /* T208: a duplicate is a DECISION, not a red line. The route
         * names the account it matched, and the caller puts the two
         * people side by side; only when it declines does this say
         * anything. */
        if (body?.duplicate === true && onDuplicate) {
          const match: DuplicateMatch | null =
            body.match && typeof body.match.id === "string"
              ? {
                  id: String(body.match.id),
                  firstName: String(body.match.firstName ?? ""),
                  lastName: String(body.match.lastName ?? ""),
                  email:
                    typeof body.match.email === "string" && body.match.email
                      ? body.match.email
                      : null,
                  phone:
                    typeof body.match.phone === "string" && body.match.phone
                      ? body.match.phone
                      : null,
                }
              : null;
          /* Null match included (T208 review): the decision names what
           * it knows and offers the search, which is the whole of what
           * a teacher can do about it. */
          if (
            onDuplicate(match, {
              firstName: values.firstName,
              lastName: values.lastName,
              email: values.email || null,
            })
          ) {
            return;
          }
        }
        setError(
          typeof body?.error === "string" && body.error
            ? body.error
            : `Mindbody did not accept the sign-up (HTTP ${res.status}).`,
        );
        return;
      }
      if (body.suppressed) {
        setSuppressedNote(
          body.suppressed === "dry-run"
            ? "Not created: dry run is on, so nothing was sent to Mindbody."
            : "Not created: the write guard allows only the listed test " +
                "clients, and a client being created has no id to list.",
        );
        return;
      }
      const client = body.client as NewClientResult | null;
      if (!client || typeof client.id !== "string") {
        setError("Mindbody answered without a client. Search for the name.");
        return;
      }
      /* T204: the two things a teacher must hear about a sign-up's
       * Create, said in the amber line the caller already shows: a
       * waiver that did not land, and a text opt-in Mindbody dropped. */
      const extra: string[] = [];
      if (signup) {
        if (body.waiver && body.waiver.agreed !== true) {
          extra.push(
            body.waiver.suppressed
              ? `The waiver was not recorded: ${body.waiver.suppressed === "dry-run" ? "dry run is on" : "the write guard is on"}.`
              : "The waiver was not recorded. Open their profile and use the waiver dialog.",
          );
        } else if (body.waiver && body.waiver.documentFiled === false) {
          extra.push(
            "The waiver is recorded; the signature image did not reach Mindbody.",
          );
        }
        if (body.textOptInStuck === false) {
          extra.push(
            "Mindbody did not keep the text opt-in; it is noted on their profile to set by hand.",
          );
        }
      }
      const fallback = body.actorFallback
        ? actorFallbackLine(body.actorFallback)
        : null;
      const note = [fallback, ...extra].filter(Boolean).join(" ");
      onCreated(client, note.length > 0 ? note : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const field = (
    key: keyof typeof values,
    label: string,
    value: string,
    set: (v: string) => void,
    extra: { type?: string; autoComplete?: string; wide?: boolean } = {},
  ) => (
    <label className={extra.wide ? "nc-field wide" : "nc-field"}>
      <span>
        {label}
        {requiredHere.has(key) ? " (required)" : ""}
      </span>
      <input
        className="reason-input"
        /* T59b review: the tap that opened the form left focus on the
         * "New client" button underneath, so the first keystroke went
         * nowhere. Land in the first name, filled or not, like the
         * sign-in and search boxes do. */
        autoFocus={key === "firstName"}
        type={extra.type ?? "text"}
        autoComplete={extra.autoComplete ?? "off"}
        autoCapitalize={extra.type ? "off" : "words"}
        value={value}
        disabled={busy}
        onChange={(e) => {
          set(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create();
        }}
      />
    </label>
  );

  return (
    <div
      className="modal-scrim over-search"
      role="presentation"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-new-client"
        role="dialog"
        aria-modal="true"
        aria-label="New client"
      >
        <button
          className="row-icon modal-x"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <div className="modal-head">
          <p className="modal-kicker">
            {review ? "Customer screen" : "Walk-in"}
          </p>
          <p className="modal-title">
            {review ? "Review sign-up" : "New client"}
          </p>
        </div>
        <p className="reason-sub nc-sub">
          {review
            ? "Signed up on the customer screen. Check the details, then create them and check them in."
            : signup
              ? "Waiver signed on the customer screen, waiting for Create. Check the spelling of the name, then Create makes their account and files the waiver together."
              : "Makes their Mindbody account. The waiver comes up when they are added to a class."}
        </p>
        {/* T208: what has to change before Mindbody will take it. */}
        {notice ? (
          <p className="modal-warn" role="status">
            {notice}
          </p>
        ) : null}
        <div className="nc-fields">
          {field("firstName", "First name", firstName, setFirstName, {
            autoComplete: "given-name",
          })}
          {field("lastName", "Last name", lastName, setLastName, {
            autoComplete: "family-name",
          })}
          {field("email", "Email", email, setEmail, {
            type: "email",
            autoComplete: "email",
            wide: true,
          })}
          {field("phone", "Phone", phone, setPhone, {
            type: "tel",
            autoComplete: "tel",
            wide: true,
          })}
          {/* T206: the fifth field, drawn only when Mindbody's own
              required list asks for it. A date input, so no format has
              to be guessed at and no amount-style pad is needed. */}
          {wantsBirthDate
            ? field("birthDate", "Birth date", birthDate, setBirthDate, {
                type: "date",
                autoComplete: "bday",
                wide: true,
              })
            : null}
        </div>
        {signup ? (
          <div className="consent-opts">
            <p className="reason-sub nc-sub">
              They asked for email: {signup.consentEmail ? "yes" : "no"}. They
              asked for texts: {signup.consentText ? "yes" : "no"}. Both go out
              with the account as they answered them.
            </p>
          </div>
        ) : (
          <div className="consent-opts">
            <label className="consent-opt">
              <input
                type="checkbox"
                checked={account}
                disabled={busy}
                onChange={(e) => setAccount(e.target.checked)}
              />
              <span>Emails about my account</span>
            </label>
            <label className="consent-opt">
              <input
                type="checkbox"
                checked={promo}
                disabled={busy}
                onChange={(e) => setPromo(e.target.checked)}
              />
              <span>News and offers</span>
            </label>
          </div>
        )}
        {missing.length > 0 ? (
          <p className="modal-warn" role="status">
            Mindbody also asks new clients here for{" "}
            {missing.map(readable).join(", ")}. This form does not have{" "}
            {missing.length === 1 ? "it" : "them"}; Mindbody may refuse the
            sign-up, or accept it without.
          </p>
        ) : null}
        {suppressedNote ? (
          <p className="modal-warn" role="status">
            {suppressedNote}
          </p>
        ) : null}
        {error ? (
          <p className="note nc-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button className="modal-cancel" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-confirm go"
            disabled={busy || !ready}
            onClick={() => void create()}
          >
            {busy ? (
              <>
                <span className="spinner" aria-label="working" /> Creating
              </>
            ) : (
              (createLabel ?? "Create")
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
