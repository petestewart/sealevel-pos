"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import DevDrawer from "./DevDrawer";
import { useSettings } from "./settings";

/**
 * The counter screen. One class selector, one roster, one search box.
 *
 * Phase 1 does exactly one thing: check people in. No cart, no payment, no
 * money. That is deliberate -- it is most of the time saved at the door and
 * it cannot break anything financial while teachers get used to it.
 */

interface ClassSummary {
  classId: number;
  name: string;
  teacher: string;
  startsAt: string;
  capacity: number | null;
  booked: number | null;
}

interface RosterEntry {
  clientId: string;
  name: string;
  visitId: number | null;
  pricingOption: string | null;
  paid: boolean;
  checkedIn: boolean;
}

interface SearchResult {
  id: string;
  name: string;
  email: string | null;
}

/** Material's undo arrow. Grey and unlabelled: it is the quiet action. */
function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"
      />
    </svg>
  );
}

function clockTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function FrontDesk() {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<{
    dryRun: boolean;
    target: string;
    siteId: string | null;
    configError: string | null;
    writeClientIds: string[];
  } | null>(null);
  /** Rows whose check-in call failed after going green optimistically. */
  const [failed, setFailed] = useState<Record<string, string>>({});
  /** Unpaid rows tapped once, awaiting a deliberate second tap. */
  const [confirming, setConfirming] = useState<string[]>([]);
  /** Rows with a check-in in flight. */
  const [busy, setBusy] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  /** Tunables live in the dev drawer's settings tab, so the ones that have
   *  already been wrong once can be adjusted without a commit. */
  const { settings } = useSettings();
  /**
   * Enter searches now rather than waiting out the debounce. The debounce
   * exists to avoid a call per keystroke; someone who has pressed Enter has
   * finished typing and should not be made to wait for a timer to agree.
   */
  const [searchNow, setSearchNow] = useState(0);
  /** The row awaiting a confirmed check-out, if any. */
  const [checkingOut, setCheckingOut] = useState<RosterEntry | null>(null);
  const skipDebounce = useRef(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    fetch(
      `/api/roster?hoursBack=${settings.hoursBack}&hoursForward=${settings.hoursForward}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setClasses(d.classes ?? []);
        setActiveId(d.classes?.[0]?.classId ?? null);
      })
      .catch((e) => setError(String(e)));
  }, [settings.hoursBack, settings.hoursForward]);

  useEffect(() => {
    if (activeId === null) return;
    fetch(`/api/roster?classId=${activeId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setEntries(d.entries ?? []);
      })
      .catch((e) => setError(String(e)));
  }, [activeId]);

  /**
   * Search hits Mindbody, so it is debounced properly and cancelled on the
   * next keystroke.
   *
   * The first version used a 120ms debounce, tuned for a local index. Once
   * search became a network call that meant typing "dennis" fired four
   * requests inside 220ms -- more calls than the index it replaced would
   * have made. It also raced: a slow "de" could land after a fast
   * "dennis" and overwrite the better answer.
   *
   * Three letters minimum by default, because two returns hundreds of
   * matches that nobody scrolls, at the cost of a metered call.
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length < settings.minQueryLength) {
      setFound([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const delay = skipDebounce.current ? 0 : settings.searchDebounceMs;
    skipDebounce.current = false;
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${settings.searchLimit}`, {
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((d) => setFound(d.results ?? []))
        .catch(() => {
          /* aborted by the next keystroke, or failed; either way keep the
           * previous results rather than blanking the list mid-type. */
        })
        .finally(() => setSearching(false));
    }, delay);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [
    query,
    searchNow,
    settings.minQueryLength,
    settings.searchDebounceMs,
    settings.searchLimit,
  ]);

  /**
   * Set a visit's signed-in state, and wait for Mindbody before showing it
   * as done.
   *
   * This was optimistic, which is faster and was wrong: the row went green
   * on tap and only corrected itself when the failure came back, by which
   * time a teacher with a queue has looked away and believes someone is
   * checked in who is not. Attendance is worth the 300-900ms. The row shows
   * a spinner meanwhile, so the wait is visible rather than mysterious.
   */
  const setSignedIn = useCallback(
    async (entry: RosterEntry, signedIn: boolean) => {
      if (entry.visitId === null) {
        setFailed((f) => ({
          ...f,
          [entry.clientId]: "No visit id on this booking, so it cannot be signed in.",
        }));
        return;
      }
      setBusy((b) => [...b, entry.clientId]);
      if (settings.optimisticCheckIn) {
        setEntries((rows) =>
          rows.map((r) =>
            r.clientId === entry.clientId ? { ...r, checkedIn: signedIn } : r,
          ),
        );
      }
      setFailed((f) => {
        const { [entry.clientId]: _drop, ...rest } = f;
        return rest;
      });
      setConfirming((c) => c.filter((id) => id !== entry.clientId));
      try {
        const res = await fetch("/api/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitId: entry.visitId, signedIn }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setEntries((rows) =>
          rows.map((r) =>
            r.clientId === entry.clientId ? { ...r, checkedIn: signedIn } : r,
          ),
        );
      } catch (err) {
        if (settings.optimisticCheckIn) {
          setEntries((rows) =>
            rows.map((r) =>
              r.clientId === entry.clientId ? { ...r, checkedIn: !signedIn } : r,
            ),
          );
        }
        setFailed((f) => ({
          ...f,
          [entry.clientId]: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setBusy((b) => b.filter((id) => id !== entry.clientId));
      }
    },
    [settings.optimisticCheckIn],
  );

  /**
   * One tap does the obvious thing, with one exception: an unpaid booking
   * has no pricing option attached, so checking it in hands over a class
   * for free. Phase 2 will sell them a pass here; until then it at least
   * takes a deliberate second tap.
   *
   * Checking OUT is not here: it has its own control and its own
   * confirmation, because undoing a check-in by the same gesture that made
   * it is too easy to do by accident.
   */
  const tapRow = useCallback(
    (entry: RosterEntry) => {
      if (busy.includes(entry.clientId) || entry.checkedIn) return;
      if (
        settings.confirmUnpaid &&
        !entry.paid &&
        !confirming.includes(entry.clientId)
      ) {
        setConfirming((c) => [...c, entry.clientId]);
        return;
      }
      void setSignedIn(entry, true);
    },
    [busy, confirming, setSignedIn, settings.confirmUnpaid],
  );

  const rosterIds = useMemo(
    () => new Set(entries.map((e) => e.clientId)),
    [entries],
  );
  const walkIns = found.filter((f) => !rosterIds.has(f.id));

  return (
    <main className="shell">
      {config?.configError ? <p className="note">{config.configError}</p> : null}

      {config && !config.configError ? (
        <p className={config.dryRun ? "banner" : "banner live"}>
          {config.dryRun
            ? "Dry run. Nothing is written to Mindbody."
            : "LIVE. Taps check real students in."}{" "}
          {config.target === "prod" ? "Production" : "Sandbox"} site {config.siteId}.
          {!config.dryRun && config.writeClientIds.length > 0
            ? ` Writes limited to client ${config.writeClientIds.join(", ")}.`
            : ""}
        </p>
      ) : null}

      {error ? <p className="note">{error}</p> : null}

      <nav className="classbar">
        {classes.map((c) => (
          <button
            key={c.classId}
            aria-pressed={c.classId === activeId}
            onClick={() => setActiveId(c.classId)}
          >
            <span className="when">{clockTime(c.startsAt)}</span>
            <span className="who">
              {c.name}
              {c.teacher ? ` - ${c.teacher}` : ""}
              {c.booked !== null ? ` - ${c.booked} booked` : ""}
            </span>
          </button>
        ))}
        {classes.length === 0 && !error ? (
          <p className="muted">No classes in the next few hours.</p>
        ) : null}
      </nav>

      <input
        className="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            skipDebounce.current = true;
            setSearchNow((n) => n + 1);
          }
        }}
        enterKeyHint="search"
        placeholder={
          searching
            ? "Searching..."
            : `Search for a walk-in (${settings.minQueryLength}+ letters)`
        }
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />

      <ul className="roster">
        {entries.map((entry) => {
          const working = busy.includes(entry.clientId);
          const detail = working
            ? "Talking to Mindbody..."
            : failed[entry.clientId]
              ? failed[entry.clientId]
              : confirming.includes(entry.clientId)
                ? "No pass on this booking. Tap again to check in for free."
                : (entry.pricingOption ?? "No pass on this booking");

          /**
           * A checked-in row is NOT a button. Undoing a check-in used to be
           * a tap anywhere on the row, which is the same gesture that made
           * it -- far too easy to reverse someone by accident while scanning
           * a list. It now takes a small deliberate control, and then a
           * confirmation.
           */
          if (entry.checkedIn && !working) {
            return (
              <li key={entry.clientId}>
                <div className="row">
                  <span className="name">
                    {entry.name}
                    <span className="detail">{detail}</span>
                  </span>
                  <span className="chip in">checked in</span>
                  <button
                    className="undo-btn"
                    onClick={() => setCheckingOut(entry)}
                    aria-label={`Check out ${entry.name}`}
                    title={`Check out ${entry.name}`}
                  >
                    <UndoIcon />
                  </button>
                </div>
              </li>
            );
          }

          return (
            <li key={entry.clientId}>
              <button className="row" onClick={() => tapRow(entry)}>
                <span className="name">
                  {entry.name}
                  <span className="detail">{detail}</span>
                </span>
                <span
                  className={
                    working
                      ? "chip busy"
                      : failed[entry.clientId]
                        ? "chip failed"
                        : confirming.includes(entry.clientId)
                          ? "chip unpaid"
                          : entry.paid
                            ? "chip walkin"
                            : "chip unpaid"
                  }
                >
                  {working ? (
                    <span className="spinner" aria-label="working" />
                  ) : failed[entry.clientId] ? (
                    "failed"
                  ) : confirming.includes(entry.clientId) ? (
                    "confirm"
                  ) : entry.paid ? (
                    "check in"
                  ) : (
                    "unpaid"
                  )}
                </span>
                {/* Holds the space the undo control occupies on a checked-in
                    row, so chips stay in one column down the list. */}
                <span className="undo-spacer" aria-hidden="true" />
              </button>
            </li>
          );
        })}

        {walkIns.map((client) => (
          <li key={`walkin-${client.id}`}>
            <button className="row" disabled>
              <span className="name">
                {client.name}
                <span className="detail">
                  Not booked into this class{client.email ? ` - ${client.email}` : ""}.
                  Booking a walk-in arrives in Phase 2.
                </span>
              </span>
              <span className="chip walkin">add</span>
            </button>
          </li>
        ))}
      </ul>
      {checkingOut ? (
        <div
          className="modal-scrim"
          onClick={() => setCheckingOut(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm check out"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">Check out {checkingOut.name}?</p>
            <p className="muted">
              This marks them as not having attended. Only do it if the
              check-in was a mistake.
            </p>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setCheckingOut(null)}>
                Cancel
              </button>
              <button
                className="modal-confirm"
                onClick={() => {
                  const entry = checkingOut;
                  setCheckingOut(null);
                  void setSignedIn(entry, false);
                }}
              >
                Check out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <DevDrawer />
    </main>
  );
}
