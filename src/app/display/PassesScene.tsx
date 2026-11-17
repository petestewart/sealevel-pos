"use client";

import { useCallback, useEffect, useState } from "react";

import { plainText } from "@/lib/richtext";
import { classesLeft, type PassesPayload } from "@/lib/displaypasses";

/**
 * T242: "Your passes", as the student sees it.
 *
 * The roster's "Pay and check in" dialog opened on this student's own
 * passes, and the teacher's iPad put the same list here: each pass's
 * name, classes left and expiry, with a 64px "Use this pass". A tap
 * sends the scene's request id and the pass's opaque KEY to
 * `/api/display/pass`, which checks the key against the offer the server
 * stored and tells the teacher's iPad; that iPad assigns the pass and
 * checks the student in. Nobody waits on the student: the teacher may
 * tap first, and then this screen simply reads "One moment" and "Done".
 *
 * THIS COMPONENT WRITES NOTHING to Mindbody and holds no id: the keys
 * were made for this scene and mean nothing anywhere else. Every name
 * goes through plainText, never dangerouslySetInnerHTML.
 */

function expiryWords(day: string | null): string | null {
  if (day === null) return null;
  const at = new Date(`${day}T12:00:00`);
  if (Number.isNaN(at.getTime())) return null;
  return `expires ${at.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}`;
}

export default function PassesScene(props: {
  requestId: string;
  payload: PassesPayload;
}) {
  const { requestId, payload } = props;
  const name = plainText(payload.clientFirstName ?? "");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* A new version of the scene (the teacher's iPad moved it on) clears a
   * tap in flight and any refusal. */
  useEffect(() => {
    setBusyKey(null);
    setError(null);
  }, [requestId, payload.mode]);

  const use = useCallback(
    async (key: string) => {
      if (busyKey !== null) return;
      setBusyKey(key);
      setError(null);
      try {
        const res = await fetch("/api/display/pass", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, key }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setBusyKey(null);
          setError(
            typeof body?.error === "string" && body.error
              ? body.error
              : "That did not go through. Please tell the front desk.",
          );
        }
        /* On success the scene moves to "One moment" on the stream. */
      } catch {
        setBusyKey(null);
        setError("That did not go through. Please tell the front desk.");
      }
    },
    [busyKey, requestId],
  );

  if (payload.mode === "working" || payload.mode === "done") {
    const pass = plainText(payload.passName ?? "");
    return (
      <div className="dticket dpasses-status" role="status">
        <h1 className="dticket-heading">
          {payload.mode === "done" ? "Done" : "One moment"}
        </h1>
        <p className="dpasses-lead">
          {payload.mode === "done"
            ? pass.length > 0
              ? `You are checked in with ${pass}. Enjoy your class.`
              : "You are checked in. Enjoy your class."
            : pass.length > 0
              ? `Checking you in with ${pass}.`
              : "Checking you in."}
        </p>
      </div>
    );
  }

  if (payload.mode === "help") {
    return (
      <div className="dticket dpasses-status" role="status">
        <h1 className="dticket-heading">Please see the front desk</h1>
        <p className="dpasses-lead">They will finish checking you in.</p>
      </div>
    );
  }

  return (
    <div className="dticket">
      <h1 className="dticket-heading">
        {name.length > 0 ? `${name}, your passes` : "Your passes"}
      </h1>
      <p className="dpasses-lead">
        Use one of your passes for this class, or the front desk can sell you
        a different one.
      </p>
      <ul className="dpasses-list">
        {payload.passes.map((p) => {
          const facts = [classesLeft(p.remaining), expiryWords(p.expires)]
            .filter(Boolean)
            .join(", ");
          return (
            <li key={p.key} className="dpasses-pass">
              <span className="dpasses-text">
                <span className="dpasses-name">{plainText(p.name)}</span>
                {facts.length > 0 ? (
                  <span className="dpasses-facts">{facts}</span>
                ) : null}
              </span>
              <button
                className="dscene-btn dscene-go dpasses-use"
                disabled={busyKey !== null}
                onClick={() => void use(p.key)}
              >
                {busyKey === p.key ? "One moment" : "Use this pass"}
              </button>
            </li>
          );
        })}
      </ul>
      {error !== null ? (
        <p className="dticket-error" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
