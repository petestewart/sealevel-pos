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

interface WaitlistRow {
  entryId: number;
  clientId: string;
  name: string;
  requestedAt: string | null;
}

/** Grey and unlabelled: checking out is the quiet action on the row. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        d="M6 6l12 12M18 6L6 18"
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
  /** Walk-in bookings in flight, by client id. Like check-in, booking is
   *  NOT optimistic: a booking is attendance-adjacent, so the row spins
   *  until Mindbody answers rather than faking success. */
  const [bookingIds, setBookingIds] = useState<string[]>([]);
  /** Per-walk-in outcome text: a failure, or "suppressed by dry run". */
  const [bookMsg, setBookMsg] = useState<Record<string, string>>({});
  /** A walk-in tapped on a full class, awaiting the explicit waitlist yes. */
  const [waitlistPrompt, setWaitlistPrompt] = useState<SearchResult | null>(
    null,
  );
  /** The waiting list panel: only offered for a full class, fetched on
   *  open, because a class with room cannot have a queue. */
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [waitlist, setWaitlist] = useState<WaitlistRow[] | null>(null);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  /** Waitlist promotions in flight, by entry id. Also non-optimistic. */
  const [promoting, setPromoting] = useState<number[]>([]);
  const [promoteMsg, setPromoteMsg] = useState<Record<number, string>>({});
  const skipDebounce = useRef(false);
  /** The class currently on screen, readable from inside an async fetch:
   *  a waitlist response that comes back after the teacher has switched
   *  classes must be dropped, not written into state under the new class. */
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

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

  /**
   * The roster for one class, also called after a booking so the new visit
   * appears with its visit id. The response carries fresh capacity and
   * booked counts, which update the class summary too: a booking that
   * fills the class must flip the walk-in action to "waitlist" without
   * waiting for a page reload.
   */
  const refreshRoster = useCallback(async (classId: number) => {
    try {
      const d = await fetch(`/api/roster?classId=${classId}`).then((r) =>
        r.json(),
      );
      if (d.error) return setError(d.error);
      setEntries(d.entries ?? []);
      setClasses((cs) =>
        cs.map((c) =>
          c.classId === classId
            ? { ...c, capacity: d.capacity ?? c.capacity, booked: d.booked ?? c.booked }
            : c,
        ),
      );
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (activeId === null) return;
    setWaitlistOpen(false);
    setWaitlist(null);
    setWaitlistError(null);
    setPromoteMsg({});
    void refreshRoster(activeId);
  }, [activeId, refreshRoster]);

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
          body: JSON.stringify({
            visitId: entry.visitId,
            signedIn,
            clientId: entry.clientId,
          }),
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

  const activeClass = classes.find((c) => c.classId === activeId) ?? null;
  /** Full means TotalBooked has reached MaxCapacity. Unknown counts are
   *  treated as room: Mindbody is the arbiter and will refuse a booking a
   *  stale count would have allowed. */
  const classFull =
    activeClass !== null &&
    activeClass.capacity !== null &&
    activeClass.booked !== null &&
    activeClass.booked >= activeClass.capacity;

  const loadWaitlist = useCallback(async (classId: number) => {
    setWaitlistError(null);
    try {
      const d = await fetch(`/api/waitlist?classId=${classId}`).then((r) =>
        r.json(),
      );
      /* The teacher switched classes while this was in flight: the reset
       * effect already cleared the waitlist state for the new class, and
       * this response would repopulate it with the OLD class's entries --
       * a wrong counter, and promote buttons carrying entry ids from a
       * different class. Drop it. */
      if (activeIdRef.current !== classId) return;
      if (d.error) return setWaitlistError(d.error);
      setWaitlist(d.entries ?? []);
    } catch (e) {
      if (activeIdRef.current !== classId) return;
      setWaitlistError(String(e));
    }
  }, []);

  /**
   * The waitlist counter needs the entries, and only a full class can have
   * any: `TotalBooked < MaxCapacity` means nobody is queued, so for a class
   * with room the counter renders zero without any request going out. For a
   * full class the entries are fetched ONCE here, into the same state the
   * waiting list panel reads, so opening the panel costs nothing extra.
   *
   * No loop: a successful fetch makes `waitlist` non-null, and a failed one
   * leaves the deps untouched (the error lives in `waitlistError`, which is
   * deliberately not a dep). Opening the panel is the retry path.
   */
  useEffect(() => {
    if (activeId !== null && classFull && waitlist === null) {
      void loadWaitlist(activeId);
    }
  }, [activeId, classFull, waitlist, loadWaitlist]);

  /**
   * Book a walk-in into the active class, or onto its waiting list. Not
   * optimistic, same reasoning as check-in: a booking the teacher believes
   * in and Mindbody refused is someone standing in a class with no visit.
   * The row spins until the answer comes back; on success the person
   * simply appears on the roster, one tap from checked in.
   */
  const bookWalkIn = useCallback(
    async (client: SearchResult, waitlist: boolean) => {
      if (activeId === null || bookingIds.includes(client.id)) return;
      setBookingIds((b) => [...b, client.id]);
      setBookMsg((m) => {
        const { [client.id]: _drop, ...rest } = m;
        return rest;
      });
      try {
        const res = await fetch("/api/book", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: client.id, classId: activeId, waitlist }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (body.suppressed) {
          setBookMsg((m) => ({
            ...m,
            [client.id]:
              body.suppressed === "dry-run"
                ? "Dry run: booking suppressed, nothing was written."
                : "Write guard: this client is not in POS_WRITE_CLIENT_IDS.",
          }));
          return;
        }
        if (waitlist) {
          setBookMsg((m) => ({ ...m, [client.id]: "On the waiting list." }));
          /* Refresh unconditionally: the header counter shows this list's
           * length even when the panel is closed, and it just grew. */
          void loadWaitlist(activeId);
        }
        await refreshRoster(activeId);
      } catch (err) {
        setBookMsg((m) => ({
          ...m,
          [client.id]: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setBookingIds((b) => b.filter((id) => id !== client.id));
      }
    },
    [activeId, bookingIds, refreshRoster, loadWaitlist],
  );

  /**
   * Promote a waiting client into the class: the same booking endpoint
   * carrying the WaitlistEntryId, which is the documented way to move
   * someone off a waiting list rather than double-booking them. Also
   * non-optimistic; the entry spins until Mindbody answers.
   */
  const promote = useCallback(
    async (row: WaitlistRow) => {
      if (activeId === null || promoting.includes(row.entryId)) return;
      setPromoting((p) => [...p, row.entryId]);
      setPromoteMsg((m) => {
        const { [row.entryId]: _drop, ...rest } = m;
        return rest;
      });
      try {
        const res = await fetch("/api/book", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: row.clientId,
            classId: activeId,
            waitlistEntryId: row.entryId,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (body.suppressed) {
          setPromoteMsg((m) => ({
            ...m,
            [row.entryId]:
              body.suppressed === "dry-run"
                ? "Dry run: promotion suppressed, nothing was written."
                : "Write guard: this client is not in POS_WRITE_CLIENT_IDS.",
          }));
          return;
        }
        await Promise.all([refreshRoster(activeId), loadWaitlist(activeId)]);
      } catch (err) {
        setPromoteMsg((m) => ({
          ...m,
          [row.entryId]: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setPromoting((p) => p.filter((id) => id !== row.entryId));
      }
    },
    [activeId, promoting, refreshRoster, loadWaitlist],
  );

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

      {/* Three numbers, read at arm's length in the ninety seconds before
          class: is everyone here, is anyone missing, is there room. Signed
          up and checked in come from the roster already in memory, capacity
          from the class summary; only the waitlist ever costs a call, and
          only for a full class. Not tappable yet: T4 puts the lists behind
          them. */}
      {activeClass ? (
        <header className="counters" aria-label="Counts for the selected class">
          <div className="counter">
            <span className="counter-num">
              {entries.length}
              {activeClass.capacity !== null ? (
                <span className="counter-cap"> of {activeClass.capacity}</span>
              ) : null}
            </span>
            <span className="counter-label">signed up</span>
          </div>
          <div className="counter">
            <span className="counter-num">
              {entries.filter((e) => e.checkedIn).length}
            </span>
            <span className="counter-label">checked in</span>
          </div>
          <div className="counter">
            <span className="counter-num">
              {waitlist !== null
                ? waitlist.length
                : classFull
                  ? waitlistError
                    ? "?"
                    : "..."
                  : 0}
            </span>
            <span className="counter-label">waitlist</span>
          </div>
        </header>
      ) : null}

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
                    <CloseIcon />
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
                            ? "chip action"
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

        {walkIns.map((client) => {
          const working = bookingIds.includes(client.id);
          const msg = bookMsg[client.id];
          const detail = working
            ? "Talking to Mindbody..."
            : msg ??
              `Not booked into this class${client.email ? ` - ${client.email}` : ""}.` +
                (classFull ? " Class is full." : "");
          return (
            <li key={`walkin-${client.id}`}>
              <button
                className="row"
                disabled={working}
                onClick={() =>
                  classFull
                    ? setWaitlistPrompt(client)
                    : void bookWalkIn(client, false)
                }
              >
                <span className="name">
                  {client.name}
                  <span className="detail">{detail}</span>
                </span>
                <span
                  className={
                    working
                      ? "chip busy"
                      : classFull
                        ? "chip unpaid"
                        : "chip action"
                  }
                >
                  {working ? (
                    <span className="spinner" aria-label="working" />
                  ) : classFull ? (
                    "waitlist"
                  ) : (
                    "add"
                  )}
                </span>
                <span className="undo-spacer" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>

      {/* The waiting list, offered only for a full class: a class with
          room cannot have a queue, so the metered call never fires for
          one. T4 turns this into the counter modal; this is the minimal
          affordance that makes promotion reachable. A loaded, non-empty
          list keeps the section visible even after a spot opens up,
          because that is exactly the moment promotion is useful. */}
      {activeId !== null &&
      (classFull || (waitlist !== null && waitlist.length > 0)) ? (
        <section className="waitlist-section">
          <button
            className="waitlist-toggle"
            aria-expanded={waitlistOpen}
            onClick={() => {
              const opening = !waitlistOpen;
              setWaitlistOpen(opening);
              if (opening && waitlist === null) void loadWaitlist(activeId);
            }}
          >
            {waitlistOpen ? "Hide waiting list" : "Show waiting list"}
          </button>
          {waitlistOpen ? (
            <>
              {waitlistError ? <p className="note">{waitlistError}</p> : null}
              {waitlist === null && !waitlistError ? (
                <p className="muted">Loading the waiting list...</p>
              ) : null}
              {waitlist !== null && waitlist.length === 0 ? (
                <p className="muted">Nobody is waiting.</p>
              ) : null}
            </>
          ) : null}
          {waitlistOpen && waitlist !== null && waitlist.length > 0 ? (
            <ul className="roster">
              {waitlist.map((row) => {
                const working = promoting.includes(row.entryId);
                const msg = promoteMsg[row.entryId];
                return (
                  <li key={`wl-${row.entryId}`}>
                    <button
                      className="row"
                      disabled={working}
                      onClick={() => void promote(row)}
                    >
                      <span className="name">
                        {row.name}
                        <span className="detail">
                          {working
                            ? "Talking to Mindbody..."
                            : msg ??
                              (row.requestedAt
                                ? `Waiting since ${clockTime(row.requestedAt)}`
                                : "On the waiting list")}
                        </span>
                      </span>
                      <span className={working ? "chip busy" : "chip action"}>
                        {working ? (
                          <span className="spinner" aria-label="working" />
                        ) : (
                          "promote"
                        )}
                      </span>
                      <span className="undo-spacer" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}
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

      {waitlistPrompt ? (
        <div
          className="modal-scrim"
          onClick={() => setWaitlistPrompt(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm waiting list"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">
              This class is full
              {activeClass &&
              activeClass.capacity !== null &&
              activeClass.booked !== null
                ? ` (${activeClass.booked} of ${activeClass.capacity})`
                : ""}
              .
            </p>
            <p className="muted">
              Add {waitlistPrompt.name} to the waiting list? They get the next
              spot that opens up.
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setWaitlistPrompt(null)}
              >
                Cancel
              </button>
              <button
                className="modal-confirm go"
                onClick={() => {
                  const client = waitlistPrompt;
                  setWaitlistPrompt(null);
                  void bookWalkIn(client, true);
                }}
              >
                Add to waiting list
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <DevDrawer />
    </main>
  );
}
