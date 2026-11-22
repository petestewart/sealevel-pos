"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * T227: "Connect card reader" (Pete: make reconnecting easy for a
 * teacher). Asks the server for a Square device code and shows it large
 * with a five minute countdown; the teacher types it on the Terminal's
 * sign-in page under "Device Code" (NOT "Sign in", which is Square's own
 * POS app). The screen polls until the Terminal is paired, then says so.
 * An expired code offers a new one. Any signed-in teacher; the server
 * logs who.
 */
export default function ReaderPair({
  open,
  onClose,
  onPaired,
}: {
  open: boolean;
  onClose: () => void;
  onPaired?: () => void;
}) {
  const [code, setCode] = useState<{ id: string; code: string; pairBy: number } | null>(null);
  const [state, setState] = useState<"asking" | "waiting" | "paired" | "expired" | "error">("asking");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [tail, setTail] = useState<string | null>(null);
  const live = useRef(true);

  const ask = useCallback(async () => {
    setState("asking");
    setError(null);
    setCode(null);
    try {
      const res = await fetch("/api/reader/pair", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || typeof body?.code !== "string") {
        setError(String(body?.error ?? `HTTP ${res.status}`));
        setState("error");
        return;
      }
      setCode({
        id: String(body.id),
        code: body.code,
        pairBy: body.pairBy ? Date.parse(body.pairBy) : Date.now() + 5 * 60_000,
      });
      setState("waiting");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, []);

  useEffect(() => {
    live.current = open;
    if (open) void ask();
    return () => {
      live.current = false;
    };
  }, [open, ask]);

  useEffect(() => {
    if (!open || state !== "waiting" || code === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/reader/pair?id=${encodeURIComponent(code.id)}`);
        const body = await res.json().catch(() => null);
        if (!live.current) return;
        if (body?.paired === true) {
          setTail(typeof body.deviceTail === "string" ? body.deviceTail : null);
          setState("paired");
          onPaired?.();
        } else if (body?.status === "EXPIRED") {
          setState("expired");
        }
      } catch {
        /* The next poll asks again. */
      }
    }, 2000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [open, state, code, onPaired]);

  if (!open) return null;
  const left = code === null ? 0 : Math.max(0, Math.round((code.pairBy - now) / 1000));
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal" role="dialog" aria-label="Connect card reader">
        <div className="modal-head">
          <p className="modal-kicker">Card reader</p>
          <p className="modal-title">Connect card reader</p>
        </div>
        {state === "asking" ? <p className="reason-sub">Getting a code from Square.</p> : null}
        {state === "waiting" && code !== null ? (
          <>
            <p className="reason-sub">
              On the Square Terminal&apos;s sign-in screen, tap <strong>Device Code</strong> (not
              &quot;Sign in&quot;) and type:
            </p>
            <p className="reader-code" aria-label={`Code ${code.code.split("").join(" ")}`}>
              {code.code}
            </p>
            <p className="reader-countdown">
              {left > 0 ? `Expires in ${mmss}` : "Expired. Get a new code."}
            </p>
          </>
        ) : null}
        {state === "paired" ? (
          <p className="reader-paired" role="status">
            Card reader connected{tail ? ` (ending ${tail})` : ""}.
          </p>
        ) : null}
        {state === "expired" ? (
          <p className="reason-note">That code expired before it was used.</p>
        ) : null}
        {state === "error" ? <p className="reason-note">{error}</p> : null}
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>
            {state === "paired" ? "Done" : "Close"}
          </button>
          {state === "expired" || state === "error" || (state === "waiting" && left === 0) ? (
            <button className="modal-confirm go" onClick={() => void ask()}>
              New code
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
