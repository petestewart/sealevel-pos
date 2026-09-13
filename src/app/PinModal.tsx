"use client";

import { useEffect, useState } from "react";

import { isPinShape, PIN_MAX, PIN_MIN } from "@/lib/comp";

import type { Teacher } from "./StaffModal";

/**
 * Choosing a comp PIN with no password (T80). Pete: "when a teacher
 * first signs in, if they have not set up a PIN they should be prompted
 * to do so", and "when they create their PIN there should be an
 * additional box to re-enter and verify the new PIN".
 *
 * Two places open this one box. Right after a sign-in whose answer said
 * `hasPin: false`, page.tsx puts it up BEFORE the roster, so a teacher
 * who will need a PIN at the first comp of the shift has one; and the
 * account modal opens it as "Set up PIN" or "Change PIN". Both post to
 * /api/teacher/pin, which takes no username and no password: the
 * teacher signed in with their Mindbody login moments ago and the token
 * is in the staff session, which is the proof. The comp dialog's own
 * enrollment form (SaleScreen, T48) still asks for the login, because
 * it can be reached with the session gone.
 *
 * The PIN is typed twice and Save stays disabled until both boxes hold
 * the same 4 to 6 digits; the quiet line says so while they differ. The
 * server checks the match again, since this check is a convenience. Both
 * boxes are cleared whenever the box closes, so a PIN never sits in
 * state behind a modal nobody is looking at.
 *
 * "Not now" is the way past: the prompt is a prompt, not a second gate.
 * It comes back at the next sign-in, and a teacher can always reach it
 * from the account modal.
 */
export default function PinModal({
  open,
  teacher,
  mode,
  dismissLabel = "Not now",
  onClose,
  onDone,
}: {
  open: boolean;
  teacher: Teacher;
  /** "set": no PIN yet (the sign-in prompt). "change": replacing one. */
  mode: "set" | "change";
  /** The quiet exit's words. "Not now" for the prompt, "Cancel" when it
   *  was opened deliberately from the account modal. */
  dismissLabel?: string;
  onClose: () => void;
  /** The PIN was stored. The caller closes the box and says so. */
  onDone: () => void;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  /* Each opening starts empty, and nothing is left behind on close. */
  useEffect(() => {
    if (open) {
      setPin("");
      setConfirm("");
      setMsg(null);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const digits = (v: string) => v.replace(/\D/g, "").slice(0, PIN_MAX);
  const matches = pin.length > 0 && pin === confirm;
  const mismatch = pin.length > 0 && confirm.length > 0 && pin !== confirm;
  const valid = isPinShape(pin) && matches;

  const save = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/teacher/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin, confirm }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok === true) {
        /* Out of state before anything else happens. */
        setPin("");
        setConfirm("");
        onDone();
        return;
      }
      if (res.status === 429) {
        const secs = Number(body?.retryAfterSeconds ?? 30);
        setMsg(
          `Too many attempts. Try again in ${Number.isFinite(secs) ? secs : 30}s.`,
        );
        return;
      }
      setMsg(
        typeof body?.error === "string" && body.error
          ? body.error
          : "Could not set that PIN. Try again.",
      );
    } catch {
      setMsg("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-staff"
        role="dialog"
        aria-label={mode === "set" ? "Set up your PIN" : "Change your PIN"}
      >
        <div className="modal-head">
          <p className="modal-kicker">Comps and discounts</p>
          <p className="modal-title">
            {mode === "set" ? "Set up your PIN" : "Change your PIN"}
          </p>
        </div>
        <p className="reason-sub">
          Signed in as {teacher.name}. Choose a{mode === "set" ? "" : " new"}{" "}
          PIN of {PIN_MIN} to {PIN_MAX} digits for discounts and comps. You
          will type it at the counter, so make it one you can remember and
          nobody can guess.
        </p>
        <input
          className="reason-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          maxLength={PIN_MAX}
          placeholder={`New PIN (${PIN_MIN} to ${PIN_MAX} digits)`}
          aria-label="New PIN"
          value={pin}
          disabled={busy}
          onChange={(e) => setPin(digits(e.target.value))}
        />
        <input
          className="reason-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={PIN_MAX}
          placeholder="Re-enter PIN"
          aria-label="Re-enter PIN"
          value={confirm}
          disabled={busy}
          onChange={(e) => setConfirm(digits(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        {mismatch ? <p className="reason-note">PINs do not match</p> : null}
        {msg ? <p className="lock-msg">{msg}</p> : null}
        <div className="modal-actions">
          <button className="modal-cancel" disabled={busy} onClick={onClose}>
            {dismissLabel}
          </button>
          <button
            className="modal-confirm go"
            disabled={!valid || busy}
            title={valid ? "Save this PIN" : "Type the same PIN in both boxes"}
            onClick={() => void save()}
          >
            {busy ? "Saving..." : "Save PIN"}
          </button>
        </div>
      </div>
    </div>
  );
}
