"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The lock screen (T21). When POS_PIN is set and the browser has no valid
 * session, this is ALL the page renders: the studio name, the mode banner,
 * and a PIN pad. Nothing secret lives here: the client only POSTs whatever
 * was typed to /api/login and reacts to the status code. The PIN, its
 * hash, and the comparison all stay on the server.
 *
 * Same visual system as the payment mockup's cash keypad: 64px keys, token
 * colours in both palettes, nothing under 16px. Submit is the explicit
 * Unlock button (or Enter): PIN length varies, so there is no
 * auto-submit-at-N.
 */

/** What the mode banner needs, from /api/config's trimmed pre-auth shape. */
interface LockConfig {
  dryRun: boolean;
  target: string;
  banner: string | null;
}

export default function LockScreen() {
  const [config, setConfig] = useState<LockConfig | null>(null);
  const [pin, setPin] = useState("");
  /** Quiet failure line under the dots: wrong PIN, or the lockout. */
  const [message, setMessage] = useState<string | null>(null);
  /** Bumped on a wrong PIN so the dots replay their shake. */
  const [shakeGen, setShakeGen] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  /** Epoch ms until which the server refuses attempts, for the countdown. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) =>
        setConfig({
          dryRun: d.dryRun === true,
          target: typeof d.target === "string" ? d.target : "sandbox",
          banner: typeof d.banner === "string" ? d.banner : null,
        }),
      )
      .catch(() => setConfig(null));
  }, []);

  /* Tick once a second while locked out, so the countdown moves. */
  useEffect(() => {
    if (lockedUntil === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lockedUntil]);

  const lockedFor =
    lockedUntil !== null ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;

  const press = useCallback((digit: string) => {
    if (submittingRef.current) return;
    setMessage(null);
    setPin((p) => (p.length >= 12 ? p : p + digit));
  }, []);

  const backspace = useCallback(() => {
    if (submittingRef.current) return;
    setMessage(null);
    setPin((p) => p.slice(0, -1));
  }, []);

  const submit = useCallback(async () => {
    const entered = pinRef.current;
    if (submittingRef.current || entered.length === 0) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: entered }),
      });
      if (res.ok) {
        /* The cookie is set; reload into the app so every fetch starts
         * over with a session rather than resuming half-loaded state. */
        window.location.reload();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setPin("");
      if (res.status === 429) {
        const secs = Number(body?.retryAfterSeconds ?? 30);
        setLockedUntil(Date.now() + (Number.isFinite(secs) ? secs : 30) * 1000);
        setNow(Date.now());
        setMessage(null);
      } else {
        setMessage("Wrong PIN.");
        setShakeGen((g) => g + 1);
      }
    } catch {
      setPin("");
      setMessage("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }, []);

  /* Physical keyboard support, for a dev machine or a paired keyboard. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") backspace();
      else if (e.key === "Enter") void submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, backspace, submit]);

  return (
    <main className="shell lock-shell">
      {/* T70: the banners sit at the top of the screen, full width, like
          the roster's and the staff gate's; the card stays centred. */}
      <div className="lock-banners">
        {config ? (
          <p className={config.dryRun ? "banner" : "banner live"}>
            {config.dryRun
              ? "Dry run. Nothing is written to Mindbody."
              : "LIVE. Taps check real students in."}{" "}
            {config.target === "prod" ? "Production" : "Sandbox"} site.
          </p>
        ) : null}
        {config?.banner ? <p className="studio-banner">{config.banner}</p> : null}
      </div>

      <div className="lock-card">
        <p className="lock-kicker">Front desk</p>
        <h1 className="lock-title">Sealevel Hot Yoga</h1>
        <p className="lock-sub">Enter the counter PIN to unlock.</p>

        <div
          key={`dots-${shakeGen}`}
          className={message === "Wrong PIN." ? "lock-dots shake" : "lock-dots"}
          aria-label={`${pin.length} digits entered`}
        >
          {pin.length === 0 ? (
            <span className="lock-dots-empty">PIN</span>
          ) : (
            Array.from(pin).map((_, i) => (
              <span key={i} className="lock-dot" />
            ))
          )}
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
              disabled={submitting || lockedFor > 0}
              onClick={() => press(d)}
            >
              {d}
            </button>
          ))}
          <span aria-hidden="true" />
          <button
            className="key"
            disabled={submitting || lockedFor > 0}
            onClick={() => press("0")}
          >
            0
          </button>
          <button
            className="key back"
            aria-label="Delete last digit"
            disabled={submitting || lockedFor > 0}
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

        <button
          className="lock-unlock"
          disabled={submitting || lockedFor > 0 || pin.length === 0}
          onClick={() => void submit()}
        >
          {submitting ? "Checking..." : "Unlock"}
        </button>
      </div>
    </main>
  );
}
