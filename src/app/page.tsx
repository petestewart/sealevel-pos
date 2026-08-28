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
  /** The pass paying for this visit, from Visit.Service on the roster
   *  fetch. All null when the booking carries no service. */
  passRemaining: number | null;
  passCount: number | null;
  passExpires: string | null;
  /** Purchase-instance id of the pass, what a payment change posts. */
  clientServiceId: number | null;
  /** AccountBalance from the batched client lookup; null when unknown. */
  balance: number | null;
  /** MembershipIcon nonzero on the client record; null when unknown. */
  member: boolean | null;
  paid: boolean;
  checkedIn: boolean;
  /** true = waiver on file, false = blocked, null = unknown (fails open). */
  waiverSigned: boolean | null;
  /** RedAlert text from the client record; null when none or lookup failed. */
  redAlert: string | null;
  /** Staff notes from the client record; null when none or lookup failed. */
  notes: string | null;
  /** Mindbody's numeric UniqueId, for staff web app links. */
  mindbodyId: number | null;
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

/** Mirrors src/lib/clientcontext.ts, which is where the shapes are derived
 *  from the vendored spec. */
interface PassInfo {
  /** ClientService purchase-instance id; what a payment change posts.
   *  null means Mindbody omitted it and the pass cannot be picked. */
  id: number | null;
  name: string;
  remaining: number | null;
  count: number | null;
  expires: string | null;
}

interface VisitInfo {
  at: string;
  name: string | null;
  signedIn: boolean;
}

/** The on-demand pass list behind a row's payment-change dropdown. A
 *  successful fetch is cached for the session; an error is not, so
 *  reopening the dropdown retries. */
interface PassListState {
  data: PassInfo[] | null;
  error: string | null;
  loading: boolean;
}

/**
 * Roster order. "signin" is the order Mindbody returned the visits, i.e.
 * the array as fetched, which is the default. The other two sort locally:
 * a roster is at most a room's worth of rows, so there is nothing to ask
 * a server for.
 */
type RosterSort = "signin" | "last" | "first";

const ROSTER_SORTS: { value: RosterSort; label: string }[] = [
  { value: "signin", label: "Sign-in order" },
  { value: "last", label: "Last name" },
  { value: "first", label: "First name" },
];

const ROSTER_SORT_KEY = "pos.rosterSort";

/** How many history fetches the background sweep keeps in flight at once.
 *  Modest on purpose: the sweep is a nicety and must never crowd out the
 *  calls a teacher is waiting on. */
const HISTORY_SWEEP_CONCURRENCY = 4;

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

/** Warning triangle for the red alert icon; tapping it shows the text. */
function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        fill="none"
        d="M12 3.5 22 20.5H2Z"
      />
      <path
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        d="M12 9.5v5M12 17.6v.1"
      />
    </svg>
  );
}

/** Note sheet for the client's Notes field; tapping it shows the text. */
function NotesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        fill="none"
        d="M6 3.5h9L19.5 8v12.5H6Z"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M9 12h7M9 15.5h7"
      />
    </svg>
  );
}

/** Arrow out of a box: opens the client in the Mindbody staff web app. */
function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M10 5H5v14h14v-5"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M14 4h6v6M20 4l-9 9"
      />
    </svg>
  );
}

/** Checkmark marking the pass currently paying, in the change dropdown. */
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M4.5 12.5 10 18 19.5 6.5"
      />
    </svg>
  );
}

function clockTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "3rd", "21st". Plain numeric ordinals, no lookup table to run out of. */
function nth(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  const suffix =
    rem100 >= 11 && rem100 <= 13
      ? "th"
      : rem10 === 1
        ? "st"
        : rem10 === 2
          ? "nd"
          : rem10 === 3
            ? "rd"
            : "th";
  return `${n}${suffix}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The visit history as ONE line, highest signal first: a streak this week
 * beats a monthly count beats a last-seen date. Computed in the browser so
 * "this week" means the iPad's local week (Monday start), not the server's
 * timezone. The server window is ~35 days; the monthly count re-filters to
 * a strict 30 so "in the last month" is not quietly five weeks.
 *
 * No visits returns "" and the row shows nothing: on a panel "no visits"
 * was an answer, but on every new client's row it is noise.
 */
function historyLine(visits: VisitInfo[], now = new Date()): string {
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  const day = weekStart.getDay(); /* 0 = Sunday */
  weekStart.setDate(weekStart.getDate() - ((day + 6) % 7));
  const thisWeek = visits.filter((v) => new Date(v.at) >= weekStart).length;
  if (thisWeek >= 2) return `${nth(thisWeek)} class this week`;
  const monthStart = new Date(now.getTime() - 30 * DAY_MS);
  const month = visits.filter((v) => new Date(v.at) >= monthStart).length;
  if (month >= 2) return `${month} visits in the last month`;
  const latest = visits[0];
  if (latest) return `Last here ${shortDate(latest.at)}`;
  return "";
}

/** Numeric date for row copy, e.g. 8/22/27. */
function slashDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

/**
 * Mindbody fakes "unlimited" with absurd counters (99999, 99988, 1000).
 * Any pass whose original Count is 100 or more is one of them: show no
 * numbers rather than telling a teacher someone has 99987 classes left.
 * Remaining gets the same rule, for the pass whose Count Mindbody omits:
 * a real pass's Remaining can never exceed its Count, and no real pass
 * here holds 100 classes, so Remaining >= 100 is the same fake counter
 * arriving without its other half. This rule applies EVERYWHERE a pass
 * renders, the change dropdown included: "99993 of 99999 left" leaked
 * once through a renderer that forgot it.
 */
function fakeUnlimited(count: number | null, remaining: number | null): boolean {
  return (
    (count !== null && count >= 100) || (remaining !== null && remaining >= 100)
  );
}

function money(n: number): string {
  return n.toLocaleString([], {
    style: "currency",
    currency: "USD",
  });
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
    banner: string | null;
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
  /** Which counter's modal is open, if any. The lists behind "signed up"
   *  and "checked in" render from roster state already in memory; only the
   *  waitlist one can ever cost a call, and that call is shared with the
   *  counter itself. */
  const [counterModal, setCounterModal] = useState<
    "signedUp" | "checkedIn" | "waitlist" | null
  >(null);
  const [waitlist, setWaitlist] = useState<WaitlistRow[] | null>(null);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  /** Waitlist promotions in flight, by entry id. Also non-optimistic. */
  const [promoting, setPromoting] = useState<number[]>([]);
  const [promoteMsg, setPromoteMsg] = useState<Record<number, string>>({});
  /** Red alerts a teacher has explicitly read past, by client id. UI state
   *  only, deliberately: acknowledging an alert must never write anything
   *  back to Mindbody. Set ONLY by the check-in gate dialog; reading the
   *  alert through the row's info icon deliberately does not ack it. */
  const [acked, setAcked] = useState<string[]>([]);
  /** The row whose check-in is held behind an unread red alert. */
  const [redAlertPrompt, setRedAlertPrompt] = useState<RosterEntry | null>(
    null,
  );
  /**
   * The row a teacher tapped that has no released waiver. The dialog it
   * opens explains and closes; deliberately, there is no confirm button
   * and no path anywhere in this app that marks a waiver signed. The API
   * could do it in one line (`LiabilityRelease: true`), and that line is
   * exactly what the design doc forbids: a staff tap would manufacture a
   * legal record of an agreement the student may never have read. Signing
   * happens in the Mindbody app until Phase 3 puts the real waiver text on
   * the student's own phone.
   */
  const [waiverPrompt, setWaiverPrompt] = useState<RosterEntry | null>(null);
  /**
   * Read-only text behind a row icon: the red alert or the staff notes.
   * Informational only, one Close button, and it never acks the alert for
   * the check-in gate -- reading is not the same act as reading PAST.
   */
  const [infoModal, setInfoModal] = useState<{
    title: string;
    text: string;
    alert: boolean;
  } | null>(null);
  /** The client id whose payment-change dropdown is open, if any. */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /** On-demand pass lists per client, for the dropdown. Successes cache
   *  for the session; errors do not, so reopening retries. */
  const [passLists, setPassLists] = useState<Record<string, PassListState>>(
    {},
  );
  /** The pass id being written, if any. Non-optimistic, like check-in:
   *  which pass a class burns is money-adjacent, so the dropdown spins
   *  until Mindbody answers. */
  const [passSavingId, setPassSavingId] = useState<number | null>(null);
  /** Outcome text inside the dropdown: a failure, or the quiet suppression
   *  notice when dry run or the write guard stopped the write. */
  const [passMsg, setPassMsg] = useState<string | null>(null);
  /** Recent-visit windows per client, filled by the background sweep and
   *  kept for the session (keyed by client, so a class switch reuses
   *  them). Rows fill in as answers land; absent renders as nothing. */
  const [histories, setHistories] = useState<Record<string, VisitInfo[]>>({});
  /** The sweep's session cache: which client ids have been asked already
   *  (value null = the fetch failed; not retried this session, because a
   *  history line is not worth hammering a struggling API for). */
  const historyCache = useRef(new Map<string, VisitInfo[] | null>());
  /** Set when the roster's batched client lookup failed: waiver state is
   *  unknown on every row and rows fail open. Shown quietly. */
  const [waiverError, setWaiverError] = useState<string | null>(null);
  /**
   * How the roster is ordered on screen. A teacher-facing control, so it
   * lives on the page rather than in the dev drawer, and it persists in
   * localStorage: starts as the default, then reads the stored choice in
   * an effect so the server render and first client render agree.
   */
  const [rosterSort, setRosterSort] = useState<RosterSort>("signin");
  const skipDebounce = useRef(false);
  /** The class currently on screen, readable from inside an async fetch:
   *  a waitlist response that comes back after the teacher has switched
   *  classes must be dropped, not written into state under the new class. */
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  useEffect(() => {
    /* localStorage can throw (private mode, storage disabled); the sort
     * is a convenience and falls back to the default silently. */
    try {
      const stored = localStorage.getItem(ROSTER_SORT_KEY);
      if (stored === "signin" || stored === "last" || stored === "first") {
        setRosterSort(stored);
      }
    } catch {
      /* keep the default */
    }
  }, []);

  const pickRosterSort = useCallback((value: RosterSort) => {
    setRosterSort(value);
    try {
      localStorage.setItem(ROSTER_SORT_KEY, value);
    } catch {
      /* applies for this session anyway */
    }
  }, []);

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
      /* Same staleness rule as loadWaitlist: a roster that comes back after
       * the teacher has switched classes must not overwrite the new class's
       * entries. The capacity update below is keyed by classId and stays
       * correct either way, so only the entries write is at stake. */
      if (activeIdRef.current !== classId) return;
      if (d.error) return setError(d.error);
      setEntries(d.entries ?? []);
      setWaiverError(d.waiverError ?? null);
      setClasses((cs) =>
        cs.map((c) =>
          c.classId === classId
            ? { ...c, capacity: d.capacity ?? c.capacity, booked: d.booked ?? c.booked }
            : c,
        ),
      );
    } catch (e) {
      if (activeIdRef.current !== classId) return;
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (activeId === null) return;
    setPickerFor(null);
    setPassMsg(null);
    setCounterModal(null);
    setWaitlist(null);
    setWaitlistError(null);
    setPromoteMsg({});
    void refreshRoster(activeId);
  }, [activeId, refreshRoster]);

  /**
   * The history sweep: after a roster renders, fetch each client's recent
   * visits in the background, a few at a time, and let the rows fill in
   * as the answers land. The roster itself NEVER waits on this.
   *
   * The session cache is keyed by client id, so switching classes and
   * refreshing the roster refetch nothing, and a late answer can only
   * ever write under its own client's key -- it cannot dirty another
   * class's rows. The loop itself still stops early when the teacher
   * switches classes (activeIdRef), so a stale sweep does not keep
   * spending metered calls on a roster nobody is looking at.
   */
  useEffect(() => {
    if (activeId === null || entries.length === 0) return;
    const classId = activeId;
    const ids = [
      ...new Set(entries.map((e) => e.clientId).filter((id) => id)),
    ].filter((id) => !historyCache.current.has(id));
    if (ids.length === 0) return;
    let cancelled = false;
    let next = 0;
    const worker = async () => {
      while (!cancelled && activeIdRef.current === classId) {
        const id = ids[next++];
        if (id === undefined) return;
        /* Claim the id before fetching, so a re-run of the effect (a
         * roster refresh mid-sweep) does not fetch it twice. */
        if (historyCache.current.has(id)) continue;
        historyCache.current.set(id, null);
        try {
          const r = await fetch(
            `/api/history?clientId=${encodeURIComponent(id)}`,
          );
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
          const visits: VisitInfo[] = body?.visits ?? [];
          historyCache.current.set(id, visits);
          setHistories((h) => ({ ...h, [id]: visits }));
        } catch {
          /* Left as null in the cache: the row shows nothing, and this
           * client is not retried this session. A history line is a
           * nicety, not worth a retry storm. */
        }
      }
    };
    for (let i = 0; i < HISTORY_SWEEP_CONCURRENCY; i++) void worker();
    return () => {
      cancelled = true;
    };
  }, [entries, activeId]);

  /** Escape closes the payment dropdown (outside taps close it via its
   *  scrim). Never while a write is in flight: the answer is coming. */
  useEffect(() => {
    if (pickerFor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && passSavingId === null) setPickerFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerFor, passSavingId]);

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
      /**
       * No released waiver stops everything, before the red alert and
       * before the unpaid confirm: the tap opens the explanation and goes
       * no further. There is no override and no acknowledgement that lets
       * the tap through, unlike the red alert below, because reading past
       * a warning is a judgement call and signing a legal waiver is not.
       * Unknown (null, lookup failed) fails open and is not this branch.
       */
      if (entry.waiverSigned === false) {
        setWaiverPrompt(entry);
        return;
      }
      /**
       * A known red alert stops the tap until it is read. The alert rides
       * the roster's batched client lookup, so it is known from roster
       * load on every row. Once seen it must be explicitly read past,
       * once, before this row will check in; reading it through the row's
       * info icon deliberately does not count. The acknowledgement lives
       * in this browser session only; nothing is ever written back.
       */
      if (entry.redAlert && !acked.includes(entry.clientId)) {
        setRedAlertPrompt(entry);
        return;
      }
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
    [busy, confirming, acked, setSignedIn, settings.confirmUnpaid],
  );

  /**
   * Open the payment-change dropdown on a row, fetching the client's pass
   * list on the FIRST open only: one metered `/client/clientservices`
   * call per client per session, cached thereafter. A failed fetch is not
   * cached, so closing and reopening the dropdown is the retry path.
   */
  const openPicker = useCallback(
    (entry: RosterEntry) => {
      setPassMsg(null);
      setPickerFor(entry.clientId);
      const have = passLists[entry.clientId];
      if (have?.data || have?.loading) return;
      setPassLists((l) => ({
        ...l,
        [entry.clientId]: { data: null, error: null, loading: true },
      }));
      fetch(`/api/passes?clientId=${encodeURIComponent(entry.clientId)}`)
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
          setPassLists((l) => ({
            ...l,
            [entry.clientId]: {
              data: (body?.passes ?? []) as PassInfo[],
              error: null,
              loading: false,
            },
          }));
        })
        .catch((err) => {
          setPassLists((l) => ({
            ...l,
            [entry.clientId]: {
              data: null,
              error: err instanceof Error ? err.message : String(err),
              loading: false,
            },
          }));
        });
    },
    [passLists],
  );

  /**
   * The roster as displayed. Sorting is client-side, stable (Array.sort is
   * stable), case-insensitive, and never mutates `entries`, which stays in
   * Mindbody's sign-in order -- that IS the default option. Last-name sort
   * splits on the final space of the display name; a one-word name sorts
   * by that word. The counter modals deliberately keep sign-in order.
   */
  const sortedEntries = useMemo(() => {
    if (rosterSort === "signin") return entries;
    const key = (name: string): string => {
      const trimmed = name.trim();
      if (rosterSort === "first") return trimmed.toLowerCase();
      const cut = trimmed.lastIndexOf(" ");
      return (cut === -1 ? trimmed : trimmed.slice(cut + 1)).toLowerCase();
    };
    return [...entries].sort((a, b) => key(a.name).localeCompare(key(b.name)));
  }, [entries, rosterSort]);

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
        /* A real booking moves the person onto the roster, so the search
         * has done its job: clear it rather than leave the other matches
         * hanging under the row the teacher is about to tap. Emptying the
         * query clears the results through the search effect. Suppressed
         * writes, errors, and waitlist adds keep the results, because
         * their feedback renders on the walk-in row itself. */
        if (!waitlist) setQuery("");
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

  /**
   * Post the payment change: `{VisitId, ClientServiceId}` through the same
   * guard plumbing as check-in, then refresh the roster so the row shows
   * the new pass (refreshRoster already drops stale responses if the
   * teacher has switched classes). Non-optimistic: the picked option
   * spins until Mindbody answers. A suppressed write keeps the dropdown
   * open and says which guard fired, quietly, never as success.
   */
  const changePass = useCallback(
    async (entry: RosterEntry, clientServiceId: number) => {
      if (entry.visitId === null || passSavingId !== null) return;
      setPassSavingId(clientServiceId);
      setPassMsg(null);
      try {
        const res = await fetch("/api/visit-payment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            visitId: entry.visitId,
            clientServiceId,
            clientId: entry.clientId,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (body.suppressed) {
          setPassMsg(
            body.suppressed === "dry-run"
              ? "Dry run: change suppressed, nothing was written."
              : "Write guard: this client is not in POS_WRITE_CLIENT_IDS.",
          );
          return;
        }
        if (activeIdRef.current !== null) {
          await refreshRoster(activeIdRef.current);
        }
        setPickerFor(null);
      } catch (err) {
        setPassMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setPassSavingId(null);
      }
    },
    [passSavingId, refreshRoster],
  );

  /**
   * The payment-change dropdown, anchored under the row's payment cell.
   * Current pass checked at the top, the client's OTHER current passes as
   * options; the fake-unlimited rule applies to every line in it. An
   * unpaid booking lists everything as assignable. Closes on outside tap
   * (the scrim) and Escape; stays open across a suppressed write so the
   * notice is actually read.
   */
  const renderPassDropdown = (entry: RosterEntry) => {
    const list = passLists[entry.clientId];
    const passes = list?.data ?? null;
    const current =
      entry.clientServiceId !== null && passes
        ? (passes.find((p) => p.id === entry.clientServiceId) ?? null)
        : null;
    const others = (passes ?? []).filter(
      (p): p is PassInfo & { id: number } =>
        p.id !== null && p.id !== entry.clientServiceId,
    );
    const facts = (p: {
      remaining: number | null;
      count: number | null;
      expires: string | null;
    }): string =>
      [
        !fakeUnlimited(p.count, p.remaining) && p.remaining !== null
          ? `${p.remaining} left`
          : null,
        p.expires ? `exp ${slashDate(p.expires)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    /* The pass paying now, shown checked at the top. When the fetched
     * list does not carry it (or has not landed yet), the roster's own
     * Visit.Service data stands in, so the top line is always the truth
     * the row shows. */
    const currentLine = entry.pricingOption
      ? {
          name: current?.name ?? entry.pricingOption,
          facts: facts(
            current ?? {
              remaining: entry.passRemaining,
              count: entry.passCount,
              expires: entry.passExpires,
            },
          ),
        }
      : null;
    return (
      <>
        <div
          className="pass-scrim"
          onClick={() => {
            if (passSavingId === null) setPickerFor(null);
          }}
          role="presentation"
        />
        <div
          className="pass-dd"
          role="dialog"
          aria-label={`Change how ${entry.name} is paying`}
        >
          {passMsg ? <p className="pass-note">{passMsg}</p> : null}
          {currentLine ? (
            <div className="pass-opt current" aria-current="true">
              <span className="pass-check">
                <CheckIcon />
              </span>
              <span className="pass-opt-name">{currentLine.name}</span>
              {currentLine.facts ? (
                <span className="pass-opt-facts">{currentLine.facts}</span>
              ) : null}
            </div>
          ) : null}
          {list?.loading ? (
            <p className="pass-empty">
              <span className="spinner" aria-label="working" /> Looking up
              their passes...
            </p>
          ) : null}
          {list?.error ? (
            <p className="pass-note">Passes unavailable: {list.error}</p>
          ) : null}
          {passes && others.length === 0 ? (
            <p className="pass-empty">
              {entry.pricingOption
                ? "No other current passes."
                : "No current passes to assign."}
            </p>
          ) : null}
          {others.map((p) => {
            const saving = passSavingId === p.id;
            const line = facts(p);
            return (
              <button
                key={`opt-${p.id}`}
                className="pass-opt"
                disabled={passSavingId !== null}
                onClick={() => void changePass(entry, p.id)}
              >
                <span className="pass-check">
                  {saving ? (
                    <span className="spinner" aria-label="working" />
                  ) : null}
                </span>
                <span className="pass-opt-name">{p.name}</span>
                {line ? <span className="pass-opt-facts">{line}</span> : null}
              </button>
            );
          })}
        </div>
      </>
    );
  };

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

      {/* Studio banner: an announcement, never a status. It renders BELOW
          the mode banner and in a deliberately different shape (quiet
          surface, accent rail, no fill colour) so it cannot crowd out or be
          mistaken for the dry-run/live line above it. */}
      {config?.banner ? <p className="studio-banner">{config.banner}</p> : null}

      {error ? <p className="note">{error}</p> : null}

      {/* Quiet on purpose: waiver state failing open must not read like the
          counter is broken, only like one column of it is missing. */}
      {waiverError ? (
        <p className="muted">
          Waiver status could not be checked ({waiverError}). Rows check in as
          normal; verify new students in the Mindbody app.
        </p>
      ) : null}

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
          only for a full class. Each one taps open to the list behind it,
          which is where "is Dennis here yet" gets answered without
          scrolling the roster. */}
      {activeClass ? (
        <header className="counters" aria-label="Counts for the selected class">
          <button
            className="counter"
            onClick={() => setCounterModal("signedUp")}
            aria-haspopup="dialog"
          >
            <span className="counter-num">
              {entries.length}
              {activeClass.capacity !== null ? (
                <span className="counter-cap"> of {activeClass.capacity}</span>
              ) : null}
            </span>
            <span className="counter-label">signed up</span>
          </button>
          <button
            className="counter"
            onClick={() => setCounterModal("checkedIn")}
            aria-haspopup="dialog"
          >
            <span className="counter-num">
              {entries.filter((e) => e.checkedIn).length}
            </span>
            <span className="counter-label">checked in</span>
          </button>
          <button
            className="counter"
            onClick={() => {
              setCounterModal("waitlist");
              /* Opening the modal is the retry path after a failed fetch,
               * and the first fetch if the auto-fetch has not fired. Still
               * gated on the class being full: a class with room cannot
               * have a queue, so the metered call never fires for one. */
              if (activeId !== null && classFull && waitlist === null) {
                void loadWaitlist(activeId);
              }
            }}
            aria-haspopup="dialog"
          >
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
          </button>
        </header>
      ) : null}

      <div className="search-wrap">
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
      {query ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          onClick={() => setQuery("")}
        >
          <CloseIcon />
        </button>
      ) : null}
      </div>

      {/* Roster order, above the list it orders. Teacher-facing, so it is
          on the page (not the dev drawer), 16px+, 64px targets. */}
      {activeClass ? (
        <div className="sortbar" role="group" aria-label="Roster order">
          {ROSTER_SORTS.map((s) => (
            <button
              key={s.value}
              aria-pressed={rosterSort === s.value}
              onClick={() => pickRosterSort(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* The roster as a table, like Mindbody's own sign-in screen: one
          shared grid template so the payment, expiry, remaining and
          balance columns line up down the list, and NOTHING is behind a
          tap. The expandable row this replaced was the friction Pete asked
          to remove; detail moved into it missed the point. */}
      {sortedEntries.length > 0 ? (
        <div className="roster-head" aria-hidden="true">
          <span>Name</span>
          <span>Payment</span>
          <span>Expires</span>
          <span>Left</span>
          <span className="cell-bal">Balance</span>
          <span />
        </div>
      ) : null}

      <ul className="roster">
        {sortedEntries.map((entry) => {
          const working = busy.includes(entry.clientId);
          /* False only. Null is unknown (lookup failed) and fails open:
             no badge, normal check-in. */
          const noWaiver = entry.waiverSigned === false && !entry.checkedIn;
          /* The line under the name: an in-flight call, a failure, or a
             gate message outranks the quiet history line; with none of
             those and no history yet, nothing renders and nothing waits. */
          const statusMsg = working
            ? "Talking to Mindbody..."
            : failed[entry.clientId]
              ? failed[entry.clientId]
              : noWaiver
                ? "Needs the liability waiver. Sign it in the Mindbody app."
                : confirming.includes(entry.clientId)
                  ? "No pass on this booking. Tap again to check in for free."
                  : null;
          const visits = histories[entry.clientId];
          const history =
            statusMsg === null && visits ? historyLine(visits) : "";
          const unlimited = fakeUnlimited(entry.passCount, entry.passRemaining);
          const showRemaining =
            entry.pricingOption !== null &&
            !unlimited &&
            entry.passRemaining !== null;
          const canTap = !entry.checkedIn && !working;

          const chipClass = entry.checkedIn
            ? "chip in"
            : working
              ? "chip busy"
              : failed[entry.clientId]
                ? "chip failed"
                : noWaiver
                  ? "chip stop"
                  : confirming.includes(entry.clientId)
                    ? "chip unpaid"
                    : entry.paid
                      ? "chip action"
                      : "chip unpaid";
          const chipLabel = entry.checkedIn ? (
            "checked in"
          ) : working ? (
            <span className="spinner" aria-label="working" />
          ) : failed[entry.clientId] ? (
            "failed"
          ) : noWaiver ? (
            "no waiver"
          ) : confirming.includes(entry.clientId) ? (
            "confirm"
          ) : entry.paid ? (
            "check in"
          ) : (
            "unpaid"
          );

          return (
            <li key={entry.clientId}>
              {/* The whole row is the check-in target, same as before the
                  rework; the chip is the button a keyboard reaches. The
                  inline controls (icons, Change, undo, the Mindbody link)
                  stop the tap from bubbling into a check-in. */}
              <div
                className={canTap ? "rrow tappable" : "rrow"}
                onClick={canTap ? () => tapRow(entry) : undefined}
              >
                <div className="cell-name">
                  <span className="name-line">
                    <span className="name-text">{entry.name}</span>
                    {entry.member ? (
                      <span className="m-chip" title="Member" aria-label="Member">
                        M
                      </span>
                    ) : null}
                    {entry.redAlert ? (
                      <button
                        className="row-icon row-alert"
                        aria-label={`Red alert for ${entry.name}`}
                        title="Red alert"
                        onClick={(e) => {
                          e.stopPropagation();
                          setInfoModal({
                            title: `Red alert on ${entry.name}`,
                            text: entry.redAlert ?? "",
                            alert: true,
                          });
                        }}
                      >
                        <AlertIcon />
                      </button>
                    ) : null}
                    {entry.notes ? (
                      <button
                        className="row-icon"
                        aria-label={`Notes for ${entry.name}`}
                        title="Notes"
                        onClick={(e) => {
                          e.stopPropagation();
                          setInfoModal({
                            title: `Notes on ${entry.name}`,
                            text: entry.notes ?? "",
                            alert: false,
                          });
                        }}
                      >
                        <NotesIcon />
                      </button>
                    ) : null}
                  </span>
                  {statusMsg ? (
                    <span
                      className={
                        failed[entry.clientId] || noWaiver
                          ? "subline stop-text"
                          : "subline"
                      }
                    >
                      {statusMsg}
                    </span>
                  ) : history ? (
                    <span className="subline">{history}</span>
                  ) : null}
                </div>

                <div className="cell-pay">
                  <span
                    className={
                      entry.pricingOption ? "pay-name" : "pay-name none"
                    }
                    title={entry.pricingOption ?? undefined}
                  >
                    {entry.pricingOption ?? "No pass"}
                  </span>
                  {/* No visit id means nothing to reassign, so no control.
                      Everyone else gets the dropdown: Change swaps the
                      paying pass, Assign puts one on an unpaid booking. */}
                  {entry.visitId !== null ? (
                    <button
                      className="change-link"
                      disabled={passSavingId !== null}
                      aria-haspopup="dialog"
                      aria-expanded={pickerFor === entry.clientId}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (pickerFor === entry.clientId) {
                          if (passSavingId === null) setPickerFor(null);
                        } else {
                          openPicker(entry);
                        }
                      }}
                    >
                      {entry.pricingOption ? "Change" : "Assign"}
                    </button>
                  ) : null}
                  {pickerFor === entry.clientId
                    ? renderPassDropdown(entry)
                    : null}
                </div>

                <span className="cell-plain">
                  {entry.pricingOption && entry.passExpires
                    ? slashDate(entry.passExpires)
                    : ""}
                </span>

                {/* The fake-unlimited rule: no number is better than
                    99987. Remaining 1 is the renewal conversation that
                    happens now or never, so it stays loud. */}
                <span className="cell-plain">
                  {showRemaining ? (
                    entry.passRemaining === 1 ? (
                      <span className="detail-last">1</span>
                    ) : (
                      entry.passRemaining
                    )
                  ) : (
                    ""
                  )}
                </span>

                <span
                  className={
                    entry.balance !== null && entry.balance < 0
                      ? "cell-bal neg"
                      : "cell-bal"
                  }
                >
                  {entry.balance !== null && entry.balance !== 0
                    ? money(entry.balance)
                    : ""}
                </span>

                <div className="cell-actions">
                  {entry.checkedIn && !working ? (
                    <span className={chipClass}>{chipLabel}</span>
                  ) : (
                    <button
                      className={chipClass}
                      onClick={(e) => {
                        e.stopPropagation();
                        tapRow(entry);
                      }}
                      aria-label={`Check in ${entry.name}`}
                    >
                      {chipLabel}
                    </button>
                  )}
                  {entry.checkedIn && !working ? (
                    <button
                      className="undo-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCheckingOut(entry);
                      }}
                      aria-label={`Check out ${entry.name}`}
                      title={`Check out ${entry.name}`}
                    >
                      <CloseIcon />
                    </button>
                  ) : (
                    <span className="act-spacer" aria-hidden="true" />
                  )}
                  {/* The one thing this app deliberately does not do
                      (edit a client) is a tap away in the tool that does.
                      Opens the staff web app; the teacher must already be
                      signed in to Mindbody there. */}
                  {entry.mindbodyId ? (
                    <a
                      className="row-icon"
                      href={`https://clients.mindbodyonline.com/app/clients/${entry.mindbodyId}/client-info`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${entry.name} in Mindbody`}
                      title="Open in Mindbody"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLinkIcon />
                    </a>
                  ) : (
                    <span className="act-spacer" aria-hidden="true" />
                  )}
                </div>
              </div>
            </li>
          );
        })}

        {walkIns.map((client) => {
          const working = bookingIds.includes(client.id);
          const msg = bookMsg[client.id];
          const detail = working
            ? "Talking to Mindbody..."
            : msg ??
              [client.email, classFull ? "Class is full." : null]
                .filter(Boolean)
                .join(" - ");
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
                  {detail ? <span className="detail">{detail}</span> : null}
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
              </button>
            </li>
          );
        })}
      </ul>

      {/* The lists behind the counters. Signed up and checked in render
          from roster state already in memory, so opening them costs no
          call. The waitlist modal is the ONE place the queue appears as
          rows, reading the same `waitlist` state the counter shows, and it
          is where promotion lives: the waiting list panel this replaced
          had a second toggle for the same state, which was one source of
          truth too many. */}
      {counterModal && activeClass ? (
        <div
          className="modal-scrim"
          onClick={() => setCounterModal(null)}
          role="presentation"
        >
          <div
            className="modal modal-list"
            role="dialog"
            aria-modal="true"
            aria-label={
              counterModal === "signedUp"
                ? "Everyone signed up"
                : counterModal === "checkedIn"
                  ? "Everyone checked in"
                  : "The waiting list"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">
              {counterModal === "signedUp"
                ? `Signed up (${entries.length}${
                    activeClass.capacity !== null
                      ? ` of ${activeClass.capacity}`
                      : ""
                  })`
                : counterModal === "checkedIn"
                  ? `Checked in (${entries.filter((e) => e.checkedIn).length} of ${entries.length})`
                  : `Waiting list${waitlist !== null ? ` (${waitlist.length})` : ""}`}
            </p>

            {counterModal === "signedUp" ? (
              entries.length === 0 ? (
                <p className="muted">Nobody is signed up yet.</p>
              ) : (
                <ul className="roster modal-roster">
                  {entries.map((entry) => (
                    <li key={`m-su-${entry.clientId}`}>
                      <div className="row">
                        <span className="name">
                          {entry.name}
                          <span className="detail">
                            {entry.pricingOption ?? "No pass on this booking"}
                          </span>
                        </span>
                        <span
                          className={entry.checkedIn ? "chip in" : "chip out"}
                        >
                          {entry.checkedIn ? "checked in" : "not yet"}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}

            {counterModal === "checkedIn" ? (
              entries.filter((e) => e.checkedIn).length === 0 ? (
                <p className="muted">Nobody is checked in yet.</p>
              ) : (
                <ul className="roster modal-roster">
                  {entries
                    .filter((e) => e.checkedIn)
                    .map((entry) => (
                      <li key={`m-ci-${entry.clientId}`}>
                        <div className="row">
                          <span className="name">
                            {entry.name}
                            <span className="detail">
                              {entry.pricingOption ?? "No pass on this booking"}
                            </span>
                          </span>
                          <span className="chip in">checked in</span>
                        </div>
                      </li>
                    ))}
                </ul>
              )
            ) : null}

            {counterModal === "waitlist" ? (
              <>
                {waitlistError ? <p className="note">{waitlistError}</p> : null}
                {waitlist === null && !waitlistError && classFull ? (
                  <p className="muted">Loading the waiting list...</p>
                ) : null}
                {(waitlist !== null && waitlist.length === 0) ||
                (waitlist === null && !classFull && !waitlistError) ? (
                  <p className="muted">Nobody is waiting.</p>
                ) : null}
                {waitlist !== null && waitlist.length > 0 ? (
                  <ul className="roster modal-roster">
                    {waitlist.map((row) => {
                      const working = promoting.includes(row.entryId);
                      const msg = promoteMsg[row.entryId];
                      return (
                        <li key={`m-wl-${row.entryId}`}>
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
                            <span
                              className={working ? "chip busy" : "chip action"}
                            >
                              {working ? (
                                <span className="spinner" aria-label="working" />
                              ) : (
                                "promote"
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </>
            ) : null}

            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setCounterModal(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* The row icons' read-only text: the red alert or the staff notes,
          one Close button, nothing else. Deliberately NOT the check-in
          gate: reading an alert here does not acknowledge it, so a
          flagged row's check-in tap still stops at the blocking dialog
          below. */}
      {infoModal ? (
        <div
          className="modal-scrim"
          onClick={() => setInfoModal(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={infoModal.title}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">{infoModal.title}</p>
            <p
              className={
                infoModal.alert ? "ctx-alert modal-alert" : "modal-note"
              }
            >
              {infoModal.text}
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setInfoModal(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* A red alert is Mindbody's own "stop and read this" flag, so a
          row known to carry one does not check in on reflex: the tap stops
          here until the teacher has read the alert and chosen to continue.
          The acknowledgement is this browser session's state only; nothing
          is written back to Mindbody, and cancelling leaves the row
          exactly as it was. */}
      {redAlertPrompt ? (
        <div
          className="modal-scrim"
          onClick={() => setRedAlertPrompt(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-label="Red alert on this client"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">
              Red alert on {redAlertPrompt.name}
            </p>
            <p className="ctx-alert modal-alert">
              {redAlertPrompt.redAlert ?? "The studio flagged this client."}
            </p>
            <p className="muted">
              The studio flagged this deliberately. Read it before letting
              them into class.
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setRedAlertPrompt(null)}
              >
                Cancel
              </button>
              <button
                className="modal-confirm"
                onClick={() => {
                  const entry = redAlertPrompt;
                  setRedAlertPrompt(null);
                  setAcked((a) =>
                    a.includes(entry.clientId) ? a : [...a, entry.clientId],
                  );
                  /* Past the alert, the normal rules resume: an unpaid
                     booking still takes its own confirming tap. */
                  if (settings.confirmUnpaid && !entry.paid) {
                    setConfirming((c) =>
                      c.includes(entry.clientId) ? c : [...c, entry.clientId],
                    );
                    return;
                  }
                  void setSignedIn(entry, true);
                }}
              >
                I have read it, check in
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* No released waiver: the tap ends here. One button, Close. There is
          deliberately no "mark it signed" and no "check in anyway": a staff
          tap that flips LiabilityRelease manufactures a legal record of an
          agreement the student may never have read (design doc, "Waiver
          status"). Phase 3 puts the actual waiver on the student's own
          phone; until then it is signed in the Mindbody app, outside this
          screen. */}
      {waiverPrompt ? (
        <div
          className="modal-scrim"
          onClick={() => setWaiverPrompt(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-label="Liability waiver needed"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">
              {waiverPrompt.name} has not signed the waiver
            </p>
            <p className="ctx-alert modal-alert">
              No liability waiver on file. They cannot be checked in from
              here until it is signed.
            </p>
            <p className="muted">
              Have them sign it in the Mindbody app first. This screen cannot
              mark a waiver signed on their behalf, and once it is signed the
              row will check in normally.
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setWaiverPrompt(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
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
