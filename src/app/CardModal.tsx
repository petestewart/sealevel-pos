"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { actorFallbackLine } from "./actornote";
import type { CardOnFile } from "@/lib/clientcard";

/**
 * T84: the card on file, typed at the counter (Pete: "we need to add the
 * ability to add a card on file"). Opened from the profile card's "Card on
 * file" row, over the profile modal.
 *
 * The T61 idiom: one fixed box, the X, the scrim, Escape, one Cancel/Save
 * pair at the modal-actions height. Save is single flight and stays
 * disabled until the fields check out, so a typo costs a quiet line rather
 * than a round trip; the server checks the same rules again, because a
 * browser's validation is not a rule.
 *
 * There is no CVV field: Mindbody's ClientCreditCard model does not have
 * one (client.yml:7365). If Mindbody turns out to want one, it refuses in
 * words and the field is added then, never stored.
 *
 * The number lives in this component's state and in the one request, and
 * nowhere else: no draft is kept, nothing is written to localStorage, and
 * the fields are cleared on every exit. The call log redacts what the
 * server sent (src/lib/calllog.ts).
 */

interface Props {
  clientId: string;
  /** Who it is for, for the modal's head. */
  name: string;
  /** The card on file now, so the box can say what is being replaced. */
  current: CardOnFile | null;
  onClose: () => void;
  /** The card Mindbody holds after the save, and the amber line when the
   *  write ran as the studio account (T49's one loud fallback). */
  onSaved: (card: CardOnFile, note: string | null) => void;
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

/** The Luhn check digit, the same rule the server enforces
 *  (src/lib/clientcard.ts luhnOk). Repeated rather than imported so the
 *  browser bundle does not pull a module that calls mindbody(). */
function luhnOk(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const MIN_DIGITS = 13;
const MAX_DIGITS = 19;

const MONTHS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
];

export default function CardModal({
  clientId,
  name,
  current,
  onClose,
  onSaved,
}: Props) {
  const [number, setNumber] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [holder, setHolder] = useState("");
  const [postal, setPostal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suppressedNote, setSuppressedNote] = useState<string | null>(null);
  const inFlight = useRef(false);

  /* Everything typed goes when the box goes. Unmounting would do it on
   * its own; doing it here as well means a future caller that keeps the
   * modal mounted cannot leave a card number in React state. */
  const leave = useCallback(() => {
    setNumber("");
    setMonth("");
    setYear("");
    setHolder("");
    setPostal("");
    setError(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        leave();
      }
    };
    /* Capture, so the profile modal underneath does not also close. */
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, leave]);

  /* The years a card can expire in: this year through eleven more, which
   * is longer than any card is issued for. */
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 12 }, (_, i) => String(thisYear + i));

  const digits = number.replace(/[\s -]/g, "");
  const lengthOk = digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS;
  const numberOk = lengthOk && luhnOk(digits);
  /* The quiet line, only once there are enough digits for the check to
   * mean anything: it must not scold someone mid-typing. */
  const numberNote =
    digits !== "" && !/^\d+$/.test(digits)
      ? "Digits only."
      : digits.length >= MIN_DIGITS && !numberOk
        ? "That card number does not check out. Check the digits."
        : null;
  /* A card expires at the END of its month, so this month is still
   * valid. */
  const expiryOk =
    month !== "" &&
    year !== "" &&
    new Date(Number(year), Number(month), 1).getTime() > Date.now();
  const postalOk = /^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/.test(postal.trim());
  const ready =
    numberOk && expiryOk && holder.trim() !== "" && postalOk && !busy;

  async function save() {
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSuppressedNote(null);
    try {
      const res = await fetch("/api/client-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId,
          number: digits,
          expMonth: month,
          expYear: year,
          cardHolder: holder.trim(),
          postalCode: postal.trim(),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok !== true) {
        setError(
          typeof body?.error === "string" && body.error
            ? body.error
            : `Mindbody did not accept the card (HTTP ${res.status}).`,
        );
        return;
      }
      if (body.suppressed) {
        /* Suppression is never success: the row must not start showing a
         * card that is not on file. */
        setSuppressedNote(
          body.suppressed === "dry-run"
            ? "Not saved: dry run is on, so nothing was sent to Mindbody."
            : "Not saved: the write guard allows only the clients listed " +
                "in POS_WRITE_CLIENT_IDS.",
        );
        return;
      }
      const card = body.card as CardOnFile | null;
      if (!card || typeof card.lastFour !== "string") {
        setError(
          "Mindbody took the card but did not show one back. Check the " +
            "profile in Mindbody before trying again.",
        );
        return;
      }
      onSaved(
        card,
        body.actorFallback ? actorFallbackLine(body.actorFallback) : null,
      );
      /* The parent closes the box; clear what was typed either way. */
      setNumber("");
      setHolder("");
      setPostal("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-scrim over-profile"
      role="presentation"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) leave();
      }}
    >
      <div
        className="modal modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={current ? "Replace card on file" : "Add card on file"}
      >
        <button
          className="row-icon modal-x"
          aria-label="Close"
          disabled={busy}
          onClick={leave}
        >
          <CloseIcon />
        </button>
        <div className="modal-head">
          <p className="modal-kicker">{name}</p>
          <p className="modal-title">
            {current ? "Replace card on file" : "Add card on file"}
          </p>
        </div>
        <p className="reason-sub nc-sub">
          {current
            ? `Replaces the card ending ${current.lastFour}. Mindbody keeps the card; this app never stores it.`
            : "Mindbody keeps the card; this app never stores it."}
        </p>
        <div className="nc-fields">
          <label className="nc-field wide">
            <span>Card number</span>
            <input
              className="reason-input"
              autoFocus
              type="text"
              inputMode="numeric"
              autoComplete="cc-number"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={number}
              disabled={busy}
              onChange={(e) => {
                setNumber(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="nc-field">
            <span>Expiry month</span>
            <select
              className="reason-input"
              autoComplete="cc-exp-month"
              value={month}
              disabled={busy}
              onChange={(e) => {
                setMonth(e.target.value);
                setError(null);
              }}
            >
              <option value="">MM</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="nc-field">
            <span>Expiry year</span>
            <select
              className="reason-input"
              autoComplete="cc-exp-year"
              value={year}
              disabled={busy}
              onChange={(e) => {
                setYear(e.target.value);
                setError(null);
              }}
            >
              <option value="">YYYY</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="nc-field wide">
            <span>Name on card</span>
            <input
              className="reason-input"
              type="text"
              autoComplete="cc-name"
              autoCapitalize="words"
              value={holder}
              disabled={busy}
              onChange={(e) => {
                setHolder(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="nc-field wide">
            <span>Postal code</span>
            <input
              className="reason-input"
              type="text"
              inputMode="text"
              autoComplete="postal-code"
              autoCapitalize="characters"
              value={postal}
              disabled={busy}
              onChange={(e) => {
                setPostal(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
          </label>
        </div>
        {/* Always present, blank when there is nothing to say: the box
            must not grow under a finger mid-typing (T68's rule for every
            other dialog). */}
        <p className="card-note" role="status">
          {numberNote ?? ""}
        </p>
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
          <button className="modal-cancel" disabled={busy} onClick={leave}>
            Cancel
          </button>
          <button
            className="modal-confirm go"
            disabled={!ready}
            onClick={() => void save()}
          >
            {busy ? (
              <>
                <span className="spinner" aria-label="working" /> Saving
              </>
            ) : (
              "Save card"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
