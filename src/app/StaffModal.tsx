"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The staff sign-in (T49). Opens from the header control that reads
 * "Sign in" or the signed-in teacher's first name. Nothing in the app
 * requires it: with nobody signed in every write runs as the studio's
 * service account exactly as before, and nothing prompts at start. When
 * a teacher IS signed in, every write runs under their own Mindbody
 * token, so Mindbody's records name them.
 *
 * Two faces. Signed out: email and password (autoComplete username /
 * current-password, so a saved login fills), Sign in. Signed in: the
 * name, the probe summary (what their Mindbody login can actually do,
 * from /api/teacher/probe) and Sign out. The password is sent once and
 * cleared from state on every answer; it is never kept.
 */

export interface Teacher {
  id: number;
  name: string;
}

export interface ProbeResult {
  teacher: Teacher;
  tokenOk: boolean;
  group: string | null;
  ipRestricted: boolean;
  allowed: { name: string; allowed: boolean }[];
  denied: string[];
  sale:
    | { ok: true; total: number | null; item: string }
    | { ok: false; error: string; item: string | null }
    | { skipped: string }
    | { suppressed: true; item: string };
}

/** What each needed permission lets the counter do, for the summary. */
const CAPABILITY: Record<string, string> = {
  LaunchSignInScreen: "check in",
  BookClassesAndEventsWithoutPayment: "book",
  MakeSales: "sell",
  CreateRetailTickets: "sell",
  AddProductsOnRetailScreen: "sell",
  UseStoredCreditCards: "charge a stored card",
};

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "Kim's Mindbody account can check in, book, and sell" or "cannot:
 *  <list>". The Test price counts as selling: a permission list that
 *  says yes while the cart says no is exactly the case the probe exists
 *  to catch. */
export function probeSummary(probe: ProbeResult): string {
  const who = `${firstName(probe.teacher.name)}'s Mindbody account`;
  const cannot: string[] = [];
  for (const p of probe.allowed) {
    if (!p.allowed) {
      const cap = CAPABILITY[p.name] ?? p.name;
      const line = `${cap} (${p.name})`;
      if (!cannot.includes(line)) cannot.push(line);
    }
  }
  if ("ok" in probe.sale && probe.sale.ok === false) {
    cannot.push(`price a sale (${probe.sale.error})`);
  }
  if (cannot.length === 0) {
    return `${who} can check in, book, and sell.`;
  }
  return `${who} cannot: ${cannot.join("; ")}.`;
}

