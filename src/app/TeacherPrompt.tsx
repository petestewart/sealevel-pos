"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * "Who is at the counter?" (T44). A full-screen overlay in the lock
 * screen's idiom, shown after the device unlock (or straight away with
 * auth disabled) until a teacher has entered the last four digits of
 * their phone. Nothing secret lives here either: the four digits go to
 * /api/teacher/login and the answer is a name, a list of names to pick
 * from when two teachers share the digits, a 401, or the lockout.
 *
 * Four digits exactly, so the fourth submits; there is no Unlock button
 * to find. With POS_PIN set there is no way past this screen without a
 * name. With auth disabled a quiet "Continue without a name" exists for
 * dev, and the server lets unnamed writes through in that mode anyway.
 */

export interface TeacherIdentity {
  id: number;
  name: string;
}

/** GET /api/teacher's shape, minus the teacher itself. */
export interface TeacherInfo {
  required: boolean;
  pinsAvailable: number | null;
  noPhone: string[];
  staffError: string | null;
}

interface Props {
  info: TeacherInfo | null;
  onNamed: (teacher: TeacherIdentity) => void;
  /** Offered only when info.required is false. */
  onSkip: () => void;
}

const PIN_LENGTH = 4;

export default function TeacherPrompt({ info, onNamed, onSkip }: Props) {
  const [pin, setPin] = useState("");
  const [choices, setChoices] = useState<TeacherIdentity[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [shakeGen, setShakeGen] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /* Synchronous mirrors: the fourth digit submits from inside press, and
   * a second tap or a StrictMode double render must not post twice. */
  const pinRef = useRef("");
  const submittingRef = useRef(false);
  const onNamedRef = useRef(onNamed);
  onNamedRef.current = onNamed;

  useEffect(() => {
    if (lockedUntil === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lockedUntil]);

  const lockedFor =
    lockedUntil !== null ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;

  /** One post to the login route; `staffId` is the second post after a
   *  collision, naming one of the listed matches. */
  const submit = useCallback(async (digits: string, staffId?: number) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/teacher/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          staffId === undefined ? { pin: digits } : { pin: digits, staffId },
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok === true && body.teacher) {
        onNamedRef.current({
          id: Number(body.teacher.id),
          name: String(body.teacher.name),
        });
        return;
      }
      if (res.ok && Array.isArray(body?.choices) && body.choices.length > 0) {
        setChoices(
          body.choices.map((c: { id: number; name: string }) => ({
            id: Number(c.id),
            name: String(c.name),
          })),
        );
        return;
      }
      pinRef.current = "";
      setPin("");
      setChoices(null);
      if (res.status === 429) {
        const secs = Number(body?.retryAfterSeconds ?? 30);
        setLockedUntil(Date.now() + (Number.isFinite(secs) ? secs : 30) * 1000);
        setNow(Date.now());
      } else if (res.status === 401) {
        setMessage("No teacher has a phone ending in those digits.");
        setShakeGen((g) => g + 1);
      } else {
        setMessage(
          typeof body?.error === "string"
            ? body.error
            : "Could not check those digits. Try again.",
        );
      }
    } catch {
      pinRef.current = "";
      setPin("");
      setChoices(null);
      setMessage("Could not reach the server. Try again.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, []);

  const press = useCallback(
    (digit: string) => {
      if (submittingRef.current || choices !== null) return;
      setMessage(null);
      if (pinRef.current.length >= PIN_LENGTH) return;
      const next = pinRef.current + digit;
      pinRef.current = next;
      setPin(next);
      if (next.length === PIN_LENGTH) void submit(next);
    },
    [choices, submit],
  );

  const backspace = useCallback(() => {
    if (submittingRef.current || choices !== null) return;
    setMessage(null);
    pinRef.current = pinRef.current.slice(0, -1);
    setPin(pinRef.current);
  }, [choices]);

  const startOver = useCallback(() => {
    if (submittingRef.current) return;
    setChoices(null);
    pinRef.current = "";
    setPin("");
    setMessage(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") backspace();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, backspace]);

  const keysOff = submitting || lockedFor > 0 || choices !== null;
  const required = info?.required !== false;

  return (
    <div
      className="teacher-shell"
      role="dialog"
      aria-modal="true"
      aria-label="Who is at the counter?"
    >
      <div className="lock-card teacher-card">
        <h1 className="lock-title">Who is at the counter?</h1>
        <p className="lock-sub">
          {choices !== null
            ? "More than one teacher has those digits. Tap your name."
            : "Enter the last four digits of your phone."}
        </p>

        {choices !== null ? (
          <div className="teacher-choices">
            {choices.map((c) => (
              <button
                key={c.id}
                className="teacher-choice"
                disabled={submitting}
                onClick={() => void submit(pin, c.id)}
              >
                {c.name}
              </button>
            ))}
            <button
              className="teacher-skip"
              disabled={submitting}
              onClick={startOver}
            >
              Not me, start over
            </button>
          </div>
        ) : (
          <>
            <div
              key={`dots-${shakeGen}`}
              className={
                message !== null && lockedFor === 0
                  ? "lock-dots teacher-dots shake"
                  : "lock-dots teacher-dots"
              }
              aria-label={`${pin.length} of ${PIN_LENGTH} digits entered`}
            >
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <span
                  key={i}
                  className={i < pin.length ? "lock-dot" : "lock-dot empty"}
                />
              ))}
            </div>

            {lockedFor > 0 ? (
              <p className="lock-msg">
                Too many attempts. Try again in {lockedFor}s.
              </p>
            ) : message ? (
              <p className="lock-msg">{message}</p>
            ) : (
              <p className="lock-msg lock-msg-empty" aria-hidden="true">
                &nbsp;
              </p>
            )}

            <div className="keypad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button
                  key={d}
                  className="key"
                  disabled={keysOff}
                  onClick={() => press(d)}
                >
                  {d}
                </button>
              ))}
              <span aria-hidden="true" />
              <button
                className="key"
                disabled={keysOff}
                onClick={() => press("0")}
              >
                0
              </button>
              <button
                className="key back"
                aria-label="Delete last digit"
                disabled={keysOff}
                onClick={backspace}
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
                  <path d="M18 9l-6 6" />
                  <path d="M12 9l6 6" />
                </svg>
              </button>
            </div>
          </>
        )}

        {/* The staff read failing is said plainly: "wrong digits" would
            send a teacher hunting through their own number. */}
        {info?.staffError ? (
          <p className="teacher-note stop">
            Could not read the staff list from Mindbody: {info.staffError}
          </p>
        ) : null}
        {info && info.noPhone.length > 0 ? (
          <p className="teacher-note">
            No phone on file in Mindbody for: {info.noPhone.join(", ")}
          </p>
        ) : null}
        {info && info.pinsAvailable === 0 && !info.staffError ? (
          <p className="teacher-note stop">
            No teacher has a phone number on file, so nobody can sign in
            here. Add one in Mindbody.
          </p>
        ) : null}

        {!required ? (
          <button
            className="teacher-skip"
            disabled={submitting}
            onClick={onSkip}
          >
            Continue without a name
          </button>
        ) : null}
      </div>
    </div>
  );
}
