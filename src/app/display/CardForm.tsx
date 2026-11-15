"use client";

import { useState } from "react";

import { luhnOk } from "@/lib/cardrules";
import { parseTypedCard } from "@/lib/typedcard";

/**
 * T241: the student types their own card on the customer iPad ("A
 * different card"; Pete: "i dont want teachers to have to do that. a
 * student shouldnt have to hand them their card.").
 *
 * The same fields and the SAME validator as the teacher's typed-card
 * modal (T93, src/lib/typedcard.ts and src/lib/cardrules.ts, both pure),
 * so the form cannot accept what /api/checkout would refuse. The OS
 * keyboard is kept on the number field on purpose: `cc-number` is what
 * puts Apple's "Scan Credit Card" in the QuickType bar (CLAUDE.md's
 * card-entry convention, T98). The fields sit at the TOP of the scene,
 * inside the visual viewport band DisplayScreen publishes, so the
 * keyboard rises under them rather than over them.
 *
 * Where the card goes: this component's state, then ONE request to
 * /api/display/card, which holds it in the server's memory for one
 * charge. Nothing is kept here after that request (the fields are
 * cleared whatever it answered), nothing reaches storage or the URL, and
 * nothing about the card comes back to this screen, not even its last
 * four. It charges nothing: the teacher's Finalize does, and with the
 * approval setting on, the student's own Approve on the ticket that
 * follows.
 */

const CC = {
  number: "cc-number",
  expMonth: "cc-exp-month",
  expYear: "cc-exp-year",
  holder: "cc-name",
  postal: "postal-code",
} as const;

const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

export default function CardForm(props: {
  requestId: string;
  /** Whether a "Save this card for next time" box may be offered: the
   *  teacher's iPad said a client is attached (T93 refuses keep on file
   *  for the house client). */
  canKeep: boolean;
  /** The server has the card. */
  onSent: () => void;
  onCancel: () => void;
}) {
  const [number, setNumber] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [cvv, setCvv] = useState("");
  const [holder, setHolder] = useState("");
  const [postal, setPostal] = useState("");
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 12 }, (_, i) => String(thisYear + i));
  const digits = number.replace(/[\s-]/g, "");
  const numberNote =
    digits !== "" && !/^\d+$/.test(digits)
      ? "Digits only."
      : digits.length >= 13 && !luhnOk(digits)
        ? "That card number does not check out. Check the digits."
        : null;

  const clear = () => {
    setNumber("");
    setMonth("");
    setYear("");
    setCvv("");
    setHolder("");
    setPostal("");
    setKeep(false);
  };

  const send = async () => {
    if (busy) return;
    const parsed = parseTypedCard({
      number: digits,
      expMonth: month,
      expYear: year,
      cvv: cvv.trim(),
      billingName: holder.trim(),
      postalCode: postal.trim(),
      keep: props.canKeep && keep,
    });
    if (parsed.card === null) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/display/card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: props.requestId,
          card: {
            number: parsed.card.number,
            expMonth: parsed.card.expMonth,
            expYear: parsed.card.expYear,
            cvv: parsed.card.cvv,
            billingName: parsed.card.billingName,
            postalCode: parsed.card.postalCode,
            keep: parsed.card.keep,
          },
        }),
      });
      const body = await res.json().catch(() => null);
      /* Whatever the answer, nothing typed stays on this screen. */
      clear();
      if (!res.ok) {
        setError(
          typeof body?.error === "string" && body.error
            ? `${body.error} Please tell the front desk.`
            : "That did not go through. Please tell the front desk.",
        );
        return;
      }
      props.onSent();
    } catch {
      clear();
      setError("That did not go through. Please tell the front desk.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dcard" aria-label="Your card">
      <h2 className="dcard-heading">Enter your card</h2>
      <div className="dcard-fields">
        <label className="dsignup-field dcard-wide">
          <span>Card number</span>
          <input
            className="dsignup-input"
            autoFocus
            type="text"
            inputMode="numeric"
            autoComplete={CC.number}
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
        <p className="dcard-note" role="status">
          {numberNote ?? ""}
        </p>
        <label className="dsignup-field">
          <span>Expiry month</span>
          <select
            className="dsignup-input"
            autoComplete={CC.expMonth}
            value={month}
            disabled={busy}
            onChange={(e) => setMonth(e.target.value)}
          >
            <option value="">MM</option>
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="dsignup-field">
          <span>Expiry year</span>
          <select
            className="dsignup-input"
            autoComplete={CC.expYear}
            value={year}
            disabled={busy}
            onChange={(e) => setYear(e.target.value)}
          >
            <option value="">YYYY</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="dsignup-field">
          <span>Security code</span>
          <input
            className="dsignup-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={4}
            value={cvv}
            disabled={busy}
            onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
          />
        </label>
        <label className="dsignup-field">
          <span>Postal code</span>
          <input
            className="dsignup-input"
            type="text"
            autoComplete={CC.postal}
            autoCapitalize="characters"
            value={postal}
            disabled={busy}
            onChange={(e) => setPostal(e.target.value)}
          />
        </label>
        <label className="dsignup-field dcard-wide">
          <span>Name on card</span>
          <input
            className="dsignup-input"
            type="text"
            autoComplete={CC.holder}
            autoCapitalize="words"
            value={holder}
            disabled={busy}
            onChange={(e) => setHolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send();
            }}
          />
        </label>
      </div>
      {props.canKeep ? (
        <label className="dsignup-opt">
          <input
            type="checkbox"
            checked={keep}
            disabled={busy}
            onChange={(e) => setKeep(e.target.checked)}
          />
          Save this card for next time
        </label>
      ) : null}
      {error !== null ? <p className="dticket-error">{error}</p> : null}
      <div className="dticket-approve-buttons">
        <button
          type="button"
          className="dscene-btn"
          disabled={busy}
          onClick={() => {
            clear();
            props.onCancel();
          }}
        >
          Back
        </button>
        <button
          type="button"
          className="dscene-btn dscene-go"
          disabled={busy}
          onClick={() => void send()}
        >
          {busy ? "One moment" : "Use this card"}
        </button>
      </div>
      <p className="dcard-fine">
        Nothing is charged until the front desk finishes the sale.
      </p>
    </section>
  );
}