export default function StaffModal({
  open,
  teacher,
  onClose,
  onTeacherChange,
}: {
  open: boolean;
  teacher: Teacher | null;
  onClose: () => void;
  /** The session changed: signed in as someone, or signed out (null). */
  onTeacherChange: (teacher: Teacher | null) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const runProbe = useCallback(async () => {
    setProbeBusy(true);
    setProbeError(null);
    try {
      const res = await fetch("/api/teacher/probe");
      const body = await res.json().catch(() => null);
      if (res.status === 401 && body?.staffSessionEnded) {
        onTeacherChange(null);
        setProbe(null);
        setProbeError(String(body.error ?? "Sign in again."));
        return;
      }
      if (!res.ok) {
        setProbeError(String(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      setProbe(body as ProbeResult);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbeBusy(false);
    }
  }, [onTeacherChange]);

  /* Each opening starts clean. */
  useEffect(() => {
    if (open) setMsg(null);
  }, [open]);

  /* The probe runs whenever the modal is open on a signed-in teacher:
   * on opening, and again the moment a sign-in lands (the teacher prop
   * changes), so the sign-in handler does not run it a second time. */
  useEffect(() => {
    if (!open) return;
    if (teacher) void runProbe();
    else {
      setProbe(null);
      setProbeError(null);
    }
  }, [open, teacher, runProbe]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const valid = username.trim().length >= 3 && password.length > 0;

  const signIn = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setMsg(null);
    const sent = { username: username.trim(), password };
    /* The password leaves state the moment it is sent. */
    setPassword("");
    try {
      const res = await fetch("/api/teacher/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sent),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg(
          res.status === 429
            ? `Too many attempts. Try again in ${body?.retryAfterSeconds ?? 30}s.`
            : String(body?.error ?? `HTTP ${res.status}`),
        );
        return;
      }
      const t = body?.teacher as Teacher;
      setUsername("");
      onTeacherChange(t);
      setMsg(`Signed in as ${t.name}.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/teacher/signout", { method: "POST" });
    } catch {
      /* The cookie may still stand; the next write says so. */
    } finally {
      setBusy(false);
      setProbe(null);
      onTeacherChange(null);
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-staff"
        role="dialog"
        aria-label={teacher ? "Signed-in teacher" : "Staff sign-in"}
      >
        {teacher ? (
          <>
            <p className="modal-title">{teacher.name}</p>
            <p className="reason-sub">
              Signed in to Mindbody. Check-ins, bookings and sales from this
              iPad are recorded under this login until sign-out or twelve
              hours.
            </p>
            {msg ? <p className="reason-note">{msg}</p> : null}
            <ProbeView
              probe={probe}
              busy={probeBusy}
              error={probeError}
              onRun={() => void runProbe()}
            />
            <div className="modal-actions">
              <button className="modal-cancel" onClick={onClose}>
                Close
              </button>
              <button
                className="modal-confirm"
                disabled={busy}
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-title">Sign in to Mindbody</p>
            <p className="reason-sub">
              Optional. Signed in, your check-ins, bookings and sales are
              recorded under your own Mindbody login; signed out, they are
              recorded under the studio account, as before. Your password is
              checked with Mindbody and not kept.
            </p>
            <input
              className="reason-input"
              type="email"
              autoComplete="username"
              autoFocus
              placeholder="Mindbody username (email)"
              aria-label="Mindbody username"
              value={username}
              disabled={busy}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="reason-input"
              type="password"
              autoComplete="current-password"
              placeholder="Mindbody password"
              aria-label="Mindbody password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void signIn();
              }}
            />
            {msg ? <p className="lock-msg">{msg}</p> : null}
            <div className="modal-actions">
              <button className="modal-cancel" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button
                className="modal-confirm go"
                disabled={busy || !valid}
                onClick={() => void signIn()}
              >
                {busy ? "Signing in" : "Sign in"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The probe's answer, in one line and then the six permissions. Also
 *  rendered in the dev drawer's Settings tab. */
export function ProbeView({
  probe,
  busy,
  error,
  onRun,
}: {
  probe: ProbeResult | null;
  busy: boolean;
  error: string | null;
  onRun: () => void;
}) {
  return (
    <div className="probe">
      {busy && !probe ? (
        <p className="reason-note">Checking what this login can do...</p>
      ) : null}
      {error ? <p className="lock-msg">{error}</p> : null}
      {probe ? (
        <>
          <p className="probe-summary">{probeSummary(probe)}</p>
          <p className="reason-note">
            Permission group {probe.group ?? "(unnamed)"}
            {probe.ipRestricted ? ", IP restricted" : ""}.
          </p>
          <ul className="probe-list" aria-label="Permissions this app needs">
            {probe.allowed.map((p) => (
              <li key={p.name} className={p.allowed ? "probe-ok" : "probe-no"}>
                <span aria-hidden="true">{p.allowed ? "✓" : "✗"}</span>{" "}
                {p.name}
              </li>
            ))}
            <li
              className={
                "ok" in probe.sale
                  ? probe.sale.ok
                    ? "probe-ok"
                    : "probe-no"
                  : "probe-skip"
              }
            >
              <span aria-hidden="true">
                {"ok" in probe.sale ? (probe.sale.ok ? "✓" : "✗") : "–"}
              </span>{" "}
              {"skipped" in probe.sale
                ? `Test price skipped: ${probe.sale.skipped}`
                : "suppressed" in probe.sale
                  ? `Test price of ${probe.sale.item} suppressed (dry run)`
                  : probe.sale.ok
                    ? `Test price of ${probe.sale.item}${
                        probe.sale.total !== null
                          ? ` came to $${probe.sale.total.toFixed(2)}`
                          : ""
                      }`
                    : `Test price${probe.sale.item ? ` of ${probe.sale.item}` : ""} refused: ${probe.sale.error}`}
            </li>
          </ul>
        </>
      ) : null}
      <button className="reason-link" disabled={busy} onClick={onRun}>
        {busy ? "Running probe" : probe ? "Run probe again" : "Run probe"}
      </button>
    </div>
  );
}
