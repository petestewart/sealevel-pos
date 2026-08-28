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
interface CtxSection<T> {
  data: T | null;
  error: string | null;
}

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

interface ClientContext {
  passes: CtxSection<PassInfo[]>;
  balance: CtxSection<number>;
  visits: CtxSection<VisitInfo[]>;
  habits: CtxSection<string[]>;
  profile: CtxSection<{ notes: string | null; redAlert: string | null }>;
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

/** Warning triangle for the red alert line; the dialog spells it out. */
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

/** Note sheet for the client's Notes field. */
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

/** Clock with a counter-clockwise arrow for the recent-visits lines. */
function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        d="M4.5 5.5v4h4"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        d="M4.9 9.2a8 8 0 1 1-.4 4"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        d="M12 8v4.4l3 1.8"
      />
    </svg>
  );
}

/** Chevron for the per-row context toggle; rotates when the row is open. */
function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M6 9l6 6 6-6"
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
 */
function historyLine(visits: VisitInfo[], now = new Date()): string {
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  const day = weekStart.getDay(); /* 0 = Sunday */
  weekStart.setDate(weekStart.getDate() - ((day + 6) % 7));
  const thisWeek = visits.filter((v) => new Date(v.at) >= weekStart).length;
  if (thisWeek >= 2) return `${nth(thisWeek)} class this week.`;
  const monthStart = new Date(now.getTime() - 30 * DAY_MS);
  const month = visits.filter((v) => new Date(v.at) >= monthStart).length;
  if (month >= 2) return `${month} visits in the last month.`;
  const latest = visits[0];
  if (latest) return `Last here ${shortDate(latest.at)}.`;
  return "No visits in the last month.";
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
 */
function fakeUnlimited(count: number | null): boolean {
  return count !== null && count >= 100;
}

/**
 * What the person is paying with, on the row itself: pass name, remaining,
 * expiry, balance. Secondary details, scannable at arm's length -- except
 * "1 left", which is the renewal conversation that happens now or never
 * and gets the loud warn treatment.
 */
function PassLine({ entry }: { entry: RosterEntry }) {
  const unlimited = fakeUnlimited(entry.passCount);
  const showRemaining =
    entry.pricingOption !== null && !unlimited && entry.passRemaining !== null;
  const balance =
    entry.balance !== null && entry.balance !== 0 ? entry.balance : null;
  return (
    <>
      {entry.pricingOption ?? "No pass on this booking"}
      {showRemaining ? (
        <span className={entry.passRemaining === 1 ? "detail-last" : undefined}>
          {" "}
          &middot; {entry.passRemaining} left
        </span>
      ) : null}
      {entry.pricingOption !== null && entry.passExpires ? (
        <> &middot; exp {slashDate(entry.passExpires)}</>
      ) : null}
      {balance !== null ? <> &middot; {money(balance)} balance</> : null}
    </>
  );
}

/**
 * Badges beside the name: the membership chip, and the red alert's icon so
 * a flagged row is visibly flagged before anyone taps it (the tap gate
 * already existed; this makes it not a surprise).
 */
function NameBadges({ entry }: { entry: RosterEntry }) {
  return (
    <>
      {entry.member ? (
        <span className="m-chip" title="Member" aria-label="Member">
          M
        </span>
      ) : null}
      {entry.redAlert ? (
        <span className="row-alert" title="Red alert" aria-label="Red alert">
          <AlertIcon />
        </span>
      ) : null}
    </>
  );
}

/**
 * The pass list answers "what are they paying with", not "everything on
 * account" (sandbox clients own eight passes; the Mindbody link below the
 * list is the escape hatch). The pass this visit is booked against sorts
 * first, identical lines collapse with a count, and the list caps at four.
 */
const PASS_DISPLAY_CAP = 4;

function passLines(
  passes: PassInfo[],
  inUse: string | null,
): { lines: { text: string; dupes: number }[]; more: number } {
  const ordered = inUse
    ? [...passes].sort(
        (a, b) => Number(b.name === inUse) - Number(a.name === inUse),
      )
    : passes;
  const lines: { text: string; dupes: number }[] = [];
  const seen = new Map<string, number>();
  for (const p of ordered) {
    const text =
      p.name +
      (p.remaining !== null
        ? `: ${p.remaining}${p.count !== null ? ` of ${p.count}` : ""} left`
        : "") +
      (p.expires ? `, expires ${shortDate(p.expires)}` : "");
    const at = seen.get(text);
    if (at !== undefined) {
      const line = lines[at];
      if (line) line.dupes += 1;
      continue;
    }
    seen.set(text, lines.length);
    lines.push({ text, dupes: 1 });
  }
  const shown = lines.slice(0, PASS_DISPLAY_CAP);
  const more = lines.length - shown.length;
  return { lines: shown, more };
}

function money(n: number): string {
  return n.toLocaleString([], {
    style: "currency",
    currency: "USD",
  });
}

/**
 * What the teacher should know about the person in front of them, on one
 * open row: red alert, notes, the pass and what remains on it, account
 * credit, recent visits, habitual add-ons. Opens instantly with a spinner;
 * each section renders its own error as text, because a purchases outage
 * must not hide the red alert, and no error here ever blocks check-in.
 */
function ContextPanel({
  ctx,
  loading,
  error,
  mindbodyId,
  passInUse,
  onChangePass,
  canChangePass,
}: {
  ctx: ClientContext | undefined;
  loading: boolean;
  error: string | undefined;
  mindbodyId: number | null;
  passInUse: string | null;
  /** Opens the pass picker. null hides the affordance entirely (fewer
   *  than two current passes to choose between, so nothing to change). */
  onChangePass: (() => void) | null;
  /** False when the row has no visit id: the affordance renders disabled,
   *  because there is no visit to reassign a pass to. */
  canChangePass: boolean;
}) {
  /* The one thing this app deliberately does not do (edit a client) is a
   * tap away in the tool that does. Opens the staff web app; the teacher
   * must already be signed in to Mindbody there. */
  const mbLink = mindbodyId ? (
    <a
      className="mb-link"
      href={`https://clients.mindbodyonline.com/app/clients/${mindbodyId}/client-info`}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open in Mindbody
    </a>
  ) : null;
  if (loading || (!ctx && !error)) {
    return (
      <div className="context">
        <span className="ctx-line muted">
          <span className="spinner" aria-label="working" /> Looking them up...
        </span>
        {mbLink}
      </div>
    );
  }
  if (!ctx) {
    return (
      <div className="context">
        <span className="ctx-line ctx-err">Could not load details: {error}</span>
        {mbLink}
      </div>
    );
  }

  const passes = ctx.passes.data ?? [];
  const lastClass = passes.some((p) => p.remaining === 1);
  const balance = ctx.balance.data;
  const visits = ctx.visits.data;
  const habits = ctx.habits.data ?? [];
  const profile = ctx.profile.data;

  return (
    <div className="context">
      {profile?.redAlert ? (
        <span className="ctx-alert">
          <AlertIcon /> {profile.redAlert}
        </span>
      ) : null}
      {ctx.profile.error ? (
        <span className="ctx-line ctx-err">
          Notes and alerts unavailable: {ctx.profile.error}
        </span>
      ) : null}
      {profile?.notes ? (
        <span className="ctx-line ctx-iconed">
          <NotesIcon /> {profile.notes}
        </span>
      ) : null}

      {/* Remaining: 1 is the highest-value prompt in the app: the renewal
          conversation happens now or not at all. It gets the loud warn
          treatment, not a line in a list. */}
      {lastClass ? (
        <span className="ctx-warn">
          This is the last class on their pass. Offer the renewal now.
        </span>
      ) : null}
      {ctx.passes.error ? (
        <span className="ctx-line ctx-err">
          Passes unavailable: {ctx.passes.error}
        </span>
      ) : passes.length === 0 ? (
        <span className="ctx-line muted">No active pass.</span>
      ) : (
        (() => {
          const trimmed = passLines(passes, passInUse);
          return (
            <>
              {trimmed.lines.map((line) => (
                <span className="ctx-line" key={line.text}>
                  {line.text}
                  {line.dupes > 1 ? ` (x${line.dupes})` : ""}
                </span>
              ))}
              {trimmed.more > 0 ? (
                <span className="ctx-line muted">
                  And {trimmed.more} more in Mindbody.
                </span>
              ) : null}
            </>
          );
        })()
      )}
      {/* More than one current pass means "which one pays" is a real
          question, so the picker is a tap away. Disabled rather than
          hidden when the row has no visit id: the reason nothing can
          change is worth a glance, not a mystery. */}
      {onChangePass ? (
        <button
          className="change-btn"
          onClick={onChangePass}
          disabled={!canChangePass}
        >
          Change which pass pays
        </button>
      ) : null}
      {onChangePass && !canChangePass ? (
        <span className="ctx-line muted">
          No visit id on this booking, so the payment cannot be changed here.
        </span>
      ) : null}

      {ctx.balance.error ? (
        <span className="ctx-line ctx-err">
          Account credit unavailable: {ctx.balance.error}
        </span>
      ) : balance !== null && balance !== 0 ? (
        <span className="ctx-line">Account credit: {money(balance)}.</span>
      ) : null}

      {ctx.visits.error ? (
        <span className="ctx-line ctx-err">
          Visits unavailable: {ctx.visits.error}
        </span>
      ) : visits ? (
        /* ONE line, highest signal wins: streak this week, else monthly
           count, else last seen, else nothing recent. One line means one
           line. */
        <span className="ctx-line ctx-iconed">
          <HistoryIcon /> {historyLine(visits)}
        </span>
      ) : null}

      {/* Habitual add-ons need a real pattern (3 of the last 5 sales) or
          they are noise; with no pattern this whole section is nothing. */}
      {ctx.habits.error ? (
        <span className="ctx-line ctx-err">
          Purchase history unavailable: {ctx.habits.error}
        </span>
      ) : habits.length > 0 ? (
        <span className="ctx-line ctx-habit">
          Usually adds: {habits.join(", ")}. Worth asking.
        </span>
      ) : null}
      {mbLink}
    </div>
  );
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
  /** The one roster row whose context panel is open. One at a time: the
   *  panel answers "who is in front of me", and one person is in front. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Fetched context per client id, kept for the session so re-opening a
   *  row is free. Four metered calls per entry is why this is per-open,
   *  never per-roster. */
  const [contexts, setContexts] = useState<Record<string, ClientContext>>({});
  const [ctxLoading, setCtxLoading] = useState<string[]>([]);
  const [ctxError, setCtxError] = useState<Record<string, string>>({});
  /** Red alerts a teacher has explicitly read past, by client id. UI state
   *  only, deliberately: acknowledging an alert must never write anything
   *  back to Mindbody. */
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
  /** The row whose pass picker (change how they are paying) is open. */
  const [passPicker, setPassPicker] = useState<RosterEntry | null>(null);
  /** The pass id being written, if any. Non-optimistic, like check-in:
   *  which pass a class burns is money-adjacent, so the picker spins until
   *  Mindbody answers. */
  const [passSavingId, setPassSavingId] = useState<number | null>(null);
  /** Outcome text inside the picker: a failure, or the quiet suppression
   *  notice when dry run or the write guard stopped the write. */
  const [passMsg, setPassMsg] = useState<string | null>(null);
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
    setExpandedId(null);
    setCounterModal(null);
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
       * the roster's batched client lookup now, so it is known from roster
       * load on every row, unopened ones included; the context fetch is
       * the fallback for the rare row the batch missed. Once seen it must
       * be explicitly read past, once, before this row will check in. The
       * acknowledgement lives in this browser session only; nothing is
       * ever written back.
       */
      const redAlert =
        entry.redAlert ?? contexts[entry.clientId]?.profile.data?.redAlert;
      if (redAlert && !acked.includes(entry.clientId)) {
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
    [busy, confirming, contexts, acked, setSignedIn, settings.confirmUnpaid],
  );

  /**
   * Open or close the context panel on a row. Its own 64px control, NOT the
   * row tap: check-in is the app's whole point and stays one tap on the row
   * body. The panel opens instantly with a spinner and the batched fetch
   * fills it in; a failure renders as text in the panel and never blocks
   * check-in, because the fallback for "context is down" is the counter
   * working exactly as it did before this feature existed.
   */
  const toggleContext = useCallback(
    (clientId: string) => {
      if (expandedId === clientId) {
        setExpandedId(null);
        return;
      }
      setExpandedId(clientId);
      if (contexts[clientId] || ctxLoading.includes(clientId)) return;
      setCtxLoading((l) => [...l, clientId]);
      setCtxError((e) => {
        const { [clientId]: _drop, ...rest } = e;
        return rest;
      });
      fetch(`/api/client-context?clientId=${encodeURIComponent(clientId)}`)
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
          setContexts((c) => ({ ...c, [clientId]: body as ClientContext }));
        })
        .catch((err) => {
          setCtxError((e) => ({
            ...e,
            [clientId]: err instanceof Error ? err.message : String(err),
          }));
        })
        .finally(() => {
          setCtxLoading((l) => l.filter((id) => id !== clientId));
        });
    },
    [expandedId, contexts, ctxLoading],
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
   * teacher has switched classes). A suppressed write keeps the picker
   * open and says which guard fired, exactly like the booking path.
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
        setPassPicker(null);
      } catch (err) {
        setPassMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setPassSavingId(null);
      }
    },
    [passSavingId, refreshRoster],
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

      <ul className="roster">
        {sortedEntries.map((entry) => {
          const working = busy.includes(entry.clientId);
          /* False only. Null is unknown (lookup failed) and fails open:
             no badge, normal check-in. */
          const noWaiver = entry.waiverSigned === false && !entry.checkedIn;
          const detail = working
            ? "Talking to Mindbody..."
            : failed[entry.clientId]
              ? failed[entry.clientId]
              : noWaiver
                ? "Needs the liability waiver. Sign it in the Mindbody app."
                : confirming.includes(entry.clientId)
                  ? "No pass on this booking. Tap again to check in for free."
                  : /* The quiet case: what the Mindbody sign-in screen
                       shows per row, with no extra taps. */
                    <PassLine entry={entry} />;

          const open = expandedId === entry.clientId;
          /* The context toggle: its own control, so opening details never
             costs the check-in tap a second gesture. */
          const infoBtn = (
            <button
              className="info-btn"
              onClick={() => toggleContext(entry.clientId)}
              aria-expanded={open}
              aria-label={
                open
                  ? `Hide details for ${entry.name}`
                  : `Show details for ${entry.name}`
              }
              title={open ? "Hide details" : "Show details"}
            >
              <ChevronIcon />
            </button>
          );
          /* The picker only exists when there is a real choice: two or
             more current passes with ids the API can assign. The pass
             list is the one already fetched on row open; no new read. */
          const pickablePasses = (
            contexts[entry.clientId]?.passes.data ?? []
          ).filter((p) => p.id !== null);
          const panel = open ? (
            <ContextPanel
              ctx={contexts[entry.clientId]}
              loading={ctxLoading.includes(entry.clientId)}
              error={ctxError[entry.clientId]}
              mindbodyId={entry.mindbodyId}
              passInUse={entry.pricingOption}
              onChangePass={
                pickablePasses.length > 1
                  ? () => {
                      setPassMsg(null);
                      setPassPicker(entry);
                    }
                  : null
              }
              canChangePass={entry.visitId !== null}
            />
          ) : null;

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
                  <span className="row-main">
                    <span className="name">
                      {entry.name}
                      <NameBadges entry={entry} />
                      <span className="detail">{detail}</span>
                    </span>
                    <span className="chip in">checked in</span>
                  </span>
                  {infoBtn}
                  <button
                    className="undo-btn"
                    onClick={() => setCheckingOut(entry)}
                    aria-label={`Check out ${entry.name}`}
                    title={`Check out ${entry.name}`}
                  >
                    <CloseIcon />
                  </button>
                </div>
                {panel}
              </li>
            );
          }

          return (
            <li key={entry.clientId}>
              <div className="row">
                {/* Check-in stays ONE tap on the row body. The context
                    toggle sits outside this button, so knowing more about
                    someone is optional and checking them in never waits
                    on it. */}
                <button className="row-main" onClick={() => tapRow(entry)}>
                  <span className="name">
                    {entry.name}
                    <NameBadges entry={entry} />
                    <span className="detail">{detail}</span>
                  </span>
                  {/* The no-waiver chip outranks everything but an
                      in-flight call or a failure: it is the blocked state
                      the teacher must see before their thumb lands. */}
                  <span
                    className={
                      working
                        ? "chip busy"
                        : failed[entry.clientId]
                          ? "chip failed"
                          : noWaiver
                            ? "chip stop"
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
                    ) : noWaiver ? (
                      "no waiver"
                    ) : confirming.includes(entry.clientId) ? (
                      "confirm"
                    ) : entry.paid ? (
                      "check in"
                    ) : (
                      "unpaid"
                    )}
                  </span>
                </button>
                {infoBtn}
                {/* Holds the space the undo control occupies on a checked-in
                    row, so chips stay in one column down the list. */}
                <span className="undo-spacer" aria-hidden="true" />
              </div>
              {panel}
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
                {/* Walk-in rows have no info button, so the chip needs its
                    width made up or the pill drifts out of the chip column
                    the roster rows establish. */}
                <span className="info-spacer" aria-hidden="true" />
                <span className="undo-spacer" aria-hidden="true" />
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
              {redAlertPrompt.redAlert ??
                contexts[redAlertPrompt.clientId]?.profile.data?.redAlert ??
                "The studio flagged this client."}
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

      {/* Mindbody's "Change how the client is paying": every current pass
          on the account, tap one to make it pay for this visit. The list
          is the context fetch already in memory. Writing is
          non-optimistic and the modal survives a suppressed write so the
          notice is actually read. */}
      {passPicker ? (
        <div
          className="modal-scrim"
          onClick={() => {
            if (passSavingId === null) setPassPicker(null);
          }}
          role="presentation"
        >
          <div
            className="modal modal-list"
            role="dialog"
            aria-modal="true"
            aria-label="Change which pass pays"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">
              Change how {passPicker.name} is paying
            </p>
            {passMsg ? <p className="note">{passMsg}</p> : null}
            <ul className="roster modal-roster">
              {(contexts[passPicker.clientId]?.passes.data ?? [])
                .filter((p): p is PassInfo & { id: number } => p.id !== null)
                .map((p) => {
                  const working = passSavingId === p.id;
                  const inUse =
                    passPicker.clientServiceId !== null &&
                    p.id === passPicker.clientServiceId;
                  const facts = [
                    !fakeUnlimited(p.count) && p.remaining !== null
                      ? `${p.remaining} left`
                      : null,
                    p.expires ? `exp ${slashDate(p.expires)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={`pass-${p.id}`}>
                      <button
                        className="row"
                        disabled={inUse || passSavingId !== null}
                        onClick={() => void changePass(passPicker, p.id)}
                      >
                        <span className="name">
                          {p.name}
                          {facts ? (
                            <span className="detail">{facts}</span>
                          ) : null}
                        </span>
                        <span
                          className={
                            working
                              ? "chip busy"
                              : inUse
                                ? "chip in"
                                : "chip action"
                          }
                        >
                          {working ? (
                            <span className="spinner" aria-label="working" />
                          ) : inUse ? (
                            "paying now"
                          ) : (
                            "use this"
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
            </ul>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                disabled={passSavingId !== null}
                onClick={() => setPassPicker(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <DevDrawer />
    </main>
  );
}
