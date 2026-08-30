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
import LockScreen from "./LockScreen";
import SaleScreen, {
  ModeBanner,
  type ModeConfig,
  type SaleClient,
} from "./SaleScreen";
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
  /** The pricing option's own id (Service.ProductId), matching
   *  CatalogItem.productId; what T26's renewal defaults the next pack
   *  to. Null when the visit carries no service or Mindbody omits it. */
  passProductId: number | null;
  /** AccountBalance from the batched client lookup; null when unknown. */
  balance: number | null;
  /** MembershipIcon nonzero on the client record; null when unknown. */
  member: boolean | null;
  paid: boolean;
  checkedIn: boolean;
  /** true = waiver on file, false = blocked, null = unknown (fails open). */
  waiverSigned: boolean | null;
  /** RedAlert text from the client record; null when none or lookup failed.
   *  Information behind the info icon since T20, not a gate. */
  redAlert: string | null;
  /** YellowAlert text; same standing as redAlert. */
  yellowAlert: string | null;
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
  yellowAlert: string | null;
  balance: number | null;
  member: boolean;
  notes: string | null;
  mindbodyId: number | null;
}

/**
 * Who the waiver dialog is about, and which flow resumes once the
 * student's agreement is recorded (T19, T20): a roster row continues
 * into the normal check-in path, a search result into the normal
 * booking path, a waitlist row into the normal promotion path.
 * Everything else about the dialog -- the real text, the scroll-to-end
 * gate, the receipt -- is shared and identical for all three.
 */
type WaiverSubject =
  | { source: "roster"; entry: RosterEntry }
  | { source: "walkin"; client: SearchResult }
  | { source: "promote"; row: WaitlistRow };

/** Mirrors src/lib/roster.ts: waiverSigned and notes ride the same
 *  batched client lookup that fills missing names, fail-open null. */
interface WaitlistRow {
  entryId: number;
  clientId: string;
  name: string;
  requestedAt: string | null;
  waiverSigned: boolean | null;
  notes: string | null;
}

/** Mirrors src/lib/clientcontext.ts, which is where the shapes are derived
 *  from the vendored spec. */
interface PassInfo {
  /** ClientService purchase-instance id; what a payment change posts.
   *  null means Mindbody omitted it and the pass cannot be picked. */
  id: number | null;
  /** The pricing option's own id, matching the catalog's productId; what
   *  T25 matches on to find a just-purchased instance. */
  productId: number | null;
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

/** A sellable pricing option in the pay-and-check-in dialog (T25): the
 *  catalog's Service items, as /api/catalog serves them. */
interface PayOption {
  id: string | number;
  productId: number | null;
  name: string;
  price: number;
  taxExempt: boolean;
  /** The option's own tax rate at the studio (null when Mindbody omitted
   *  it); rides every cart line so expectedTotal taxes at the item's
   *  rate, not a hardcoded studio constant (the sandbox taxes at 13%). */
  taxRate: number | null;
  /** Initial usage count of the option; 1 is a drop-in. */
  count: number | null;
  type: "Product" | "Service";
}

/** The stored card + live balance, as /api/stored-card serves them. */
interface PayProfile {
  loading: boolean;
  balance: number | null;
  card: {
    lastFour: string;
    expMonth: string | null;
    expYear: string | null;
    expired: boolean;
  } | null;
  error: string | null;
}

/** Mirrors /api/price-cart's PricedCart, trimmed to what the pay dialog
 *  renders. */
interface PayPriced {
  suppressed: boolean;
  grandTotal: number | null;
  expectedTotal: number;
  disagrees: boolean;
}

/**
 * How the last pay-and-check-in gesture ended, when it did not simply
 * succeed (success closes the dialog). Every shape is an HONEST outcome
 * reported at ITS stage: suppression is amber and stops at stage (a); a
 * definite charge refusal invites a retry because nothing else happened;
 * an ambiguous one does not; the post-charge failures say exactly what
 * DID happen and how the roster machinery finishes the job by hand.
 */
type PayOutcome =
  | { kind: "suppressed"; mode: string }
  | { kind: "charge-failed"; message: string }
  | { kind: "charge-ambiguous"; message: string }
  | { kind: "split"; message: string; mindbody: string }
  | { kind: "attach-failed"; message: string }
  | { kind: "checkin-failed" };

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

/** A person with a check: the search modal's row action in attach mode
 *  (T23). Selects the client for the sale and closes; books nothing. */
function PersonCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle
        cx="10"
        cy="8"
        r="3.4"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        d="M4 19.5c.6-3.4 3-5.2 6-5.2 1.2 0 2.3.3 3.2.8"
      />
      <path
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M14.5 17.5l2.2 2.2 3.8-4.4"
      />
    </svg>
  );
}

/** An "i" in a circle: the row's ONE info affordance (T20), opening the
 *  combined red alert / yellow alert / notes view. Replaces the separate
 *  alert-triangle and note-sheet icons. */
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
      />
      <path
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        d="M12 11v5.4M12 7.4v.1"
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

/** A shopping bag: opens the Buy overlay with the row's client already
 *  attached. The quiet per-row companion to the header's Buy button. */
function BagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M5.5 8h13l-1 12.5h-11Z"
      />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M8.8 10.5V6.7a3.2 3.2 0 0 1 6.4 0v3.8"
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
  const [config, setConfig] = useState<ModeConfig | null>(null);
  /** Rows whose check-in call failed after going green optimistically. */
  const [failed, setFailed] = useState<Record<string, string>>({});
  /**
   * The pay-and-check-in dialog over an unpaid row (T25): the row and the
   * class it was tapped under, both captured at open so the writes cannot
   * chase a moved activeId -- same posture as the cancel dialog. Null
   * means closed.
   */
  const [payDialog, setPayDialog] = useState<{
    entry: RosterEntry;
    classId: number;
    /** "unpaid" is T25's three-stage gesture (charge, attach, check in);
     *  "renewal" is T26's post-check-in offer, whose gesture is stage
     *  (a) ONLY: the visit is already paid and signed in, so the charge
     *  deliberately touches neither. */
    flavor: "unpaid" | "renewal";
  } | null>(null);
  /** Synchronous mirror of payDialog (the activeIdRef pattern), for the
   *  async renewal-offer decision: by the time its reads land, the
   *  render-scope payDialog is stale. */
  const payDialogRef = useRef<typeof payDialog>(null);
  payDialogRef.current = payDialog;
  /** Rows whose last session was just used where the renewal dialog had
   *  nothing to charge with (no card on file, no covering credit): a
   *  quiet row line instead, so the teacher can use Buy manually.
   *  Keyed by clientId; cleared on a class switch. */
  const [lastUsed, setLastUsed] = useState<Record<string, true>>({});
  /** The sellable pricing options, from /api/catalog, fetched on the
   *  dialog's first open and kept for the session (the route caches
   *  server-side too). Errors are not kept, so reopening retries. */
  const [payCatalog, setPayCatalog] = useState<{
    passes: PayOption[] | null;
    error: string | null;
    loading: boolean;
  }>({ passes: null, error: null, loading: false });
  /** The chosen pricing option's catalog id. Null until the default
   *  lands (see the effect that picks it). */
  const [paySelectedId, setPaySelectedId] = useState<string | number | null>(
    null,
  );
  /** Card on file + live balance for the dialog's client, fetched at
   *  open. Which method the one Charge button uses derives from this,
   *  per T24's rules; /api/checkout re-reads it all server-side. */
  const [payProfile, setPayProfile] = useState<PayProfile | null>(null);
  /** The server-priced total for the chosen option, T23's pessimistic
   *  pricing loop in miniature: the Charge button restates Mindbody's
   *  number or none. */
  const [payPriced, setPayPriced] = useState<PayPriced | null>(null);
  const [payPricing, setPayPricing] = useState(false);
  const [payPriceError, setPayPriceError] = useState<string | null>(null);
  /** Stale-response guard for the dialog's profile fetch: bumped on
   *  every open and close, the waiverGen pattern. */
  const payGen = useRef(0);
  /** Its sibling for the dialog's pricing loop, separate so a repriced
   *  selection cannot orphan a profile fetch mid-flight. */
  const payPriceGen = useRef(0);
  /** Which stage of the gesture is in flight; non-null locks the dialog
   *  shut (scrim, Escape, Cancel all refuse). */
  const [payStage, setPayStage] = useState<
    "charge" | "attach" | "checkin" | null
  >(null);
  /** The synchronous double-tap lock, T24's inFlight pattern: state
   *  re-renders too late for a fast second tap. */
  const payFlight = useRef(false);
  /** How the last gesture ended, when it did not fully succeed. */
  const [payOutcome, setPayOutcome] = useState<PayOutcome | null>(null);
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
   *  "checked in" renders from roster state already in memory; only the
   *  waitlist one can ever cost a call, and that call is shared with the
   *  counter itself. The signed-up counter opens nothing: its list IS the
   *  roster on screen, so it is a plain stat (Pete, 2026-08-29). */
  const [counterModal, setCounterModal] = useState<
    "checkedIn" | "waitlist" | null
  >(null);
  const [waitlist, setWaitlist] = useState<WaitlistRow[] | null>(null);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  /** Waitlist promotions in flight, by entry id. Also non-optimistic. */
  const [promoting, setPromoting] = useState<number[]>([]);
  const [promoteMsg, setPromoteMsg] = useState<Record<number, string>>({});
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
   *
   * Since T19 the same dialog also gates the walk-in ADD: the subject
   * says which flow opened it, and a recorded agreement resumes that
   * flow -- check-in for a roster row, booking for a search result.
   */
  const [waiverPrompt, setWaiverPrompt] = useState<WaiverSubject | null>(null);
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
  /** Bumped every time the waiver dialog closes, so a text fetch still in
   *  flight when the teacher cancelled cannot land its result into the
   *  NEXT open: without this, the leaked text put a fresh dialog straight
   *  into the reading state (skipping the "has not signed" framing for a
   *  different person), and a waiver short enough to fit unscrolled left
   *  the confirm permanently disabled, because the fits-without-scrolling
   *  effect keys on waiverText changing and it already held the text.
   *  Same stale-response pattern as activeIdRef. */
  const waiverGen = useRef(0);
  /**
   * The ONE info view behind a row's info icon (T20): the client's red
   * alert, yellow alert, and staff notes together, titled with their
   * name. Each section is editable in place through the same textarea /
   * Cancel / Save flow notes always had, one field per save. DECISION
   * REVERSAL, recorded on the ticket: Pete studied the studio's actual
   * RedAlert usage and it does not block anything ("Cleaning on
   * Wednesdays"), so the alert is information here, not a gate -- the
   * blocking dialogs and the session ack list are gone.
   */
  const [infoView, setInfoView] = useState<{
    clientId: string;
    name: string;
    redAlert: string | null;
    yellowAlert: string | null;
    notes: string | null;
  } | null>(null);
  /** Which of the info view's three fields is being edited, if any. The
   *  values are the Mindbody field names the save posts; the whitelist
   *  proper lives server-side in /api/client-field. */
  const [infoEditing, setInfoEditing] = useState<
    "RedAlert" | "YellowAlert" | "Notes" | null
  >(null);
  /** The textarea's contents while editing an info field. */
  const [infoDraft, setInfoDraft] = useState("");
  /** True while an info-field save is in flight. Non-optimistic, like
   *  every write here: the Save button spins until Mindbody answers, and
   *  the view refuses to close meanwhile. */
  const [infoSaving, setInfoSaving] = useState(false);
  /** Outcome text inside the info view: a failure, or the suppression
   *  notice when dry run or the write guard stopped the save. */
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
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
  /** Whether the sale overlay (T23) is on screen. Pure UI state: the
   *  roster stays mounted underneath and the URL is untouched, so closing
   *  lands back exactly where the teacher was. SaleScreen itself stays
   *  mounted across open/close, so a cart survives an accidental Back. */
  const [saleOpen, setSaleOpen] = useState(false);
  /** The client the sale is for, or null for an anonymous sale. Chosen
   *  through the search modal's attach mode; rides /api/price-cart. */
  const [saleClient, setSaleClient] = useState<SaleClient | null>(null);
  /** True while the search modal is open as the sale's attach picker
   *  (T23): same modal, same submit-triggered search, same row format,
   *  but the row action selects the client instead of booking, and the
   *  booking-only furniture (full-class notice, pass picker, roster
   *  de-duplication) steps aside. */
  const [attachMode, setAttachMode] = useState(false);
  /**
   * Attach-mode furniture ONLY, all of it (T27 round three, Pete's third
   * live test): the person a sale is for is usually standing in a class
   * that is already on screen, so the attach modal offers the roster
   * BEFORE the search -- an "In class" quick-pick of tappable rows, with
   * a class dropdown above it for a student signed up for a DIFFERENT
   * class today. The booking-mode search modal renders none of this.
   *
   * `attachClassId` is whose roster the quick-pick shows; it starts as
   * the selected class, whose roster is already in memory (zero calls).
   */
  const [attachClassId, setAttachClassId] = useState<number | null>(null);
  /** Whether the quick-pick's class dropdown menu is open. Pure UI. */
  const [attachClassMenuOpen, setAttachClassMenuOpen] = useState(false);
  /** The whole teaching day's classes, for the dropdown: fetched lazily
   *  on the modal's first open of the day (ONE metered call, the
   *  around-now window is too narrow), then served from the per-day
   *  session cache below. */
  const [dayClasses, setDayClasses] = useState<{
    list: ClassSummary[] | null;
    loading: boolean;
    error: string | null;
  }>({ list: null, loading: false, error: null });
  /** Session cache for the day-classes call, keyed by the anchor's local
   *  date so a counter left open overnight refetches for the new day. */
  const dayClassesCache = useRef<{
    key: string;
    list: ClassSummary[];
  } | null>(null);
  /** Rosters fetched for the quick-pick when a NON-selected class is
   *  picked, cached per classId for the session (the selected class's
   *  roster is `entries`, used directly, zero calls). */
  const attachRosterCache = useRef(new Map<number, RosterEntry[]>());
  /** classIds with a quick-pick roster fetch already in flight: a
   *  re-pick mid-flight must not fire a second metered call (the first
   *  answer still lands, via the attachClassIdRef guard). */
  const attachRosterFetching = useRef(new Set<number>());
  /** The day key whose classes fetch is in flight: reopening the modal
   *  before it lands must not fire a second metered call, and a slow
   *  answer for a SUPERSEDED day must not render as the current one. */
  const dayFetchKeyRef = useRef<string | null>(null);
  const [attachRoster, setAttachRoster] = useState<{
    entries: RosterEntry[] | null;
    loading: boolean;
    error: string | null;
  }>({ entries: null, loading: false, error: null });
  /** Which class the quick-pick is showing, readable at fetch-response
   *  time: a roster landing after the teacher picked another class must
   *  be dropped, not rendered. Same pattern as activeIdRef. */
  const attachClassIdRef = useRef<number | null>(null);
  attachClassIdRef.current = attachClassId;
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
    /* Failure text is keyed by CLIENT id, so without this a failure shown
     * on one class would carry to the same client's booking on another
     * class. Per-class-view state; a class switch resets it. The pay
     * dialog (T25) deliberately does NOT close here: it is a modal (a
     * teacher cannot switch classes under it; only the settings-driven
     * classes refetch can move activeId), it captured its entry and
     * classId at open, and closing it mid-gesture would unmount the
     * outcome of a charge. */
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
    /* The quiet "Last session used." lines belong to the class they were
     * earned on. */
    setLastUsed({});
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

  /** Escape closes the counter modals (checked-in, waitlist) -- unless
   *  the waiver dialog is stacked above the waitlist panel (the promote
   *  gate, T20), or an info view is: Escape peels the top layer, same
   *  contract as the search modal's guard. The stacked dialogs close on
   *  their own scrims. */
  useEffect(() => {
    if (counterModal === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !waiverPrompt && !infoView) {
        setCounterModal(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [counterModal, waiverPrompt, infoView]);

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
    setAttachMode(false);
    setAttachClassMenuOpen(false);
  }, []);

  /** Open the search modal as the sale's attach picker (T23): no query
   *  yet, so the modal renders its own copy of the search bar, wired to
   *  the SAME query state and submitSearch, and the one metered call
   *  still fires on submit only. Since T27 round three the modal leads
   *  with the "In class" quick-pick, so opening also points it at the
   *  selected class (roster already in memory) and lazily fetches the
   *  day's classes for its dropdown, once per day per session. */
  const openAttachSearch = useCallback(() => {
    setAttachMode(true);
    setSearchMsg(null);
    setSearchError(null);
    setSearchTitle("");
    setFound([]);
    setQuery("");
    setSearchOpen(true);
    setAttachClassMenuOpen(false);
    setAttachClassId(activeIdRef.current);
    setAttachRoster({ entries: null, loading: false, error: null });
    /* The day window anchors on the SELECTED class's date (not the
     * browser clock): the quick-pick is about the day that class sits
     * in. Cached per STUDIO-local date, so reopening the modal all shift
     * long costs nothing more. startsAt is Mindbody's NAIVE studio-local
     * string, so its own date part IS the studio date (a browser-local
     * or UTC reading drifts a day at timezone boundaries: toDateString
     * on a UTC-set iPad called a 5pm class tomorrow); with no class
     * selected the anchor is "now", whose studio date comes from Intl,
     * mirroring roster.ts's STUDIO_TZ. */
    const startsAt =
      classes.find((c) => c.classId === activeIdRef.current)?.startsAt ?? "";
    const anchor = startsAt || new Date().toISOString();
    const key = startsAt
      ? startsAt.slice(0, 10)
      : new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles",
        }).format(new Date());
    const cached = dayClassesCache.current;
    if (cached && cached.key === key) {
      setDayClasses({ list: cached.list, loading: false, error: null });
      return;
    }
    setDayClasses({ list: null, loading: true, error: null });
    /* Already fetching this same day (the modal reopened before the
     * answer landed): that flight's answer lands here, no second call. */
    if (dayFetchKeyRef.current === key) return;
    dayFetchKeyRef.current = key;
    fetch(`/api/roster?day=1&anchor=${encodeURIComponent(anchor)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(String(d.error));
        const list: ClassSummary[] = d.classes ?? [];
        dayClassesCache.current = { key, list };
        /* A newer day's fetch superseded this one (open overnight):
         * cache it, but do not render it as the current day. */
        if (dayFetchKeyRef.current !== key) return;
        dayFetchKeyRef.current = null;
        setDayClasses({ list, loading: false, error: null });
      })
      .catch((e) => {
        if (dayFetchKeyRef.current !== key) return;
        dayFetchKeyRef.current = null;
        setDayClasses({
          list: null,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }, [classes]);

  /** Point the quick-pick at another class. The selected class's roster
   *  is on screen already (zero calls); any other class's is fetched
   *  through the existing /api/roster route once and session-cached per
   *  classId. */
  const pickAttachClass = useCallback((classId: number) => {
    setAttachClassMenuOpen(false);
    setAttachClassId(classId);
    if (classId === activeIdRef.current) return;
    const cached = attachRosterCache.current.get(classId);
    if (cached) {
      setAttachRoster({ entries: cached, loading: false, error: null });
      return;
    }
    setAttachRoster({ entries: null, loading: true, error: null });
    /* A fetch for this class is already in flight (picked away and back
     * before it landed): its answer still renders through the
     * attachClassIdRef guard below, so no second metered call. */
    if (attachRosterFetching.current.has(classId)) return;
    attachRosterFetching.current.add(classId);
    fetch(`/api/roster?classId=${classId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(String(d.error));
        const list: RosterEntry[] = d.entries ?? [];
        attachRosterCache.current.set(classId, list);
        attachRosterFetching.current.delete(classId);
        if (attachClassIdRef.current !== classId) return;
        setAttachRoster({ entries: list, loading: false, error: null });
      })
      .catch((e) => {
        attachRosterFetching.current.delete(classId);
        if (attachClassIdRef.current !== classId) return;
        setAttachRoster({
          entries: null,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }, []);

  /** The attach-mode row action: select the client for the sale and
   *  close. Writes nothing, books nothing, gates nothing -- buying a
   *  bottle of water needs no waiver. Takes just id/name/balance so the
   *  quick-pick's RosterEntry rows and the search results share it. */
  const attachSaleClient = useCallback(
    (client: { id: string; name: string; balance: number | null }) => {
      setSaleClient({
        id: client.id,
        name: client.name,
        balance: client.balance,
      });
      closeSearch();
    },
    [closeSearch],
  );

  /**
   * The per-row Buy button (roster rows and normal-mode search results):
   * open the Buy overlay with THAT client already attached, from the
   * facts the row holds. Attaching writes nothing; SaleScreen's pricing
   * loop keys on the client id, so a cart already held reprices for the
   * new client exactly as the attach-mode path does. Opened from the
   * search modal, the modal closes first (the overlay sits below every
   * modal scrim).
   */
  const openBuyFor = useCallback(
    (client: SaleClient) => {
      setSaleClient(client);
      /* Same tidying as the header's Buy button: anything anchored to
       * roster rows would otherwise paint above the overlay. */
      setPickerFor(null);
      setSortMenuOpen(false);
      closeSearch();
      setSaleOpen(true);
    },
    [closeSearch],
  );

  /**
   * Best-effort refresh of everything the screen holds about one client
   * after money moved for them (a sale, T30's contract purchase). Their
   * pass caches are dropped so the next open refetches, and the roster
   * refreshes: a sale spends account credit and can add a pass, and Pete's
   * fourth live test caught a $5 credit spend leaving $40.00 on the row
   * until the class was switched and switched back. The purchase already
   * stands whatever happens here.
   */
  const refreshClientState = useCallback(
    (cid: string) => {
      passSweepCache.current.delete(cid);
      setPassLists((l) => {
        const { [cid]: _drop, ...rest } = l;
        return rest;
      });
      if (activeId !== null) void refreshRoster(activeId);
    },
    [activeId, refreshRoster],
  );

  /** Escape closes the search-results modal, unless a layer is stacked
   *  on top of it (the waiver gate, waitlist confirm, the info view, the
   *  pass picker): Escape peels the top layer, so an open pass picker
   *  closes first and the modal takes the next press. The dialogs close
   *  on their own scrims. */
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !waitlistPrompt &&
        !waiverPrompt &&
        !infoView
      ) {
        if (walkinPicker) {
          setWalkinPicker(null);
        } else if (attachClassMenuOpen) {
          /* The quick-pick's class dropdown is a layer too: Escape peels
           * it before closing the modal, same as the pass picker. */
          setAttachClassMenuOpen(false);
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
    waiverPrompt,
    infoView,
    walkinPicker,
    attachClassMenuOpen,
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
   *
   * Returns whether the write REALLY reached Mindbody, so a caller can
   * chain something that must only follow a real check-in (T26's renewal
   * offer): false on failure, and false on a dry-run or write-guard
   * suppression too, because a suppressed write consumed nobody's
   * session. The row still flips on a suppressed 200 (the long-standing
   * dev-mode behavior, so the flow stays exercisable under dry run), but
   * nothing downstream may treat it as a session spent.
   */
  const setSignedIn = useCallback(
    async (entry: RosterEntry, signedIn: boolean): Promise<boolean> => {
      if (entry.visitId === null) {
        setFailed((f) => ({
          ...f,
          [entry.clientId]: "No visit id on this booking, so it cannot be signed in.",
        }));
        return false;
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
        return !body?.suppressed;
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
        return false;
      } finally {
        setBusy((b) => b.filter((id) => id !== entry.clientId));
      }
    },
    [settings.optimisticCheckIn],
  );

  /**
   * Open the pay-and-check-in dialog (T25) over an unpaid row: capture
   * the row and the class NOW (the cancel dialog's discipline: the
   * eventual writes name these, never whatever activeId has become),
   * reset every piece of dialog state, and start the two reads the
   * dialog needs -- the catalog's pricing options (session-cached) and
   * the client's card + live balance.
   */
  const openPayDialog = useCallback(
    (
      entry: RosterEntry,
      flavor: "unpaid" | "renewal" = "unpaid",
      /** A profile the caller just read (T26's offer gate reads it to
       *  decide whether to open at all); passing it skips the fetch. */
      profile?: PayProfile,
    ) => {
      if (activeId === null) return;
      payGen.current += 1;
      payPriceGen.current += 1;
      const gen = payGen.current;
      setPayOutcome(null);
      setPayPriced(null);
      setPayPriceError(null);
      setPayPricing(false);
      setPaySelectedId(null);
      setPayDialog({ entry, classId: activeId, flavor });
      if (profile) {
        setPayProfile(profile);
      } else {
        /* The roster's balance stands in until the live read lands. */
        setPayProfile({
          loading: true,
          balance: entry.balance,
          card: null,
          error: null,
        });
        fetch(`/api/stored-card?clientId=${encodeURIComponent(entry.clientId)}`)
          .then(async (r) => {
            const body = await r.json();
            if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
            if (payGen.current !== gen) return;
            setPayProfile({
              loading: false,
              balance:
                typeof body?.balance === "number"
                  ? body.balance
                  : entry.balance,
              card: body?.card ?? null,
              error: null,
            });
          })
          .catch((e) => {
            if (payGen.current !== gen) return;
            setPayProfile({
              loading: false,
              balance: entry.balance,
              card: null,
              error: e instanceof Error ? e.message : String(e),
            });
          });
      }
      /* The catalog, once per session; a kept error would dead-end every
       * later open, so errors are shown but not cached (the dialog's
       * Retry re-enters here). */
      if (payCatalog.passes === null && !payCatalog.loading) {
        setPayCatalog({ passes: null, error: null, loading: true });
        fetch("/api/catalog")
          .then(async (r) => {
            const body = await r.json();
            if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
            const passes: PayOption[] = (body?.passes ?? []).filter(
              (p: PayOption) => p?.type === "Service",
            );
            setPayCatalog({ passes, error: null, loading: false });
          })
          .catch((e) =>
            setPayCatalog({
              passes: null,
              error: e instanceof Error ? e.message : String(e),
              loading: false,
            }),
          );
      }
    },
    [activeId, payCatalog],
  );

  /** Close the pay dialog and drop everything it held. Refused while any
   *  stage of the gesture is in flight: money may be moving, and the
   *  outcome renders HERE. */
  const closePayDialog = useCallback(() => {
    if (payStage !== null) return;
    payGen.current += 1;
    payPriceGen.current += 1;
    setPayDialog(null);
    setPayOutcome(null);
    setPayPriced(null);
    setPayPriceError(null);
    setPayPricing(false);
    setPaySelectedId(null);
    setPayProfile(null);
  }, [payStage]);

  /**
   * T26: after a REAL check-in that used a pass's last session, decide
   * between the renewal dialog and the quiet row line. Never blocking:
   * the check-in already happened and stands whatever this does. The
   * dialog opens only when there is something to charge with -- an
   * unexpired card on file, or account credit covering the would-be
   * default pack's list price -- and only if the teacher is still on the
   * class the tap belonged to with no other pay dialog open; otherwise
   * the row gets the quiet "Last session used." line so the teacher can
   * use Buy manually.
   */
  const maybeOfferRenewal = useCallback(
    async (entry: RosterEntry, classId: number) => {
      const quiet = () => {
        /* The line belongs to the class the tap was on. Landing after a
         * class switch must not write into the NEW class's map -- the
         * switch already cleared it, and the same clientId can sit on
         * both rosters. Switching back loses the line, which is the
         * "cleared on class switch" rule applied consistently. */
        if (activeIdRef.current !== classId) return;
        setLastUsed((m) => ({ ...m, [entry.clientId]: true }));
      };
      /* The live profile: the same read the dialog would make, done up
       * front because it IS the decision. A failed read cannot decide,
       * so it goes quiet rather than opening a dialog with nothing
       * chargeable in it. */
      let profile: PayProfile;
      try {
        const r = await fetch(
          `/api/stored-card?clientId=${encodeURIComponent(entry.clientId)}`,
        );
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        profile = {
          loading: false,
          balance:
            typeof body?.balance === "number" ? body.balance : entry.balance,
          card: body?.card ?? null,
          error: null,
        };
      } catch {
        quiet();
        return;
      }
      const card = profile.card && !profile.card.expired ? profile.card : null;
      /* The catalog, for the covering-credit yardstick (and the dialog
       * itself); reuse the session cache, fetch it once if this offer
       * gets there first. Best-effort: no catalog means the yardstick
       * cannot pass, and a card-on-file dialog shows the catalog error
       * with its Retry. */
      let passes = payCatalog.passes;
      if (passes === null && card === null) {
        try {
          const r = await fetch("/api/catalog");
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
          passes = ((body?.passes ?? []) as PayOption[]).filter(
            (p) => p?.type === "Service",
          );
          setPayCatalog({ passes, error: null, loading: false });
        } catch {
          passes = null;
        }
      }
      /* The pack the dialog would default to: same ProductId when still
       * sellable, else the usual single-visit default. Its LIST price is
       * the covering-credit yardstick; tax can push the real total past
       * it, and /api/checkout re-reads the balance and refuses honestly
       * if so. */
      let target: PayOption | null = null;
      if (passes && passes.length > 0) {
        target =
          (entry.passProductId !== null
            ? passes.find((p) => p.productId === entry.passProductId)
            : undefined) ??
          [...passes].sort((a, b) => {
            const ca =
              a.count !== null && a.count < 100
                ? a.count
                : Number.MAX_SAFE_INTEGER;
            const cb =
              b.count !== null && b.count < 100
                ? b.count
                : Number.MAX_SAFE_INTEGER;
            return ca - cb || a.price - b.price;
          })[0] ??
          null;
      }
      const creditCovers =
        target !== null &&
        profile.balance !== null &&
        profile.balance >= target.price;
      if (
        (card !== null || creditCovers) &&
        payDialogRef.current === null &&
        !payFlight.current &&
        activeIdRef.current === classId
      ) {
        openPayDialog(entry, "renewal", profile);
      } else {
        quiet();
      }
    },
    [openPayDialog, payCatalog.passes],
  );

  /**
   * The dialog's default selection: the sensible single-visit option, so
   * the common gesture is tap-the-chip, tap-Charge. Lowest real Count
   * wins (a drop-in is Count 1; the fake-unlimited counters >= 100 sort
   * last), price breaks ties. Runs when the catalog lands with the
   * dialog open and nothing chosen yet.
   */
  useEffect(() => {
    if (!payDialog || paySelectedId !== null) return;
    const passes = payCatalog.passes;
    if (!passes || passes.length === 0) return;
    /* Renewal flavor (T26): the default is the SAME pack again, matched
     * by the current pass's ProductId, when the catalog still sells it.
     * No match (or no ProductId) falls through to the usual default. */
    if (payDialog.flavor === "renewal" && payDialog.entry.passProductId !== null) {
      const same = passes.find(
        (p) => p.productId === payDialog.entry.passProductId,
      );
      if (same) {
        setPaySelectedId(same.id);
        return;
      }
    }
    const best = [...passes].sort((a, b) => {
      const ca =
        a.count !== null && a.count < 100 ? a.count : Number.MAX_SAFE_INTEGER;
      const cb =
        b.count !== null && b.count < 100 ? b.count : Number.MAX_SAFE_INTEGER;
      return ca - cb || a.price - b.price;
    })[0];
    if (best) setPaySelectedId(best.id);
  }, [payDialog, paySelectedId, payCatalog.passes]);

  /**
   * The dialog's pricing loop, T23's pessimistic pattern in miniature:
   * the chosen option debounces briefly (a teacher tapping down the list
   * costs one metered Test call, not one per tap), POSTs /api/price-cart
   * with the client attached (attachment can change pricing), and only
   * the newest generation's answer lands. The Charge button restates the
   * SERVER's total or none; suppression and disagreement render as
   * exactly what they are.
   */
  useEffect(() => {
    const clientId = payDialog?.entry.clientId ?? null;
    const sel =
      paySelectedId !== null
        ? (payCatalog.passes?.find((p) => p.id === paySelectedId) ?? null)
        : null;
    if (clientId === null || sel === null) {
      setPayPriced(null);
      setPayPricing(false);
      setPayPriceError(null);
      return;
    }
    const gen = ++payPriceGen.current;
    setPayPricing(true);
    setPayPriceError(null);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/price-cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: [
              {
                type: sel.type,
                metadataId: sel.id,
                quantity: 1,
                price: sel.price,
                taxExempt: sel.taxExempt,
                taxRate: sel.taxRate,
              },
            ],
            clientId,
          }),
        });
        const body = await res.json();
        if (payPriceGen.current !== gen) return;
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setPayPriced(body as PayPriced);
      } catch (err) {
        if (payPriceGen.current !== gen) return;
        setPayPriced(null);
        setPayPriceError(err instanceof Error ? err.message : String(err));
      } finally {
        if (payPriceGen.current === gen) setPayPricing(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [payDialog, paySelectedId, payCatalog.passes]);

  /** Escape closes the pay dialog like its Cancel does -- never while a
   *  stage of the gesture is in flight: money may be moving, and the
   *  outcome renders here. */
  useEffect(() => {
    if (!payDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && payStage === null) closePayDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payDialog, payStage, closePayDialog]);

  /**
   * The check-in CHIP's tap. The chip is the ONLY check-in trigger: the
   * row body used to be the target too, for speed, and live use showed
   * accidental check-ins -- a deliberate reversal (T16, Pete's call), so
   * do not restore row-tap check-in. Every gate lives here, in order:
   * waiver block FIRST, then the unpaid gate -- an unpaid booking has no
   * pricing option attached, and since T25 its tap opens the
   * pay-and-check-in dialog, which sells the missing pass, attaches it,
   * and checks them in as one gesture (free entry survives inside it as
   * the labelled exception).
   *
   * Checking OUT is not here: it has its own control and its own
   * confirmation, because undoing a check-in by the same gesture that made
   * it is too easy to do by accident.
   */
  const tapCheckIn = useCallback(
    (entry: RosterEntry) => {
      if (busy.includes(entry.clientId) || entry.checkedIn) return;
      /**
       * No released waiver stops everything, BEFORE the pay dialog: an
       * unpaid no-waiver client meets the waiver gate first, and only a
       * recorded agreement re-enters this tap and reaches the pay
       * dialog. Since T18 the dialog can RESOLVE the waiver, but only by
       * showing the student the real text, scrolled to the end, and
       * recording THEIR agreement; a teacher cannot simply wave it past.
       * Unknown (null, lookup failed) fails open and is not this branch.
       *
       * There is deliberately no red-alert gate here anymore (T20,
       * Pete's recorded reversal): the studio's real alerts are notes
       * like "Cleaning on Wednesdays", information behind the row's
       * info icon, not something to block a check-in over.
       */
      if (entry.waiverSigned === false) {
        setWaiverPrompt({ source: "roster", entry });
        return;
      }
      /* The T25 gate. A row with no visit id cannot be attached to or
       * signed in, so it falls through to setSignedIn, which reports
       * that plainly. confirmUnpaid=false keeps the old direct
       * behavior: unpaid checks straight in, no dialog. */
      if (settings.confirmUnpaid && !entry.paid && entry.visitId !== null) {
        openPayDialog(entry);
        return;
      }
      /* T26: a real pass down to its last session. The check-in itself
       * runs exactly as normal -- they still have the session, and the
       * tap must not get slower -- and only a SUCCESSFUL write chains
       * the renewal offer, which never blocks or undoes anything. */
      const lastSession =
        entry.paid &&
        entry.passRemaining === 1 &&
        !fakeUnlimited(entry.passCount, entry.passRemaining);
      const classId = activeIdRef.current;
      if (lastSession && classId !== null) {
        void (async () => {
          const ok = await setSignedIn(entry, true);
          if (ok) void maybeOfferRenewal(entry, classId);
        })();
        return;
      }
      void setSignedIn(entry, true);
    },
    [busy, setSignedIn, settings.confirmUnpaid, openPayDialog, maybeOfferRenewal],
  );

  /** Close the waiver dialog and drop every piece of its state, so a
   *  half-read waiver on one client can never leak into another's dialog.
   *  Refused mid-write: the answer is coming. */
  const closeWaiverDialog = useCallback(() => {
    if (waiverSaving) return;
    waiverGen.current += 1;
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
    const gen = waiverGen.current;
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
        /* The dialog this fetch belonged to has closed: drop the result
         * rather than leaking the reading state into the next open. */
        if (waiverGen.current !== gen) return;
        setWaiverScrolled(false);
        setWaiverText({ text: body.text, sha256: body.sha256 });
      })
      .catch((e) => {
        if (waiverGen.current !== gen) return;
        setWaiverFetchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (waiverGen.current !== gen) return;
        setWaiverLoading(false);
      });
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

  /** Open the info view for a person, whichever surface their row is on.
   *  Always opens, even with nothing behind it: adding the first note or
   *  alert starts here too. */
  const openInfoView = useCallback(
    (p: {
      clientId: string;
      name: string;
      redAlert: string | null;
      yellowAlert: string | null;
      notes: string | null;
    }) => {
      setInfoEditing(null);
      setInfoMsg(null);
      setInfoView({
        clientId: p.clientId,
        name: p.name,
        redAlert: p.redAlert,
        yellowAlert: p.yellowAlert,
        notes: p.notes,
      });
    },
    [],
  );

  /** Close the info view and drop any editing state with it.
   *  Refused mid-save: the answer is coming. */
  const closeInfoView = useCallback(() => {
    if (infoSaving) return;
    setInfoView(null);
    setInfoEditing(null);
    setInfoMsg(null);
  }, [infoSaving]);

  /**
   * Save the field being edited through /api/client-field, which posts
   * the surgical `{Client: {Id, <field>}, CrossRegionalUpdate: false}`
   * update -- ONE field per save, whitelisted server-side (see
   * src/lib/clients.ts). Non-optimistic: the Save button spins until
   * Mindbody answers. On success the person's local state updates in
   * place wherever this screen holds them -- the roster row and any
   * search result, so the info icon's grey/bright recomputes -- and the
   * view drops back to reading, showing the saved text. Suppression
   * renders inside the view as the amber notice, never as success;
   * failure shows Mindbody's reason and keeps the draft for another try.
   */
  const saveInfoField = useCallback(async () => {
    if (!infoView || !infoEditing || infoSaving) return;
    const { clientId } = infoView;
    const field = infoEditing;
    setInfoSaving(true);
    setInfoMsg(null);
    try {
      const res = await fetch("/api/client-field", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, field, value: infoDraft }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (body.suppressed) {
        setInfoMsg(
          body.suppressed === "dry-run"
            ? "Dry run: save suppressed, nothing was written."
            : "Write guard: this client is not in POS_WRITE_CLIENT_IDS.",
        );
        return;
      }
      /* The batched brief lookup and the search mapping both trim and
       * null-convert these fields the same way, so the local update
       * matches what a reload would show. */
      const trimmed = infoDraft.trim() || null;
      const patch =
        field === "Notes"
          ? { notes: trimmed }
          : field === "RedAlert"
            ? { redAlert: trimmed }
            : { yellowAlert: trimmed };
      setEntries((rows) =>
        rows.map((r) => (r.clientId === clientId ? { ...r, ...patch } : r)),
      );
      setFound((rows) =>
        rows.map((r) => (r.id === clientId ? { ...r, ...patch } : r)),
      );
      /* Waitlist rows carry notes too, and theirs feed the waiver
       * receipt append (agreeWaiver posts the row's notes for the
       * server to append to): a notes edit that skipped them would be
       * clobbered by the very next recorded agreement for that person.
       * Same cross-surface reasoning as agreeWaiver's own waitlist
       * patch. Alerts are not on the row, so only Notes applies. */
      if (field === "Notes") {
        setWaitlist((rows) =>
          rows === null
            ? rows
            : rows.map((r) =>
                r.clientId === clientId ? { ...r, notes: trimmed } : r,
              ),
        );
      }
      setInfoView((v) => (v ? { ...v, ...patch } : v));
      setInfoEditing(null);
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setInfoSaving(false);
    }
  }, [infoView, infoEditing, infoDraft, infoSaving]);

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
  /** What the search modal lists. Attach mode (T23) shows EVERY match:
   *  someone already on the roster can still buy a drink, so the
   *  booking-flow de-duplication does not apply to a sale. */
  const shownResults = attachMode ? found : walkIns;

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
   * The walk-in ADD tap. One gate, same as the roster's tapCheckIn:
   * the waiver, then the full-class handling.
   *
   * The waiver gates the ADD, not just the eventual check-in (T19):
   * Mindbody can return an after-start booking already signed in, so the
   * roster's check-in gate never runs for it -- the add is the last
   * reliable stop. A result with no released waiver opens the same T18
   * dialog the roster uses, and nothing is booked until the student's
   * agreement is recorded.
   *
   * The red alert no longer gates here (T20, Pete's recorded reversal):
   * it is information behind the row's info icon. Past the waiver, the
   * existing full-class handling stands: a full class offers the
   * waiting list, a class with room books.
   */
  const tapWalkIn = useCallback(
    (client: SearchResult) => {
      /* Same single-flight rule as bookWalkIn: any booking in flight
       * blocks every other row's tap, not just this client's. */
      if (bookingIds.length > 0) return;
      if (client.waiverSigned === false) {
        setWaiverPrompt({ source: "walkin", client });
        return;
      }
      if (classFull) {
        setWaitlistPrompt(client);
      } else {
        void bookWalkIn(client, false);
      }
    },
    [bookingIds, classFull, bookWalkIn],
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
   * The promote tap, with the waiver gate in front of it (T20, found by
   * the T19 review): a no-waiver student who waitlisted online was
   * promotable with no dialog, and an after-start promotion can come
   * back from Mindbody already signed in, so the roster's check-in gate
   * never runs for it -- the promote tap is the last reliable stop,
   * exactly the T19 add-side mechanism. `false` only: null is a failed
   * lookup and FAILS OPEN, matching the roster's posture -- unknown
   * must not block a promotion.
   */
  const tapPromote = useCallback(
    (row: WaitlistRow) => {
      if (promoting.includes(row.entryId)) return;
      if (row.waiverSigned === false) {
        setWaiverPrompt({ source: "promote", row });
        return;
      }
      void promote(row);
    },
    [promoting, promote],
  );

  /**
   * Record the student's agreement (T18). Only reachable from the reading
   * state's confirm, which is disabled until the text has been scrolled
   * to the end -- so by construction the release is never written without
   * the real text having been shown. Non-optimistic: the confirm spins
   * until Mindbody answers. Suppression (dry run / write guard) renders
   * inside the dialog as the amber notice, never as success -- and never
   * continues to a check-in or a booking; failure shows Mindbody's
   * reason.
   *
   * On a real success: the dialog closes, the person's local
   * waiverSigned flips wherever this screen holds them -- the roster
   * always, and for a walk-in the search results too, so the pill clears
   * without a new search -- and the SAME flow that opened the dialog
   * takes over, now past the waiver gate. A roster row re-enters
   * tapCheckIn, with the unpaid confirm still applying; a walk-in
   * re-enters tapWalkIn, with the full-class waitlist offer, the chosen
   * pass, and the single-flight booking lock all still applying (T19).
   * The next roster load confirms from Mindbody.
   */
  const agreeWaiver = useCallback(async () => {
    const subject = waiverPrompt;
    if (!subject || !waiverText || !waiverScrolled || waiverSaving) return;
    const person =
      subject.source === "roster"
        ? {
            id: subject.entry.clientId,
            name: subject.entry.name,
            notes: subject.entry.notes,
          }
        : subject.source === "walkin"
          ? {
              id: subject.client.id,
              name: subject.client.name,
              notes: subject.client.notes,
            }
          : {
              id: subject.row.clientId,
              name: subject.row.name,
              notes: subject.row.notes,
            };
    setWaiverSaving(true);
    setWaiverMsg(null);
    try {
      const res = await fetch("/api/waiver-agree", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: person.id,
          /* The freshest notes this screen holds, for the receipt append.
           * A stale value loses at most a concurrent edit from another
           * surface; the roster refetches notes on every load. */
          notes: person.notes,
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
          : person.notes;
      setWaiverReceiptWarn(
        body.receiptNoted
          ? null
          : `Waiver recorded for ${person.name}, but the receipt note did not save` +
              `${body.receiptReason ? ` (${body.receiptReason})` : ""}. The agreement stands; the server log holds the receipt.`,
      );
      /* The roster updates for both flows: a walk-in who somehow already
       * has a roster row (booked from another surface mid-search) must
       * not keep a stale block on that row. */
      setEntries((rows) =>
        rows.map((r) =>
          r.clientId === person.id
            ? { ...r, waiverSigned: true, notes: newNotes }
            : r,
        ),
      );
      if (subject.source === "walkin") {
        setFound((rows) =>
          rows.map((r) =>
            r.id === person.id
              ? { ...r, waiverSigned: true, notes: newNotes }
              : r,
          ),
        );
      }
      /* The waitlist rows update for every flow, not just promote: the
       * same person can be queued here while being signed from another
       * surface, and a stale false would re-open the dialog on their
       * promotion. */
      setWaitlist((rows) =>
        rows === null
          ? rows
          : rows.map((r) =>
              r.clientId === person.id
                ? { ...r, waiverSigned: true, notes: newNotes }
                : r,
            ),
      );
      setWaiverSaving(false);
      closeWaiverDialog();
      /* The normal path for whichever flow opened the dialog, on the
       * updated person: past the waiver gate now, every other gate still
       * ahead. */
      if (subject.source === "roster") {
        tapCheckIn({ ...subject.entry, waiverSigned: true, notes: newNotes });
      } else if (subject.source === "walkin") {
        tapWalkIn({ ...subject.client, waiverSigned: true, notes: newNotes });
      } else {
        tapPromote({ ...subject.row, waiverSigned: true, notes: newNotes });
      }
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
    tapWalkIn,
    tapPromote,
  ]);

  /** The waiver dialog's subject, flattened for its rendering. */
  const waiverName =
    waiverPrompt === null
      ? ""
      : waiverPrompt.source === "roster"
        ? waiverPrompt.entry.name
        : waiverPrompt.source === "walkin"
          ? waiverPrompt.client.name
          : waiverPrompt.row.name;

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

  /* ------------------------------------------------------------------
   * T25: the pay-and-check-in gesture's derived state and stages. Plain
   * render-body values and functions, deliberately not memoized: they
   * are only read by the dialog's JSX and its button handlers, so every
   * read sees the current render's truth with no stale-closure risk.
   * ---------------------------------------------------------------- */
  const paySelected =
    paySelectedId !== null
      ? (payCatalog.passes?.find((p) => p.id === paySelectedId) ?? null)
      : null;
  /* The chargeable total: the server's number, current selection only.
   * While the pricing loop (or its debounce) is pending, the previous
   * selection's total must not be restated on the button. */
  const payTotal =
    !payPricing && payPriced && !payPriced.suppressed && !payPriced.disagrees
      ? payPriced.grandTotal
      : null;
  const payBalance = payProfile?.balance ?? payDialog?.entry.balance ?? null;
  const payCard = payProfile?.card ?? null;
  /* T24's method rules, applied without a chooser: when credit covers
   * the total, credit IS the method (rule 1; /api/checkout refuses the
   * card server-side too); otherwise a live card on file. No cash here:
   * this dialog is one primary action, and a cash sale has a whole
   * screen. */
  const payCreditCovers =
    payBalance !== null && payTotal !== null && payBalance >= payTotal;
  const payMethod: "credit" | "storedcard" | null = payCreditCovers
    ? "credit"
    : payProfile && !payProfile.loading && payCard && !payCard.expired
      ? "storedcard"
      : null;
  /* The one-line reason there is nothing to charge with, greyed and
   * shown rather than hidden (T24's posture). */
  const payMethodReason =
    payMethod !== null
      ? null
      : !payProfile || payProfile.loading
        ? "Checking the card on file..."
        : payProfile.error
          ? `Card check failed: ${payProfile.error}`
          : payCard?.expired
            ? `The card on file (...${payCard.lastFour}) is expired.`
            : "No card on file.";
  /* Once money moved (or MAY have moved), the dialog offers no second
   * charge and no free entry: the outcome text says how the roster
   * machinery finishes the job, and Close is the way out. */
  const payMoneyMoved =
    payOutcome !== null &&
    payOutcome.kind !== "suppressed" &&
    payOutcome.kind !== "charge-failed";
  const payChargeable =
    payStage === null &&
    !payMoneyMoved &&
    payDialog !== null &&
    paySelected !== null &&
    payTotal !== null &&
    payMethod !== null;

  /**
   * The gesture (T25): charge, attach, check in -- pessimistic end to
   * end, each stage's failure reported at ITS stage and nothing retried
   * automatically. The entry and class were captured at open; the
   * roster refresh at the end is what shows the row paid and checked
   * in, and it drops itself if the teacher has somehow moved on.
   */
  const runPayAndCheckIn = async () => {
    if (payFlight.current || !payChargeable) return;
    if (!payDialog || !paySelected || payMethod === null) return;
    const { entry, classId, flavor } = payDialog;
    /* The unpaid gesture attaches to and signs in a visit; without a
     * visit id there is nothing to run. The renewal gesture (T26) is the
     * charge alone -- the visit is already paid and checked in and is
     * deliberately not touched -- so it needs no visit id. */
    if (flavor === "unpaid" && entry.visitId === null) return;
    payFlight.current = true;
    setPayOutcome(null);
    try {
      /* Stage (a): the charge, via the one route that moves money. The
       * route rehearses and re-prices server-side; the browser's number
       * is never what gets charged. */
      setPayStage("charge");
      let chargeRes: Response;
      let chargeBody: any = null;
      try {
        chargeRes = await fetch("/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: [
              {
                type: paySelected.type,
                metadataId: paySelected.id,
                quantity: 1,
                price: paySelected.price,
                taxExempt: paySelected.taxExempt,
                taxRate: paySelected.taxRate,
              },
            ],
            clientId: entry.clientId,
            method: payMethod,
          }),
        });
      } catch {
        /* The request died between us and our server: the outcome is
         * UNKNOWN, and the one wrong move is to invite a retry. */
        setPayOutcome({ kind: "charge-ambiguous", message: "" });
        return;
      }
      try {
        chargeBody = await chargeRes.json();
      } catch {
        chargeBody = null;
      }
      if (chargeBody === null && (chargeRes.ok || chargeRes.status >= 500)) {
        /* A 200 whose body could not be read, or a 500-class answer with
         * no readable verdict (a gateway 502/504 serves HTML): the route
         * may have run -- and charged -- before the answer was lost, so
         * this must NOT render as "not charged, safe to retry". Only a
         * readable refusal or a 4xx earns the definite branch below. */
        setPayOutcome({
          kind: "charge-ambiguous",
          message: chargeRes.ok
            ? "The server answered but the outcome could not be read."
            : `The server's answer (HTTP ${chargeRes.status}) carried no readable outcome.`,
        });
        return;
      }
      if (chargeRes.ok && chargeBody?.suppressed) {
        /* Stage (a) suppression: amber, and the gesture STOPS -- no
         * attach, no check-in, because nothing was sold. */
        setPayOutcome({
          kind: "suppressed",
          mode: String(chargeBody.suppressed),
        });
        return;
      }
      if (!(chargeRes.ok && chargeBody?.ok === true)) {
        if (chargeBody?.stage === "checkout-after-credit") {
          /* T24's seam, surfaced with the same discipline: the $10
           * credit exists, the sale did not complete (or, when the route
           * flagged the checkout ambiguous, MAY not have), and the
           * credit step must not run again. This dialog offers no path
           * that could -- and when the sale's own outcome is unknown,
           * the message must not assert it failed, or the teacher
           * re-sells a pass that may already exist. */
          const saleVerdict =
            chargeBody?.ambiguous === true
              ? "the pass sale may or may not have completed, so check the " +
                "dev drawer or Mindbody before selling again"
              : "the pass sale failed";
          setPayOutcome({
            kind: "split",
            message:
              `The $10 credit purchase succeeded; ${saleVerdict}; ` +
              `their balance is now ${
                typeof chargeBody?.creditBalance === "number"
                  ? money(chargeBody.creditBalance)
                  : "unknown (Mindbody did not answer the balance read)"
              }; do NOT re-run the credit step.` +
              (chargeBody?.ambiguous === true
                ? ""
                : flavor === "renewal"
                  ? " Sell the pack in Buy, on account credit."
                  : " Sell the pass in Buy, on account credit, then attach " +
                    "and check in from the row."),
            mindbody: String(chargeBody?.error ?? "no reason returned"),
          });
          return;
        }
        if (chargeBody?.ambiguous === true) {
          setPayOutcome({
            kind: "charge-ambiguous",
            message: String(chargeBody?.error ?? ""),
          });
          return;
        }
        /* A definite refusal: nothing was charged, nothing else
         * happened, and saying so is what makes a retry safe. A refusal
         * that names the live balance (rule 1: "credit covers this")
         * refreshes the method gate, T24's freshBalance move, so the
         * retry runs on credit instead of failing identically. */
        if (typeof chargeBody?.creditBalance === "number") {
          setPayProfile((prof) =>
            prof ? { ...prof, balance: chargeBody.creditBalance } : prof,
          );
        }
        setPayOutcome({
          kind: "charge-failed",
          message: String(chargeBody?.error ?? `HTTP ${chargeRes.status}`),
        });
        return;
      }

      /* Renewal flavor (T26): the gesture is stage (a) alone. The visit
       * is already paid and checked in, so the purchase deliberately
       * touches neither the visit assignment nor the sign-in state; the
       * pass caches and the roster refresh so the row's pass facts show
       * the new pack, best-effort because the sale already stands. */
      if (flavor === "renewal") {
        try {
          const pr = await fetch(
            `/api/passes?clientId=${encodeURIComponent(entry.clientId)}`,
          );
          const pBody = await pr.json();
          if (pr.ok) {
            const fresh: PassInfo[] = pBody?.passes ?? [];
            passSweepCache.current.set(entry.clientId, fresh);
            setPassLists((l) => ({
              ...l,
              [entry.clientId]: { data: fresh, error: null, loading: false },
            }));
          }
        } catch {
          /* The row's chevron refetches on open; the sale is unaffected. */
        }
        await refreshRoster(classId);
        setLastUsed((m) => {
          const { [entry.clientId]: _drop, ...rest } = m;
          return rest;
        });
        payGen.current += 1;
        payPriceGen.current += 1;
        setPayDialog(null);
        setPayOutcome(null);
        setPayPriced(null);
        setPayPriceError(null);
        setPayPricing(false);
        setPaySelectedId(null);
        setPayProfile(null);
        return;
      }

      /* Stage (b): find the NEW ClientService (re-fetch their passes;
       * the just-purchased option's instance is the newest id carrying
       * its ProductId) and assign it to the visit. A failure here is
       * charged-but-not-attached, finished BY HAND with the payment
       * chevron -- never auto-retried: the charge stands and a blind
       * second write is how a visit ends up on the wrong pass. */
      setPayStage("attach");
      try {
        const pr = await fetch(
          `/api/passes?clientId=${encodeURIComponent(entry.clientId)}`,
        );
        const pBody = await pr.json();
        if (!pr.ok) throw new Error(pBody?.error ?? `HTTP ${pr.status}`);
        const fresh: PassInfo[] = pBody?.passes ?? [];
        /* Refresh the caches the payment chevron reads, so the by-hand
         * finish is a working path whatever happens below. */
        passSweepCache.current.set(entry.clientId, fresh);
        setPassLists((l) => ({
          ...l,
          [entry.clientId]: { data: fresh, error: null, loading: false },
        }));
        if (paySelected.productId === null) {
          throw new Error(
            "this pricing option carries no ProductId, so the new " +
              "purchase could not be identified",
          );
        }
        const instance = fresh
          .filter(
            (p): p is PassInfo & { id: number } =>
              p.id !== null && p.productId === paySelected.productId,
          )
          .reduce<(PassInfo & { id: number }) | null>(
            (newest, p) => (newest === null || p.id > newest.id ? p : newest),
            null,
          );
        if (!instance) {
          throw new Error(
            "the purchased pass has not appeared on their account yet",
          );
        }
        const ar = await fetch("/api/visit-payment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            visitId: entry.visitId,
            clientServiceId: instance.id,
            clientId: entry.clientId,
          }),
        });
        const aBody = await ar.json();
        if (!ar.ok) throw new Error(aBody?.error ?? `HTTP ${ar.status}`);
        if (aBody?.suppressed) {
          /* Should be unreachable (the guard let the charge through two
           * calls ago), but if it happens the truth is the same shape:
           * charged, not attached. */
          throw new Error(
            `the write was suppressed (${aBody.suppressed}) after the charge went through`,
          );
        }
      } catch (err) {
        setPayOutcome({
          kind: "attach-failed",
          message: err instanceof Error ? err.message : String(err),
        });
        await refreshRoster(classId);
        return;
      }

      /* Stage (c): the check-in itself, the same write the chip makes. */
      setPayStage("checkin");
      try {
        const cr = await fetch("/api/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            visitId: entry.visitId,
            signedIn: true,
            clientId: entry.clientId,
          }),
        });
        const cBody = await cr.json();
        if (!cr.ok) throw new Error(cBody?.error ?? `HTTP ${cr.status}`);
      } catch {
        /* Paid and attached; the row is now a normal paid row, and its
         * ordinary check-in tap finishes the job. */
        setPayOutcome({ kind: "checkin-failed" });
        await refreshRoster(classId);
        return;
      }

      /* The whole gesture landed: the refreshed roster shows the row
       * paid and checked in. Closed inline rather than via
       * closePayDialog, whose payStage guard would read this run's
       * in-flight stage from a stale closure. */
      await refreshRoster(classId);
      payGen.current += 1;
      payPriceGen.current += 1;
      setPayDialog(null);
      setPayOutcome(null);
      setPayPriced(null);
      setPayPriceError(null);
      setPayPricing(false);
      setPaySelectedId(null);
      setPayProfile(null);
    } finally {
      payFlight.current = false;
      setPayStage(null);
    }
  };

  /** Free entry, the deliberate exception (T25): today's Phase 1
   *  behavior exactly -- no charge, just the pessimistic check-in write
   *  -- behind its own labelled choice. */
  const freeCheckIn = () => {
    /* payFlight is the SYNCHRONOUS lock: payStage lags a render behind,
     * so without the ref a free tap landing in the same tick as a Charge
     * tap could check someone in mid-charge. Same single-flight as the
     * paid gesture. */
    if (payFlight.current || payStage !== null || !payDialog || payMoneyMoved)
      return;
    /* The renewal dialog has no free entry: the student is already
     * checked in, so there is nothing to comp. */
    if (payDialog.flavor === "renewal") return;
    const entry = payDialog.entry;
    closePayDialog();
    void setSignedIn(entry, true);
  };

  return (
    <main className="shell">
      {config?.configError ? <p className="note">{config.configError}</p> : null}

      {/* The mode banner is shared with the sale overlay (T23): ONE
          component, one wording, so "is this live" reads the same on
          every screen. */}
      <ModeBanner config={config} />

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
          {/* Opens the Buy overlay (T23; "Buy" since the second live
              test -- the counter conversation is the student's, "I want
              to buy a mat"). Quiet like "Change class": selling is
              deliberate, not the thing hit at speed. The roster stays
              mounted underneath; closing lands right back. */}
          <button
            className="class-change"
            onClick={() => {
              /* Anything anchored to roster rows (dropdowns, menus) would
               * otherwise paint above the overlay at a higher z-index. */
              setPickerFor(null);
              setSortMenuOpen(false);
              setSaleOpen(true);
            }}
          >
            Buy
          </button>
          <div className="counters" aria-label="Counts for the selected class">
          {/* A plain stat, not a button: its list IS the roster below,
              and a modal copying the screen behind it earned nothing
              (Pete, 2026-08-29). Checked-in and waitlist keep their
              panels; the waitlist's is the only home its entries have. */}
          <div className="counter counter-stat">
            <span className="counter-num">
              {entries.length}
              {activeClass.capacity !== null ? (
                <span className="counter-cap"> of {activeClass.capacity}</span>
              ) : null}
            </span>
            <span className="counter-label">signed up</span>
          </div>
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
            : (failed[entry.clientId] ?? null);
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

                {/* Fixed icon slots in a set order (M | info), the same
                    width on every row, so each marker lines up as its own
                    column down the roster instead of trailing the name at
                    whatever x the name ends. A row without the marker
                    keeps the empty slot. One info icon since T20: the
                    separate alert and notes icons folded into it. */}
                <div className="cell-icons">
                  <span className="icon-slot">
                    {entry.member ? (
                      <span className="m-chip" title="Member" aria-label="Member">
                        M
                      </span>
                    ) : null}
                  </span>
                  <span className="icon-slot">
                    {/* On EVERY row: dimmed when the client has no red
                        alert, no yellow alert and no notes, because
                        adding the first one starts here too; bright when
                        any exist. */}
                    <button
                      className={
                        entry.redAlert || entry.yellowAlert || entry.notes
                          ? "row-icon"
                          : "row-icon dim"
                      }
                      aria-label={`Alerts and notes for ${entry.name}`}
                      title="Alerts and notes"
                      onClick={(e) => {
                        e.stopPropagation();
                        openInfoView(entry);
                      }}
                    >
                      <InfoIcon />
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
                    {/* T26's quiet fallback: the last session was just
                        used and the renewal dialog had nothing to charge
                        with (no card on file, no covering credit), so
                        the fact sits here for a manual Buy. */}
                    {lastUsed[entry.clientId] ? (
                      <span className="pass-last-used">Last session used.</span>
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
                  {/* Buy for this student: the overlay opens with them
                      already attached (id, name, balance from the row),
                      and any held cart reprices for them. */}
                  <button
                    className="row-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      openBuyFor({
                        id: entry.clientId,
                        name: entry.name,
                        balance: entry.balance,
                      });
                    }}
                    aria-label={`Buy for ${entry.name}`}
                    title={`Buy for ${entry.name}`}
                  >
                    <BagIcon />
                  </button>
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
          is the only action on a row, with the roster gates intact: the
          waiver blocks, a full class offers the waiting list. The X (and
          Escape, and the scrim) closes with no action. */}
      {searchOpen ? (
        <div className="modal-scrim" onClick={closeSearch} role="presentation">
          <div
            className="modal modal-list modal-search"
            role="dialog"
            aria-modal="true"
            aria-label={
              attachMode
                ? "Attach a client to the sale"
                : `Search results for ${searchTitle}`
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="row-icon modal-x"
              aria-label="Close search results"
              onClick={closeSearch}
            >
              <CloseIcon />
            </button>
            <p className="modal-title">
              {attachMode
                ? "Attach a client to the sale"
                : `Results for "${searchTitle}"`}
            </p>
            {/* The "In class" quick-pick (T27 round three, attach mode
                ONLY): the person a sale is for is usually on a roster
                already on screen, so it renders IMMEDIATELY on open,
                above the search. A class dropdown (the pass-dropdown
                idiom) offers the rest of the day's classes -- fetched
                once per day per session, see openAttachSearch -- and
                picking one shows ITS roster (session-cached per class;
                the selected class's roster is `entries`, zero calls).
                Tapping a row attaches exactly like a search row does. */}
            {attachMode
              ? (() => {
                  const menuClasses = dayClasses.list ?? classes;
                  const picked =
                    menuClasses.find((c) => c.classId === attachClassId) ??
                    classes.find((c) => c.classId === attachClassId) ??
                    null;
                  const showingActive =
                    attachClassId !== null && attachClassId === activeId;
                  const quickEntries = showingActive
                    ? entries
                    : attachRoster.entries;
                  return (
                    <div className="attach-quick">
                      <div className="attach-class">
                        <span className="attach-quick-label">In class</span>
                        <button
                          className="class-change attach-class-btn"
                          aria-haspopup="dialog"
                          aria-expanded={attachClassMenuOpen}
                          aria-label="Pick which class to show"
                          onClick={() => setAttachClassMenuOpen((o) => !o)}
                        >
                          <span className="attach-class-name">
                            {picked
                              ? `${clockTime(picked.startsAt)} · ${picked.name}${
                                  picked.teacher ? ` - ${picked.teacher}` : ""
                                }`
                              : "Pick a class"}
                          </span>
                          <ChevronDownIcon />
                        </button>
                        {attachClassMenuOpen ? (
                          <>
                            <div
                              className="pass-scrim"
                              role="presentation"
                              onClick={() => setAttachClassMenuOpen(false)}
                            />
                            <div
                              className="pass-dd attach-class-dd"
                              role="dialog"
                              aria-label="Classes today"
                            >
                              {dayClasses.loading ? (
                                <p className="pass-empty">
                                  <span
                                    className="spinner"
                                    aria-label="working"
                                  />{" "}
                                  Loading the day&apos;s classes...
                                </p>
                              ) : null}
                              {dayClasses.error ? (
                                /* Quiet: the around-now classes below
                                   still work, the wider day just is not
                                   available. */
                                <p className="pass-empty">
                                  Only the classes around now are
                                  available: {dayClasses.error}
                                </p>
                              ) : null}
                              {menuClasses.map((c) => {
                                const current = c.classId === attachClassId;
                                return (
                                  <button
                                    key={`ac-${c.classId}`}
                                    className={
                                      current ? "pass-opt current" : "pass-opt"
                                    }
                                    aria-pressed={current}
                                    onClick={() => pickAttachClass(c.classId)}
                                  >
                                    <span className="pass-check">
                                      {current ? <CheckIcon /> : null}
                                    </span>
                                    <span className="pass-opt-text">
                                      <span className="pass-opt-name">
                                        {clockTime(c.startsAt)} · {c.name}
                                        {c.teacher ? ` - ${c.teacher}` : ""}
                                      </span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </>
                        ) : null}
                      </div>
                      {!showingActive && attachRoster.loading ? (
                        <p className="muted">
                          <span className="spinner" aria-label="working" />{" "}
                          Loading the roster...
                        </p>
                      ) : !showingActive && attachRoster.error ? (
                        <p className="muted">
                          Roster unavailable: {attachRoster.error}
                        </p>
                      ) : quickEntries && quickEntries.length === 0 ? (
                        <p className="muted">Nobody is booked yet.</p>
                      ) : quickEntries ? (
                        <ul className="roster attach-quick-list">
                          {quickEntries.map((en) => (
                            <li key={`aq-${en.clientId}`}>
                              <button
                                className="row"
                                onClick={() =>
                                  attachSaleClient({
                                    id: en.clientId,
                                    name: en.name,
                                    balance: en.balance,
                                  })
                                }
                                aria-label={`Attach ${en.name} to the sale`}
                              >
                                <span className="name">{en.name}</span>
                                {en.balance !== null && en.balance !== 0 ? (
                                  <span
                                    className={
                                      en.balance < 0
                                        ? "bal-chip neg"
                                        : "bal-chip"
                                    }
                                  >
                                    {money(en.balance)}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <p className="attach-or">Or search everyone</p>
                    </div>
                  );
                })()
              : null}
            {/* Attach mode opens the modal BEFORE any search exists, so
                the search bar renders here: the same query state, the
                same submitSearch, the same one-call-on-submit rule as the
                page's own bar. */}
            {attachMode ? (
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
                    placeholder="Who is the sale for? (press Enter)"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
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
            ) : null}
            {attachMode && searchMsg ? (
              <p className="search-quiet">{searchMsg}</p>
            ) : null}
            {/* A class-level fact, said once here rather than stamped on
                every result row: with the class full, every add offers
                the waiting list instead. Booking flow only; a sale does
                not care whether the class is full. */}
            {!attachMode && classFull && walkIns.length > 0 ? (
              <p className="muted">Class is full. Adding goes to the waiting list.</p>
            ) : null}
            {searching ? (
              <p className="muted">
                <span className="spinner" aria-label="working" /> Searching
                Mindbody...
              </p>
            ) : null}
            {searchError ? <p className="note">{searchError}</p> : null}
            {!searching && !searchError && shownResults.length === 0 ? (
              <p className="muted">
                {attachMode
                  ? searchTitle
                    ? "Nobody found. Check the spelling, or try fewer letters."
                    : "Search for the client the sale is for, or close to sell anonymously."
                  : found.length > 0
                    ? "Everyone matching is already on this class's roster."
                    : "Nobody found. Check the spelling, or try fewer letters."}
              </p>
            ) : null}
            {shownResults.length > 0 ? (
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
                  {shownResults.map((client) => {
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
                            the only action. While ONE row's booking is in
                            flight every other row dims: the single-flight
                            lock already made them inert, this makes it
                            visible. */}
                        <div
                          className={
                            bookingIds.length > 0 && !working
                              ? "rrow row-dim"
                              : "rrow"
                          }
                        >
                          <div className="cell-name">
                            {/* The name owns the row's whole first line and
                                NEVER ellipsizes: it is the one column a
                                teacher cannot read truncated. An absurdly
                                long name wraps; "..." is not an option
                                here (T17). */}
                            <span className="name-text">{client.name}</span>
                            {/* The second line holds the markers, in a
                                fixed order: M, info, no-waiver. The info
                                icon is on every result row (T20), same
                                grey/bright treatment as the roster's, so
                                the line always renders. */}
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
                              <button
                                className={
                                  client.redAlert ||
                                  client.yellowAlert ||
                                  client.notes
                                    ? "row-icon"
                                    : "row-icon dim"
                                }
                                aria-label={`Alerts and notes for ${client.name}`}
                                title="Alerts and notes"
                                onClick={() =>
                                  openInfoView({
                                    clientId: client.id,
                                    name: client.name,
                                    redAlert: client.redAlert,
                                    yellowAlert: client.yellowAlert,
                                    notes: client.notes,
                                  })
                                }
                              >
                                <InfoIcon />
                              </button>
                              {!client.waiverSigned ? (
                                <span className="mini-stop">no waiver</span>
                              ) : null}
                            </span>
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
                                action beyond updating this cell. Booking
                                flow only: attaching a client to a sale
                                picks no pass. */}
                            {!attachMode && choosable.length >= 2 ? (
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
                            {/* In attach mode the row's one action is a
                                person-check: select this client for the
                                sale and close. No waiver gate, no
                                waitlist offer, nothing written (T23). */}
                            {attachMode ? (
                              <button
                                className="add-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  attachSaleClient(client);
                                }}
                                aria-label={`Attach ${client.name} to the sale`}
                                title="Attach to the sale"
                              >
                                <PersonCheckIcon />
                              </button>
                            ) : (
                            <>
                            {/* Buy for a searched person without booking
                                them: the modal closes and the Buy overlay
                                opens with them attached. No gates -- a
                                purchase needs no waiver. */}
                            <button
                              className="row-icon"
                              disabled={working || bookingIds.length > 0}
                              onClick={(e) => {
                                e.stopPropagation();
                                openBuyFor({
                                  id: client.id,
                                  name: client.name,
                                  balance: client.balance,
                                });
                              }}
                              aria-label={`Buy for ${client.name}`}
                              title={`Buy for ${client.name}`}
                            >
                              <BagIcon />
                            </button>
                            {/* A "+" icon, not a text chip (T17): the one
                                booking action on the row, a 52px filled
                                circle in the same action pairing as the
                                check-in chip. The aria-label carries what
                                the label text used to: whether the tap
                                books or offers the waiting list. All
                                gates are in tapWalkIn, unchanged. */}
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
                            </>
                            )}
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
              counterModal === "checkedIn"
                ? "Everyone checked in"
                : "The waiting list"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">
              {counterModal === "checkedIn"
                ? `Checked in (${entries.filter((e) => e.checkedIn).length} of ${entries.length})`
                : `Waiting list${waitlist !== null ? ` (${waitlist.length})` : ""}`}
            </p>

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
                            onClick={() => tapPromote(row)}
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

      {/* The ONE info view behind a row's info icon (T20): red alert,
          yellow alert and notes together, titled with the client's name.
          Purely informational -- it gates nothing and never did the
          acknowledging; the red-alert blocking dialogs it absorbed are
          gone (Pete's recorded reversal: the studio's alerts do not
          block). Each section shows its text (the red alert keeps its
          stop treatment, the yellow its warn pair -- information can
          still look important) or a quiet "None.", with a pencil opening
          the same textarea / Cancel / Save flow notes always had. Each
          save writes exactly ONE field. */}
      {infoView ? (
        <div
          className="modal-scrim"
          onClick={closeInfoView}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Alerts and notes for ${infoView.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">{infoView.name}</p>
            {(
              [
                {
                  field: "RedAlert" as const,
                  label: "Red alert",
                  text: infoView.redAlert,
                  textClass: "ctx-alert modal-alert",
                },
                {
                  field: "YellowAlert" as const,
                  label: "Yellow alert",
                  text: infoView.yellowAlert,
                  textClass: "modal-warn",
                },
                {
                  field: "Notes" as const,
                  label: "Notes",
                  text: infoView.notes,
                  textClass: "modal-note",
                },
              ]
            ).map((s) => (
              <div key={s.field}>
                <p className="info-label">
                  {s.label}
                  {/* One pencil per section; they rest while a section is
                      being edited, so exactly one field is ever in play. */}
                  {infoEditing === null ? (
                    <button
                      className="row-icon"
                      aria-label={`Edit ${s.label.toLowerCase()} for ${infoView.name}`}
                      title={`Edit ${s.label.toLowerCase()}`}
                      onClick={() => {
                        setInfoDraft(s.text ?? "");
                        setInfoMsg(null);
                        setInfoEditing(s.field);
                      }}
                    >
                      <PencilIcon />
                    </button>
                  ) : null}
                </p>
                {infoEditing === s.field ? (
                  /* Editing: the textarea seeded with the current text.
                     Whitespace and line breaks survive the round trip:
                     the textarea holds them natively and the reading
                     views render pre-wrap. */
                  <textarea
                    className="notes-edit"
                    value={infoDraft}
                    onChange={(e) => setInfoDraft(e.target.value)}
                    disabled={infoSaving}
                    aria-label={`Edit ${s.label.toLowerCase()}`}
                    autoFocus
                  />
                ) : s.text ? (
                  <p className={s.textClass}>{s.text}</p>
                ) : (
                  <p className="info-none">None.</p>
                )}
              </div>
            ))}
            {infoMsg ? (
              <p className="pass-note modal-note-gap">{infoMsg}</p>
            ) : null}
            <div className="modal-actions">
              {infoEditing !== null ? (
                <>
                  <button
                    className="modal-cancel"
                    disabled={infoSaving}
                    onClick={() => {
                      setInfoEditing(null);
                      setInfoMsg(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="modal-confirm go"
                    disabled={infoSaving}
                    onClick={() => void saveInfoField()}
                  >
                    {infoSaving ? (
                      <span className="spinner" aria-label="working" />
                    ) : (
                      "Save"
                    )}
                  </button>
                </>
              ) : (
                <button className="modal-cancel" onClick={closeInfoView}>
                  Close
                </button>
              )}
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
          state; this is the bridge.

          Since T19 the same dialog gates the walk-in ADD, opened from
          inside the search modal (it renders after that modal, so it
          stacks above it): identical discipline, only the continuation
          and the verb differ. */}
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
                ? `For ${waiverName} to read and agree to.`
                : `${waiverName} has not signed the waiver.`}
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
                    ) : waiverPrompt.source === "walkin" ? (
                      "Record agreement and add"
                    ) : waiverPrompt.source === "promote" ? (
                      "Record agreement and promote"
                    ) : (
                      "Record agreement and check in"
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="ctx-alert modal-alert">
                  {waiverPrompt.source === "walkin"
                    ? "No liability waiver on file. They cannot be added to the class until they have read and agreed to it."
                    : waiverPrompt.source === "promote"
                      ? "No liability waiver on file. They cannot be promoted into the class until they have read and agreed to it."
                      : "No liability waiver on file. They cannot be checked in until they have read and agreed to it."}
                </p>
                {waiverFetchError ? (
                  /* The fetch failed: the old close-only shape, with the
                     reason said quietly. Signing falls back to the
                     Mindbody app until the text can be shown here. */
                  <p className="muted">
                    The waiver text could not be fetched ({waiverFetchError}).
                    Have them sign it in the Mindbody app instead; once it is
                    signed the{" "}
                    {waiverPrompt.source === "walkin"
                      ? "add will go through normally."
                      : waiverPrompt.source === "promote"
                        ? "promotion will go through normally."
                        : "row will check in normally."}
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

      {/* Pay and check in (T25): the unpaid row's dialog. ONE primary
          action that restates the amount; free entry demoted to the
          labelled quiet exception; each stage's failure reported at its
          stage. The scrim, Escape and Cancel all refuse to close while
          any stage is in flight. */}
      {payDialog ? (
        <div className="modal-scrim" onClick={closePayDialog} role="presentation">
          <div
            className="modal modal-pay"
            role="dialog"
            aria-modal="true"
            aria-label={
              payDialog.flavor === "renewal"
                ? `Sell the next pack to ${payDialog.entry.name}`
                : `Pay and check in ${payDialog.entry.name}`
            }
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">
              {payDialog.flavor === "renewal"
                ? "Last session used. Sell the next pack?"
                : "Pay and check in"}
            </p>
            <p className="modal-entity">{payDialog.entry.name}</p>

            {/* The pass to sell. Sorted single-visit first (the default
                selection's own order), 64px rows, short name with the
                full Mindbody name under it when shortening dropped
                anything, price on the right. */}
            {payCatalog.loading ? (
              <p className="pass-empty">
                <span className="spinner" aria-label="working" /> Loading
                pricing options...
              </p>
            ) : payCatalog.error ? (
              <div>
                <p className="pass-note modal-note-gap">
                  Pricing options unavailable: {payCatalog.error}
                </p>
                <button
                  className="class-change"
                  onClick={() => openPayDialog(payDialog.entry, payDialog.flavor)}
                >
                  Retry
                </button>
              </div>
            ) : payCatalog.passes && payCatalog.passes.length === 0 ? (
              <p className="pass-empty">
                Mindbody lists nothing sellable at the studio.
              </p>
            ) : payCatalog.passes ? (
              <div className="pay-opts" aria-label="Pass to sell">
                {[...payCatalog.passes]
                  .sort((a, b) => {
                    const ca =
                      a.count !== null && a.count < 100
                        ? a.count
                        : Number.MAX_SAFE_INTEGER;
                    const cb =
                      b.count !== null && b.count < 100
                        ? b.count
                        : Number.MAX_SAFE_INTEGER;
                    return ca - cb || a.price - b.price;
                  })
                  .map((p) => {
                    const short = shortPassName(p.name);
                    const selected = paySelectedId === p.id;
                    return (
                      <button
                        key={`payopt-${p.id}`}
                        className={selected ? "pass-opt sel" : "pass-opt"}
                        disabled={payStage !== null || payMoneyMoved}
                        aria-pressed={selected}
                        onClick={() => setPaySelectedId(p.id)}
                      >
                        <span className="pass-check">
                          {selected ? <CheckIcon /> : null}
                        </span>
                        <span className="pass-opt-text">
                          <span className="pass-opt-name">{short}</span>
                          {short !== p.name.trim() ? (
                            <span className="pass-opt-full">{p.name}</span>
                          ) : null}
                        </span>
                        <span className="pass-col">{money(p.price)}</span>
                      </button>
                    );
                  })}
              </div>
            ) : null}

            {/* The pricing area: the server's answer or an honest
                absence, never a locally computed number dressed as a
                total. Suppression here means the charge cannot run
                (there is no priced amount), rendered amber. */}
            {payPricing ? (
              <p className="pay-price-line">
                <span className="spinner" aria-label="working" /> Pricing with
                Mindbody...
              </p>
            ) : payPriceError ? (
              <div className="sale-stop">Pricing failed: {payPriceError}</div>
            ) : payPriced?.suppressed ? (
              <div className="pass-note modal-note-gap">
                Suppressed (dry run or write guard): Mindbody did not price
                this option, so there is no amount to charge. Nothing was
                written.
              </div>
            ) : payPriced?.disagrees ? (
              <div className="sale-stop">
                Totals disagree. Our math says{" "}
                {money(payPriced.expectedTotal)}, Mindbody says{" "}
                {payPriced.grandTotal !== null
                  ? money(payPriced.grandTotal)
                  : "nothing"}
                . Do not charge; this is a bug to report.
              </div>
            ) : null}

            {/* How it gets paid, derived from T24's rules: credit when it
                covers the total (rule 1: the card is not offered then),
                otherwise the stored card. A missing method renders its
                reason rather than disappearing. */}
            <p className="pay-method-line">
              {payMethod === "credit"
                ? `Pays with account credit (${
                    payBalance !== null ? money(payBalance) : ""
                  }).`
                : payMethod === "storedcard" && payCard
                  ? `Pays with the stored card ...${payCard.lastFour}.`
                  : payMethodReason}
            </p>
            <p className="pay-cash-note">For cash, use Buy.</p>

            {/* The outcome, when the gesture did not simply finish. */}
            {payOutcome?.kind === "suppressed" ? (
              <p className="pass-note modal-note-gap">
                {payOutcome.mode === "dry-run"
                  ? payDialog.flavor === "renewal"
                    ? "Dry run: nothing was charged."
                    : "Dry run: nothing was charged and nobody was checked in."
                  : "Write guard: this client is not in POS_WRITE_CLIENT_IDS."}{" "}
                The write was suppressed on the server.
              </p>
            ) : payOutcome?.kind === "charge-failed" ? (
              <div className="sale-stop">
                Not charged: {payOutcome.message} Nothing else happened; it is
                safe to try again.
              </div>
            ) : payOutcome?.kind === "charge-ambiguous" ? (
              <div className="sale-stop">
                The charge may or may not have gone through. Check the dev
                drawer or Mindbody before charging again.
                {payOutcome.message ? ` (${payOutcome.message})` : ""}
              </div>
            ) : payOutcome?.kind === "split" ? (
              <div className="sale-stop">
                <p className="pay-split-head">{payOutcome.message}</p>
                <p className="pay-split-why">
                  Mindbody said: {payOutcome.mindbody}
                </p>
              </div>
            ) : payOutcome?.kind === "attach-failed" ? (
              <div className="sale-stop">
                Charged, but the pass was not attached to this visit; attach
                it with the payment chevron, then check in.
                {payOutcome.message ? ` (${payOutcome.message})` : ""}
              </div>
            ) : payOutcome?.kind === "checkin-failed" ? (
              <p className="pass-note modal-note-gap">
                Paid and attached; the check-in tap will finish it.
              </p>
            ) : null}

            <div className="modal-actions">
              <button
                className="modal-cancel"
                disabled={payStage !== null}
                onClick={closePayDialog}
              >
                {payOutcome !== null && payOutcome.kind !== "charge-failed"
                  ? "Close"
                  : payDialog.flavor === "renewal"
                    ? "Not now"
                    : "Cancel"}
              </button>
              {!payMoneyMoved ? (
                <button
                  className="modal-confirm pay-charge"
                  disabled={!payChargeable}
                  onClick={() => void runPayAndCheckIn()}
                >
                  {payStage === "charge" ? (
                    <>
                      <span className="spinner" aria-label="working" />{" "}
                      Charging...
                    </>
                  ) : payStage === "attach" ? (
                    <>
                      <span className="spinner" aria-label="working" />{" "}
                      Attaching the pass...
                    </>
                  ) : payStage === "checkin" ? (
                    <>
                      <span className="spinner" aria-label="working" />{" "}
                      Checking in...
                    </>
                  ) : payTotal !== null ? (
                    payDialog.flavor === "renewal" ? (
                      `Charge ${money(payTotal)}`
                    ) : (
                      `Charge ${money(payTotal)} and check in`
                    )
                  ) : payDialog.flavor === "renewal" ? (
                    "Charge"
                  ) : (
                    "Charge and check in"
                  )}
                </button>
              ) : null}
            </div>

            {/* Free entry: present, labelled, and visually the
                exception. Today's Phase 1 behavior exactly: no charge,
                just the pessimistic check-in write. Not in the renewal
                flavor: the student is already checked in, and "Not now"
                is the whole exit. */}
            {!payMoneyMoved && payDialog.flavor !== "renewal" ? (
              <button
                className="pay-free"
                disabled={payStage !== null}
                onClick={freeCheckIn}
              >
                Check in free (comp)
              </button>
            ) : null}
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

      {/* The sale overlay (T23). ALWAYS mounted so its cart survives an
          accidental Back and reopens where it left off; `open` is what
          shows it. It sits below every modal scrim, so the search modal
          in attach mode, the info view, and the dev drawer all stack
          above it as usual. */}
      <SaleScreen
        open={saleOpen}
        onClose={() => setSaleOpen(false)}
        config={config}
        client={saleClient}
        onRequestAttach={openAttachSearch}
        onDetachClient={() => setSaleClient(null)}
        modalAbove={searchOpen || infoView !== null || waiverPrompt !== null}
        onContractPurchased={refreshClientState}
        onSaleCompleted={refreshClientState}
      />

      <DevDrawer />
    </main>
  );
}

/**
 * The auth gate (T21). Asks /api/session whether a lock exists and whether
 * this browser holds a session; until it answers, nothing renders (a blank
 * flash beats flashing the roster at a locked counter). Locked renders
 * ONLY the lock screen. While the app is open, a 401 from any /api data
 * fetch flips back to the lock screen: sessions expire after 30 days and a
 * PIN change revokes them all, and the fallback must be the lock, not a
 * page of failed rows.
 */
function AuthGate() {
  const [phase, setPhase] = useState<"checking" | "locked" | "open">(
    "checking",
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/session")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setPhase(d.authRequired && !d.authenticated ? "locked" : "open");
      })
      .catch(() => {
        /* The session probe failing (server down, network blip) must not
         * brick the counter behind a lock that cannot check a PIN either.
         * Open; every real route still enforces server-side. */
        if (!cancelled) setPhase("open");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* The one shared chokepoint for "a data fetch answered 401": wrap
   * window.fetch while the app is open. Every call site (FrontDesk, the
   * dev drawer's polling) goes through it, so none of them needs its own
   * 401 handling and a future fetch cannot forget it. The wrapper only
   * OBSERVES same-origin /api responses; it never alters them. */
  useEffect(() => {
    if (phase !== "open") return;
    const original = window.fetch;
    window.fetch = async (...args: Parameters<typeof window.fetch>) => {
      const response = await original(...args);
      try {
        const url = new URL(String(
          args[0] instanceof Request ? args[0].url : args[0],
        ), window.location.origin);
        if (
          response.status === 401 &&
          url.origin === window.location.origin &&
          url.pathname.startsWith("/api/") &&
          url.pathname !== "/api/login"
        ) {
          setPhase("locked");
        }
      } catch {
        /* URL parsing is best-effort; never break the actual fetch. */
      }
      return response;
    };
    return () => {
      window.fetch = original;
    };
  }, [phase]);

  if (phase === "checking") return null;
  if (phase === "locked") return <LockScreen />;
  return <FrontDesk />;
}

/**
 * useSearchParams in a client component must sit under a Suspense boundary
 * (Next requires it for the static shell). The page is fully client-side,
 * so the fallback flashes at most once, before hydration.
 */
export default function FrontDeskPage() {
  return (
    <Suspense fallback={null}>
      <AuthGate />
    </Suspense>
  );
}
