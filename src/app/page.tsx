"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import DevDrawer from "./DevDrawer";

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

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    fetch("/api/roster")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setClasses(d.classes ?? []);
        setActiveId(d.classes?.[0]?.classId ?? null);
      })
      .catch((e) => setError(String(e)));
  }, []);

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

  /** Search is local to the server's in-memory index, so a short debounce
   *  is enough; the round trip is milliseconds, not a Mindbody call. */
  useEffect(() => {
    if (query.trim().length < 2) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => r.json())
        .then((d) => setFound(d.results ?? []))
        .catch(() => setFound([]));
    }, 120);
    return () => clearTimeout(t);
  }, [query]);

  /**
   * Set a visit's signed-in state. Optimistic: the row flips immediately
   * and the call runs behind it, because nobody should watch a spinner
   * with a queue waiting. A failure rolls the row back and says why.
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
      setEntries((rows) =>
        rows.map((r) => (r.clientId === entry.clientId ? { ...r, checkedIn: signedIn } : r)),
      );
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
      } catch (err) {
        setEntries((rows) =>
          rows.map((r) =>
            r.clientId === entry.clientId ? { ...r, checkedIn: !signedIn } : r,
          ),
        );
        setFailed((f) => ({
          ...f,
          [entry.clientId]: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [],
  );

  /**
   * One tap does the obvious thing, with one exception: an unpaid booking
   * has no pricing option attached, so checking it in hands over a class
   * for free. Phase 2 will sell them a pass here; until then it at least
   * takes a deliberate second tap.
   *
   * Checking someone in is reversible (updateclientvisit takes
   * SignedIn: false), so a tap on an already-checked-in row undoes it.
   */
  const tapRow = useCallback(
    (entry: RosterEntry) => {
      if (entry.checkedIn) return void setSignedIn(entry, false);
      if (!entry.paid && !confirming.includes(entry.clientId)) {
        setConfirming((c) => [...c, entry.clientId]);
        return;
      }
      void setSignedIn(entry, true);
    },
    [confirming, setSignedIn],
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
        placeholder="Search for a walk-in"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />

      <ul className="roster">
        {entries.map((entry) => (
          <li key={entry.clientId}>
            <button
              className="row"
              onClick={() => tapRow(entry)}

            >
              <span className="name">
                {entry.name}
                <span className="detail">
                  {failed[entry.clientId]
                    ? failed[entry.clientId]
                    : confirming.includes(entry.clientId)
                      ? "No pass on this booking. Tap again to check in for free."
                      : entry.checkedIn
                        ? `${entry.pricingOption ?? "No pass"} - tap to undo`
                        : (entry.pricingOption ?? "No pass on this booking")}
                </span>
              </span>
              <span
                className={
                  failed[entry.clientId]
                    ? "chip failed"
                    : entry.checkedIn
                      ? "chip in"
                      : confirming.includes(entry.clientId)
                        ? "chip unpaid"
                        : entry.paid
                          ? "chip walkin"
                          : "chip unpaid"
                }
              >
                {failed[entry.clientId]
                  ? "failed"
                  : entry.checkedIn
                    ? "in"
                    : confirming.includes(entry.clientId)
                      ? "confirm"
                      : entry.paid
                        ? "check in"
                        : "unpaid"}
              </span>
            </button>
          </li>
        ))}

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
      <DevDrawer />
    </main>
  );
}
