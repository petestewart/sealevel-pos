"use client";

import { useId, useState } from "react";

/**
 * A password box with a reveal control (Pete, 2026-09-17: "we also need
 * a feature where the user can see the password they're entering if they
 * want to").
 *
 * Typing a Mindbody password blind on a glass keyboard, in a hot room,
 * with a queue, is how a teacher gets locked out of a sign-in that was
 * never wrong. So the box carries a 44px eye at its right edge that
 * swaps the field between masked and plain.
 *
 * It starts MASKED every time and is never remembered: this is a counter
 * iPad in a room with students in it, so revealing is a deliberate act
 * for the seconds it takes to check a typo, not a setting that could
 * leave the next teacher's password on show. Remounting the modal (every
 * open does) starts masked again, and `autoComplete` is whatever the
 * caller asks for.
 *
 * The value never leaves the caller's state: this component holds only
 * whether the field is showing.
 */
export default function PasswordInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** The label read out, and the one the eye's own label is built from
   *  ("Show the Mindbody password"), so two boxes on one screen are told
   *  apart by a screen reader and by a Playwright locator. */
  label: string;
  autoComplete?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  inputMode?: "text" | "numeric";
  maxLength?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="pw-field">
      <input
        id={id}
        className="reason-input pw-input"
        type={shown ? "text" : "password"}
        autoComplete={props.autoComplete ?? "current-password"}
        placeholder={props.placeholder}
        aria-label={props.label}
        value={props.value}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={props.onKeyDown}
      />
      {/* Not a submit: inside a form, a bare <button> would send it. */}
      <button
        type="button"
        className="pw-eye"
        aria-controls={id}
        aria-pressed={shown}
        disabled={props.disabled}
        aria-label={`${shown ? "Hide" : "Show"} the ${props.label.toLowerCase()}`}
        title={shown ? "Hide" : "Show"}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

/** Currentcolor throughout, so the icon is whatever the button's token
 *  resolves to in either palette. */
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle
        cx="12"
        cy="12"
        r="2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle
        cx="12"
        cy="12"
        r="2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M4 20L20 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
