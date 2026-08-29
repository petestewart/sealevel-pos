"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

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

/** Mirrors src/lib/clients.ts: the context fields ride the searchText
 *  response for free (full Client records), parsed the same way as the
 *  roster's batched lookup. */
interface SearchResult {
  id: string;
  name: string;
  email: string | null;
  waiverSigned: boolean;
  redAlert: string | null;
  balance: number | null;
  member: boolean;
  notes: string | null;
  mindbodyId: number | null;
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

/** X, for clearing the search box. */
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

/** Counter-clockwise arrow: check-out is undoing a check-in, and the icon
 *  says so. Grey and unlabelled: the quiet action on the row, deliberately
 *  separate from the check-in gesture. */
function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M3.5 4.5v6h6"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M5.1 15.2a8 8 0 1 0 1.7-8.6L3.5 10.5"
      />
    </svg>
  );
}

/** Trash can: cancels the booking itself, behind a confirmation. */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5 7.5 20h9l1-13.5"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M10 10.5v6M14 10.5v6"
      />
    </svg>
  );
}

/** Plus sign: the add action on a search-result row (books, or offers the
 *  waiting list on a full class -- the aria-label says which). */
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        d="M12 5v14M5 12h14"
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

/** Paired up/down arrows: opens the roster-order menu. */
function SortIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M8 19V5M8 5 4.5 8.5M8 5l3.5 3.5"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M16 5v14M16 19l-3.5-3.5M16 19l3.5-3.5"
      />
    </svg>
  );
}

/** Pencil: switches the notes modal into its editing state. */
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M15.5 4.5 19.5 8.5 8 20H4v-4Z"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M13 7l4 4"
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

/** Chevron opening the payment-change dropdown on a roster row. */
function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M5.5 9.5 12 16l6.5-6.5"
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

/** "Fri Aug 28": weekday and date for the class header. Joined by hand so
 *  the locale's comma does not creep in. */
function dayDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${d.toLocaleDateString(
    [],
    { month: "short", day: "numeric" },
  )}`;
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
 * The visit history as ONE line, highest signal first, and the week wins:
 * any visit in the trailing seven days beats the monthly count beats a
 * last-seen date. Trailing days, not the calendar week: on a Monday the
 * calendar week is empty by definition and the line kept saying "4 visits
 * in the last month" about someone who was here yesterday. The server
 * window is ~35 days; the monthly count re-filters to a strict 30 so "in
 * the last month" is not quietly five weeks.
 *
 * No visits returns "" and the row shows nothing: on a panel "no visits"
 * was an answer, but on every new client's row it is noise.
 */
function historyLine(visits: VisitInfo[], now = new Date()): string {
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);
  const thisWeek = visits.filter((v) => new Date(v.at) >= weekStart).length;
  if (thisWeek >= 2) return `${nth(thisWeek)} class this week`;
  if (thisWeek === 1) return "1 visit this week";
  const monthStart = new Date(now.getTime() - 30 * DAY_MS);
  const month = visits.filter((v) => new Date(v.at) >= monthStart).length;
  if (month >= 2) return `${month} visits in the last month`;
  const latest = visits[0];
  if (latest) return `Last here ${shortDate(latest.at)}`;
  return "";
}

/**
 * Mindbody pass names carry back-office qualifiers the counter does not
 * need: "Monthly Membership - Gym Access (Auto-Renew)" is one pass, and
 * on a roster row it truncated to "Monthly Membersh...". Shorten
 * deterministically instead of shrinking text below the 16px floor:
 * strip parenthetical qualifiers, drop everything after " - ", collapse
 * the whitespace that leaves behind. If stripping eats the whole name
 * (a name that is ONLY a parenthetical), fall back to the full name.
 * Everywhere a pass renders on a row uses this; the dropdown shows the
 * full name as a second muted line when the short form dropped text.
 */
function shortPassName(name: string): string {
  const cut = (name.replace(/\s*\([^)]*\)/g, " ").split(" - ")[0] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return cut || name.replace(/\s+/g, " ").trim();
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

/**
 * The right-aligned fact columns shared by every pass-dropdown row (the
 * roster's payment change and the search modal's pass picker), so "4 left"
 * and the expiry line up vertically down the list. Empty string keeps the
 * column's slot so alignment holds; the fake-unlimited rule applies.
 */
function passLeftCol(p: {
  remaining: number | null;
  count: number | null;
}): string {
  return !fakeUnlimited(p.count, p.remaining) && p.remaining !== null
    ? `${p.remaining} left`
    : "";
}

function passExpCol(p: { expires: string | null }): string {
  return p.expires ? `exp ${slashDate(p.expires)}` : "";
}

/**
 * The pass facts as ONE sub-line under the pass name, everywhere a pass
 * renders two-line (roster payment cell, walk-in summaries): "3 remaining,
 * exp 3/2/27"; a fake-unlimited pass shows only the expiry; nothing known,
 * no line. "1 remaining" keeps the warn pill: it is the renewal
 * conversation that happens now or never, so it stays loud even in a
 * sub-line.
 */
function PassFactsLine(props: {
  remaining: number | null;
  count: number | null;
  expires: string | null;
}) {
  const showRemaining =
    !fakeUnlimited(props.count, props.remaining) && props.remaining !== null;
  const exp = props.expires ? `exp ${slashDate(props.expires)}` : null;
  if (!showRemaining && !exp) return null;
  return (
    <span className="pass-facts">
      {showRemaining ? (
        props.remaining === 1 ? (
          <span className="detail-last">1 remaining</span>
        ) : (
          `${props.remaining} remaining`
        )
      ) : null}
      {showRemaining && exp ? ", " : null}
      {exp}
    </span>
  );
}

function money(n: number): string {
  return n.toLocaleString([], {
    style: "currency",
    currency: "USD",
  });
}

function FrontDesk() {
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
  /** Whether the search-results modal is open. */
  const [searchOpen, setSearchOpen] = useState(false);
  /** The query as submitted, for the modal's title: `query` keeps moving
   *  with the input while the modal shows what was actually searched. */
  const [searchTitle, setSearchTitle] = useState("");
  /** The quiet under-the-input message when a submit is too short. */
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  /** A failed search, shown inside the modal. */
  const [searchError, setSearchError] = useState<string | null>(null);
  /** The row awaiting a confirmed check-out, if any. */
  const [checkingOut, setCheckingOut] = useState<RosterEntry | null>(null);
  /** The row awaiting a confirmed booking cancellation, if any, WITH the
   *  class id the dialog was opened under: the write must name that class,
   *  never whatever activeId is by the time the confirm lands. */
  const [cancelling, setCancelling] = useState<{
    entry: RosterEntry;
    classId: number;
  } | null>(null);
  /** True while the cancellation write is in flight: the dialog's confirm
   *  button spins and the dialog refuses to close until Mindbody answers.
   *  Non-optimistic, same reasoning as check-in: a teacher who saw the row
   *  vanish believes the booking is gone. */
  const [cancelBusy, setCancelBusy] = useState(false);
  /** Outcome text inside the cancel dialog: a failure, or the suppression
   *  notice when dry run or the write guard stopped the write. Never
   *  rendered as success. */
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
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
  /** A red-alert walk-in whose ADD is held behind the unread alert, same
   *  contract as the roster's check-in gate: blocking dialog, explicit
   *  "I have read it", session-only acknowledgement, nothing written. */
  const [walkinAlertPrompt, setWalkinAlertPrompt] =
    useState<SearchResult | null>(null);
  /** Per-result chosen pass (ClientServiceId), from the search modal's
   *  pass picker. LOCAL selection only: picking writes nothing and books
   *  nothing -- the "+" tap is the one action, and it sends the choice on
   *  the booking call. Absent means no explicit choice, which books
   *  exactly as before. Reset when the modal closes or a new search
   *  lands. */
  const [walkinPassChoice, setWalkinPassChoice] = useState<
    Record<string, number>
  >({});
  /** The open pass picker in the search modal: which result, and where.
   *  The coordinates are captured from the row when the chevron is
   *  tapped, because the dropdown renders position: fixed -- the modal's
   *  results list scrolls (overflow-y), and a row-anchored absolute
   *  dropdown would be clipped at its edge; a fixed element escapes
   *  ancestor overflow entirely, same solution family as the roster
   *  dropdown's escape-the-cell anchoring. Scrolling the list closes it
   *  rather than letting it drift off its row. */
  const [walkinPicker, setWalkinPicker] = useState<{
    id: string;
    top: number;
    right: number;
    /** Viewport room below `top`, applied inline so the picker can never
     *  run off the bottom even when a wrapped pass name makes it taller
     *  than the open-time estimate. */
    maxHeight: number;
  } | null>(null);
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
   * opens can now resolve it at the counter (T18, Pete's recorded
   * reversal of T6's "no tap path marks a waiver signed": Mindbody's own
   * POS shows the waiver text with a staff-tappable Resolve, so this
   * matches the studio's existing tool rather than creating a new risk).
   * The discipline survives the reversal: `LiabilityRelease: true` is
   * written ONLY after the real waiver text was fetched, rendered, and
   * scrolled to the end, and the confirm is worded as recording the
   * STUDENT's agreement. If the text cannot be fetched, the dialog falls
   * back to the old close-only shape -- no path records agreement without
   * the text having been shown. The QR-on-their-phone flow remains the
   * Phase 3 end state.
   */
  const [waiverPrompt, setWaiverPrompt] = useState<RosterEntry | null>(null);
  /** The waiver text as served, with the sha256 of exactly that text
   *  (from /api/waiver) so the agreement receipt names what was shown.
   *  Non-null switches the dialog into its reading state. */
  const [waiverText, setWaiverText] = useState<{
    text: string;
    sha256: string;
  } | null>(null);
  /** True while the waiver text fetch is in flight. */
  const [waiverLoading, setWaiverLoading] = useState(false);
  /** A failed waiver fetch: the dialog shows the close-only fallback with
   *  this quiet reason. */
  const [waiverFetchError, setWaiverFetchError] = useState<string | null>(
    null,
  );
  /** True once the reading region has been scrolled to the bottom (or the
   *  text fits without scrolling). The confirm is disabled until then. */
  const [waiverScrolled, setWaiverScrolled] = useState(false);
  /** True while the release write is in flight. Non-optimistic, like
   *  every write here: the confirm spins until Mindbody answers, and the
   *  dialog refuses to close meanwhile. */
  const [waiverSaving, setWaiverSaving] = useState(false);
  /** Outcome text inside the waiver dialog: a failure, or the suppression
   *  notice when dry run or the write guard stopped the release write.
   *  Never rendered as success. */
  const [waiverMsg, setWaiverMsg] = useState<string | null>(null);
  /** Quiet page-level warning when the agreement stood but the Notes
   *  receipt did not land (the structured server log line did). */
  const [waiverReceiptWarn, setWaiverReceiptWarn] = useState<string | null>(
    null,
  );
  /** The scrollable waiver text region, for the fits-without-scrolling
   *  check once the text renders. */
  const waiverScrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * Read-only text behind a row icon: the red alert or the staff notes.
   * Informational only, one Close button, and it never acks the alert for
   * the check-in gate -- reading is not the same act as reading PAST.
   */
  const [infoModal, setInfoModal] = useState<{
    title: string;
    text: string;
    alert: boolean;
    /** Set on the NOTES modal only: the client whose notes these are,
     *  which is what makes the pencil render. The alert modal never sets
     *  it, so an alert stays strictly read-only. */
    notesClientId?: string;
  } | null>(null);
  /** True while the notes modal is in its editing state. */
  const [notesEditing, setNotesEditing] = useState(false);
  /** The textarea's contents while editing notes. */
  const [notesDraft, setNotesDraft] = useState("");
  /** True while the notes save is in flight. Non-optimistic, like every
   *  write here: the Save button spins until Mindbody answers, and the
   *  modal refuses to close meanwhile. */
  const [notesSaving, setNotesSaving] = useState(false);
  /** Outcome text inside the notes modal: a failure, or the suppression
   *  notice when dry run or the write guard stopped the save. */
  const [notesMsg, setNotesMsg] = useState<string | null>(null);
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
  /** The sweep's claim ledger for pass fetches, same shape as the history
   *  cache: which client ids the sweep has asked /api/passes about (null =
   *  failed, and the sweep does not retry -- but the dropdown's own
   *  on-demand fetch reads `passLists`, not this, so opening the dropdown
   *  remains the retry path). Successful answers land in `passLists`, the
   *  ONE cache the dropdown reads, so its open is instant and nothing is
   *  fetched twice. */
  const passSweepCache = useRef(new Map<string, PassInfo[] | null>());
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
  /** Whether the sort menu (anchored under the header's sort icon) is
   *  open. Pure UI state; the choice itself is rosterSort. */
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  /** Whether the class picker (behind the header's "Change class") is
   *  open. Pure UI state; the selection itself is activeId. */
  const [classPickerOpen, setClassPickerOpen] = useState(false);
  /** The class currently on screen, readable from inside an async fetch:
   *  a waitlist response that comes back after the teacher has switched
   *  classes must be dropped, not written into state under the new class. */
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  const router = useRouter();
  const searchParams = useSearchParams();
  /** The URL's ?classId=, readable at fetch-response time without making
   *  the classes fetch re-run on every router.replace below. */
  const classIdParamRef = useRef<string | null>(null);
  classIdParamRef.current = searchParams.get("classId");

  /**
   * Keep ?classId= equal to the selected class, so a refresh lands on the
   * same class instead of the default. replace, not push: switching
   * classes is not a history the back button should walk, and scroll:
   * false so the roster does not jump. The page is fully client-side
   * state, so the replace never remounts anything.
   */
  const syncClassParam = useCallback(
    (id: number | null) => {
      const current = classIdParamRef.current;
      const wanted = id === null ? null : String(id);
      if (current === wanted) return;
      router.replace(wanted === null ? "/" : `/?classId=${wanted}`, {
        scroll: false,
      });
    },
    [router],
  );

  /** Every class switch goes through here so the URL follows along. */
  const selectClass = useCallback(
    (id: number) => {
      setActiveId(id);
      syncClassParam(id);
    },
    [syncClassParam],
  );

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
        const list: ClassSummary[] = d.classes ?? [];
        setClasses(list);
        /* The URL names the class to land on. If it is not in the
         * classes-around-now window (an old link, a class that has
         * scrolled out), fall back to the default quietly and correct
         * the param, so the URL always says what the screen shows. */
        const wanted = Number(classIdParamRef.current);
        const fromUrl =
          Number.isFinite(wanted) && classIdParamRef.current !== null
            ? (list.find((c) => c.classId === wanted) ?? null)
            : null;
        const chosen = fromUrl?.classId ?? list[0]?.classId ?? null;
        setActiveId(chosen);
        syncClassParam(chosen);
      })
      .catch((e) => setError(String(e)));
  }, [settings.hoursBack, settings.hoursForward, syncClassParam]);

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
    /* The unpaid-confirm arm and any failure text are keyed by CLIENT id,
     * so without this a "confirm" armed on one class would carry to the
     * same client's unpaid booking on another class, turning the
     * deliberate second tap into a pre-armed single tap. Both are
     * per-class-view state; a class switch resets them. */
    setConfirming([]);
    setFailed({});
    /* A cancel dialog has no business surviving a class switch; close it.
     * Safe even mid-write: the dialog state carries the classId it was
     * opened for, and that is what the write posts. */
    setCancelling(null);
    setCancelMsg(null);
    setCounterModal(null);
    setWaitlist(null);
    setWaitlistError(null);
    setPromoteMsg({});
    void refreshRoster(activeId);
  }, [activeId, refreshRoster]);

  /**
   * The background sweep: after a roster renders, fetch each client's
   * recent visits AND their pass list in the background, a few clients at
   * a time, and let the rows fill in as the answers land. The roster
   * itself NEVER waits on this. The pass list is what decides whether a
   * row shows the payment-change chevron at all (a paid row with one pass
   * has nothing to change to), and it pre-warms the dropdown: the same
   * `passLists` cache the dropdown reads is filled here, so its open is
   * instant and no double-fetch happens.
   *
   * The session caches are keyed by client id, so switching classes and
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
    ].filter(
      (id) =>
        !historyCache.current.has(id) || !passSweepCache.current.has(id),
    );
    if (ids.length === 0) return;
    let cancelled = false;
    let next = 0;
    const fetchHistory = async (id: string) => {
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
    };
    const fetchSweepPasses = async (id: string) => {
      try {
        const r = await fetch(`/api/passes?clientId=${encodeURIComponent(id)}`);
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        const passes: PassInfo[] = body?.passes ?? [];
        passSweepCache.current.set(id, passes);
        /* Never clobber the dropdown's own fetch: if it answered (or is
         * mid-flight) for this client, its result stands. */
        setPassLists((l) =>
          l[id]?.data || l[id]?.loading
            ? l
            : { ...l, [id]: { data: passes, error: null, loading: false } },
        );
      } catch {
        /* Left as null in the claim ledger; the dropdown's on-demand
         * fetch is the retry path. */
      }
    };
    const worker = async () => {
      while (!cancelled && activeIdRef.current === classId) {
        const id = ids[next++];
        if (id === undefined) return;
        /* Claim the id before fetching, so a re-run of the effect (a
         * roster refresh mid-sweep) does not fetch it twice. */
        const jobs: Promise<void>[] = [];
        if (!historyCache.current.has(id)) {
          historyCache.current.set(id, null);
          jobs.push(fetchHistory(id));
        }
        if (!passSweepCache.current.has(id)) {
          passSweepCache.current.set(id, null);
          jobs.push(fetchSweepPasses(id));
        }
        await Promise.all(jobs);
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

  /** Escape closes the class picker. Nothing in it writes. */
  useEffect(() => {
    if (!classPickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setClassPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [classPickerOpen]);

  /** Escape closes the sort menu (outside taps close it via its scrim).
   *  Nothing here ever writes, so no in-flight guard is needed. */
  useEffect(() => {
    if (!sortMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSortMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sortMenuOpen]);

  /** Escape closes the cancel-booking dialog too, except mid-write: once
   *  the removal is on the wire the dialog waits for the answer, because a
   *  dismissed dialog whose write later succeeds is a row that vanishes
   *  with nobody watching. */
  useEffect(() => {
    if (cancelling === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cancelBusy) {
        setCancelling(null);
        setCancelMsg(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelling, cancelBusy]);

  /**
   * Cancel a booking outright, from the cancel dialog's confirm button.
   * Non-optimistic: the button spins until Mindbody answers. On success
   * the dialog closes and the roster refreshes through the same
   * activeIdRef-guarded refresh everything else uses, so the row's
   * disappearance is Mindbody's answer, not our guess. Suppression
   * (dry run / write guard) renders inside the dialog as the amber
   * notice, never as success; failure shows Mindbody's reason.
   */
  const cancelVisit = useCallback(
    async (req: { entry: RosterEntry; classId: number }) => {
      if (cancelBusy) return;
      setCancelBusy(true);
      setCancelMsg(null);
      try {
        const res = await fetch("/api/cancel-visit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: req.entry.clientId,
            /* The class the dialog was opened for, captured when the trash
             * was tapped -- NOT activeId, which could in principle have
             * moved (the settings-driven classes refetch resets it) in the
             * moment before the close-on-switch effect runs. */
            classId: req.classId,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (body.suppressed) {
          setCancelMsg(
            body.suppressed === "dry-run"
              ? "Dry run: removal suppressed, nothing was written."
              : "Write guard: this client is not in POS_WRITE_CLIENT_IDS.",
          );
          return;
        }
        /* refreshRoster drops the response itself if the teacher has
         * switched classes by the time it lands (activeIdRef). */
        await refreshRoster(req.classId);
        setCancelling(null);
      } catch (err) {
        setCancelMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setCancelBusy(false);
      }
    },
    [cancelBusy, refreshRoster],
  );

  /**
   * Search fires on SUBMIT only (Enter, or the Search button), never
   * while typing: the debounced live search this replaces still cost a
   * metered call per pause, and results appearing under a moving cursor
   * were easy to mis-tap (T16). One submit, one call, and the results
   * open in their own modal titled with the query.
   *
   * The minimum length applies at submit, quietly, under the input.
   * Three letters by default, because two returns hundreds of matches
   * that nobody scrolls, at the cost of a metered call.
   */
  const submitSearch = useCallback(() => {
    if (searching) return;
    const q = query.trim();
    if (q.length < settings.minQueryLength) {
      setSearchMsg(
        `Type at least ${settings.minQueryLength} letters, then search.`,
      );
      return;
    }
    setSearchMsg(null);
    setSearchTitle(q);
    setSearchOpen(true);
    setSearching(true);
    setSearchError(null);
    setFound([]);
    /* A new search is a new set of people: any pass chosen for the old
     * results must not silently apply to a same-id row in the new ones. */
    setWalkinPassChoice({});
    setWalkinPicker(null);
    fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${settings.searchLimit}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setSearchError(String(d.error));
        setFound(d.results ?? []);
      })
      .catch((e) => setSearchError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSearching(false));
  }, [query, searching, settings.minQueryLength, settings.searchLimit]);

  /** Closing the results modal, by any path, also clears the input and
   *  the held results: a closed search is a finished search, and stale
   *  text in the box otherwise invites resubmitting it by reflex. */
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setFound([]);
  }, []);

  /** Escape closes the search-results modal, unless a layer is stacked
   *  on top of it (red alert, waitlist confirm, an info modal, the pass
   *  picker): Escape peels the top layer, so an open pass picker closes
   *  first and the modal takes the next press. The dialogs close on
   *  their own scrims. */
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !waitlistPrompt &&
        !walkinAlertPrompt &&
        !infoModal
      ) {
        if (walkinPicker) {
          setWalkinPicker(null);
        } else {
          closeSearch();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    searchOpen,
    waitlistPrompt,
    walkinAlertPrompt,
    infoModal,
    walkinPicker,
    closeSearch,
  ]);

  /** The chosen-pass selection lives only as long as the modal: closing
   *  it (any path: X, scrim, Escape, a successful add) resets both the
   *  choices and any open picker, so a stale choice can never ride into
   *  the next search session. */
  useEffect(() => {
    if (!searchOpen) {
      setWalkinPassChoice({});
      setWalkinPicker(null);
    }
  }, [searchOpen]);

  /** The picker's coordinates are position: fixed and captured at open
   *  time, so a resize or an orientation change would leave it floating
   *  over a reflowed modal at stale coordinates. Close it instead, same
   *  posture as scrolling the results list. */
  useEffect(() => {
    if (!walkinPicker) return;
    const close = () => setWalkinPicker(null);
    window.addEventListener("resize", close);
    window.addEventListener("orientationchange", close);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("orientationchange", close);
    };
  }, [walkinPicker]);

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
   * The check-in CHIP's tap. The chip is the ONLY check-in trigger: the
   * row body used to be the target too, for speed, and live use showed
   * accidental check-ins -- a deliberate reversal (T16, Pete's call), so
   * do not restore row-tap check-in. Every gate lives here, in order:
   * waiver block, red alert, then the unpaid confirm -- an unpaid booking
   * has no pricing option attached, so checking it in hands over a class
   * for free, and until Phase 2 sells them a pass it at least takes a
   * deliberate second tap of this same chip.
   *
   * Checking OUT is not here: it has its own control and its own
   * confirmation, because undoing a check-in by the same gesture that made
   * it is too easy to do by accident.
   */
  const tapCheckIn = useCallback(
    (entry: RosterEntry) => {
      if (busy.includes(entry.clientId) || entry.checkedIn) return;
      /**
       * No released waiver stops everything, before the red alert and
       * before the unpaid confirm: the tap opens the gate dialog and goes
       * no further. Unlike the red alert below there is no plain
       * acknowledgement that lets the tap through -- since T18 the dialog
       * can RESOLVE the waiver, but only by showing the student the real
       * text, scrolled to the end, and recording THEIR agreement; a
       * teacher cannot simply wave it past. Unknown (null, lookup failed)
       * fails open and is not this branch.
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

  /** Close the waiver dialog and drop every piece of its state, so a
   *  half-read waiver on one client can never leak into another's dialog.
   *  Refused mid-write: the answer is coming. */
  const closeWaiverDialog = useCallback(() => {
    if (waiverSaving) return;
    setWaiverPrompt(null);
    setWaiverText(null);
    setWaiverLoading(false);
    setWaiverFetchError(null);
    setWaiverScrolled(false);
    setWaiverMsg(null);
  }, [waiverSaving]);

  /**
   * Fetch the waiver text and swap the dialog into its reading state. One
   * metered call at most per server process (/api/waiver caches the text),
   * so re-opening the dialog costs nothing. Failure falls back to the
   * close-only shape with the reason shown quietly; retry is tapping
   * "Read the waiver" again on the next open.
   */
  const readWaiver = useCallback(() => {
    if (waiverLoading) return;
    setWaiverLoading(true);
    setWaiverFetchError(null);
    fetch("/api/waiver")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        if (
          typeof body?.text !== "string" ||
          typeof body?.sha256 !== "string"
        ) {
          throw new Error("The waiver text was missing from the response.");
        }
        setWaiverScrolled(false);
        setWaiverText({ text: body.text, sha256: body.sha256 });
      })
      .catch((e) =>
        setWaiverFetchError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setWaiverLoading(false));
  }, [waiverLoading]);

  /** A waiver short enough to fit without scrolling has been fully shown
   *  the moment it renders, so the confirm enables immediately; anything
   *  longer waits for the scroll-to-bottom check on the region itself. */
  useEffect(() => {
    if (!waiverText) return;
    const el = waiverScrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 8) {
      setWaiverScrolled(true);
    }
  }, [waiverText]);

  /**
   * Record the student's agreement (T18). Only reachable from the reading
   * state's confirm, which is disabled until the text has been scrolled
   * to the end -- so by construction the release is never written without
   * the real text having been shown. Non-optimistic: the confirm spins
   * until Mindbody answers. Suppression (dry run / write guard) renders
   * inside the dialog as the amber notice, never as success; failure
   * shows Mindbody's reason.
   *
   * On a real success: the dialog closes, the row's local waiverSigned
   * flips (and its notes update if the receipt landed), and the SAME
   * tapCheckIn flow the chip runs takes over -- now past the waiver gate,
   * with the red-alert and unpaid gates still applying in their usual
   * order. The next roster load confirms from Mindbody.
   */
  const agreeWaiver = useCallback(async () => {
    const entry = waiverPrompt;
    if (!entry || !waiverText || !waiverScrolled || waiverSaving) return;
    setWaiverSaving(true);
    setWaiverMsg(null);
    try {
      const res = await fetch("/api/waiver-agree", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: entry.clientId,
          /* The freshest notes this screen holds, for the receipt append.
           * A stale value loses at most a concurrent edit from another
           * surface; the roster refetches notes on every load. */
          notes: entry.notes,
          textSha256: waiverText.sha256,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (body.suppressed) {
        setWaiverMsg(
          body.suppressed === "dry-run"
            ? "Dry run: the agreement was suppressed, nothing was written."
            : "Write guard: this client is not in POS_WRITE_CLIENT_IDS.",
        );
        return;
      }
      const newNotes =
        body.receiptNoted && typeof body.notes === "string"
          ? body.notes.trim() || null
          : entry.notes;
      setWaiverReceiptWarn(
        body.receiptNoted
          ? null
          : `Waiver recorded for ${entry.name}, but the receipt note did not save` +
              `${body.receiptReason ? ` (${body.receiptReason})` : ""}. The agreement stands; the server log holds the receipt.`,
      );
      setEntries((rows) =>
        rows.map((r) =>
          r.clientId === entry.clientId
            ? { ...r, waiverSigned: true, notes: newNotes }
            : r,
        ),
      );
      setWaiverSaving(false);
      closeWaiverDialog();
      /* The normal check-in path, on the updated row: past the waiver
       * gate now, with the red-alert and unpaid gates still ahead. */
      tapCheckIn({ ...entry, waiverSigned: true, notes: newNotes });
    } catch (err) {
      setWaiverMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setWaiverSaving(false);
    }
  }, [
    waiverPrompt,
    waiverText,
    waiverScrolled,
    waiverSaving,
    closeWaiverDialog,
    tapCheckIn,
  ]);

  /** Close the info modal and drop any notes-editing state with it.
   *  Refused mid-save: the answer is coming. */
  const closeInfoModal = useCallback(() => {
    if (notesSaving) return;
    setInfoModal(null);
    setNotesEditing(false);
    setNotesMsg(null);
  }, [notesSaving]);

  /**
   * Save the notes draft through /api/client-notes, which posts the
   * surgical `{Client: {Id, Notes}}` update (see src/lib/clients.ts).
   * Non-optimistic: the Save button spins until Mindbody answers. On
   * success the row's local notes state updates in place -- no roster
   * reload for a one-field edit -- and the modal drops back to its
   * reading state showing the saved text. Suppression renders inside the
   * modal as the amber notice, never as success; failure shows Mindbody's
   * reason and keeps the draft for another try.
   */
  const saveNotes = useCallback(async () => {
    const clientId = infoModal?.notesClientId;
    if (!clientId || notesSaving) return;
    setNotesSaving(true);
    setNotesMsg(null);
    try {
      const res = await fetch("/api/client-notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, notes: notesDraft }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (body.suppressed) {
        setNotesMsg(
          body.suppressed === "dry-run"
            ? "Dry run: save suppressed, nothing was written."
            : "Write guard: this client is not in POS_WRITE_CLIENT_IDS.",
        );
        return;
      }
      /* The roster's batched brief lookup trims and null-converts notes
       * the same way, so the local update matches what a reload would
       * show (and it undims the icon). */
      const trimmed = notesDraft.trim();
      setEntries((rows) =>
        rows.map((r) =>
          r.clientId === clientId ? { ...r, notes: trimmed || null } : r,
        ),
      );
      setInfoModal((m) => (m ? { ...m, text: trimmed } : m));
      setNotesEditing(false);
    } catch (err) {
      setNotesMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setNotesSaving(false);
    }
  }, [infoModal, notesDraft, notesSaving]);

  /**
   * Open the payment-change dropdown on a row. The background sweep has
   * normally cached the pass list already (that is what made the chevron
   * render), so this is usually instant; the fetch below is the fallback
   * for a somehow-uncached client, one metered `/client/clientservices`
   * call per client per session. A failed fetch is not cached, so closing
   * and reopening the dropdown is the retry path.
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
          const passes = (body?.passes ?? []) as PassInfo[];
          /* Claim the sweep's ledger too, so a later sweep does not spend
           * a second call on a client this fetch already answered. */
          passSweepCache.current.set(entry.clientId, passes);
          setPassLists((l) => ({
            ...l,
            [entry.clientId]: {
              data: passes,
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
  const walkIns = useMemo(
    () => found.filter((f) => !rosterIds.has(f.id)),
    [found, rosterIds],
  );

  /**
   * Forms of payment for the DISPLAYED walk-in results: once a submitted
   * search has its results in the modal, fetch each shown client's pass
   * list in the background and let a muted summary line fill in as
   * answers land. Rendering the results NEVER waits on this.
   *
   * Reuses the roster sweep's machinery wholesale: the same claim ledger
   * (`passSweepCache`, so a client already swept from a roster costs
   * nothing here and vice versa), the same `passLists` cache the rows
   * read, the same concurrency cap, and the same staleness posture --
   * this effect's cleanup cancels the workers when the result set
   * changes (the analogue of the roster sweep's activeIdRef guard), and
   * caches are keyed by client id, so a late answer can only ever land
   * under its own client and can never dirty another result set's rows.
   * Metered-call note (on the ticket): worst case is result-limit calls
   * per novel search.
   */
  useEffect(() => {
    const ids = walkIns
      .map((w) => w.id)
      .filter((id) => !passSweepCache.current.has(id));
    if (ids.length === 0) return;
    let cancelled = false;
    let next = 0;
    const worker = async () => {
      while (!cancelled) {
        const id = ids[next++];
        if (id === undefined) return;
        /* Claim before fetching, so an overlapping roster sweep or a
         * re-run of this effect does not fetch the same client twice. */
        if (passSweepCache.current.has(id)) continue;
        passSweepCache.current.set(id, null);
        try {
          const r = await fetch(
            `/api/passes?clientId=${encodeURIComponent(id)}`,
          );
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
          const passes: PassInfo[] = body?.passes ?? [];
          passSweepCache.current.set(id, passes);
          setPassLists((l) =>
            l[id]?.data || l[id]?.loading
              ? l
              : { ...l, [id]: { data: passes, error: null, loading: false } },
          );
        } catch {
          /* Ledger keeps the null claim: the summary line is a nicety,
           * not worth a retry storm on a struggling API. */
        }
      }
    };
    for (let i = 0; i < HISTORY_SWEEP_CONCURRENCY; i++) void worker();
    return () => {
      cancelled = true;
    };
  }, [walkIns]);

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
      /* ONE booking at a time, across the whole modal, not per client:
       * with per-client locking a fast run of "+" taps booked several
       * people in parallel, each racing past the same stale capacity
       * check, and Mindbody's API happily overbooked the class (21 of
       * 20 seen live). The modal closes on the first success anyway, so
       * serializing costs nothing a teacher can feel. */
      if (activeId === null || bookingIds.length > 0) return;
      setBookingIds((b) => [...b, client.id]);
      setBookMsg((m) => {
        const { [client.id]: _drop, ...rest } = m;
        return rest;
      });
      /* The pass chosen in the modal, if any, rides the ONE booking call:
       * AddClientToClassRequest carries ClientServiceId per the vendored
       * spec (docs/mindbody-openapi/class.yml), so there is no follow-up
       * write. No explicit choice means the field is omitted and the
       * payload is exactly what it was. A waitlist add deliberately never
       * sends it: a queue entry is not a booking, and the waitlist flow
       * stays byte-for-byte as before. */
      const chosenPass = waitlist ? undefined : walkinPassChoice[client.id];
      try {
        const res = await fetch("/api/book", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: client.id,
            classId: activeId,
            waitlist,
            clientServiceId: chosenPass,
          }),
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
         * has done its job: the modal closes and the search clears,
         * leaving the teacher looking at the roster row they are about to
         * check in. Suppressed writes, errors, and waitlist adds keep the
         * modal and its results, because their feedback renders on the
         * result row itself. */
        if (!waitlist) closeSearch();
      } catch (err) {
        setBookMsg((m) => ({
          ...m,
          [client.id]: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setBookingIds((b) => b.filter((id) => id !== client.id));
      }
    },
    [activeId, bookingIds, refreshRoster, loadWaitlist, walkinPassChoice, closeSearch],
  );

  /**
   * The walk-in ADD tap. A known red alert stops it exactly the way it
   * stops a roster check-in: the blocking dialog opens and nothing is
   * booked until the teacher has read the alert and chosen to continue
   * (this closes the T5 follow-up where a red-alert walk-in could be
   * booked without the alert ever showing). Past the gate, the existing
   * full-class handling stands: a full class offers the waiting list, a
   * class with room books.
   */
  const tapWalkIn = useCallback(
    (client: SearchResult) => {
      /* Same single-flight rule as bookWalkIn: any booking in flight
       * blocks every other row's tap, not just this client's. */
      if (bookingIds.length > 0) return;
      if (client.redAlert && !acked.includes(client.id)) {
        setWalkinAlertPrompt(client);
        return;
      }
      if (classFull) {
        setWaitlistPrompt(client);
      } else {
        void bookWalkIn(client, false);
      }
    },
    [bookingIds, acked, classFull, bookWalkIn],
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
    /* The pass paying now, shown checked at the top. When the fetched
     * list does not carry it (or has not landed yet), the roster's own
     * Visit.Service data stands in, so the top line is always the truth
     * the row shows. */
    const currentLine = entry.pricingOption
      ? {
          name: current?.name ?? entry.pricingOption,
          facts: current ?? {
            remaining: entry.passRemaining,
            count: entry.passCount,
            expires: entry.passExpires,
          },
        }
      : null;
    return (
      <>
        <div
          className="pass-scrim"
          onClick={(e) => {
            /* The row body is no longer a check-in target (T16), so this
             * stopPropagation is belt and braces, not load-bearing. */
            e.stopPropagation();
            if (passSavingId === null) setPickerFor(null);
          }}
          role="presentation"
        />
        <div
          className="pass-dd"
          role="dialog"
          aria-label={`Change how ${entry.name} is paying`}
          onClick={(e) => e.stopPropagation()}
        >
          {passMsg ? <p className="pass-note">{passMsg}</p> : null}
          {currentLine ? (
            <div className="pass-opt current" aria-current="true">
              <span className="pass-check">
                <CheckIcon />
              </span>
              <span className="pass-opt-text">
                <span className="pass-opt-name">
                  {shortPassName(currentLine.name)}
                </span>
                {shortPassName(currentLine.name) !== currentLine.name.trim() ? (
                  <span className="pass-opt-full">{currentLine.name}</span>
                ) : null}
              </span>
              <span className="pass-col">{passLeftCol(currentLine.facts)}</span>
              <span className="pass-col">{passExpCol(currentLine.facts)}</span>
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
            const short = shortPassName(p.name);
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
                <span className="pass-opt-text">
                  <span className="pass-opt-name">{short}</span>
                  {short !== p.name.trim() ? (
                    <span className="pass-opt-full">{p.name}</span>
                  ) : null}
                </span>
                <span className="pass-col">{passLeftCol(p)}</span>
                <span className="pass-col">{passExpCol(p)}</span>
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

      {/* The agreement stood but the Notes receipt did not land. Quiet:
          the structured server log line already holds the receipt, so
          this is bookkeeping to chase, not a broken counter. */}
      {waiverReceiptWarn ? <p className="muted">{waiverReceiptWarn}</p> : null}

      {classes.length === 0 && !error ? (
        <p className="muted">No classes in the next few hours.</p>
      ) : null}

      {/* ONE header row for the class (the horizontal class bar it
          replaced spent a full row on classes nobody was working): on the
          left the CURRENT class -- date and time, name, teacher -- with a
          labelled "Change class" button opening the picker; on the right
          the three counters, read at arm's length in the ninety seconds
          before class. Signed up and checked in come from the roster
          already in memory, capacity from the class summary; only the
          waitlist ever costs a call, and only for a full class. Each
          counter taps open to the list behind it, which is where "is
          Dennis here yet" gets answered without scrolling the roster.
          Layout only: the classes data and selection state are exactly
          what the old bar used. */}
      {activeClass ? (
        <header className="class-header">
          <div className="class-current">
            <span className="class-when">
              {dayDate(activeClass.startsAt)} · {clockTime(activeClass.startsAt)}
            </span>
            <span className="class-title">
              {activeClass.name}
              {activeClass.teacher ? ` - ${activeClass.teacher}` : ""}
            </span>
          </div>
          <button
            className="class-change"
            aria-haspopup="dialog"
            onClick={() => setClassPickerOpen(true)}
          >
            Change class
          </button>
          <div className="counters" aria-label="Counts for the selected class">
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
          </div>
        </header>
      ) : null}

      {/* The class picker behind "Change class": the classes around now
          with the same facts the old bar showed, the current one marked.
          Picking one switches exactly as the old bar tap did. */}
      {classPickerOpen ? (
        <div
          className="modal-scrim"
          onClick={() => setClassPickerOpen(false)}
          role="presentation"
        >
          <div
            className="modal modal-list"
            role="dialog"
            aria-modal="true"
            aria-label="Change class"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">Classes around now</p>
            {classes.length === 0 ? (
              <p className="muted">No classes in the next few hours.</p>
            ) : (
              <ul className="roster modal-roster">
                {classes.map((c) => (
                  <li key={`pick-${c.classId}`}>
                    <button
                      className="row"
                      onClick={() => {
                        selectClass(c.classId);
                        setClassPickerOpen(false);
                      }}
                    >
                      <span className="name">
                        {dayDate(c.startsAt)} · {clockTime(c.startsAt)}
                        <span className="detail">
                          {c.name}
                          {c.teacher ? ` - ${c.teacher}` : ""}
                          {c.booked !== null ? ` - ${c.booked} booked` : ""}
                        </span>
                      </span>
                      {c.classId === activeId ? (
                        <span className="chip in">current</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setClassPickerOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Submit-triggered search (T16): typing costs nothing, Enter or
          the Search button fires the one metered call and opens the
          results modal. */}
      <div className="search-bar">
        <div className="search-wrap">
          <input
            className="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchMsg(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitSearch();
              }
            }}
            enterKeyHint="search"
            placeholder="Search for a walk-in (press Enter)"
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
        <button className="search-go" onClick={submitSearch}>
          Search
        </button>
      </div>
      {searchMsg ? <p className="search-quiet">{searchMsg}</p> : null}

      {/* The roster as a table, like Mindbody's own sign-in screen: one
          shared grid template so the payment and balance columns line up
          down the list, and NOTHING is behind a tap. The expandable row
          this replaced was the friction Pete asked to remove; detail
          moved into it missed the point. The right end of the header row
          carries the sort control: a quiet 44px icon over the actions
          column, opening an anchored menu -- it superseded the pill bar
          (T15), which crowded the roster it ordered. */}
      {sortedEntries.length > 0 ? (
        <div className="roster-head">
          <span aria-hidden="true">Name</span>
          {/* The icon-slot column: no label needed. */}
          <span aria-hidden="true" />
          <span aria-hidden="true">Payment</span>
          <span className="cell-bal" aria-hidden="true">
            Balance
          </span>
          <span className="head-actions">
            <button
              className="row-icon"
              aria-haspopup="dialog"
              aria-expanded={sortMenuOpen}
              aria-label="Roster order"
              title="Roster order"
              onClick={() => setSortMenuOpen((o) => !o)}
            >
              <SortIcon />
            </button>
            {sortMenuOpen ? (
              <>
                <div
                  className="pass-scrim"
                  role="presentation"
                  onClick={() => setSortMenuOpen(false)}
                />
                <div
                  className="sort-dd"
                  role="dialog"
                  aria-label="Roster order"
                >
                  {ROSTER_SORTS.map((s) => (
                    <button
                      key={s.value}
                      className={
                        rosterSort === s.value ? "pass-opt current" : "pass-opt"
                      }
                      aria-pressed={rosterSort === s.value}
                      onClick={() => {
                        pickRosterSort(s.value);
                        setSortMenuOpen(false);
                      }}
                    >
                      <span className="pass-check">
                        {rosterSort === s.value ? <CheckIcon /> : null}
                      </span>
                      <span className="pass-opt-text">
                        <span className="pass-opt-name">{s.label}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      <ul className="roster">
        {sortedEntries.map((entry) => {
          const working = busy.includes(entry.clientId);
          /* False only. Null is unknown (lookup failed) and fails open:
             no badge, normal check-in. */
          const noWaiver = entry.waiverSigned === false && !entry.checkedIn;
          /* The line under the name: an in-flight call, a failure, or a
             confirm prompt outranks the quiet history line; with none of
             those and no history yet, nothing renders and nothing waits.
             The waiver gate does NOT get a line here: the "no waiver" pill
             already says it, and the tap-gate dialog carries the signing
             path (T18). */
          const statusMsg = working
            ? "Talking to Mindbody..."
            : failed[entry.clientId]
              ? failed[entry.clientId]
              : confirming.includes(entry.clientId)
                ? "No pass on this booking. Tap confirm to check in for free."
                : null;
          const visits = histories[entry.clientId];
          const history =
            statusMsg === null && visits ? historyLine(visits) : "";

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
              {/* The row body is NOT a check-in target (T16 reversal:
                  accidental check-ins): the chip in the actions cell is
                  the only trigger. The inline controls' stopPropagation
                  calls are harmless leftovers; nothing depends on them
                  for check-in safety anymore. */}
              <div className="rrow">
                <div className="cell-name">
                  <span className="name-line">
                    <span className="name-text">{entry.name}</span>
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

                {/* Fixed icon slots in a set order (M | alert | notes), the
                    same width on every row, so each marker lines up as its
                    own column down the roster instead of trailing the name
                    at whatever x the name ends. A row without the marker
                    keeps the empty slot. */}
                <div className="cell-icons">
                  <span className="icon-slot">
                    {entry.member ? (
                      <span className="m-chip" title="Member" aria-label="Member">
                        M
                      </span>
                    ) : null}
                  </span>
                  <span className="icon-slot">
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
                  </span>
                  <span className="icon-slot">
                    {/* On EVERY row: dimmed when there is nothing behind
                        it yet, because adding a note starts here too. */}
                    <button
                      className={entry.notes ? "row-icon" : "row-icon dim"}
                      aria-label={
                        entry.notes
                          ? `Notes for ${entry.name}`
                          : `Add notes for ${entry.name}`
                      }
                      title={entry.notes ? "Notes" : "Add notes"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setNotesEditing(false);
                        setNotesMsg(null);
                        setInfoModal({
                          title: `Notes on ${entry.name}`,
                          text: entry.notes ?? "",
                          alert: false,
                          notesClientId: entry.clientId,
                        });
                      }}
                    >
                      <NotesIcon />
                    </button>
                  </span>
                </div>

                <div className="cell-pay">
                  {/* Two lines: the pass name, and under it the remaining/
                      expiry facts that used to be their own grid columns
                      (T15). No pass, no sub-line. */}
                  <span className="pay-stack">
                    <span
                      className={
                        entry.pricingOption ? "pay-name" : "pay-name none"
                      }
                      title={entry.pricingOption ?? undefined}
                    >
                      {entry.pricingOption
                        ? shortPassName(entry.pricingOption)
                        : "No pass"}
                    </span>
                    {entry.pricingOption ? (
                      <PassFactsLine
                        remaining={entry.passRemaining}
                        count={entry.passCount}
                        expires={entry.passExpires}
                      />
                    ) : null}
                  </span>
                  {/* The payment-change chevron renders only when there is
                      something to change TO: a paid row needs a second
                      current pass, an unpaid row needs at least one, and a
                      row with no visit id has nothing to reassign at all.
                      The pass count comes from the background sweep (which
                      shares the dropdown's cache); until it answers for
                      this client no control renders -- it appears when
                      known, rather than offering a dropdown that could
                      only say "no other passes". */}
                  {(() => {
                    const known = passLists[entry.clientId]?.data ?? null;
                    const showControl =
                      entry.visitId !== null &&
                      known !== null &&
                      known.length >= (entry.pricingOption ? 2 : 1);
                    return showControl ? (
                      <button
                        className="row-icon pass-toggle"
                        disabled={passSavingId !== null}
                        aria-haspopup="dialog"
                        aria-expanded={pickerFor === entry.clientId}
                        aria-label={
                          entry.pricingOption
                            ? "Change which pass pays"
                            : "Assign a pass"
                        }
                        title={
                          entry.pricingOption
                            ? "Change which pass pays"
                            : "Assign a pass"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (pickerFor === entry.clientId) {
                            if (passSavingId === null) setPickerFor(null);
                          } else {
                            openPicker(entry);
                          }
                        }}
                      >
                        <ChevronDownIcon />
                      </button>
                    ) : null;
                  })()}
                  {pickerFor === entry.clientId
                    ? renderPassDropdown(entry)
                    : null}
                </div>

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
                      disabled={working}
                      onClick={() => tapCheckIn(entry)}
                      aria-label={`Check in ${entry.name}`}
                    >
                      {chipLabel}
                    </button>
                  )}
                  {/* The undo renders on EVERY checked-in row, waiver state
                      included (audited for T15): the waiver gate lives in
                      tapCheckIn, which returns early for checked-in rows, so it
                      applies to check-IN only. A no-waiver client checked in
                      by mistake must be sign-out-able, or the mistake is
                      permanent. */}
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
                      <UndoIcon />
                    </button>
                  ) : !entry.checkedIn && !working ? (
                    /* Not checked in: the quiet trash sits where the undo
                       would, and cancels the BOOKING (behind a confirm)
                       rather than a sign-in. */
                    <button
                      className="undo-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (activeId === null) return;
                        setCancelMsg(null);
                        /* Capture the class the dialog is about NOW, so
                         * the eventual confirm cannot post against a
                         * different activeId. */
                        setCancelling({ entry, classId: activeId });
                      }}
                      aria-label={`Remove ${entry.name} from this class`}
                      title={`Remove ${entry.name} from this class`}
                    >
                      <TrashIcon />
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

      </ul>

      {/* Search results, in their own modal (T16): opened by a submitted
          search, titled with the query, and formatted with the SAME grid
          row layout as the roster (a sibling column template: name, icon
          slots, pass summary with its sub-line, balance, action) so a
          person reads the same on both sides of the booking. The add chip
          is the only action on a row, with the roster gates intact: red
          alert blocks, a full class offers the waiting list. The X (and
          Escape, and the scrim) closes with no action. */}
      {searchOpen ? (
        <div className="modal-scrim" onClick={closeSearch} role="presentation">
          <div
            className="modal modal-list modal-search"
            role="dialog"
            aria-modal="true"
            aria-label={`Search results for ${searchTitle}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="row-icon modal-x"
              aria-label="Close search results"
              onClick={closeSearch}
            >
              <CloseIcon />
            </button>
            <p className="modal-title">{`Results for "${searchTitle}"`}</p>
            {/* A class-level fact, said once here rather than stamped on
                every result row: with the class full, every add offers
                the waiting list instead. */}
            {classFull && walkIns.length > 0 ? (
              <p className="muted">Class is full. Adding goes to the waiting list.</p>
            ) : null}
            {searching ? (
              <p className="muted">
                <span className="spinner" aria-label="working" /> Searching
                Mindbody...
              </p>
            ) : null}
            {searchError ? <p className="note">{searchError}</p> : null}
            {!searching && !searchError && walkIns.length === 0 ? (
              <p className="muted">
                {found.length > 0
                  ? "Everyone matching is already on this class's roster."
                  : "Nobody found. Check the spelling, or try fewer letters."}
              </p>
            ) : null}
            {walkIns.length > 0 ? (
              <>
                <div className="roster-head">
                  <span aria-hidden="true">Name</span>
                  <span aria-hidden="true">Passes</span>
                  <span className="cell-bal" aria-hidden="true">
                    Balance
                  </span>
                  <span aria-hidden="true" />
                </div>
                <ul
                  className="roster modal-roster"
                  /* The picker is position: fixed, so scrolling the list
                     would slide its row out from under it; close it
                     instead. */
                  onScroll={
                    walkinPicker ? () => setWalkinPicker(null) : undefined
                  }
                >
                  {walkIns.map((client) => {
                    const working = bookingIds.includes(client.id);
                    const msg = bookMsg[client.id];
                    /* Under the markers: an in-flight call or an outcome
                     * message only. Email is gone from the row entirely
                     * (T17), and the full-class notice is a class-level
                     * fact said ONCE under the modal title, not stamped on
                     * every row. */
                    const subline = working ? "Talking to Mindbody..." : (msg ?? null);
                    /* The pass summary, once the background fetch has
                     * landed: the same two-line format as the roster's
                     * payment cell. With more than one current pass the
                     * cell grows the roster's chevron and which pass will
                     * pay becomes choosable (T17): the choice is LOCAL --
                     * rendered here, sent only when the "+" books --
                     * defaulting to the list's first pass, which is what
                     * the summary always showed. Only passes carrying an
                     * id are choosable; a pass Mindbody returned without
                     * one cannot be named on a booking call. */
                    const passList = passLists[client.id]?.data ?? null;
                    const choosable = (passList ?? []).filter(
                      (p): p is PassInfo & { id: number } => p.id !== null,
                    );
                    const chosenId = walkinPassChoice[client.id];
                    const chosen =
                      chosenId !== undefined
                        ? (choosable.find((p) => p.id === chosenId) ?? null)
                        : null;
                    const shownPass = chosen ?? passList?.[0] ?? null;
                    const pickerOpen = walkinPicker?.id === client.id;
                    return (
                      <li key={`walkin-${client.id}`}>
                        {/* The row body is not an add target (T16, same
                            principle as roster check-in): the add chip is
                            the only action. */}
                        <div className="rrow">
                          <div className="cell-name">
                            {/* The name owns the row's whole first line and
                                NEVER ellipsizes: it is the one column a
                                teacher cannot read truncated. An absurdly
                                long name wraps; "..." is not an option
                                here (T17). */}
                            <span className="name-text">{client.name}</span>
                            {/* The second line holds only the markers, in a
                                fixed order: M, alert, no-waiver. A row with
                                none of them skips the line. */}
                            {client.member ||
                            client.redAlert ||
                            !client.waiverSigned ? (
                              <span className="marker-line">
                                {client.member ? (
                                  <span
                                    className="m-chip"
                                    title="Member"
                                    aria-label="Member"
                                  >
                                    M
                                  </span>
                                ) : null}
                                {client.redAlert ? (
                                  <button
                                    className="row-icon row-alert"
                                    aria-label={`Red alert for ${client.name}`}
                                    title="Red alert"
                                    onClick={() => {
                                      /* Info-only, same as the roster icon:
                                         reading here does not acknowledge
                                         the ADD gate. */
                                      setInfoModal({
                                        title: `Red alert on ${client.name}`,
                                        text: client.redAlert ?? "",
                                        alert: true,
                                      });
                                    }}
                                  >
                                    <AlertIcon />
                                  </button>
                                ) : null}
                                {!client.waiverSigned ? (
                                  <span className="mini-stop">no waiver</span>
                                ) : null}
                              </span>
                            ) : null}
                            {subline ? (
                              <span className="subline">{subline}</span>
                            ) : null}
                          </div>
                          <div className="cell-pay">
                            <span className="pay-stack">
                              {passList !== null ? (
                                shownPass ? (
                                  <>
                                    <span
                                      className="pay-name"
                                      title={shownPass.name}
                                    >
                                      {shortPassName(shownPass.name)}
                                    </span>
                                    <PassFactsLine
                                      remaining={shownPass.remaining}
                                      count={shownPass.count}
                                      expires={shownPass.expires}
                                    />
                                  </>
                                ) : (
                                  <span className="pay-name muted">
                                    No current passes
                                  </span>
                                )
                              ) : null}
                            </span>
                            {/* The chevron only when there is a real
                                choice: two or more choosable passes. The
                                tap opens the picker; picking takes NO
                                action beyond updating this cell. */}
                            {choosable.length >= 2 ? (
                              <button
                                className="row-icon pass-toggle"
                                disabled={working}
                                aria-haspopup="dialog"
                                aria-expanded={pickerOpen}
                                aria-label={`Choose which pass pays for ${client.name}`}
                                title="Choose which pass pays"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (pickerOpen) {
                                    setWalkinPicker(null);
                                    return;
                                  }
                                  /* Anchor the fixed dropdown to the ROW's
                                   * bottom-right. The pull-up clamp uses
                                   * the LIST's estimated height (64px
                                   * option floor + gaps + chrome, capped
                                   * at the CSS max-height), not a fixed
                                   * worst case: a two-option picker for a
                                   * bottom row must stay glued to its row,
                                   * not float mid-screen over somebody
                                   * else's cells. The inline max-height is
                                   * the belt: wrapped pass names can beat
                                   * the estimate, and then the picker
                                   * scrolls instead of running off the
                                   * bottom. */
                                  const row =
                                    e.currentTarget.closest(".rrow") ??
                                    e.currentTarget;
                                  const r = row.getBoundingClientRect();
                                  const capHeight = Math.min(
                                    window.innerHeight * 0.48,
                                    420,
                                  );
                                  const estHeight = Math.min(
                                    choosable.length * 66 + 18,
                                    capHeight,
                                  );
                                  const top = Math.min(
                                    r.bottom + 6,
                                    Math.max(
                                      window.innerHeight - estHeight - 8,
                                      16,
                                    ),
                                  );
                                  setWalkinPicker({
                                    id: client.id,
                                    top,
                                    right: Math.max(
                                      window.innerWidth - r.right,
                                      8,
                                    ),
                                    maxHeight: Math.min(
                                      window.innerHeight - top - 8,
                                      capHeight,
                                    ),
                                  });
                                }}
                              >
                                <ChevronDownIcon />
                              </button>
                            ) : null}
                            {pickerOpen && walkinPicker ? (
                              <>
                                <div
                                  className="pass-scrim"
                                  role="presentation"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setWalkinPicker(null);
                                  }}
                                />
                                <div
                                  className="pass-dd dd-fixed"
                                  style={{
                                    top: walkinPicker.top,
                                    right: walkinPicker.right,
                                    maxHeight: walkinPicker.maxHeight,
                                  }}
                                  role="dialog"
                                  aria-label={`Choose which pass pays for ${client.name}`}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {choosable.map((p) => {
                                    const selected = shownPass?.id === p.id;
                                    const short = shortPassName(p.name);
                                    return (
                                      <button
                                        key={`wp-${client.id}-${p.id}`}
                                        className={
                                          selected
                                            ? "pass-opt current"
                                            : "pass-opt"
                                        }
                                        aria-pressed={selected}
                                        onClick={() => {
                                          /* Selection only: nothing is
                                             written and nothing books
                                             until the "+" tap. */
                                          setWalkinPassChoice((c) => ({
                                            ...c,
                                            [client.id]: p.id,
                                          }));
                                          setWalkinPicker(null);
                                        }}
                                      >
                                        <span className="pass-check">
                                          {selected ? <CheckIcon /> : null}
                                        </span>
                                        <span className="pass-opt-text">
                                          <span className="pass-opt-name">
                                            {short}
                                          </span>
                                          {short !== p.name.trim() ? (
                                            <span className="pass-opt-full">
                                              {p.name}
                                            </span>
                                          ) : null}
                                        </span>
                                        <span className="pass-col">
                                          {passLeftCol(p)}
                                        </span>
                                        <span className="pass-col">
                                          {passExpCol(p)}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </>
                            ) : null}
                          </div>
                          <span
                            className={
                              client.balance !== null && client.balance < 0
                                ? "cell-bal neg"
                                : "cell-bal"
                            }
                          >
                            {client.balance !== null && client.balance !== 0
                              ? money(client.balance)
                              : ""}
                          </span>
                          <div className="cell-actions">
                            {/* A "+" icon, not a text chip (T17): the one
                                action on the row, a 52px filled circle in
                                the same action pairing as the check-in
                                chip. The aria-label carries what the label
                                text used to: whether the tap books or
                                offers the waiting list. All gates are in
                                tapWalkIn, unchanged. */}
                            <button
                              className="add-btn"
                              /* Every row's "+" goes inert while ANY booking
                                 is in flight; the spinner stays on the row
                                 that is actually booking. */
                              disabled={working || bookingIds.length > 0}
                              onClick={(e) => {
                                e.stopPropagation();
                                tapWalkIn(client);
                              }}
                              aria-label={
                                classFull
                                  ? `Add ${client.name} to the waitlist`
                                  : `Add ${client.name} to this class`
                              }
                              title={
                                classFull ? "Add to waitlist" : "Add to this class"
                              }
                            >
                              {working ? (
                                <span className="spinner" aria-label="working" />
                              ) : (
                                <PlusIcon />
                              )}
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

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
                            {entry.pricingOption
                              ? shortPassName(entry.pricingOption)
                              : "No pass on this booking"}
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
                              {entry.pricingOption
                              ? shortPassName(entry.pricingOption)
                              : "No pass on this booking"}
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

      {/* The row icons' text: the red alert or the staff notes.
          Deliberately NOT the check-in gate: reading an alert here does
          not acknowledge it, so a flagged row's check-in tap still stops
          at the blocking dialog below. The NOTES modal (notesClientId
          set) additionally carries the pencil that edits them -- the one
          write this modal can make, and it writes Notes only. The alert
          modal stays strictly read-only. */}
      {infoModal ? (
        <div
          className="modal-scrim"
          onClick={closeInfoModal}
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
            {notesEditing && infoModal.notesClientId ? (
              /* Editing: the textarea seeded with the current notes.
                 Whitespace and line breaks survive the round trip: the
                 textarea holds them natively and modal-note renders
                 pre-wrap. */
              <textarea
                className="notes-edit"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                disabled={notesSaving}
                aria-label="Edit notes"
                autoFocus
              />
            ) : infoModal.text ? (
              <p
                className={
                  infoModal.alert ? "ctx-alert modal-alert" : "modal-note"
                }
              >
                {infoModal.text}
              </p>
            ) : (
              <p className="modal-note muted">No notes yet.</p>
            )}
            {notesMsg ? (
              <p className="pass-note modal-note-gap">{notesMsg}</p>
            ) : null}
            <div className="modal-actions">
              {notesEditing && infoModal.notesClientId ? (
                <>
                  <button
                    className="modal-cancel"
                    disabled={notesSaving}
                    onClick={() => {
                      setNotesEditing(false);
                      setNotesMsg(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="modal-confirm go"
                    disabled={notesSaving}
                    onClick={() => void saveNotes()}
                  >
                    {notesSaving ? (
                      <span className="spinner" aria-label="working" />
                    ) : (
                      "Save"
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button className="modal-cancel" onClick={closeInfoModal}>
                    Close
                  </button>
                  {infoModal.notesClientId ? (
                    <button
                      className="modal-cancel"
                      onClick={() => {
                        setNotesDraft(infoModal.text);
                        setNotesMsg(null);
                        setNotesEditing(true);
                      }}
                    >
                      <span className="btn-ico">
                        <PencilIcon />
                      </span>
                      Edit
                    </button>
                  ) : null}
                </>
              )}
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

      {/* The walk-in twin of the gate above: a red-alert walk-in does not
          get booked on reflex either. Confirming acknowledges for this
          browser session (the same acked list the roster gate uses, so
          reading past it once covers both surfaces for that person) and
          then continues into the normal add flow, full-class handling
          included. Nothing is ever written back. */}
      {walkinAlertPrompt ? (
        <div
          className="modal-scrim"
          onClick={() => setWalkinAlertPrompt(null)}
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
              Red alert on {walkinAlertPrompt.name}
            </p>
            <p className="ctx-alert modal-alert">
              {walkinAlertPrompt.redAlert ??
                "The studio flagged this client."}
            </p>
            <p className="muted">
              The studio flagged this deliberately. Read it before adding
              them to the class.
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setWalkinAlertPrompt(null)}
              >
                Cancel
              </button>
              <button
                className="modal-confirm"
                onClick={() => {
                  const client = walkinAlertPrompt;
                  setWalkinAlertPrompt(null);
                  setAcked((a) =>
                    a.includes(client.id) ? a : [...a, client.id],
                  );
                  /* Past the alert, the normal add flow resumes: a full
                     class still offers the waiting list instead. */
                  if (classFull) {
                    setWaitlistPrompt(client);
                  } else {
                    void bookWalkIn(client, false);
                  }
                }}
              >
                I have read it, add
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* No released waiver: the tap stops here, and since T18 (Pete's
          recorded reversal of T6's no-tap rule, matching Mindbody's own
          POS waiver-plus-Resolve) it can also be RESOLVED here: "Read the
          waiver" fetches the studio's real text and the dialog becomes a
          reading surface. The confirm stays disabled until the text has
          been scrolled to the end, is worded as recording the STUDENT's
          agreement, and a fetch failure falls back to the old close-only
          shape -- no path records agreement without the text rendered.
          The QR flow on the student's own phone remains the Phase 3 end
          state; this is the bridge. */}
      {waiverPrompt ? (
        <div
          className="modal-scrim"
          onClick={closeWaiverDialog}
          role="presentation"
        >
          <div
            className={waiverText ? "modal modal-waiver" : "modal"}
            role="alertdialog"
            aria-modal="true"
            aria-label="Liability waiver needed"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Titled the way Mindbody's own dialog is: the document name
                on top, the person as the line beneath it. */}
            <p className="modal-title">Liability Waiver</p>
            <p className="muted modal-who">
              {waiverText
                ? `For ${waiverPrompt.name} to read and agree to.`
                : `${waiverPrompt.name} has not signed the waiver.`}
            </p>
            {waiverText ? (
              <>
                <div
                  className="waiver-scroll"
                  ref={waiverScrollRef}
                  tabIndex={0}
                  aria-label="The liability waiver"
                  onScroll={(e) => {
                    /* Scrolled to the bottom, with a small tolerance for
                       fractional pixel heights. Once true it stays true:
                       scrolling back up does not un-read the text. */
                    const el = e.currentTarget;
                    if (
                      el.scrollTop + el.clientHeight >=
                      el.scrollHeight - 24
                    ) {
                      setWaiverScrolled(true);
                    }
                  }}
                >
                  {waiverText.text}
                </div>
                {!waiverScrolled ? (
                  <p className="muted">
                    Scroll to the end of the waiver to continue.
                  </p>
                ) : null}
                {waiverMsg ? (
                  <p className="pass-note modal-note-gap">{waiverMsg}</p>
                ) : null}
                <div className="modal-actions">
                  <button
                    className="modal-cancel"
                    disabled={waiverSaving}
                    onClick={closeWaiverDialog}
                  >
                    Cancel
                  </button>
                  <button
                    className="modal-confirm go"
                    disabled={!waiverScrolled || waiverSaving}
                    onClick={() => void agreeWaiver()}
                  >
                    {waiverSaving ? (
                      <span className="spinner" aria-label="working" />
                    ) : (
                      "Record agreement and check in"
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="ctx-alert modal-alert">
                  No liability waiver on file. They cannot be checked in
                  until they have read and agreed to it.
                </p>
                {waiverFetchError ? (
                  /* The fetch failed: the old close-only shape, with the
                     reason said quietly. Signing falls back to the
                     Mindbody app until the text can be shown here. */
                  <p className="muted">
                    The waiver text could not be fetched ({waiverFetchError}).
                    Have them sign it in the Mindbody app instead; once it is
                    signed the row will check in normally.
                  </p>
                ) : (
                  <p className="muted">
                    Hand them the iPad to read the studio&apos;s waiver, or
                    have them sign it in the Mindbody app. Recording an
                    agreement here requires the full text to be read first.
                  </p>
                )}
                <div className="modal-actions">
                  <button className="modal-cancel" onClick={closeWaiverDialog}>
                    Close
                  </button>
                  {!waiverFetchError ? (
                    <button
                      className="modal-confirm go"
                      disabled={waiverLoading}
                      onClick={readWaiver}
                    >
                      {waiverLoading ? (
                        <span className="spinner" aria-label="working" />
                      ) : (
                        "Read the waiver"
                      )}
                    </button>
                  ) : null}
                </div>
              </>
            )}
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

      {/* Cancel a booking. Names the person, says what it does in the stop
          colour, and waits for Mindbody on the confirm button itself: the
          dialog is the spinner, and it refuses to close mid-write. */}
      {cancelling ? (
        <div
          className="modal-scrim"
          onClick={() => {
            if (!cancelBusy) {
              setCancelling(null);
              setCancelMsg(null);
            }
          }}
          role="presentation"
        >
          <div
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm removal from class"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">
              Remove {cancelling.entry.name} from this class?
            </p>
            <p className="modal-entity">
              {cancelling.entry.pricingOption
                ? shortPassName(cancelling.entry.pricingOption)
                : "No pass"}
            </p>
            <p className="modal-consequence">
              Cancels their booking for this class.
            </p>
            {cancelMsg ? <p className="pass-note modal-note-gap">{cancelMsg}</p> : null}
            <div className="modal-actions">
              <button
                className="modal-cancel"
                disabled={cancelBusy}
                onClick={() => {
                  setCancelling(null);
                  setCancelMsg(null);
                }}
              >
                Cancel
              </button>
              <button
                className="modal-confirm"
                disabled={cancelBusy}
                onClick={() => void cancelVisit(cancelling)}
              >
                {cancelBusy ? (
                  <span className="spinner" aria-label="working" />
                ) : (
                  "Remove"
                )}
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

/**
 * useSearchParams in a client component must sit under a Suspense boundary
 * (Next requires it for the static shell). The page is fully client-side,
 * so the fallback flashes at most once, before hydration.
 */
export default function FrontDeskPage() {
  return (
    <Suspense fallback={null}>
      <FrontDesk />
    </Suspense>
  );
}
