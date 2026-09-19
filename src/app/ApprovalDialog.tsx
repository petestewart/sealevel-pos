"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { APPROVE_PURPOSE, isPinShape, PIN_MAX, PIN_MIN } from "@/lib/comp";

/**
 * T203 (Phase 2.5 item 4), the D1 override: "Approve sale", beside
 * "Waiting for the customer to approve".
 *
 * Pete, answering D1: "Teacher override, they must enter their PIN". So
 * this is T48's authorization and nothing new: one step, the signed-in
 * teacher's own PIN, checked by /api/teacher/verify with purpose
 * "approve", and the one-shot token that comes back is what the sale
 * hands to /api/checkout. The route verifies the purpose and that the
 * token names the teacher whose session is behind the tap (the T94
 * rule), spends it once, and files the override on the client with their
 * name (T45/T62). No reason is asked for: the design's sentence is fixed
 * ("customer screen not used"), and a teacher standing in front of
 * somebody whose screen just died should be asked for as little as the
 * record allows.
 *
 * Nothing here charges, and nothing here decides whether a write reaches
 * Mindbody: the setting is enforced on the server, and this only carries
 * an authorization to it.
 */

export interface ApprovalArmed {
  teacher: { id: number; name: string };
  token: string;
}

export default function ApprovalDialog(props: {
  /** Why the screen could not be used, in the teacher's own words, so
   *  they read what they are standing in for. */
  because: string;
  onCancel: () => void;
  onArmed: (armed: ApprovalArmed) => void;
}) {
  const { because, onCancel, onArmed } = props;
  const [pin, setPin] = useState("");
  const pinRef = useRef("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [shake, setShake] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [lockedUntil]);
  const lockedFor = Math.max(0, Math.ceil((lockedUntil - now) / 1000));

  const tap = useCallback((key: string) => {
    if (busyRef.current) return;
    setMsg(null);
    const next =
      key === "back"
        ? pinRef.current.slice(0, -1)
        : pinRef.current.length >= PIN_MAX
          ? pinRef.current
          : pinRef.current + key;
    pinRef.current = next;
    setPin(next);
  }, []);

  const submit = useCallback(async () => {
    const digits = pinRef.current;
    if (busyRef.current || !isPinShape(digits)) return;
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/teacher/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* The PURPOSE is signed into the token (T94 review), so a PIN
         * typed here approves a sale and authorizes nothing else. */
        body: JSON.stringify({ pin: digits, purpose: APPROVE_PURPOSE }),
      });
      const body = await res.json().catch(() => ({}));
      pinRef.current = "";
      setPin("");
      if (
        res.ok &&
        body?.ok === true &&
        typeof body?.teacher?.id === "number" &&
        typeof body?.token === "string" &&
        body.token.length > 0
      ) {
        onArmed({
          teacher: { id: body.teacher.id, name: String(body.teacher.name ?? "") },
          token: body.token,
        });
        return;
      }
      if (res.status === 429) {
        const secs = Number(body?.retryAfterSeconds ?? 30);
        setLockedUntil(Date.now() + (Number.isFinite(secs) ? secs : 30) * 1000);
        setNow(Date.now());
      } else if (res.status === 401) {
        setMsg(
          typeof body?.error === "string" ? body.error : "That is not your PIN.",
        );
        setShake((g) => g + 1);
      } else {
        setMsg(
          typeof body?.error === "string"
            ? body.error
            : "Could not check that PIN. Try again.",
        );
      }
    } catch {
      pinRef.current = "";
      setPin("");
      setMsg("Could not reach the server. Try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onArmed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      if (/^[0-9]$/.test(e.key)) tap(e.key);
      else if (e.key === "Backspace") tap("back");
      else if (e.key === "Enter") void submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, tap, submit]);

  const scrimDown = useRef(false);
  return (
    <div
      className="modal-scrim"
      role="presentation"
      onPointerDown={(e) => {
        scrimDown.current = e.target === e.currentTarget;
      }}
      onClick={() => {
        const down = scrimDown.current;
        scrimDown.current = false;
        if (down && !busy) onCancel();
      }}
    >
      <div
        className="modal modal-sale modal-amount modal-reason"
        role="dialog"
        aria-modal="true"
        aria-label="Approve this sale yourself"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="modal-title">Approve this sale yourself</p>
        <p className="reason-sub">{because} Enter your PIN.</p>
        <p className="reason-note muted-note">
          Your name goes on the sale as the person who approved it.
        </p>
        <div
          key={`dots-${shake}`}
          className={
            msg !== null && lockedFor === 0 && pin === ""
              ? "lock-dots pin-dots shake"
              : "lock-dots pin-dots"
          }
          aria-label={`${pin.length} digits entered`}
        >
          {Array.from({ length: PIN_MAX }).map((_, i) => (
            <span
              key={i}
              className={i < pin.length ? "lock-dot" : "lock-dot empty"}
            />
          ))}
        </div>
        {lockedFor > 0 ? (
          <p className="lock-msg">Too many attempts. Try again in {lockedFor}s.</p>
        ) : msg ? (
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
              disabled={busy || lockedFor > 0}
              onClick={() => tap(k)}
            >
              {k}
            </button>
          ))}
          <button
            className="pad-key"
            aria-label="Delete last digit"
            disabled={busy || lockedFor > 0}
            onClick={() => tap("back")}
          >
            &#9003;
          </button>
          <button
            className="pad-key"
            disabled={busy || lockedFor > 0}
            onClick={() => tap("0")}
          >
            0
          </button>
          <span aria-hidden="true" />
        </div>
        <div className="modal-actions">
          <button className="modal-cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="modal-confirm go"
            disabled={busy || lockedFor > 0 || pin.length < PIN_MIN}
            title={
              pin.length < PIN_MIN
                ? `Enter ${PIN_MIN} to ${PIN_MAX} digits`
                : "Check this PIN"
            }
            onClick={() => void submit()}
          >
            {busy ? "Checking..." : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
