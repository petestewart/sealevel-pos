"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The sign-up tray (T204, Phase 2.5 item 5).
 *
 * A student who tapped "New here? Sign up" on the customer screen is
 * not in Mindbody yet: their typed form and their signature are waiting
 * on the server, and the teacher meets them HERE, at a moment of their
 * own choosing, rather than by waiting on a result. So this is a count
 * in the header ("2 signed up") in the `--gold` role, which is badges
 * and counts, and one tap opens the list.
 *
 * Two sources, like the display mark beside it: the teacher's own SSE
 * stream, which is what makes it immediate, and a 30 second poll, which
 * is what makes it right when the stream is refused (nobody signed in)
 * or dropped. Neither calls Mindbody.
 *
 * The list holds NAMES and a moment. The email, the phone and the
 * signature are never in it: they are served, once, to the form the
 * teacher opens by tapping a name.
 */

export interface PendingSignupRow {
  requestId: string;
  firstName: string;
  lastName: string;
  completedAt: string | null;
}

/** "3 minutes ago", roughly, which is all a teacher wants of it. */
export function ago(iso: string | null): string {
  if (iso === null) return "just now";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export default function SignupTray(props: {
  /** Bumped by the page when a sign-up has been created or cleared, so
   *  the badge does not wait for the next poll to be right. */
  refreshKey: number;
  onPick: (row: PendingSignupRow) => void;
}) {
  const { refreshKey, onPick } = props;
  const [rows, setRows] = useState<PendingSignupRow[]>([]);
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const alive = useRef(true);

  const read = useCallback(() => {
    fetch("/api/display/signups")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!alive.current || !body || !Array.isArray(body.signups)) return;
        setRows(body.signups as PendingSignupRow[]);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    read();
    const timer = setInterval(read, 30_000);
    return () => clearInterval(timer);
  }, [read, refreshKey]);

  /* The stream: a `signups` event carries the count and the names, and
   * a `completed` for a register request is the same news arriving by
   * another door. Neither carries a result. */
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const open2 = () => {
      if (stopped) return;
      try {
        source = new EventSource("/api/display/events");
      } catch {
        return;
      }
      source.addEventListener("signups", (ev) => {
        try {
          const data: unknown = JSON.parse((ev as MessageEvent).data);
          if (
            data !== null &&
            typeof data === "object" &&
            Array.isArray((data as Record<string, unknown>).signups)
          ) {
            setRows(
              (data as { signups: PendingSignupRow[] }).signups.filter(
                (r) => typeof r?.requestId === "string",
              ),
            );
            return;
          }
        } catch {
          /* An unreadable event still means something changed. */
        }
        read();
      });
      source.addEventListener("completed", (ev) => {
        try {
          const data: unknown = JSON.parse((ev as MessageEvent).data);
          if (
            data !== null &&
            typeof data === "object" &&
            (data as Record<string, unknown>).kind === "register"
          ) {
            read();
          }
        } catch {
          read();
        }
      });
      source.addEventListener("error", () => {
        source?.close();
        source = null;
        if (!stopped && retry === null) {
          retry = setTimeout(() => {
            retry = null;
            open2();
          }, 15_000);
        }
      });
    };
    open2();
    return () => {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      source?.close();
    };
  }, [read]);

  const clear = async (requestId: string) => {
    setClearing(requestId);
    try {
      await fetch(`/api/display/signups/${encodeURIComponent(requestId)}`, {
        method: "DELETE",
      });
    } catch {
      /* The poll below is the truth either way. */
    }
    setClearing(null);
    setConfirming(null);
    setRows((prev) => prev.filter((r) => r.requestId !== requestId));
    read();
  };

  if (rows.length === 0) return null;

  return (
    <div className="signup-tray">
      <button
        className="signup-badge"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setConfirming(null);
        }}
      >
        {rows.length} signed up
      </button>
      {open ? (
        <div className="signup-list" role="group" aria-label="Signed up on the customer screen">
          <p className="signup-list-head">
            Signed up on the customer screen, not created yet.
          </p>
          <ul className="signup-rows">
            {rows.map((row) => (
              <li key={row.requestId} className="signup-row">
                <button
                  className="signup-name"
                  onClick={() => {
                    setOpen(false);
                    setConfirming(null);
                    onPick(row);
                  }}
                >
                  <span className="signup-name-text">
                    {`${row.firstName} ${row.lastName}`.trim() || "(unnamed)"}
                  </span>
                  <span className="signup-when">{ago(row.completedAt)}</span>
                </button>
                <button
                  className={
                    confirming === row.requestId
                      ? "signup-clear confirming"
                      : "signup-clear"
                  }
                  disabled={clearing === row.requestId}
                  onClick={() => {
                    if (confirming === row.requestId) {
                      void clear(row.requestId);
                    } else {
                      setConfirming(row.requestId);
                    }
                  }}
                >
                  {confirming === row.requestId ? "Sure?" : "Clear"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
