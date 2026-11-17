"use client";

import { useState } from "react";

/**
 * "Reset customer screen" (T244, the stuck-screen hotfix). One piece,
 * drawn in two places: the header's customer display mark (the one a
 * deployed counter can reach, since the drawer needs POS_DEVTOOLS) and
 * the drawer's customer display section beside Pair and Unpair.
 *
 * It takes down whatever the customer screen shows and sends it back to
 * its welcome screen. The SERVER decides whether to ask first
 * (`/api/display/cancel` with `scope: "reset"`): a live ticket, a
 * post-sale summary or nothing goes at once; a sign-up, a waiver, a
 * contract or an approval answers 409 `reason: "confirm"` with the
 * question in words, asked here once. Nothing in it calls Mindbody, and
 * the route logs the teacher's staff id.
 */
export default function ResetDisplay(props: {
  /** Class for an ordinary control, and for the confirming one. */
  buttonClass: string;
  confirmClass: string;
  /** Told after a reset landed. */
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);

  const reset = async (confirm: boolean) => {
    setBusy(true);
    setLine(null);
    try {
      const res = await fetch("/api/display/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "reset", ...(confirm ? { confirm } : {}) }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 409 && body?.reason === "confirm") {
        setQuestion(String(body.error ?? "Clear the customer screen?"));
        return;
      }
      if (!res.ok) {
        setQuestion(null);
        setLine(String(body?.error ?? `That did not work (HTTP ${res.status}).`));
        return;
      }
      setQuestion(null);
      setLine("The customer screen is back to its welcome screen.");
      props.onDone?.();
    } catch {
      setLine("That did not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="display-reset">
      {question !== null ? (
        <>
          <p className="display-reset-question">{question}</p>
          <div className="display-reset-buttons">
            <button
              type="button"
              className={props.buttonClass}
              disabled={busy}
              onClick={() => setQuestion(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={props.confirmClass}
              disabled={busy}
              onClick={() => void reset(true)}
            >
              Clear it
            </button>
          </div>
        </>
      ) : (
        <div className="display-reset-buttons">
          <button
            type="button"
            className={props.buttonClass}
            disabled={busy}
            onClick={() => void reset(false)}
          >
            {busy ? "Resetting" : "Reset customer screen"}
          </button>
        </div>
      )}
      {line !== null ? (
        <p className="display-reset-line" role="status">
          {line}
        </p>
      ) : null}
    </div>
  );
}
