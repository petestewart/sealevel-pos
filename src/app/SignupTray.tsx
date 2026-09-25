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

/**
 * T207: a sign-up the automatic run could not finish, kept by the page
 * rather than the server. Two kinds, and the difference is whether a
 * client now EXISTS: a create that was refused leaves the request
 * waiting on the server (the row above carries the reason under the
 * name and tapping it opens the same prefilled form review mode would),
 * and a create that landed with a booking that did not leaves nothing on
 * the server at all, so the page keeps the row here and tapping it opens
 * the person's profile. Tapping must never offer Create for somebody
 * Mindbody already has.
 */
export interface StuckSignupRow {
  requestId: string;
  name: string;
  reason: string;
  /** The client the create made: the tap opens their profile. */
  clientId: string;
}

/** T207: one line about a sign-up that finished by itself, shown for a
 *  few seconds. It is the only thing a teacher sees of a create they did
 *  not tap, so it names the person, the class, and what happened. */
export interface SignupOutcome {
  id: string;
  text: string;
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
  /** T207: every list this tray reads, handed up so the page can run the
   *  automatic create against it. The tray's three sources (the stream's
   *  `signups` event, a `completed` register event, and the 30 second
   *  poll, which includes the read on mount and the connect replay) all
   *  come through here, so an iPad that was asleep catches up without a
   *  second mechanism. */
  onRows?: (rows: PendingSignupRow[]) => void;
  /** T207: why a name is still here, by request id. */
  reasons?: Record<string, string>;
  /**
   * T208: what the automatic run is doing with a name RIGHT NOW, by
   * request id: the words to show under it and the name itself. Pete,
   * second drive: "auto sign up does work, but there is a brief wait
   * between when the banner shows up and when they are signed in to
   * class. there should be a waiting spinner so the teacher knows it
   * didn't fail." A name with nothing under it for two seconds reads
   * exactly like a name that is stuck, and the badge keeps its count
   * throughout.
   *
   * The NAME rides along because the row has to outlive the server's
   * list (T208 review): the create spends the handle half way through
   * the run, and the `signups` event that follows drops the row while
   * the booking and the check-in are still going. A spinner that ends
   * before the run does is the thing this was built to prevent, so a
   * busy id the list no longer carries is still drawn, from here.
   */
  busy?: Record<string, { label: string; name: string }>;
  /** T208: which mode the counter is in, for the heading only. Nothing
   *  here decides what runs; the page does that. */
  mode?: "automatic" | "review";
  /** T207: rows the server no longer lists because the client WAS
   *  created, and the booking after it was not. */
  stuck?: StuckSignupRow[];
  onStuckPick?: (row: StuckSignupRow) => void;
  onStuckClear?: (requestId: string) => void;
  /** T207: what just happened, with no tap, for about ten seconds. */
  outcomes?: SignupOutcome[];
}) {
  const {
    refreshKey,
    onPick,
    onRows,
    reasons,
    busy,
    mode,
    stuck,
    onStuckPick,
    onStuckClear,
    outcomes,
  } = props;
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

  /* T207: every list, handed up. An effect rather than a call inside
   * `read`, so the page sees the rows the stream delivered too. */
  useEffect(() => {
    onRows?.(rows);
  }, [rows, onRows]);

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

  const stuckRows = stuck ?? [];
  const lines = outcomes ?? [];
  /* T208 review: the ones still running that the server has stopped
   * listing. They keep their place in the tray until the run resolves. */
  const held = Object.entries(busy ?? {})
    .filter(([id]) => !rows.some((r) => r.requestId === id))
    .map(([id, what]) => ({ requestId: id, ...what }));
  const waiting = rows.length + held.length + stuckRows.length;
  /* T207: the tray is also where a finished sign-up says so, so it
   * renders for an outcome line with nobody waiting. */
  if (waiting === 0 && lines.length === 0) return null;

  return (
    <div className="signup-tray">
      {waiting > 0 ? (
        <button
          className="signup-badge"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
            setConfirming(null);
          }}
        >
          {waiting} signed up
        </button>
      ) : null}
      {lines.map((line) => (
        /* role="status": the one thing on this screen that appears with
           no tap behind it, so a teacher using VoiceOver hears it. */
        <p key={line.id} className="signup-outcome" role="status">
          {line.text}
        </p>
      ))}
      {/* T207: the badge is what closes this, and the badge is gone when
          nobody is waiting, so an outcome line left over from the last
          sign-up must not leave an empty list open with no way to shut
          it. */}
      {open && waiting > 0 ? (
        <div className="signup-list" role="group" aria-label="Signed up on the customer screen">
          <p className="signup-list-head">
            {/* T208: review mode says what the tap is FOR. Pete, second
                drive: "i see nothing that says 'review'." In automatic
                the only names here are the ones a person is needed for,
                which is what the other sentence says. */}
            {mode === "review"
              ? "Waiting for your review"
              : rows.length > 0
                ? "Signed up on the customer screen, not created yet."
                : "Signed up on the customer screen."}
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
                  {/* T208: in progress, before there is anything to
                      say about it. The spinner is the one thing on this
                      row that means "wait", so it outranks a reason
                      left over from an earlier attempt. */}
                  {busy?.[row.requestId] ? (
                    <span className="signup-working">
                      <span className="spinner" aria-label="working" />
                      {busy[row.requestId]?.label}
                    </span>
                  ) : reasons?.[row.requestId] ? (
                    /* T207: why this one is still here. The tap is
                       unchanged: it opens the same prefilled form, so a
                       teacher can fix a name and create by hand. */
                    <span className="signup-why">{reasons[row.requestId]}</span>
                  ) : null}
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
            {/* T208 review: still running, and no longer on the
                server's list, because the create has already spent the
                handle. No Clear on these: there is a write in flight,
                and the outcome (a line, or a row) is seconds away. */}
            {held.map((row) => (
              <li key={row.requestId} className="signup-row">
                <span className="signup-name signup-name-held">
                  <span className="signup-name-text">
                    {row.name || "(unnamed)"}
                  </span>
                  <span className="signup-working">
                    <span className="spinner" aria-label="working" />
                    {row.label}
                  </span>
                </span>
              </li>
            ))}
            {/* T207: created, and the class booking after it was not.
                The client EXISTS, so the tap opens their profile and
                there is no Create anywhere on this row. Clear is local:
                the server has nothing left to consume. */}
            {stuckRows.map((row) => (
              <li key={row.requestId} className="signup-row">
                <button
                  className="signup-name"
                  onClick={() => {
                    setOpen(false);
                    setConfirming(null);
                    onStuckPick?.(row);
                  }}
                >
                  <span className="signup-name-text">
                    {row.name || "(unnamed)"}
                  </span>
                  <span className="signup-why">{row.reason}</span>
                </button>
                <button
                  className={
                    confirming === row.requestId
                      ? "signup-clear confirming"
                      : "signup-clear"
                  }
                  onClick={() => {
                    if (confirming === row.requestId) {
                      setConfirming(null);
                      onStuckClear?.(row.requestId);
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
