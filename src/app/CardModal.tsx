"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { actorFallbackLine } from "./actornote";
import { luhnOk } from "@/lib/cardrules";
import type { CardOnFile } from "@/lib/clientcard";
import { parseTypedCard, type TypedCard } from "@/lib/typedcard";

/**
 * T84: the card on file, typed at the counter (Pete: "we need to add the
 * ability to add a card on file"). Opened from the profile card's "Card on
 * file" row, over the profile modal.
 *
 * T93: the same box, in a second mode, for a card typed to pay for THIS
 * sale (Pete: "the Card button should have a number keypad icon on its
 * right. this will open a credit card manual entry modal (same as the
 * 'Replace card on file' modal)"). One component, because it is one form
 * and Pete asked for the same one:
 *
 * - mode "file" (the default, T84): Save card, straight to
 *   /api/client-card, which writes the card on the client.
 * - mode "sale" (T93): "Use this card", which CHARGES NOTHING. It hands
 *   the card up to the payment surface as a tender line, and the charge
 *   happens on Finalize Sale with every other tender, single flight. The
 *   extra field is the CVV (the spec lists it for a CreditCard payment;
 *   T84 has none because Mindbody's ClientCreditCard model has none), the
 *   three optional billing lines sit behind one disclosure, and for an
 *   attached client there is the two-cell choice between using the card
 *   once and keeping it on file as well.
 *
 * The T61 idiom: one fixed box, the X, the scrim, Escape, one
 * Cancel/primary pair at the modal-actions height. The primary stays
 * disabled until the fields check out (by the SAME validator the route
 * enforces, src/lib/typedcard.ts), so a typo costs a quiet line rather
 * than a round trip; the server checks the rules again, because a
 * browser's validation is not a rule.
 *
 * The number and the CVV live in this component's state and in the one
 * request, and nowhere else: no draft is kept, nothing is written to
 * localStorage or sessionStorage, nothing reaches the URL, and the fields
 * are cleared on every exit. The call log redacts what the server sent
 * (src/lib/calllog.ts strikes CardNumber, CreditCardNumber and CVV in
 * both directions). The CVV is never sent to /api/client-card: Mindbody
 * has nowhere to keep one.
 */

interface Common {
  /** Who it is for, for the modal's head. */
  name: string;
  onClose: () => void;
}

interface FileProps extends Common {
  mode?: "file";
  clientId: string;
  /** The card on file now, so the box can say what is being replaced. */
  current: CardOnFile | null;
  /** The card Mindbody holds after the save, and the amber line when the
   *  write ran as the studio account (T49's one loud fallback). */
  onSaved: (card: CardOnFile, note: string | null) => void;
}

interface SaleProps extends Common {
  mode: "sale";
  /** The card on file now, if any: "keep on file" is "replace on file"
   *  when one is already there. Only the last four is read, so the
   *  payment surface's own lookup shape fits with no conversion. */
  current: { lastFour: string } | null;
  /** Null on a walk-in cart: there is nobody to keep a card for, so the
   *  choice is not offered and the card is used once. */
  clientId: string | null;
  /** What this card is about to be tendered for, for the head's line. */
  amount: string;
  /** Hand the card up to the payment surface. It charges nothing. */
  onUse: (card: TypedCard, lastFour: string) => void;
}

type Props = FileProps | SaleProps;

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

/**
 * T98: the autocomplete tokens, named and pinned.
 *
 * Pete, watching the iOS keyboard cover this box: "one useful thing
 * though the 'Scan Card' option appears on that keyboard automatically."
 * It appears BECAUSE of these tokens: Apple puts "Scan Credit Card" in
 * the QuickType bar for a field that declares `cc-number`, and fills the
 * expiry and the name beside it from the same scan. That is why T98 lifts
 * the modal above the keyboard instead of replacing the keyboard with an
 * in-app keypad: the OS keyboard is deliberately KEPT for card entry,
 * because it is the only thing here that can read a card with the camera.
 * (T35's no-OS-keyboard rule is about MONEY entry, and the pads keep it:
 * a money pad carries no text input at all.)
 *
 * The literal types are the check. Weaken a token, to "off", to a typo,
 * or by dropping a field, and `npm run typecheck` fails, rather than the
 * scan quietly disappearing from an iPad nobody happens to be holding.
 */
