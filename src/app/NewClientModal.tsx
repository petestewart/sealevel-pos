"use client";

import { useEffect, useRef, useState } from "react";

import { actorFallbackLine } from "./actornote";

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
 *  which of the site's requirements this form can and cannot meet. */
const FORM_FIELDS: Record<string, "firstName" | "lastName" | "email" | "phone"> =
  {
    FirstName: "firstName",
    LastName: "lastName",
    Email: "email",
    MobilePhone: "phone",
    Phone: "phone",
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
  onClose,
  onCreated,
}: Props) {
  const [firstName, setFirstName] = useState(initialFirst);
  const [lastName, setLastName] = useState(initialLast);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [account, setAccount] = useState(false);
  const [promo, setPromo] = useState(false);
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
  };
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
    try {
      const res = await fetch("/api/client-create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email || null,
          phone: values.phone || null,
          sendAccountEmails: account,
          sendPromotionalEmails: promo,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
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
      onCreated(
        client,
        body.actorFallback ? actorFallbackLine(body.actorFallback) : null,
      );
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
          <p className="modal-kicker">Walk-in</p>
          <p className="modal-title">New client</p>
        </div>
        <p className="reason-sub nc-sub">
          Makes their Mindbody account. The waiver comes up when they are
          added to a class.
        </p>
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
        </div>
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
              "Create"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
