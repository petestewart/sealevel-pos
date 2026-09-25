"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { isPinShape, PIN_MAX, PIN_MIN } from "@/lib/comp";
import {
  waiverOverrideTitle,
  waiverReasonValid,
  WAIVER_PURPOSE,
  WAIVER_REASON_MAX,
  type WaiverFlow,
} from "@/lib/waiveroverride";

/**
 * T211: the third way out of the waiver gate.
 *
 * Pete, 2026-09-21: "a teacher should be able to override with their PIN
 * and must give a reason. make sure this is doable if there is an error,
 * that would probably be the main reason to do so."
 *
 * So this is T48's authorization and nothing new: the signed-in
 * teacher's own PIN, checked by /api/teacher/verify with the purpose
 * "waiver", plus a REQUIRED reason in their own words. The one-shot
 * token that comes back is what the write route verifies, spends and
 * files on the client with the reason beside it.
 *
 * TWO things are asked for, and the confirm arms only with both. The
 * reason is a text field, which is the T43/T48 precedent of the
 * discount pad's note and NOT a breach of the no-typed-amounts rule: it
 * is a sentence, not money. The PIN is the pad, digits only, exactly as
 * every other PIN in this app.
 *
 * Nothing here writes. It carries an authorization to the route that
 * does, and the gate itself, the student's release and the waiver
 * receipt are all untouched: an override lets ONE write past, it does
 * not sign anybody's waiver.
 */

export interface WaiverOverrideArmed {
  teacher: { id: number; name: string };
  token: string;
  reason: string;
}

export default function WaiverOverrideDialog(props: {
  /** Which gated flow this is for, so the title names the act. */
  flow: WaiverFlow;
  /** The student it is about, for the line under the title. */
  name: string;
  onCancel: () => void;
  onArmed: (armed: WaiverOverrideArmed) => void;
}) {
  const { flow, name, onCancel, onArmed } = props;
  const [pin, setPin] = useState("");
  const pinRef = useRef("");
  const [reason, setReason] = useState("");
  const reasonRef = useRef("");
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
    const why = reasonRef.current.trim();
    /* Both, every time: a PIN with no reason is not an override, and a
     * reason with no PIN authorizes nothing. */
    if (busyRef.current || !isPinShape(digits) || !waiverReasonValid(why)) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/teacher/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* The PURPOSE is signed into the token (T94 review), so a PIN
         * typed here goes past a waiver and authorizes nothing else. */
        body: JSON.stringify({ pin: digits, purpose: WAIVER_PURPOSE }),
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
          teacher: {
            id: body.teacher.id,
            name: String(body.teacher.name ?? ""),
          },
          token: body.token,
          reason: why,
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
        /* While the PIN is being checked, Escape does what the Cancel
         * button does, which is nothing: the verify is in flight and
         * closing here would leave onArmed to fire into a dialog the
         * teacher had already backed out of, running the write they
         * just abandoned. */
        if (!busyRef.current) onCancel();
        return;
      }
      /* The reason field is a real text field: while it has the focus
         the digits and Backspace belong to it, not to the pad. */
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
      if (/^[0-9]$/.test(e.key)) tap(e.key);
      else if (e.key === "Backspace") tap("back");
      else if (e.key === "Enter") void submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, tap, submit]);

  const reasonOk = waiverReasonValid(reason);
  const scrimDown = useRef(false);
  const title = waiverOverrideTitle(flow);
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
        className="modal modal-sale modal-amount modal-reason modal-waiver-override"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="modal-kicker">Teacher override</p>
        <p className="modal-title">{title}</p>
        <p className="reason-sub">
          The student has not signed the waiver. Your PIN and a reason are
          recorded on their profile.
        </p>
        <p className="reason-note muted-note">{name}</p>
        <label className="wo-label" htmlFor="waiver-override-reason">
          Reason
        </label>
        <textarea
          id="waiver-override-reason"
          className="reason-input reason-note-field"
          rows={2}
          maxLength={WAIVER_REASON_MAX}
          disabled={busy}
          placeholder="Why are you going ahead without it?"
          value={reason}
          onChange={(e) => {
            reasonRef.current = e.target.value;
            setReason(e.target.value);
          }}
        />
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
            disabled={
              busy || lockedFor > 0 || pin.length < PIN_MIN || !reasonOk
            }
            title={
              !reasonOk
                ? "Write a reason first"
                : pin.length < PIN_MIN
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
