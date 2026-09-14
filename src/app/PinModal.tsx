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
 * The PIN is entered twice on the counter's own pad (the discount
 * dialog's dots and keys, T48), never in a password field: on the iPad
 * a password field brought up Safari's password manager over the
 * keyboard, and a new teacher could not type a digit (Pete: "A new user
 * is unable to input their PIN for the first time"). Stage one takes
 * the PIN and Next; stage two takes it again, and when the second entry
 * reaches the first's length it is checked: a match saves, a mismatch
 * says so and clears the second entry. The server checks the match
 * again, since this check is a convenience. Everything is cleared
 * whenever the box closes, so a PIN never sits in state behind a modal
 * nobody is looking at.
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
  const [stage, setStage] = useState<"enter" | "confirm">("enter");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [shake, setShake] = useState(0);

  /* Each opening starts empty, and nothing is left behind on close. */
  useEffect(() => {
    if (open) {
      setPin("");
      setConfirm("");
      setStage("enter");
      setMsg(null);
      setBusy(false);
    }
  }, [open]);

  const save = async (first: string, second: string) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/teacher/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: first, confirm: second }),
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
      } else {
        setMsg(
          typeof body?.error === "string" && body.error
            ? body.error
            : "Could not set that PIN. Try again.",
        );
      }
      /* Back to the first stage with nothing kept: a refused PIN (taken
       * by another teacher, most likely) needs a different one. */
      setPin("");
      setConfirm("");
      setStage("enter");
    } catch {
      setMsg("Could not reach the server. Try again.");
      setConfirm("");
    } finally {
      setBusy(false);
    }
  };

  /** A key on the pad, or the keyboard standing in for it. */
  const tap = (key: string) => {
    if (busy) return;
    setMsg(null);
    if (stage === "enter") {
      setPin((cur) =>
        key === "back" ? cur.slice(0, -1) : cur.length >= PIN_MAX ? cur : cur + key,
      );
      return;
    }
    const next =
      key === "back"
        ? confirm.slice(0, -1)
        : confirm.length >= PIN_MAX
          ? confirm
          : confirm + key;
    setConfirm(next);
    if (key !== "back" && next.length === pin.length) {
      if (next === pin) {
        void save(pin, next);
      } else {
        setMsg("PINs do not match. Enter it again.");
        setShake((n) => n + 1);
        setConfirm("");
      }
    }
  };

  const toConfirm = () => {
    if (busy || !isPinShape(pin)) return;
    setMsg(null);
    setConfirm("");
    setStage("confirm");
  };

  const backToEnter = () => {
    if (busy) return;
    setMsg(null);
    setConfirm("");
    setStage("enter");
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        tap(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        tap("back");
      } else if (e.key === "Enter" && stage === "enter") {
        e.preventDefault();
        toConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;

  const entered = stage === "enter" ? pin : confirm;

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
          {stage === "enter"
            ? `Signed in as ${teacher.name}. Choose a${mode === "set" ? "" : " new"} PIN of ${PIN_MIN} to ${PIN_MAX} digits for discounts and comps: one you can remember and nobody can guess.`
            : "Enter the same PIN again."}
        </p>
        <div
          key={`dots-${stage}-${shake}`}
          className={shake > 0 && entered === "" && msg !== null ? "lock-dots pin-dots shake" : "lock-dots pin-dots"}
          aria-label={`${entered.length} digits entered`}
        >
          {Array.from({ length: PIN_MAX }).map((_, i) => (
            <span
              key={i}
              className={i < entered.length ? "lock-dot" : "lock-dot empty"}
            />
          ))}
        </div>
        {msg ? (
          <p className="lock-msg">{msg}</p>
        ) : (
          <p className="lock-msg lock-msg-empty" aria-hidden="true">
            &nbsp;
          </p>
        )}
        <div className="pad-keys">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => (
            <button
              key={k}
              className="pad-key"
              disabled={busy}
              onClick={() => tap(k)}
            >
              {k}
            </button>
          ))}
          <button
            className="pad-key"
            aria-label="Delete last digit"
            disabled={busy}
            onClick={() => tap("back")}
          >
            &#9003;
          </button>
          <button className="pad-key" disabled={busy} onClick={() => tap("0")}>
            0
          </button>
          <span aria-hidden="true" />
        </div>
        <div className="modal-actions">
          <button
            className="modal-cancel"
            disabled={busy}
            onClick={stage === "enter" ? onClose : backToEnter}
          >
            {stage === "enter" ? dismissLabel : "Back"}
          </button>
          {stage === "enter" ? (
            <button
              className="modal-confirm go"
              disabled={!isPinShape(pin) || busy}
              title={
                isPinShape(pin)
                  ? "Next: enter it again"
                  : `Enter ${PIN_MIN} to ${PIN_MAX} digits`
              }
              onClick={toConfirm}
            >
              Next
            </button>
          ) : (
            <button
              className="modal-confirm go"
              disabled={busy || confirm.length < PIN_MIN || confirm !== pin}
              title={
                confirm === pin ? "Save this PIN" : "Enter the same PIN again"
              }
              onClick={() => void save(pin, confirm)}
            >
              {busy ? "Saving..." : "Save PIN"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
