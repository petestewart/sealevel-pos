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
  /** Which call id was just copied, for the momentary "copied" label. */
  const [copied, setCopied] = useState<number | "all" | null>(null);

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

  /**
   * Cmd+D (Ctrl+D elsewhere) toggles the drawer. Both are taken by the
   * browser -- bookmark on Mac, bookmark-or-delete elsewhere -- so this
   * has to preventDefault, which is acceptable for a tool that only
   * exists in dev builds.
   */
  useEffect(() => {
    if (!available) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [available]);

  /**
   * navigator.clipboard needs a secure context, which http://<lan-ip>:3000
   * on an iPad is not, so fall back to a hidden textarea and execCommand.
   * Copying a payload off the tablet is exactly when this matters most.
   */
  const copy = useCallback(async (text: string, id: number | "all") => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(el);
      }
    }
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  }, []);

  const asText = (call: CallRecord): string =>
    [
      `${call.method} ${call.path}`,
      `${call.outcome} ${call.status ?? ""} ${call.ms}ms  ${call.at}`,
      call.requestBody ? `\n--- request ---\n${call.requestBody}` : "",
      `\n--- response ---\n${call.responseBody ?? "(empty)"}`,
    ]
      .filter(Boolean)
      .join("\n");

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
            onClick={() => copy(calls.map(asText).join("\n\n====\n\n"), "all")}
          >
            {copied === "all" ? "copied" : "copy all"}
          </button>
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
                    <div className="dev-detail-head">
                      <span className="muted">{call.at}</span>
                      <button onClick={() => copy(asText(call), call.id)}>
                        {copied === call.id ? "copied" : "copy"}
                      </button>
                    </div>
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
