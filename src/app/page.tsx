"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
  /** Rows whose check-in call failed after going green optimistically. */
  const [failed, setFailed] = useState<Record<string, string>>({});

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
   * Optimistic: the row goes green on tap and the API call runs behind it.
   * A failure rolls the row back and marks it, rather than making the
   * teacher watch a spinner with a queue waiting.
   */
  const markArrived = useCallback(
    async (clientId: string) => {
      if (activeId === null) return;
      setEntries((rows) =>
        rows.map((r) =>
          r.clientId === clientId ? { ...r, checkedIn: true } : r,
        ),
      );
      setFailed((f) => {
        const { [clientId]: _drop, ...rest } = f;
        return rest;
      });
      try {
        const res = await fetch("/api/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId, classId: activeId }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      } catch (err) {
        setEntries((rows) =>
          rows.map((r) =>
            r.clientId === clientId ? { ...r, checkedIn: false } : r,
          ),
        );
        setFailed((f) => ({
          ...f,
          [clientId]: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [activeId],
  );

  const rosterIds = useMemo(
    () => new Set(entries.map((e) => e.clientId)),
    [entries],
  );
  const walkIns = found.filter((f) => !rosterIds.has(f.id));

  return (
    <main className="shell">
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
              onClick={() => markArrived(entry.clientId)}
              disabled={entry.checkedIn}
            >
              <span className="name">
                {entry.name}
                <span className="detail">
                  {failed[entry.clientId]
                    ? failed[entry.clientId]
                    : (entry.pricingOption ?? "No pass on this booking")}
                </span>
              </span>
              <span
                className={
                  failed[entry.clientId]
                    ? "chip failed"
                    : entry.checkedIn
                      ? "chip in"
                      : entry.paid
                        ? "chip walkin"
                        : "chip unpaid"
                }
              >
                {failed[entry.clientId]
                  ? "failed"
                  : entry.checkedIn
                    ? "in"
                    : entry.paid
                      ? "check in"
                      : "unpaid"}
              </span>
            </button>
          </li>
        ))}

        {walkIns.map((client) => (
          <li key={`walkin-${client.id}`}>
            <button className="row" onClick={() => markArrived(client.id)}>
              <span className="name">
                {client.name}
                <span className="detail">
                  Not booked into this class{client.email ? ` - ${client.email}` : ""}
                </span>
              </span>
              <span className="chip walkin">add</span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
