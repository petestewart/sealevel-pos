"use client";

import { useEffect } from "react";

/**
 * T208: "We think this client already exists".
 *
 * Pete, second drive: "if we think they already exist, the teacher
 * should have a UI that very obviously states that instead of going to
 * 'New client'. should be a decision modal that says 'We think this
 * client already exists', display the one that it matches, and then
 * have two buttons: one to accept the match and one to create new
 * client anyway."
 *
 * Before this, a duplicate left a name in the tray with "Already has an
 * account, search for them." under it, and tapping it opened the New
 * client form again: the one thing Mindbody had just refused. So the
 * refusal now carries the MATCH (/api/client-create looks it up with
 * one search) and this is where the teacher decides between two people
 * they can see at once.
 *
 * Nothing here writes. "Use their existing account" posts the sign-up's
 * handle and the match's id to /api/client-create, which creates
 * nobody and files the waiver against the account that exists; "Create
 * a new client anyway" opens the same prefilled form with a line about
 * what has to change first. Mindbody's duplicate rule is first name,
 * last name and email together, so an identical form would simply be
 * refused again.
 */

export interface DuplicateMatch {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
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

export default function DuplicateModal(props: {
  /** What the student typed on the customer screen. */
  typed: { name: string; email: string | null; phone: string | null };
  /** Who Mindbody matched them to, or null when the search found
   *  nobody it could name. */
  match: DuplicateMatch | null;
  busy?: boolean;
  error?: string | null;
  onUseExisting: () => void;
  onCreateAnyway: () => void;
  onClose: () => void;
}) {
  const { typed, match, busy, error, onUseExisting, onCreateAnyway, onClose } =
    props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && busy !== true) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const person = (
    heading: string,
    who: { name: string; email: string | null; phone: string | null },
  ) => (
    <div className="dupe-person">
      <p className="dupe-heading">{heading}</p>
      <p className="dupe-name">{who.name || "(unnamed)"}</p>
      <p className="dupe-line">{who.email ?? "No email"}</p>
      <p className="dupe-line">{who.phone ?? "No phone"}</p>
    </div>
  );

  return (
    <div
      className="modal-scrim over-search"
      role="presentation"
      onClick={(e) => {
        if (busy !== true && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-dupe"
        role="dialog"
        aria-modal="true"
        aria-label="This person may already have an account"
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
          <p className="modal-kicker">Customer screen sign-up</p>
          <p className="modal-title">This person may already have an account</p>
        </div>
        <p className="reason-sub">
          Mindbody refused the new account because it already has one with
          this name and email.
        </p>
        <div className="dupe-pair">
          {person("They typed", typed)}
          {match === null ? (
            <div className="dupe-person">
              <p className="dupe-heading">Mindbody says</p>
              <p className="dupe-name">Already has an account</p>
              <p className="dupe-line">
                The search could not say which one. Search for them by name.
              </p>
            </div>
          ) : (
            person("Mindbody has", {
              name: `${match.firstName} ${match.lastName}`.trim(),
              email: match.email,
              phone: match.phone,
            })
          )}
        </div>
        <p className="reason-sub">
          Mindbody refuses a second account with the same name and email, so
          creating a new one means changing one of them first.
        </p>
        {error ? (
          <p className="note" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            className="modal-cancel"
            disabled={busy}
            onClick={onCreateAnyway}
          >
            Create a new client anyway
          </button>
          <button
            className="modal-confirm go"
            disabled={busy || match === null}
            onClick={onUseExisting}
          >
            {busy ? (
              <>
                <span className="spinner" aria-label="working" /> Working
              </>
            ) : (
              "Use their existing account"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