type ScanTokens = {
  readonly number: "cc-number";
  readonly expMonth: "cc-exp-month";
  readonly expYear: "cc-exp-year";
  readonly holder: "cc-name";
  readonly postal: "postal-code";
};

const CC_AUTOCOMPLETE = {
  number: "cc-number",
  expMonth: "cc-exp-month",
  expYear: "cc-exp-year",
  holder: "cc-name",
  postal: "postal-code",
} as const satisfies ScanTokens;

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

export default function CardModal(props: Props) {
  const { name, current, onClose } = props;
  const sale = props.mode === "sale";
  const [number, setNumber] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [holder, setHolder] = useState("");
  const [postal, setPostal] = useState("");
  /** T93, sale mode only. Never stored, never sent to /api/client-card. */
  const [cvv, setCvv] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  /** The "Billing address" disclosure. The box does not change size when
   *  it opens: the fields region is one fixed height that scrolls. */
  const [billingOpen, setBillingOpen] = useState(false);
  /** T93: "and keep on file", offered only for an attached client. */
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suppressedNote, setSuppressedNote] = useState<string | null>(null);
  const inFlight = useRef(false);

  /* Everything typed goes when the box goes. Unmounting would do it on
   * its own; doing it here as well means a future caller that keeps the
   * modal mounted cannot leave a card number, or a CVV, in React state. */
  const leave = useCallback(() => {
    setNumber("");
    setMonth("");
    setYear("");
    setHolder("");
    setPostal("");
    setCvv("");
    setAddress("");
    setCity("");
    setRegion("");
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
    /* Capture, so the surface underneath does not also close. */
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
  const cvvOk = /^\d{3,4}$/.test(cvv.trim());
  const ready =
    numberOk &&
    expiryOk &&
    holder.trim() !== "" &&
    postalOk &&
    (!sale || cvvOk) &&
    !busy;

  /** T93: the validated card, or null. The SAME function /api/checkout
   *  refuses by, so the form cannot accept what the route would not. */
  const typedCard = (): TypedCard | null => {
    const parsed = parseTypedCard({
      number: digits,
      expMonth: month,
      expYear: year,
      cvv: cvv.trim(),
      billingName: holder.trim(),
      postalCode: postal.trim(),
      address: address.trim(),
      city: city.trim(),
      state: region.trim(),
      keep,
    });
    if (parsed.card === null) {
      setError(parsed.error);
      return null;
    }
    return parsed.card;
  };

  /** Sale mode's primary. It charges NOTHING: the card goes up to the
   *  payment surface as a tender line, and Finalize Sale is the one tap
   *  that moves money. */
  function use() {
    if (!ready || props.mode !== "sale") return;
    const card = typedCard();
    if (card === null) return;
    props.onUse(card, card.number.slice(-4));
    /* The parent closes the box; clear what was typed either way. */
    leave();
  }

  /** File mode's primary (T84, unchanged): straight to /api/client-card. */
  async function save() {
    if (inFlight.current || !ready || props.mode === "sale") return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSuppressedNote(null);
    try {
      const res = await fetch("/api/client-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: props.clientId,
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
      props.onSaved(
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

  const submit = () => (sale ? use() : void save());

  const title = sale
    ? "Card for this sale"
    : current
      ? "Replace card on file"
      : "Add card on file";
  /** The choice's second cell: keeping a card where one already sits is
   *  replacing it, and it must say so. */
  const keepLabel = current ? "Use and replace on file" : "Use and keep on file";
  const canKeep = props.mode === "sale" && props.clientId !== null;

  return (
    <div
      className="modal-scrim over-profile"
      role="presentation"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) leave();
      }}
    >
      <div
        className={sale ? "modal modal-card modal-card-sale" : "modal modal-card"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
          <p className="modal-title">{title}</p>
        </div>
        <p className="reason-sub nc-sub">
          {sale
            ? `${(props as SaleProps).amount} on this card. Nothing is charged until you finalize the sale; this app never stores the card.`
            : current
              ? `Replaces the card ending ${current.lastFour}. Mindbody keeps the card; this app never stores it.`
              : "Mindbody keeps the card; this app never stores it."}
        </p>
        {/* One fixed-height region, so the box is the same size whether
            the billing disclosure is open or shut (T68's rule: a dialog
            must not grow under a finger). In file mode it is not a
            scroll region at all: the four fields always fit. */}
        <div className={sale ? "card-body" : undefined}>
        <div className="nc-fields">
          <label className="nc-field wide">
            <span>Card number</span>
            <input
              className="reason-input"
              autoFocus
              type="text"
              inputMode="numeric"
              autoComplete={CC_AUTOCOMPLETE.number}
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
          {/* Under the number it is about. Always present, blank when
              there is nothing to say, so the box cannot grow under a
              finger mid-typing (T68's rule for every other dialog). */}
          <p className="card-note" role="status">
            {numberNote ?? ""}
          </p>
          <label className="nc-field">
            <span>Expiry month</span>
            <select
              className="reason-input"
              autoComplete={CC_AUTOCOMPLETE.expMonth}
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
              autoComplete={CC_AUTOCOMPLETE.expYear}
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
              autoComplete={CC_AUTOCOMPLETE.holder}
              autoCapitalize="words"
              value={holder}
              disabled={busy}
              onChange={(e) => {
                setHolder(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className={sale ? "nc-field" : "nc-field wide"}>
            <span>Postal code</span>
            <input
              className="reason-input"
              type="text"
              inputMode="text"
              autoComplete={CC_AUTOCOMPLETE.postal}
              autoCapitalize="characters"
              value={postal}
              disabled={busy}
              onChange={(e) => {
                setPostal(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
          {/* T93: the CVV, beside the postal code. Required for a charge
              (the spec lists it for a CreditCard payment), and it goes
              nowhere but that one payment: never to /api/client-card,
              never into a card on file, cleared with the rest. */}
          {sale ? (
            <label className="nc-field">
              <span>Security code</span>
              <input
                className="reason-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={4}
                value={cvv}
                disabled={busy}
                onChange={(e) => {
                  setCvv(e.target.value.replace(/\D/g, "").slice(0, 4));
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </label>
          ) : null}
        </div>
        {/* The three optional billing lines, behind one disclosure: the
            studio's processor may want them, and the spec has fields for
            them, but nobody should have to type a street address to take
            a payment. Empty means "not given" and the payment omits the
            key rather than sending a blank. */}
        {sale ? (
          <>
            <button
              className="card-disclose"
              type="button"
              aria-expanded={billingOpen}
              disabled={busy}
              onClick={() => setBillingOpen((o) => !o)}
            >
              {billingOpen ? "Hide billing address" : "Billing address"}
              <span className="card-disclose-note">optional</span>
            </button>
            {billingOpen ? (
              <div className="nc-fields">
                <label className="nc-field wide">
                  <span>Street address</span>
                  <input
                    className="reason-input"
                    type="text"
                    autoComplete="billing street-address"
                    value={address}
                    disabled={busy}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </label>
                <label className="nc-field">
                  <span>City</span>
                  <input
                    className="reason-input"
                    type="text"
                    autoComplete="billing address-level2"
                    value={city}
                    disabled={busy}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </label>
                <label className="nc-field">
                  <span>State</span>
                  <input
                    className="reason-input"
                    type="text"
                    autoComplete="billing address-level1"
                    value={region}
                    disabled={busy}
                    onChange={(e) => setRegion(e.target.value)}
                  />
                </label>
              </div>
            ) : null}
          </>
        ) : null}
        {/* T93: with a client attached the teacher chooses whether the
            card is also kept on file (Pete: "they can add or replace this
            as a stored card, or just use it temporarily"). On a walk-in
            cart there is nobody to keep it for, so there is no choice and
            the card is used once: /api/checkout refuses `keep` on a
            house-client cart. */}
        {canKeep ? (
          <div className="card-keep">
            <p className="card-keep-label">This card</p>
            <div className="pad-chips">
              <button
                className={keep ? "pad-chip" : "pad-chip on"}
                type="button"
                disabled={busy}
                aria-pressed={!keep}
                onClick={() => setKeep(false)}
              >
                Use once
              </button>
              <button
                className={keep ? "pad-chip on" : "pad-chip"}
                type="button"
                disabled={busy}
                aria-pressed={keep}
                onClick={() => setKeep(true)}
              >
                {keepLabel}
              </button>
            </div>
            <p className="card-note" role="status">
              {keep
                ? "Kept on file only after the sale goes through."
                : ""}
            </p>
          </div>
        ) : null}
        </div>
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
            onClick={submit}
          >
            {busy ? (
              <>
                <span className="spinner" aria-label="working" /> Saving
              </>
            ) : sale ? (
              "Use this card"
            ) : (
              "Save card"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
