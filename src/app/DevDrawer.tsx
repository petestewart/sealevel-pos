"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A drawer that slides up from the bottom showing the Mindbody traffic this
 * app actually generated: method, path, status, latency, request body,
 * response body.
 *
 * Recorded server-side, so it shows what Mindbody really received and said,
 * not what our own API routes chose to forward. It renders nothing unless
 * /api/devlog answers, which it only does when devtools are enabled, so
 * this is inert on the counter iPad.
 */

interface CallRecord {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number | null;
  ms: number;
  outcome: string;
  requestBody: string | null;
  responseBody: string | null;
}

function statusClass(call: CallRecord): string {
  if (call.outcome !== "sent") return "dev-suppressed";
  if (call.status === null) return "";
  return call.status >= 400 ? "dev-bad" : "dev-good";
}

export default function DevDrawer() {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/devlog");
      if (!res.ok) return setAvailable(false);
      const body = await res.json();
      setAvailable(true);
      setCalls(body.calls ?? []);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void poll();
  }, [poll]);

  /** Only poll while the drawer is open; a closed drawer should cost
   *  nothing on a machine that is also serving the counter. */
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => void poll(), 1500);
    return () => clearInterval(t);
  }, [open, poll]);

  if (!available) return null;

  const failures = calls.filter(
    (c) => c.outcome === "sent" && c.status !== null && c.status >= 400,
  ).length;

  return (
    <>
      <button
        className="dev-handle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "close" : "API"} {calls.length}
        {failures > 0 ? <span className="dev-badge">{failures}</span> : null}
      </button>

      <section className={open ? "dev-drawer open" : "dev-drawer"}>
        <header className="dev-head">
          <strong>Mindbody calls</strong>
          <span className="muted">newest first, server-side</span>
          <button
            onClick={async () => {
              await fetch("/api/devlog", { method: "DELETE" });
              setCalls([]);
            }}
          >
            clear
          </button>
        </header>

        <div className="dev-body">
          {calls.length === 0 ? (
            <p className="muted">No calls yet.</p>
          ) : (
            calls.map((call) => (
              <div key={call.id} className="dev-call">
                <button
                  className="dev-row"
                  onClick={() =>
                    setExpanded((e) => (e === call.id ? null : call.id))
                  }
                >
                  <span className={`dev-status ${statusClass(call)}`}>
                    {call.outcome === "sent" ? call.status : call.outcome}
                  </span>
                  <span className="dev-method">{call.method}</span>
                  <span className="dev-path">{call.path}</span>
                  <span className="dev-ms">{call.ms}ms</span>
                </button>
                {expanded === call.id ? (
                  <div className="dev-detail">
                    <div className="muted">{call.at}</div>
                    {call.requestBody ? (
                      <>
                        <div className="dev-label">request</div>
                        <pre>{call.requestBody}</pre>
                      </>
                    ) : null}
                    <div className="dev-label">response</div>
                    <pre>{call.responseBody ?? "(empty)"}</pre>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}
