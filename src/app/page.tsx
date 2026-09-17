"use client";

import {
  Suspense,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

import DevDrawer from "./DevDrawer";
import LockScreen from "./LockScreen";
import NavBar, {
  BuyIcon,
  SettingsIcon,
  PayIcon,
  ProfileIcon,
  SignInIcon,
  type NavItem,
} from "./NavBar";
import NoteText from "./NoteText";
import SaleScreen, {
  ModeBanner,
  attachSearchHint,
  type ModeConfig,
  type SaleClient,
  type SaleNavState,
  type SoldSale,
} from "./SaleScreen";
import { Hit } from "./Hit";
import {
  ClientProfileCard,
  OPT_IN_EMAIL_FLAG,
  type OptInKind,
  wallDate,
} from "./ClientProfileCard";
import StaffModal, { type Teacher } from "./StaffModal";
import PinModal from "./PinModal";
import NewClientModal from "./NewClientModal";
import CardModal from "./CardModal";
import GuestModal, {
  type ClassStanding,
  type GuestPick,
} from "./GuestModal";
import { isGuestPass, usableGuestPass } from "@/lib/guestpass";
import { actorFallbackLine } from "./actornote";
import { DEFAULT_SETTINGS, useSettings } from "./settings";
import { toggleTheme, watchSystemTheme } from "./theme";
import { useVisualViewport } from "./viewport";
import type { CardOnFile } from "@/lib/clientcard";
import type { ClientProfile } from "@/lib/clientprofile";
import { stripSignatures } from "@/lib/notesig";

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
  /** T62: whose guest this visit is, from the server's guest_visits
   *  table; null with no marker or no database (then the page's own
   *  memory, guestBy, covers the class view). */
  guestOf: { name: string } | null;
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
  /** The small line under a search result's name carries email and
   *  phone (T42): duplicate names are real at this studio, and this is
   *  how Mindbody's own search tells them apart. */
  phone: string | null;
  waiverSigned: boolean;
  redAlert: string | null;
  yellowAlert: string | null;
  balance: number | null;
  member: boolean;
  notes: string | null;
  mindbodyId: number | null;
}

/**
 * A roster row read as a search result (T32), so the attach modal's two
 * groups render through ONE row renderer: the class's own people and the
 * rest of the search look the same, differing only in the facts they
 * carry. Every field but the email is on the roster entry already; the
 * unknown waiver (null, the lookup failed) fails open here exactly as it
 * does on the roster, and attaching a client to a sale gates on the
 * waiver anyway not at all.
 */
function rosterAsResult(en: RosterEntry): SearchResult {
  return {
    id: en.clientId,
    name: en.name,
    email: null,
    phone: null,
    waiverSigned: en.waiverSigned !== false,
    redAlert: en.redAlert,
    yellowAlert: en.yellowAlert,
    balance: en.balance,
    member: en.member === true,
    notes: en.notes,
    mindbodyId: en.mindbodyId,
  };
}

/**
 * One row of the attach modal's list: the person, plus their standing in
 * the class the picker names when they are in it. `status` is null for a
 * match who is not on that roster. The roster knows only these two
 * states -- a waitlisted person is not a roster entry at all -- so the
 * pill never says "waitlist".
 */
interface AttachRow {
  client: SearchResult;
  status: "checked in" | "signed up" | null;
}

/**
 * The attach modal's one segment (T87, Pete: "instead of a class selector
 * and all the buttons, just use All | Class. the class will always be the
 * class selected in the signin screen"). "class" is the sign-in screen's
 * selected class, everyone booked in it, filtered in memory by whatever is
 * typed, so it never calls Mindbody; "all" is the live Mindbody search
 * (T81). It replaced the "In class" toggle, the class dropdown and the
 * three-way All / Signed in / Not yet segment.
 */
type AttachTab = "all" | "class";

const ATTACH_TABS: { value: AttachTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "class", label: "Class" },
];

/** The attach modal's page size (T42). Raised from the walk-in search's
 *  12: the list scroll-loads now, and a first page that fills the fixed
 *  five-row window with some to spare saves the second call a teacher
 *  would otherwise trigger by reflex. Still one metered call per page. */
const ATTACH_PAGE_SIZE = 20;

/**
 * Alphabetical by last name then first (T42, Pete: "the list of clients
 * in a class should be in alphabetical order"). The last space splits the
 * display name, the roster sort's rule; a one-word name sorts by that
 * word. Case-insensitive, so "de la Cruz" sorts as "cruz", with the Cs.
 */
function byLastThenFirst(a: { name: string }, b: { name: string }): number {
  const split = (name: string): [string, string] => {
    const t = name.trim().toLowerCase();
    const cut = t.lastIndexOf(" ");
    return cut === -1 ? [t, ""] : [t.slice(cut + 1), t.slice(0, cut)];
  };
  const [al, af] = split(a.name);
  const [bl, bf] = split(b.name);
  return al.localeCompare(bl) || af.localeCompare(bf);
}

/** The small email and phone line under a search result's name (T42):
 *  whichever of the two Mindbody has, joined with a middle dot. Empty
 *  when neither is on file, and then the line does not render. */
function contactLine(c: { email: string | null; phone: string | null }): string {
  return [c.email, c.phone].filter(Boolean).join(" · ");
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
  | { source: "promote"; row: WaitlistRow }
  /* T59c: a guest picked in the guest modal; agreement resumes the
   * modal at its confirm sheet with the same person selected. */
  | { source: "guest"; client: SearchResult; standing: ClassStanding | null };

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

/** T56: what the Membership modal lists, as /api/membership serves it
 *  (shapes derived in src/lib/clientcontext.ts). */
interface MembershipPass extends PassInfo {
  /** Unexpired, but nothing left on it. Shown, never offered as payment. */
  usedUp: boolean;
}

interface ContractInfo {
  id: number | null;
  name: string;
  /** Mindbody's AutopayStatus: Active, Inactive, Suspended; null if omitted. */
  status: string | null;
  autoRenewing: boolean | null;
  agreementDate: string | null;
  startDate: string | null;
  endDate: string | null;
}

interface MembershipState {
  data: { contracts: ContractInfo[]; passes: MembershipPass[] } | null;
  error: string | null;
  loading: boolean;
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

/* T52 (Pete): "the sort options should be in order: sign-in order,
 * first name, last name". */
const ROSTER_SORTS: { value: RosterSort; label: string }[] = [
  { value: "signin", label: "Sign-in order" },
  { value: "first", label: "First name" },
  { value: "last", label: "Last name" },
];

const ROSTER_SORT_KEY = "pos.rosterSort";

/** How many history fetches the background sweep keeps in flight at once.
 *  Modest on purpose: the sweep is a nicety and must never crowd out the
 *  calls a teacher is waiting on. */
const HISTORY_SWEEP_CONCURRENCY = 4;

/** X, for clearing the search box. */
/** T70: the mockups' glyphs (docs/design/mockups/visual-pass/Roster.dc.html),
 *  inline so the counter never waits on an icon package: stroke 2,
 *  SQUARE caps (part of the look), currentColor so every icon takes the
 *  ink of the cell it sits in, in both palettes. */
function Icon({
  d,
  size = 20,
  extra,
  width = 2,
}: {
  d: string;
  size?: number;
  extra?: ReactNode;
  width?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="square"
      aria-hidden="true"
    >
      {extra}
      <path d={d} />
    </svg>
  );
}

/**
 * T59b's prefill rule, factored out in T91 so all three entries to the
 * New client form agree: a query that looks like a name (two words, no
 * digits or @) fills first and last, anything else fills nothing. A
 * half-typed email or a phone number is not a name.
 */
function namePrefill(text: string): { first: string; last: string } {
  const words = text.trim().split(/\s+/);
  const looksLikeName =
    words.length === 2 && words.every((w) => !/[\d@]/.test(w));
  return looksLikeName
    ? { first: words[0] ?? "", last: words[1] ?? "" }
    : { first: "", last: "" };
}

function CloseIcon() {
  return <Icon d="M6 6l12 12M18 6 6 18" />;
}

/** Magnifying glass: the submit control on both search bars (T52, Pete:
 *  "the 'search' button can be replaced with a magnifying glass icon"). */
function SearchIcon() {
  return (
    <Icon
      d="m16.5 16.5 4.5 4.5"
      size={24}
      extra={<circle cx="11" cy="11" r="7" />}
    />
  );
}

/** Trash can: cancels the booking itself, behind a confirmation. */
function TrashIcon() {
  return <Icon d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />;
}

/** A person silhouette: the profile icon on roster and search rows
 *  (T42), opening the client profile modal; the account icon too. */
function PersonIcon({ size = 22 }: { size?: number }) {
  return (
    <Icon
      d="M4 21c0-4 3.6-6 8-6s8 2 8 6"
      size={size}
      extra={<circle cx="12" cy="8" r="4" />}
    />
  );
}

/** T59c: a person with a plus, the Guest action on a member's row:
 *  their guest pass checks someone else in. */
function PersonPlusIcon() {
  return (
    <Icon
      d="M2 21c0-4 3.6-6 8-6c1.4 0 2.7.3 3.8.9M19 14v6M16 17h6"
      size={22}
      extra={<circle cx="10" cy="8" r="4" />}
    />
  );
}

/** An "i" in a circle: the row's ONE info affordance (T20), opening the
 *  combined red alert / yellow alert / notes view. */
function InfoIcon() {
  return (
    <Icon
      d="M12 11v6M12 7.5v.01"
      size={18}
      extra={<circle cx="12" cy="12" r="9" />}
    />
  );
}

/** Paired up/down arrows: opens the roster-order menu. */
function SortIcon() {
  return (
    <Icon d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5M17 20V4m0 0-3.5 3.5M17 4l3.5 3.5" />
  );
}

/** Pencil: switches the notes modal into its editing state. */
function PencilIcon() {
  return <Icon d="M15.5 4.5 19.5 8.5 8 20H4v-4ZM13 7l4 4" size={18} />;
}

/** Arrow out of a box: opens the client in the Mindbody staff web app. */
function ExternalLinkIcon() {
  return <Icon d="M14 4h6v6M20 4 11 13M19 15v5H4V5h5" />;
}

/** A dollar in a circle: opens the Buy overlay with the row's client
 *  already attached. T70: a dollar circle rather than the shopping bag it
 *  replaced, because at arm's length the bag read as a second trash can
 *  (README, "Roster"). */
function SellIcon() {
  return (
    <Icon
      d="M14.8 9.6c-.8-.8-1.9-1.1-2.9-1.1-1.4 0-2.3.7-2.3 1.6 0 1 .9 1.4 2.4 1.7 1.7.3 2.9.8 2.9 2.1 0 1.2-1.1 1.9-2.6 1.9-1.2 0-2.4-.4-3.2-1.3M12 6.6v10.8"
      extra={<circle cx="12" cy="12" r="9" />}
    />
  );
}

/** Chevron: the class picker's and the payment-change dropdown's. */
function ChevronDownIcon({ size = 18 }: { size?: number }) {
  return <Icon d="m6 9 6 6 6-6" size={size} width={2.2} />;
}

/** The calendar glyph on the header's day control (T46). */
function CalendarIcon() {
  return (
    <Icon
      d="M3 10h18M8 2v4M16 2v4"
      size={24}
      extra={<rect x="3" y="4" width="18" height="18" />}
    />
  );
}

/** Month stepping in the calendar. */
function ChevronLeftIcon() {
  return <Icon d="m15 6-6 6 6 6" size={22} width={2.2} />;
}

function ChevronRightIcon() {
  return <Icon d="m9 6 6 6-6 6" size={22} width={2.2} />;
}

/** Checkmark: the pass currently paying in a dropdown, and the glyph on
 *  a checked-in chip. */
function CheckIcon({ size = 18 }: { size?: number }) {
  return <Icon d="m4 12.5 5 5L20 6.5" size={size} width={2.4} />;
}

/** The sun: the top bar's light/dark toggle (T70, src/app/theme.ts). */
function SunIcon() {
  return (
    <Icon
      d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
      size={22}
      extra={<circle cx="12" cy="12" r="4" />}
    />
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

/** The studio's timezone, mirroring roster.ts's STUDIO_TZ: there is one
 *  physical studio and it is in Seattle, so "today" and "a day" on this
 *  screen are that timezone's, never the iPad's or a container's. */
const STUDIO_TZ = "America/Los_Angeles";

/** Today as a studio-local `YYYY-MM-DD` (en-CA formats exactly that). */
function studioToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: STUDIO_TZ }).format(
    new Date(),
  );
}

/** Minutes past studio midnight right now, for picking the class on
 *  another day nearest to this time of day. */
function studioMinutesNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  /* hour12: false can render midnight as "24" in some ICU versions. */
  return (get("hour") % 24) * 60 + get("minute");
}

/** A `YYYY-MM-DD` key as a local calendar date. Date-only, so the
 *  browser's zone cannot shift it: the parts are used as numbers. */
function keyToDate(key: string): Date {
  return new Date(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
  );
}

/** "Wed Aug 27" for a day key, the same shape dayDate gives a class. */
function dayKeyLabel(key: string): string {
  const d = keyToDate(key);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${d.toLocaleDateString(
    [],
    { month: "short", day: "numeric" },
  )}`;
}

/** `{y, m, d}` numbers to a `YYYY-MM-DD` key. */
function dateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Whether a class's naive studio-local `startsAt` falls on a day after
 *  the studio's current day. Its date part IS the studio date (T27 round
 *  three), so a string compare on `YYYY-MM-DD` is exact. */
function isFutureDay(startsAt: string): boolean {
  return startsAt.slice(0, 10) > studioToday();
}

/** The class on a picked day nearest to this time of day, or the first
 *  one: at 6:15pm on a Wednesday the teacher asking about "last Monday"
 *  most likely means last Monday's evening class. */
function nearestClassId(list: ClassSummary[]): number | null {
  const now = studioMinutesNow();
  let best: ClassSummary | null = null;
  let bestGap = Infinity;
  for (const c of list) {
    const mins =
      Number(c.startsAt.slice(11, 13)) * 60 + Number(c.startsAt.slice(14, 16));
    const gap = Math.abs(mins - now);
    if (gap < bestGap) {
      best = c;
      bestGap = gap;
    }
  }
  return best?.classId ?? list[0]?.classId ?? null;
}

/** Today's default class: the first one that started within `hoursBack`
 *  hours (a class in progress, or the one just finished while the room
 *  clears), else the next to start, else the last of the day. The list
 *  is sorted by start. */
function defaultClassId(list: ClassSummary[], hoursBack: number): number | null {
  const now = studioMinutesNow();
  const floor = now - hoursBack * 60;
  const pick =
    list.find((c) => {
      const mins =
        Number(c.startsAt.slice(11, 13)) * 60 + Number(c.startsAt.slice(14, 16));
      return mins >= floor;
    }) ?? list[list.length - 1];
  return pick?.classId ?? null;
}

/** The pay-and-check-in dialog's option order, shared by the list and
 *  the default pick: the plain adult Drop In first (Pete, live: "the top
 *  option after I click unpaid should be Drop In"; by count and price
 *  alone the $10 Buddy Pass and Child and the $15 Teen Drop In, all one
 *  visit, outranked it), then by visit count (a drop-in is 1; the
 *  fake-unlimited counters at 100 and up sort last), price breaking ties. */
function isPlainDropIn(name: string): boolean {
  return /drop.?in/i.test(name) && !/teen|child|kid|youth|guest|buddy/i.test(name);
}
function payOptionOrder(
  a: { name: string; count: number | null; price: number },
  b: { name: string; count: number | null; price: number },
): number {
  const da = isPlainDropIn(a.name) ? 0 : 1;
  const db = isPlainDropIn(b.name) ? 0 : 1;
  if (da !== db) return da - db;
  const ca = a.count !== null && a.count < 100 ? a.count : Number.MAX_SAFE_INTEGER;
  const cb = b.count !== null && b.count < 100 ? b.count : Number.MAX_SAFE_INTEGER;
  return ca - cb || a.price - b.price;
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

/** A single-visit pass (Count 1: a Drop In) has nothing to count: this
 *  booking IS the visit, so Mindbody reads it as 0 remaining the moment
 *  it is attached, and "0 remaining" beside a pass that is about to be
 *  used is a scare (Pete, 2026-09-14: "Drop in should never say '0
 *  remaining'"). Applies wherever a pass renders its count. */
function singleVisit(count: number | null): boolean {
  return count === 1;
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
  return !fakeUnlimited(p.count, p.remaining) &&
    !singleVisit(p.count) &&
    p.remaining !== null
    ? `${p.remaining} left`
    : "";
}

function passExpCol(p: { expires: string | null }): string {
  return p.expires ? `exp ${slashDate(p.expires)}` : "";
}

/** T70: the facts line of a dialog's entity card (Dialogs.dc.html): the
 *  pass, what is left on it, and where the row stands, so a confirm
 *  restates who and what state before the one loud consequence line. */
function entityFacts(entry: RosterEntry): string {
  return [
    entry.pricingOption ? shortPassName(entry.pricingOption) : "No pass",
    passLeftCol({ remaining: entry.passRemaining, count: entry.passCount }),
    passExpCol({ expires: entry.passExpires }),
    entry.checkedIn ? "checked in" : "not checked in",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The pass facts as ONE sub-line under the pass name, everywhere a pass
 * renders two-line (roster payment cell, walk-in summaries): "3 remaining,
 * exp 3/2/27"; a fake-unlimited pass shows only the expiry; nothing known,
 * no line. "1 remaining" keeps the warn pill: since the count is the
 * pass BEFORE this visit (roster.ts beforeThisVisit, 2026-09-14), 1
 * means this class uses the last session, the renewal conversation
 * that happens now or never, so it stays loud even in a sub-line.
 */
function PassFactsLine(props: {
  remaining: number | null;
  count: number | null;
  expires: string | null;
}) {
  const showRemaining =
    !fakeUnlimited(props.count, props.remaining) &&
    !singleVisit(props.count) &&
    props.remaining !== null;
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

function FrontDesk({
  teacher,
  onTeacherChange,
  initialFlash = null,
  onInitialFlashShown,
}: {
  /** T50: the signed-in teacher. Never null here: AuthGate renders the
   *  sign-in gate instead of this screen until someone is. */
  teacher: Teacher;
  /** Signed out, or the session ended (null); or signed in as someone
   *  else from the account modal. AuthGate owns the state. */
  /** T89: the second argument is the line the sign-in gate shows when
   *  this is a sign-OUT the counter should explain (the studio target
   *  just changed). Omitted everywhere else, which shows the gate's
   *  standing wording. */
  onTeacherChange: (teacher: Teacher | null, notice?: string | null) => void;
  /** T80: a word the gate earned before this screen existed ("PIN set"),
   *  shown in the banner slot once the roster is up. */
  initialFlash?: string | null;
  onInitialFlashShown?: () => void;
}) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<SearchResult[]>([]);
  /** T71: the query `found` answers, for the bold match in each row. Set
   *  with the first page, so a query typed after the search stays out
   *  of the rows until it is searched. */
  const [foundFor, setFoundFor] = useState("");
  /** T59b: the new-client form, open over the walk-in search's empty
   *  state with the names the search box held when it looked like one. */
  /**
   * T59c: the guest flow. `guestFlow` is the member and the guest pass
   * the modal was opened for (captured at open, like the cancel dialog's
   * class, so the eventual write names what the teacher saw);
   * `guestPick` is the chosen guest once past the waiver gate; `guestBy`
   * names the member on a guest's roster row after a real check-in
   * (Mindbody's visit carries the pass name, not whose pass it was),
   * per class view, so a class switch clears it.
   */
  const [guestFlow, setGuestFlow] = useState<{
    member: RosterEntry;
    pass: PassInfo & { id: number };
  } | null>(null);
  const [guestPick, setGuestPick] = useState<GuestPick | null>(null);
  const [guestBy, setGuestBy] = useState<Record<string, string>>({});
  const [newClient, setNewClient] = useState<{
    first: string;
    last: string;
    /** T59c: who asked for the form. "search" hands the new person to
     *  the walk-in results; "guest" selects them as the guest. T91 adds
     *  "sale": the new person is attached to the open sale. */
    for: "search" | "guest" | "sale";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ModeConfig | null>(null);
  /** Rows whose check-in call failed after going green optimistically. */
  const [failed, setFailed] = useState<Record<string, string>>({});
  /** T49/T50: the writes' answers still report the session ending
   *  (`staffSessionEnded`); that drops the teacher upstream and the gate
   *  takes over. The name is kept for the call sites below. */
  const setTeacher = onTeacherChange;
  const [staffOpen, setStaffOpen] = useState(false);
  /** T49: per-row amber notes, "Done as the studio account: ...", for a
   *  write on that row that fell back from the teacher's token. */
  const [actorNotes, setActorNotes] = useState<Record<string, string>>({});
  /** T49: the same note for writes with no row to sit on (a booking, a
   *  waiver, a cancel); one line under the mode banner, 20 seconds. */
  const [actorBanner, setActorBanner] = useState<string | null>(null);
  const actorBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * T49: what every write's answer is read for. `staffSessionEnded`
   * means Mindbody no longer honours the teacher's token and the
   * server ended the session, so the header goes back to "Sign in";
   * `actorFallback` means the write ran as the studio account and says
   * why, on the row when there is one and on the banner otherwise. The
   * line is returned too for a dialog that would rather show it itself.
   */
  const noteActor = useCallback(
    (body: any, clientId?: string): string | null => {
      if (body?.staffSessionEnded === true) setTeacher(null);
      const fb = body?.actorFallback;
      if (!fb || typeof fb.name !== "string" || typeof fb.reason !== "string") {
        return null;
      }
      const line = actorFallbackLine(fb);
      if (clientId) {
        setActorNotes((n) => ({ ...n, [clientId]: line }));
      } else {
        setActorBanner(line);
        if (actorBannerTimer.current) clearTimeout(actorBannerTimer.current);
        actorBannerTimer.current = setTimeout(() => setActorBanner(null), 20_000);
      }
      return line;
    },
    [],
  );
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
  /**
   * T88 (Pete: "if they have no card on file, instead of 'use Buy' this
   * should be able to take me where I can buy and check in"): the
   * check-in the teacher left the pay dialog to finish on the Buy
   * screen. The same facts the card path works from, captured at the
   * tap so the writes cannot chase a moved row: the visit, the class it
   * was tapped under, the client, and the pass that was chosen. `nonce`
   * is what makes a second trip to the same pass arrive at SaleScreen.
   */
  const [pendingCheckIn, setPendingCheckIn] = useState<{
    nonce: number;
    visitId: number;
    classId: number;
    clientId: string;
    clientName: string;
    itemType: "Product" | "Service";
    itemId: string | number;
    /** Mindbody's ProductId for the chosen option: what the purchased
     *  ClientService is matched on afterwards (T25 stage (b)). */
    productId: number | null;
    /** The one quiet line the sale screen shows above the ticket. */
    note: string;
  } | null>(null);
  const pendingNonce = useRef(0);
  /** Mirror of pendingCheckIn for the async finish, which runs from the
   *  sale's callback and would otherwise read a stale render. */
  const pendingRef = useRef<typeof pendingCheckIn>(null);
  pendingRef.current = pendingCheckIn;
  /** Single flight over the finish, the payFlight discipline: one sale
   *  answers once, and nothing here is ever retried. */
  const pendingFlight = useRef(false);
  /** What the finish is doing or how it went, shown on the sale's done
   *  screen. Cleared when a new pending check-in starts. */
  const [pendingResult, setPendingResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

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
  /**
   * The scroll-loaded search (T42, Pete: "we should lazy load as the user
   * scrolls"). `offset` is where the next page starts, `total` is
   * Mindbody's TotalResults for the query (null when it omitted it), and
   * `done` says there is nothing more to ask for: a short page, or the
   * total reached. `searchMore` is the NEXT page's in-flight flag, kept
   * apart from `searching` so the held rows stay on screen under it.
   */
  const [searchPage, setSearchPage] = useState<{
    offset: number;
    total: number | null;
    done: boolean;
  }>({ offset: 0, total: null, done: true });
  const [searchMore, setSearchMore] = useState(false);
  /** The in-flight search call, aborted by the next query, the next page,
   *  the X and the close: a page that lands after the query changed must
   *  not append itself to the new query's rows. */
  const searchAbort = useRef<AbortController | null>(null);
  /** T81 review: whether the call behind `searchAbort` is still out.
   *  The live search aborts only a call in flight; aborting a landed one
   *  marked the rows on screen stale, and a query typed away from and
   *  back to inside the debounce went out again, a metered call for
   *  rows already showing. */
  const searchInFlight = useRef(false);
  /** T81: the live search's pending debounce, so a submit can cancel it. */
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** T81: whether a finger is on a results list, since when, and the
   *  page held back until it lifts. */
  const listTapGuard = useRef<{
    down: boolean;
    downAt: number;
    deferred: (() => void) | null;
  }>({ down: false, downAt: 0, deferred: null });
  /** T81 review: the watchdog that lifts a press whose pointerup never
   *  reached the window, so a held result set cannot be held for ever. */
  const listLiftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The sentinel at the end of the results list, as a state-held node so
   *  the IntersectionObserver effect re-arms when the list (re)mounts. */
  const [searchSentinel, setSearchSentinel] = useState<HTMLElement | null>(
    null,
  );
  /** The attach modal's segment (T87): "class" shows the sign-in
   *  screen's selected class, filtered in memory; "all" asks Mindbody
   *  about everyone. Chosen once per open (openAttachSearch) and never
   *  by the modal itself after that, bar the T52 widen the teacher's own
   *  Enter asks for. */
  const [attachTab, setAttachTab] = useState<AttachTab>("class");
  /** T52: the attach modal turned "In class" off by itself because the
   *  submitted query matched nobody in the class (Pete: "the 'in class'
   *  filter should turn off and the non-filtered results should
   *  display"; behind the autoWidenSearch setting). Drives the one line
   *  over the rows that says so; cleared by the segment, the X, a new
   *  submit and the close. T87: what it flips is the segment, Class to
   *  All, the only path that moves the segment while the modal is open:
   *  on the teacher's Enter, or, since 2026-09-14, on the live debounce
   *  once the typed query matches nobody in class. */
  const [autoWidened, setAutoWidened] = useState(false);
  /** The query the teacher deliberately put back on Class (a tap on the
   *  Class cell while it was typed): the live widen leaves that one
   *  alone, or the cell would bounce back to All on the next debounce.
   *  Any other query widens as usual. */
  const heldOnClass = useRef<string | null>(null);
  /** T91 review: a query the APP put in the box, not a teacher: the name
   *  of a client just created with the box empty. The live search must
   *  not spend a metered Mindbody call on it, and its first page would
   *  replace the row the create just put in the list. Cleared as soon as
   *  the box is typed in, so the same name typed by hand still searches. */
  const liveSeeded = useRef<string | null>(null);
  /** The client profile modal (T42): who it is about, and the read. The
   *  fetch fires on OPEN, not on the icon's render, since the profile is
   *  three metered reads; `profileGen` drops an answer that lands after
   *  the modal closed or reopened for someone else. */
  const [profileView, setProfileView] = useState<{
    clientId: string;
    name: string;
  } | null>(null);
  const [profileState, setProfileState] = useState<{
    profile: ClientProfile | null;
    loading: boolean;
    error: string | null;
  }>({ profile: null, loading: false, error: null });
  /** T72: the open profile as a ref, for a background write's answer
   *  to know whether its profile is still the one on screen. */
  const profileViewRef = useRef(profileView);
  profileViewRef.current = profileView;
  const profileGen = useRef(0);
  /** Tunables live in the dev drawer's settings tab, so the ones that have
   *  already been wrong once can be adjusted without a commit. */
  /** T52: the Membership modal behind a roster row's M chip (Pete:
   *  "clicking on an 'M' icon should show more info about their
   *  membership"). T56 (Pete: "i want to understand what indicates the M
   *  status ... i see No current memberships or passes on file"): it no
   *  longer reads the picker's active-only pass list, which cannot show
   *  the contract or the used-up pass an M rests on. It reads
   *  /api/membership, two metered calls spent only on the tap, cached
   *  per client for the session in `memberInfo`; a failure is not
   *  cached, and the modal offers a retry. `member` is the row's flag,
   *  so the closing line can say what Mindbody says. */
  const [memberView, setMemberView] = useState<{
    clientId: string;
    name: string;
    member: boolean;
  } | null>(null);
  const [memberInfo, setMemberInfo] = useState<
    Record<string, MembershipState>
  >({});
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
  /** Where the roster's dropdown sits (T55): the roster list is the
   *  scroll container now, and an absolute dropdown anchored to a row
   *  would be clipped at the list's edge, so like the search modal's
   *  picker it is position: fixed with its coordinates captured from
   *  the row at open time. Null until measured; the row's chevron sets
   *  it in the same handler that opens the picker. */
  const [pickerPos, setPickerPos] = useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);
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
   *  mounted across open/close, so a cart survives a trip to the roster
   *  (T85: the nav bar's Sign-in item). */
  const [saleOpen, setSaleOpen] = useState(false);
  /** T85: which of the sale's two screens is showing. It lives here, not
   *  in SaleScreen, because the nav bar is rendered here and Buy and Pay
   *  are two of its items. */
  const [saleMode, setSaleMode] = useState<"shelf" | "pay">("shelf");
  /** T85: the sale's reading of Pay for the nav bar: why it is off, the
   *  tap it delegates to, and whether a charge is in flight. SaleScreen
   *  reports it whenever it changes, so the bar's Pay and the shelf's Pay
   *  are never two opinions; the sale stays the only thing that decides
   *  whether there is anything to pay. */
  const [saleNav, setSaleNav] = useState<SaleNavState>({
    payWhy: "Nothing rung up yet",
    charging: false,
    payTap: () => undefined,
  });
  /** T85: the dev drawer's pill became the bar's Dev item, so the drawer's
   *  two facts are held here: whether /api/devlog answered at all, and
   *  whether the drawer is open. */
  const [devAvailable, setDevAvailable] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  /** The client the sale is for, or null for an anonymous sale. Chosen
   *  through the search modal's attach mode; rides /api/price-cart. */
  const [saleClient, setSaleClient] = useState<SaleClient | null>(null);
  /** T91: the amber note from a New client create made on the Buy screen
   *  (a suppressed write, or the service-account fallback line). It rides
   *  down to SaleScreen's note slot, because that is where the teacher is
   *  looking; cleared when the sale screen says it has been read. */
  const [saleClientNote, setSaleClientNote] = useState<string | null>(null);
  /** T91 review: stable, because the sale screen's 20 second life for the
   *  note keys on this function: a new one every render (the config poll
   *  re-renders this component on its own) restarted the timer and the
   *  note could sit there indefinitely. */
  const readSaleClientNote = useCallback(() => setSaleClientNote(null), []);
  /** True while the search modal is open as the sale's attach picker
   *  (T23): same modal, same submit-triggered search, same row format,
   *  but the row action selects the client instead of booking, and the
   *  booking-only furniture (full-class notice, pass picker, roster
   *  de-duplication) steps aside. */
  const [attachMode, setAttachMode] = useState(false);
  /**
   * T90: the attach modal, open to pick who ONE ticket line is for
   * rather than who the sale is for (Pete: "when Other Client is
   * selected, the search box appears"). The same modal, the same live
   * search and the same Class | All segment; only the title, the row
   * action and the clear row differ. `clear` says the line already has a
   * recipient, so the row that takes it off is offered.
   */
  const [recipientFor, setRecipientFor] = useState<{
    lineKey: string;
    clear: boolean;
  } | null>(null);
  /** T90: the picked recipient, handed to SaleScreen (which owns the
   *  cart). The nonce makes a repeat of the same pick arrive. */
  const [recipientPick, setRecipientPick] = useState<{
    nonce: number;
    lineKey: string;
    client: { id: string; name: string } | null;
  } | null>(null);
  /**
   * Attach-mode furniture (T27 round three, reshaped in T87): the person
   * a sale is for is usually standing in the class already on screen, so
   * the attach modal leads with that class's roster as tappable rows
   * behind a "Class" segment cell, with "All" for the Mindbody search.
   * The booking-mode search modal renders none of this.
   *
   * T87 removed the rest of it: the "In class" toggle, the class
   * dropdown over the rows (and the day's classes it was fed), the
   * three-way segment, and the roster fetch for a class other than the
   * selected one. The class is the sign-in screen's, whose roster is
   * `entries`, already in memory: zero calls.
   */
  /** Session cache for the day-classes call, keyed by STUDIO-local date
   *  (`YYYY-MM-DD`), so a counter left open overnight refetches for the
   *  new day. The calendar's picked day (T46) is its one reader since
   *  T87 took the attach modal's dropdown out. Class lists only, for the
   *  page's life; never rosters, passes or clients. */
  const dayClassesCache = useRef(new Map<string, ClassSummary[]>());
  /** Day keys with a classes fetch in flight, each holding the flight
   *  itself: a second reader for the same day (the modal reopened, the
   *  same date tapped twice) joins that promise instead of firing a
   *  second metered call. */
  const dayClassesInFlight = useRef(
    new Map<string, Promise<ClassSummary[]>>(),
  );
  /**
   * T46: the day the roster screen is showing, as a studio-local
   * `YYYY-MM-DD`, or null for the around-now window the app starts in.
   * The class dropdown, the header and the roster all read the same
   * `classes` array in both modes; this only says which window filled
   * it, which decides the day control's outline and label (T61: the
   * date text beside it and the "Viewing" line under the row are gone),
   * the roster banner, whether check-in is open (future days: booking
   * only) and whether
   * the settings-driven around-now refetch runs.
   */
  const [viewDate, setViewDate] = useState<string | null>(null);
  /** viewDate readable at call time (pickViewDate, refreshRoster): a
   *  return to today must be a no-op when today is already showing, and
   *  a roster load must know whether its class sits outside the
   *  around-now window. Assigned wherever viewDate is set. */
  const viewDateRef = useRef<string | null>(null);
  /** Whether the picked day's classes are still on the wire. The old
   *  list stays on screen until the answer lands (a blank header would
   *  take the calendar button with it). */
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  /** Bumped on every day pick and on the return to today, so a slow
   *  answer for a superseded pick is dropped rather than rendered over
   *  the newer one. Same pattern as waiverGen. */
  const viewGen = useRef(0);
  /** Whether the calendar modal is open, and which month it shows
   *  (`{y, m}` with m 1-12; pure UI, no timezone in it). */
  const [calOpen, setCalOpen] = useState(false);
  const [calMonth, setCalMonth] = useState<{ y: number; m: number }>(() => {
    const k = studioToday();
    return { y: Number(k.slice(0, 4)), m: Number(k.slice(5, 7)) };
  });
  /** The class currently on screen, readable from inside an async fetch:
   *  a waitlist response that comes back after the teacher has switched
   *  classes must be dropped, not written into state under the new class. */
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  /** The selected class's naive startsAt, readable from tapCheckIn (which
   *  is defined before activeClass is computed): the future-day refusal
   *  reads it. Assigned where activeClass is. */
  const activeStartsAtRef = useRef("");

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

  /* T89: read once, then every 30 seconds. The banner has to be right
   * about which studio this is within seconds of a switch made on
   * ANOTHER iPad, and the config read is local apart from the banner
   * row; nothing here calls Mindbody. A failed refetch keeps the last
   * answer rather than blanking the banner. */
  const readConfig = useCallback(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body) setConfig(body);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
    const timer = setInterval(readConfig, 30_000);
    return () => clearInterval(timer);
  }, [readConfig]);

  useEffect(() => {
    /* T46: another day is showing. Its list came from the calendar pick
     * and must not be overwritten by the around-now window; the settings
     * change (or the return to today, which flips viewDate back to null
     * and re-runs this) applies then. */
    if (viewDate !== null) return;
    const gen = ++viewGen.current;
    /* The WHOLE studio day, not a window around now (Pete, live, at 7am
     * with a 10am, 5pm and 6:30pm on the schedule: "i'm only seeing one
     * class!! there are 3 today."). The window that used to cut the list
     * was the same one metered call as the day, and a day picked on the
     * calendar already showed everything; today now does too. The
     * "schedule back" setting picks the DEFAULT class instead: the first
     * class that started within that many hours, else the next one. */
    fetch(`/api/roster?day=1`)
      .then((r) => r.json())
      .then((d) => {
        /* A day was picked while this was on the wire: its answer wins. */
        if (viewGen.current !== gen) return;
        if (d.error) return setError(d.error);
        const list: ClassSummary[] = d.classes ?? [];
        setClasses(list);
        /* The URL names the class to land on. If it is not on today's
         * list (an old link), fall back to the default quietly and
         * correct the param, so the URL always says what the screen
         * shows. */
        const wanted = Number(classIdParamRef.current);
        const fromUrl =
          Number.isFinite(wanted) && classIdParamRef.current !== null
            ? (list.find((c) => c.classId === wanted) ?? null)
            : null;
        const chosen =
          fromUrl?.classId ?? defaultClassId(list, settings.hoursBack);
        setActiveId(chosen);
        syncClassParam(chosen);
      })
      .catch((e) => {
        if (viewGen.current !== gen) return;
        setError(String(e));
      });
  }, [settings.hoursBack, syncClassParam, viewDate]);

  /**
   * Every class on one studio-local day, through the existing
   * `GET /api/roster?day=1&anchor=` (T27 round three): ONE metered call
   * per day for the page's life, served from `dayClassesCache` after
   * that, and a fetch already in flight for the same day is joined, not
   * repeated. The anchor is the day's studio-local NOON as a naive
   * string, which parseRosterAnchor reads in STUDIO_TZ; noon sits as far
   * as possible from both midnights and any DST edge.
   */
  const loadDayClasses = useCallback((key: string): Promise<ClassSummary[]> => {
    const cached = dayClassesCache.current.get(key);
    if (cached) return Promise.resolve(cached);
    const inFlight = dayClassesInFlight.current.get(key);
    if (inFlight) return inFlight;
    const flight = fetch(
      `/api/roster?day=1&anchor=${encodeURIComponent(`${key}T12:00:00`)}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(String(d.error));
        const list: ClassSummary[] = d.classes ?? [];
        dayClassesCache.current.set(key, list);
        return list;
      })
      .finally(() => {
        dayClassesInFlight.current.delete(key);
      });
    dayClassesInFlight.current.set(key, flight);
    return flight;
  }, []);

  /**
   * T46: show another day. `key` is a studio-local `YYYY-MM-DD`; null
   * (or today's own date) returns to the around-now window exactly as
   * the app starts, by flipping viewDate back to null so the effect
   * above re-runs. Any other day loads its classes once (cached after)
   * and selects the class nearest to this time of day; the activeId
   * effect then fetches that roster as it does for any class switch.
   * The old list stays on screen until the answer lands.
   */
  const pickViewDate = useCallback(
    (key: string | null) => {
      setCalOpen(false);
      setClassPickerOpen(false);
      const wanted = key === studioToday() ? null : key;
      /* Today while today is already showing (with, at app start, its
       * around-now fetch still on the wire): nothing to do. Bumping
       * viewGen here orphaned that fetch, whose answer was then dropped
       * with no refetch to follow, and the screen sat on "No classes in
       * the next few hours" until a settings change. */
      if (wanted === null && viewDateRef.current === null) return;
      const gen = ++viewGen.current;
      setViewError(null);
      viewDateRef.current = wanted;
      setViewDate(wanted);
      if (wanted === null) {
        setViewLoading(false);
        return;
      }
      setViewLoading(true);
      loadDayClasses(wanted)
        .then((list) => {
          if (viewGen.current !== gen) return;
          setViewLoading(false);
          setClasses(list);
          const chosen = nearestClassId(list);
          if (chosen === null) {
            /* A day with no classes: nothing to select, so the previous
             * class's roster must not linger under the new banner. */
            setEntries([]);
            setWaiverError(null);
          }
          setActiveId(chosen);
          syncClassParam(chosen);
        })
        .catch((e) => {
          if (viewGen.current !== gen) return;
          setViewLoading(false);
          setViewError(e instanceof Error ? e.message : String(e));
          /* The day did not load. The previous class must not stay on
           * screen under this day's outlined day control: that was
           * today's roster captioned "Viewing Thu Aug 27" (the caption
           * went with T61; the outline remains). Clear it; the header
           * keeps the calendar button (retry, or Today), and the day is
           * not cached, so the next pick fetches again. */
          setClasses([]);
          setEntries([]);
          setWaiverError(null);
          setActiveId(null);
          syncClassParam(null);
        });
    },
    [loadDayClasses, syncClassParam],
  );

  /** Escape closes the calendar. Nothing in it writes. */
  useEffect(() => {
    if (!calOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calOpen]);

  /**
   * The roster for one class, also called after a booking so the new visit
   * appears with its visit id. The response carries fresh capacity and
   * booked counts, which update the class summary too: a booking that
   * fills the class must flip the walk-in action to "waitlist" without
   * waiting for a page reload.
   */
  const refreshRoster = useCallback(async (classId: number) => {
    try {
      /* T46: with another day showing, the class is outside the
       * around-now window, so the route's summary lookup (an around-now
       * `/class/classes` call) could never hit it; the header already
       * reads name, teacher and capacity from the day's list. summary=0
       * skips that call: one fewer metered call per roster load. */
      const summary = viewDateRef.current !== null ? "&summary=0" : "";
      const d = await fetch(`/api/roster?classId=${classId}${summary}`).then(
        (r) => r.json(),
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
    /* T59c: the guest modal names a member's row on THIS class, and the
     * "guest of" captions belong to this class's rows. */
    setGuestFlow(null);
    setGuestPick(null);
    setGuestBy({});
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
      if (e.key === "Escape" && !waiverPrompt && !infoView && !profileView) {
        setCounterModal(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [counterModal, waiverPrompt, infoView, profileView]);

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
        noteActor(body);
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
    [cancelBusy, refreshRoster, noteActor],
  );

  /**
   * Search runs as the teacher types (T81, Pete: "results should start
   * appearing after a delay and minimum characters are entered"), and
   * on Enter or the Search button at once. T16 had moved it to submit
   * only, for two reasons that still hold and are answered here rather
   * than by waiting for Enter: a metered call per pause (the debounce
   * and the minimum length, both drawer settings, and the keystroke
   * aborting the call in flight), and results appearing under a moving
   * finger (the modal's list keeps its top edge, and a result set that
   * lands mid-tap waits for the finger to lift, see `listTapGuard`).
   *
   * The minimum length applies to the live search silently (a short
   * query shows nothing and clears what an earlier one showed) and to
   * a submit quietly, under the input. Three letters by default,
   * because two returns hundreds of matches that nobody scrolls, at the
   * cost of a metered call.
   */
  /**
   * One page of the search, appended or replacing (T42). Aborts whatever
   * page was in flight first: a new query, a next page, the X and the
   * close all go through here or through `stopSearch`, so at most one
   * search call is ever outstanding and a late answer for a superseded
   * query can never land in the list. Appends de-duplicate by id, since
   * a client created between two pages shifts Mindbody's offsets.
   */
  const fetchSearchPage = useCallback(
    (q: string, offset: number, limit: number) => {
      searchAbort.current?.abort();
      const ctl = new AbortController();
      searchAbort.current = ctl;
      searchInFlight.current = true;
      const first = offset === 0;
      /* A first page also clears the next-page flag: the page it just
       * aborted returns early from its finally and would otherwise leave
       * `searchMore` stuck on, which blocked every later page of the new
       * query and pinned "Loading more..." under it (T42 review). */
      if (first) {
        setSearching(true);
        setSearchMore(false);
      } else setSearchMore(true);
      fetch(
        `/api/search?q=${encodeURIComponent(q)}&limit=${limit}` +
          (offset > 0 ? `&offset=${offset}` : ""),
        { signal: ctl.signal },
      )
        .then((r) => r.json())
        .then((d) => {
          if (ctl.signal.aborted) return;
          /* T81: a live search opens the modal when its first page
           * lands (an error included, or the error would show nowhere);
           * a submitted one opened it already, and this is a no-op. */
          if (first) setSearchOpen(true);
          if (d.error) {
            setSearchError(String(d.error));
            endPaging();
            return;
          }
          const page: SearchResult[] = d.results ?? [];
          const total = typeof d.total === "number" ? d.total : null;
          const apply = () => {
            if (ctl.signal.aborted) return;
            setFound((prev) => {
              if (first) return page;
              const seen = new Set(prev.map((p) => p.id));
              return [...prev, ...page.filter((p) => !seen.has(p.id))];
            });
            if (first) setFoundFor(q);
            const next = offset + page.length;
            setSearchPage({
              offset: next,
              total,
              done:
                page.length < limit || (total !== null && next >= total),
            });
          };
          /* T81: never swap the rows under a finger. A page landing
           * while a row is pressed, or within 150ms of the press, waits
           * for the pointer to lift (or the 150ms to pass), then lands;
           * a search that superseded it meanwhile has aborted this one,
           * and `apply` checks. T16's complaint, answered without
           * waiting for Enter. */
          const tap = listTapGuard.current;
          const since = Date.now() - tap.downAt;
          if (tap.down) tap.deferred = apply;
          else if (since < 150) setTimeout(apply, 150 - since);
          else apply();
        })
        .catch((e) => {
          if (ctl.signal.aborted) return;
          /* T81 review: a live first page that never reached the server
           * (the iPad off the network) opens the modal too, or the
           * error under it would show nowhere and typing would look
           * ignored. */
          if (first) setSearchOpen(true);
          setSearchError(e instanceof Error ? e.message : String(e));
          endPaging();
        })
        .finally(() => {
          if (ctl.signal.aborted) return;
          searchInFlight.current = false;
          if (first) setSearching(false);
          else setSearchMore(false);
        });
      /* A failed page ends the paging: with the sentinel still in view
       * the observer re-armed on every flag change and asked again, 14
       * metered calls in three seconds against a page that answered 429
       * (T42 review). The error shows; a new submit starts over. */
      function endPaging() {
        setSearchPage((p) => ({ ...p, done: true }));
      }
    },
    [],
  );

  /** Abort the in-flight search and drop the held results: the X, the
   *  close, and the attach modal's Class cell all mean the same thing,
   *  that the query on screen no longer has results. */
  const stopSearch = useCallback(() => {
    searchAbort.current?.abort();
    searchAbort.current = null;
    searchInFlight.current = false;
    setSearching(false);
    setSearchMore(false);
    setFound([]);
    setSearchTitle("");
    setSearchError(null);
    setSearchPage({ offset: 0, total: null, done: true });
  }, []);

  /** A NEW search for `q`, page one: the state reset every search shares,
   *  whichever control fired it (Enter, the Search button, the attach
   *  modal's All cell with a query already typed, or the typing itself,
   *  T81). A submit opens the modal now; a live search (`live`) leaves
   *  it to the first page, so nothing covers the roster until there is
   *  something to show. */
  const startSearch = useCallback(
    (q: string, live = false) => {
      setSearchMsg(null);
      setSearchTitle(q);
      if (!live) setSearchOpen(true);
      setSearchError(null);
      setAutoWidened(false);
      setSearchPage({ offset: 0, total: null, done: true });
      /* A new search is a new set of people: any pass chosen for the old
       * results must not silently apply to a same-id row in the new ones. */
      setWalkinPassChoice({});
      setWalkinPicker(null);
      fetchSearchPage(q, 0, attachMode ? ATTACH_PAGE_SIZE : settings.searchLimit);
    },
    [attachMode, fetchSearchPage, settings.searchLimit],
  );

  const submitSearch = useCallback(() => {
    const q = query.trim();
    /* T81: Enter is the live search, now. Whatever pause was pending
     * would only fire the same call twice. */
    if (liveTimer.current !== null) {
      clearTimeout(liveTimer.current);
      liveTimer.current = null;
    }
    /* On the Class cell the query filters that roster in memory as it is
     * typed (T42, T87), so Enter has nothing to ask Mindbody for...
     * unless it matched nobody. T52 (Pete): "if there are none in that
     * class, and the 'in class' filter is on, the 'in class' filter
     * should turn off and the non-filtered results should display."
     * Counted against the whole roster of the class the sign-in screen
     * has selected, which since T87 is the only roster the modal shows.
     * An EMPTY roster widens too (T87 review): nobody booked is nobody
     * matched, and it is the one case where the Class cell has nothing
     * of its own to offer, so an Enter that did nothing there left the
     * teacher with no way forward and no line saying why. The segment
     * visibly moves to All, and the line over the rows says why. */
    if (attachMode && attachTab === "class") {
      setSearchMsg(null);
      if (!settings.autoWidenSearch || !q) return;
      const lq = q.toLowerCase();
      if (entries.some((en) => en.name.toLowerCase().includes(lq))) return;
      if (q.length < settings.minQueryLength) {
        setSearchMsg(
          `Nobody in class matched. Type at least ${settings.minQueryLength} letters to search everyone.`,
        );
        return;
      }
      setAttachTab("all");
      startSearch(q);
      /* After startSearch, which resets it: the same render batch, so
       * the flag lands true. */
      setAutoWidened(true);
      return;
    }
    if (q.length < settings.minQueryLength) {
      setSearchMsg(
        `Type at least ${settings.minQueryLength} letters, then search.`,
      );
      return;
    }
    startSearch(q);
  }, [
    attachMode,
    attachTab,
    entries,
    query,
    settings.autoWidenSearch,
    settings.minQueryLength,
    startSearch,
  ]);

  /** The next page, when the list's sentinel scrolls into view (T42).
   *  One metered call, and only when the last page said there is more;
   *  never while a page is already in flight. */
  const loadMoreResults = useCallback(() => {
    if (searching || searchMore || searchPage.done || !searchTitle) return;
    fetchSearchPage(
      searchTitle,
      searchPage.offset,
      attachMode ? ATTACH_PAGE_SIZE : settings.searchLimit,
    );
  }, [
    attachMode,
    fetchSearchPage,
    searchMore,
    searchPage,
    searchTitle,
    searching,
    settings.searchLimit,
  ]);

  useEffect(() => {
    if (!searchSentinel) return;
    /* The observer accounts for the scrolling ancestor's clipping, so a
     * viewport root is right; the margin asks for the page a little before
     * the sentinel is actually in view, and since the sentinel sits BELOW
     * a full page of rows in a five-row window, the observer cannot fire
     * again until the teacher scrolls: no page is prefetched. */
    const io = new IntersectionObserver(
      (ents) => {
        if (ents.some((en) => en.isIntersecting)) loadMoreResults();
      },
      { rootMargin: "96px" },
    );
    io.observe(searchSentinel);
    return () => io.disconnect();
  }, [searchSentinel, loadMoreResults]);

  /**
   * T81: the live search. Every change to the query (either bar, they
   * share it) starts the debounce over; when it runs out and the query
   * is at least the minimum length, the search fires as if submitted,
   * except that the modal waits for the first page. A change while a
   * call is in flight aborts that call at once: its answer would be for
   * a query nobody is looking at. A query that drops below the minimum
   * clears the results it had (Pete: "after a delay and minimum
   * characters"), with the modal, if open, left open and empty for the
   * next letters, and the bar keeping focus.
   *
   * On the attach modal's Class cell the box filters that roster in
   * memory and no call goes out, EXCEPT when the settled query matches
   * nobody in the class (Pete, 2026-09-14: "when i search for a name and
   * class is selected as the default filter, if they are not in the
   * class, the filter should automatically change to All"): then the
   * same debounce moves the segment to All and searches everyone, the
   * T52 widen without waiting for Enter, behind the same
   * autoWidenSearch setting and the same line over the rows. A query
   * that still matches someone in class stays on Class.
   * Skipped when a search for exactly this query is already in flight
   * or has landed (Enter got there first, or the last keystroke put the
   * query back), so the same call never goes out twice.
   */
  useEffect(() => {
    const q = query.trim();
    /* T91 review: the box was seeded with a new client's name, not typed. */
    if (q !== "" && q === liveSeeded.current) return;
    const onClass = attachMode && attachTab === "class";
    if (onClass) {
      if (!settings.autoWidenSearch || !q) return;
      if (q === heldOnClass.current) return;
      const lq = q.toLowerCase();
      if (entries.some((en) => en.name.toLowerCase().includes(lq))) return;
    }
    /* T81 review: the drawer's number field reads 0 while it is being
     * retyped, and an older stored blob can hold anything, so the
     * minimum is at least one letter (an empty box searched Mindbody
     * for "" and opened the modal on load) and a debounce that is not
     * a number is the default (it fired on every keystroke). */
    const minLength = Math.max(1, Number(settings.minQueryLength) || 1);
    const debounceMs =
      Number.isFinite(settings.searchDebounceMs) && settings.searchDebounceMs >= 0
        ? settings.searchDebounceMs
        : DEFAULT_SETTINGS.searchDebounceMs;
    if (q.length < minLength) {
      if (searchTitle) stopSearch();
      return;
    }
    const current = searchAbort.current;
    if (q === searchTitle && current && !current.signal.aborted) return;
    if (searchInFlight.current) current?.abort();
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      if (onClass) {
        setAttachTab("all");
        setSearchMsg(null);
      }
      startSearch(q, true);
      /* After startSearch, which resets it: the same batch, so it lands
       * true and the "Nobody in class matched" line shows over the rows. */
      if (onClass) setAutoWidened(true);
    }, debounceMs);
    return () => {
      if (liveTimer.current !== null) clearTimeout(liveTimer.current);
      liveTimer.current = null;
    };
  }, [
    attachMode,
    attachTab,
    entries,
    query,
    settings.autoWidenSearch,
    searchTitle,
    settings.minQueryLength,
    settings.searchDebounceMs,
    startSearch,
    stopSearch,
  ]);

  /** T81: the guard against rows changing under a finger. The results
   *  lists mark a press (`onPointerDown`); the lift is watched on the
   *  window, since a finger can leave the list before it lifts. A page
   *  that landed during the press is held in `deferred` and applied on
   *  the lift (see fetchSearchPage). */
  const liftListTap = useCallback(() => {
    const tap = listTapGuard.current;
    if (listLiftTimer.current !== null) {
      clearTimeout(listLiftTimer.current);
      listLiftTimer.current = null;
    }
    if (!tap.down) return;
    tap.down = false;
    const apply = tap.deferred;
    tap.deferred = null;
    apply?.();
  }, []);
  const noteListTap = useCallback(() => {
    listTapGuard.current.down = true;
    listTapGuard.current.downAt = Date.now();
    /* T81 review: a pointerup that never arrives must not hold the
     * results for good. A touch takes implicit pointer capture, so a
     * lift whose target left the document is delivered to that detached
     * node and never reaches the window; the press was then down for
     * ever and EVERY later result set was held, so search rendered
     * nothing again until a reload. No press lasts a second and a
     * half. */
    if (listLiftTimer.current !== null) clearTimeout(listLiftTimer.current);
    listLiftTimer.current = setTimeout(liftListTap, 1500);
  }, [liftListTap]);
  useEffect(() => {
    window.addEventListener("pointerup", liftListTap);
    window.addEventListener("pointercancel", liftListTap);
    return () => {
      window.removeEventListener("pointerup", liftListTap);
      window.removeEventListener("pointercancel", liftListTap);
      if (listLiftTimer.current !== null) clearTimeout(listLiftTimer.current);
      listLiftTimer.current = null;
    };
  }, [liftListTap]);

  /** The X in either search bar (T42, Pete: "the search results should
   *  disappear"): the query AND the results go together. */
  const clearSearch = useCallback(() => {
    setQuery("");
    setSearchMsg(null);
    setAutoWidened(false);
    stopSearch();
  }, [stopSearch]);

  /** Closing the results modal, by any path, also clears the input and
   *  the held results: a closed search is a finished search, and stale
   *  text in the box otherwise invites resubmitting it by reflex. */
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    stopSearch();
    setAutoWidened(false);
    setAttachMode(false);
    setRecipientFor(null);
  }, [stopSearch]);

  /**
   * Open the search modal as the sale's attach picker (T23): no query
   * yet, so the modal renders its own copy of the search bar, wired to
   * the SAME query state and submitSearch, and the search fires on the
   * live debounce or Enter, never on the open.
   *
   * T87 picks the segment here, once: Class when the sign-in screen has
   * a class selected AND somebody is booked in it, since that is who is
   * standing at the counter and its roster is already in memory (zero
   * calls); All otherwise, because a Class cell that can only say
   * "Nobody is booked yet." is not where to land. Nothing moves the
   * segment after this but the teacher's own tap, or a query nobody in
   * class matches, on Enter or on the live debounce (T52).
   */
  /**
   * T90: the same opener, for one line's recipient. Everything about the
   * modal is openAttachSearch's; what changes is `recipientFor`, which
   * the row action and the title read.
   */
  const openRecipientSearch = useCallback(
    (lineKey: string, hasRecipient: boolean) => {
      setRecipientFor({ lineKey, clear: hasRecipient });
      openAttachSearchRef.current?.();
    },
    [],
  );

  const openAttachSearch = useCallback(() => {
    setAttachMode(true);
    /* T87 review: drop the previous search WHOLE, not just its rows. The
     * box is cleared here, so a live search still in the air (T81 leaves
     * the modal closed until its first page, so one can be) is for a
     * query nobody can see: unaborted, its answer lands as attach rows
     * under an empty box, and until then `searching` dims the Class rows
     * behind a "Searching Mindbody..." line on the one segment that
     * never calls Mindbody. It also leaves `searchPage.done` false, and
     * with it the paging sentinel, which would page the old query. */
    stopSearch();
    setSearchMsg(null);
    setSearchError(null);
    setQuery("");
    setSearchOpen(true);
    setAutoWidened(false);
    heldOnClass.current = null;
    setAttachTab(
      activeIdRef.current !== null && entries.length > 0 ? "class" : "all",
    );
  }, [entries.length, stopSearch]);
  /* openRecipientSearch is declared above it (it is passed down in the
     same block as the rest of the sale's props) and calls it through a
     ref so neither has to be declared twice. */
  const openAttachSearchRef = useRef<(() => void) | null>(null);
  openAttachSearchRef.current = openAttachSearch;

  /**
   * Tapping a segment cell (T87). To Class: whatever search was up is
   * dropped, the rows are the selected class's roster again and the box
   * filters them in memory. To All with a long-enough query already
   * typed: that search goes out at once, one call, so the teacher who
   * typed the name first and then widened the net is not made to wait
   * out the debounce again; with a short or empty query the hint shows
   * instead. The typed text survives either way.
   */
  const pickAttachTab = useCallback(
    (tab: AttachTab) => {
      /* A deliberate tap, either way, ends the auto-widened state (T52):
       * the line over the rows explains a move the teacher did not make,
       * not one they did. */
      setAutoWidened(false);
      setAttachTab(tab);
      heldOnClass.current = tab === "class" ? query.trim() : null;
      if (tab === "class") {
        stopSearch();
        setSearchMsg(null);
        return;
      }
      const q = query.trim();
      if (q.length >= settings.minQueryLength) startSearch(q);
      else if (q.length > 0) {
        setSearchMsg(
          `Type at least ${settings.minQueryLength} letters, then search.`,
        );
      }
    },
    [query, settings.minQueryLength, startSearch, stopSearch],
  );

  /** T71/T72: the line under the profile card's Opt-ins table when the
   *  last write did not plainly land (a suppression, a fallback to the
   *  studio account, a refusal). */
  const [optInMsg, setOptInMsg] = useState<{
    text: string;
    tone: "warn" | "stop";
  } | null>(null);
  /** T84: the card box over the profile, and the line under the profile's
   *  "Card on file" row when the last save did not plainly land. */
  const [cardOpen, setCardOpen] = useState(false);
  const [cardMsg, setCardMsg] = useState<{
    text: string;
    tone: "warn" | "stop";
  } | null>(null);
  /**
   * T72 (Pete: "every click holds everything up while the request is
   * made. can we make this update happen in the background? and
   * perhaps either with a delay or wait until the modal is closed to
   * update everything at once?"): the taps since the last write, for
   * the profile they were made on. `base` is what Mindbody held before
   * the first tap (the revert target), `flags` what the boxes show now.
   * Flushed as ONE /api/client-consent write carrying only the flags
   * that differ from the base, 2.5s after the last tap or when the
   * modal closes, whichever comes first. A ref, not state: the flush
   * runs from a timer and from closeProfile, and must see the latest
   * taps without a render in between.
   */
  const optInPending = useRef<{
    clientId: string;
    name: string;
    base: NonNullable<ClientProfile["consent"]>;
    flags: Partial<Record<OptInKind, boolean>>;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);

  /**
   * The client profile modal (T42): fetched at open, never at render,
   * since /api/client-profile is three metered reads. A stale answer
   * (closed, or reopened for someone else) is dropped by generation.
   */
  const openProfile = useCallback((clientId: string, name: string) => {
    const gen = ++profileGen.current;
    setProfileView({ clientId, name });
    setProfileState({ profile: null, loading: true, error: null });
    setOptInMsg(null);
    setCardMsg(null);
    setCardOpen(false);
    fetch(`/api/client-profile?clientId=${encodeURIComponent(clientId)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok || body?.error) {
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        return body as ClientProfile;
      })
      .then((profile) => {
        if (profileGen.current !== gen) return;
        setProfileState({ profile, loading: false, error: null });
      })
      .catch((e) => {
        if (profileGen.current !== gen) return;
        setProfileState({
          profile: null,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }, []);

  /** The banner line under the mode banner, 20s, for a word about a
   *  write whose dialog is already gone (T59b's new-client note, T72's
   *  opt-in outcome after the profile closed). */
  const flashBanner = useCallback((text: string) => {
    setActorBanner(text);
    if (actorBannerTimer.current) clearTimeout(actorBannerTimer.current);
    actorBannerTimer.current = setTimeout(() => setActorBanner(null), 20_000);
  }, []);

  /* T80: the PIN prompt's "PIN set" belongs in this banner, but it was
   * answered before the roster mounted. Shown once, then cleared
   * upstream so a later sign-in does not repeat it. */
  useEffect(() => {
    if (!initialFlash) return;
    flashBanner(initialFlash);
    onInitialFlashShown?.();
  }, [initialFlash, flashBanner, onInitialFlashShown]);

  /**
   * T72: send the pending opt-in taps as one write. Runs in the
   * background: the boxes already show the taps, and the answer only
   * matters when it is not a plain success. Suppressed (dry run, write
   * guard) or refused, the boxes go back to what Mindbody holds and the
   * reason shows under the table while that profile is still open, or
   * in the banner when it has closed. A fallback to the studio account
   * keeps the taps and says so the same way. A dead teacher token drops
   * the teacher (the gate returns) and reverts, since nothing was
   * written. Nothing here reads profileGen: a write for a closed
   * profile still has to answer somewhere.
   */
  const flushOptIn = useCallback(async () => {
    const pending = optInPending.current;
    if (!pending) return;
    optInPending.current = null;
    if (pending.timer) clearTimeout(pending.timer);
    const { clientId, name, base, flags } = pending;
    const body: Record<string, string | boolean> = { clientId };
    const reverted: Partial<NonNullable<ClientProfile["consent"]>> = {};
    for (const kind of Object.keys(flags) as OptInKind[]) {
      const value = flags[kind];
      const held =
        kind === "account"
          ? base.accountEmails
          : kind === "schedule"
            ? base.scheduleEmails
            : base.promotionalEmails;
      if (value === undefined || value === held) continue;
      body[OPT_IN_EMAIL_FLAG[kind]] = value;
      if (kind === "account") reverted.accountEmails = held;
      else if (kind === "schedule") reverted.scheduleEmails = held;
      else reverted.promotionalEmails = held;
    }
    /* Tapped back to where it started: nothing to send. */
    if (Object.keys(body).length === 1) return;
    /* What to show, and where: under the table if that profile is
     * still the open one, else the banner with the name. */
    const say = (text: string, tone: "warn" | "stop") => {
      if (profileViewRef.current?.clientId === clientId) {
        setOptInMsg({ text, tone });
      } else {
        flashBanner(`Opt-ins for ${name}: ${text}`);
      }
    };
    const revert = () =>
      setProfileState((st) =>
        st.profile && st.profile.clientId === clientId && st.profile.consent
          ? {
              ...st,
              profile: {
                ...st.profile,
                consent: { ...st.profile.consent, ...reverted },
              },
            }
          : st,
      );
    try {
      const res = await fetch("/api/client-consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = await res.json().catch(() => null);
      if (answer?.staffSessionEnded === true || answer?.reason === "staff") {
        setTeacher(null);
        revert();
        return;
      }
      if (!res.ok || answer?.ok !== true) {
        throw new Error(answer?.error ?? `HTTP ${res.status}`);
      }
      const fallback = noteActor(answer, clientId);
      if (answer.suppressed) {
        revert();
        say(
          answer.suppressed === "dry-run"
            ? "Dry run: not saved, nothing was written."
            : "Write guard: this client is not in POS_WRITE_CLIENT_IDS.",
          "warn",
        );
        return;
      }
      if (fallback) say(fallback, "warn");
    } catch (err) {
      revert();
      say(
        `Could not save: ${err instanceof Error ? err.message : String(err)}`,
        "stop",
      );
    }
  }, [noteActor, flashBanner]);

  const closeProfile = useCallback(() => {
    profileGen.current += 1;
    setProfileView(null);
    setOptInMsg(null);
    setCardMsg(null);
    setCardOpen(false);
    /* T72: the taps go out now rather than after the idle delay. */
    void flushOptIn();
  }, [flushOptIn]);

  /**
   * T72: an email opt-in box tapped on the profile card. The box flips
   * at once (the profile's consent is patched locally) and the tap
   * joins the pending write, which goes out after 2.5s without another
   * tap or when the modal closes. The base is captured on the first
   * tap for this profile so a later revert lands on what Mindbody held,
   * not on an earlier tap. A tap on a different profile than the
   * pending one flushes the old taps first.
   */
  const saveOptIn = useCallback(
    (kind: OptInKind, value: boolean) => {
      const view = profileView;
      const consent = profileState.profile?.consent;
      if (!view || !consent || profileState.profile?.clientId !== view.clientId) {
        return;
      }
      setOptInMsg(null);
      const patch =
        kind === "account"
          ? { accountEmails: value }
          : kind === "schedule"
            ? { scheduleEmails: value }
            : { promotionalEmails: value };
      setProfileState((st) =>
        st.profile && st.profile.clientId === view.clientId && st.profile.consent
          ? {
              ...st,
              profile: {
                ...st.profile,
                consent: { ...st.profile.consent, ...patch },
              },
            }
          : st,
      );
      const pending = optInPending.current;
      if (pending && pending.clientId !== view.clientId) {
        void flushOptIn();
      }
      const current =
        optInPending.current?.clientId === view.clientId
          ? optInPending.current
          : { clientId: view.clientId, name: view.name, base: consent, flags: {}, timer: null };
      if (current.timer) clearTimeout(current.timer);
      current.flags[kind] = value;
      current.timer = setTimeout(() => void flushOptIn(), 2500);
      optInPending.current = current;
    },
    [profileView, profileState.profile, flushOptIn],
  );

  /**
   * T84: the card Mindbody holds after a save. The profile's card line is
   * patched in place from the answer -- which is a read-back, not an echo
   * of the form -- so the row shows what is on file without a second
   * /api/client-profile (three metered reads). Everywhere else that needs
   * the card reads it live when it opens: the pay dialog and the sale
   * screen both fetch /api/stored-card on attach, so the next tender sees
   * this card without being told.
   */
  const cardSaved = useCallback((card: CardOnFile, note: string | null) => {
    setCardOpen(false);
    setCardMsg(note ? { text: note, tone: "warn" } : null);
    setProfileState((st) =>
      st.profile ? { ...st, profile: { ...st.profile, card } } : st,
    );
    if (note) flashBanner(note);
  }, [flashBanner]);

  /** Escape closes the profile modal. It stacks above the search modal,
   *  whose own Escape handler stands down while this is open. */
  useEffect(() => {
    if (!profileView) return;
    const onKey = (e: KeyboardEvent) => {
      /* T84: the card box handles its own Escape, in capture, and closes
       * only itself. */
      if (e.key === "Escape" && !cardOpen) closeProfile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profileView, closeProfile, cardOpen]);

  /** Escape closes the Membership modal (T52). It opens from a roster
   *  row only, so no other layer's handler needs to stand down for it. */
  useEffect(() => {
    if (!memberView) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMemberView(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [memberView]);

  /** The attach-mode row action: select the client for the sale and
   *  close. Writes nothing, books nothing, gates nothing -- buying a
   *  bottle of water needs no waiver. Takes just id/name/balance so the
   *  quick-pick's RosterEntry rows and the search results share it. */
  const attachSaleClient = useCallback(
    (client: { id: string; name: string; balance: number | null }) => {
      /* T90: in recipient mode a tap puts the LINE on that client, and
         who the sale is for does not move. */
      if (recipientFor !== null) {
        setRecipientPick((prev) => ({
          nonce: (prev?.nonce ?? 0) + 1,
          lineKey: recipientFor.lineKey,
          client: { id: client.id, name: client.name },
        }));
        closeSearch();
        return;
      }
      setSaleClient({
        id: client.id,
        name: client.name,
        balance: client.balance,
      });
      closeSearch();
    },
    [closeSearch, recipientFor],
  );
  /** T90: the clear row at the top of the recipient modal: the line comes
   *  back to whoever is paying. */
  const clearLineRecipient = useCallback(() => {
    if (recipientFor === null) return;
    setRecipientPick((prev) => ({
      nonce: (prev?.nonce ?? 0) + 1,
      lineKey: recipientFor.lineKey,
      client: null,
    }));
    closeSearch();
  }, [closeSearch, recipientFor]);

  /**
   * T85: every way into the sale goes through here. Anything anchored to
   * a roster row (a pass dropdown, the sort menu) would otherwise paint
   * above the overlay at a higher z-index, and the mode is set explicitly
   * because it is this component's state now: Buy opens the shelf, the
   * nav bar's Pay opens the payment step through `payTap`.
   */
  const openSale = useCallback((mode: "shelf" | "pay") => {
    setPickerFor(null);
    setSortMenuOpen(false);
    setSaleMode(mode);
    setSaleOpen(true);
  }, []);
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
      closeSearch();
      openSale("shelf");
    },
    [closeSearch, openSale],
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
  /**
   * T63 (Pete, live): re-read one client's pass list NOW, keeping what
   * is shown until the answer lands. Dropping the cache and leaving the
   * refetch to the background sweep lost the member's chevron after a
   * guest flow until a page refresh: the sweep only runs when the roster
   * changes, claims the client before fetching, and keeps a failed
   * fetch as a null claim for the session, so one failed read after
   * the flow left the row with no list and nothing to retry it. This
   * claims the sweep's ledger (so the two never spend a second call on
   * the same client), marks the list loading with its stale data still
   * in place (the chevron and the Guest action keep rendering from what
   * was known, and recompute when the fresh list lands), and on a
   * failure RELEASES the claim so the next sweep or picker open tries
   * again.
   */
  const refetchPassList = useCallback((clientId: string) => {
    passSweepCache.current.set(clientId, null);
    setPassLists((l) => ({
      ...l,
      [clientId]: { data: l[clientId]?.data ?? null, error: null, loading: true },
    }));
    fetch(`/api/passes?clientId=${encodeURIComponent(clientId)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        const passes = (body?.passes ?? []) as PassInfo[];
        passSweepCache.current.set(clientId, passes);
        setPassLists((l) => ({
          ...l,
          [clientId]: { data: passes, error: null, loading: false },
        }));
      })
      .catch((err) => {
        passSweepCache.current.delete(clientId);
        setPassLists((l) => ({
          ...l,
          [clientId]: {
            data: l[clientId]?.data ?? null,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          },
        }));
      });
  }, []);

  const refreshClientState = useCallback(
    (cid: string) => {
      /* T63: the list is re-read right away, not merely dropped (see
       * refetchPassList); the roster refresh rides alongside. */
      refetchPassList(cid);
      if (activeId !== null) void refreshRoster(activeId);
    },
    [activeId, refreshRoster, refetchPassList],
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
        !infoView &&
        !profileView &&
        !newClient
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
    waiverPrompt,
    infoView,
    profileView,
    walkinPicker,
    newClient,
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
      setActorNotes((n) => {
        const { [entry.clientId]: _drop, ...rest } = n;
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
        noteActor(body, entry.clientId);
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
    [settings.optimisticCheckIn, noteActor],
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
    const best = [...passes].sort(payOptionOrder)[0];
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
      /* T46: a class on a later day. Booking is open, check-in is not:
       * a sign-in recorded days early is attendance nobody took. The
       * chip is disabled too; this is the refusal behind it, so no
       * path (a keyboard, a stale render) reaches the API. */
      if (isFutureDay(activeStartsAtRef.current)) return;
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
       * the renewal offer, which never blocks or undoes anything. Since
       * 2026-09-14 passRemaining counts BEFORE this visit (roster.ts
       * beforeThisVisit), so 1 means this class is the last one on the
       * pass: the renewal conversation that happens now or never. */
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
   *
   * T58: the draft goes up as the teacher saw it, tags stripped, with
   * the raw text the edit started from as `previous`; the SERVER signs
   * whatever is new or changed with the session's name and answers
   * with the raw text it wrote, and that is what the local state takes.
   */
  const saveInfoField = useCallback(async () => {
    if (!infoView || !infoEditing || infoSaving) return;
    const { clientId } = infoView;
    const field = infoEditing;
    const previous =
      field === "Notes"
        ? infoView.notes
        : field === "RedAlert"
          ? infoView.redAlert
          : infoView.yellowAlert;
    setInfoSaving(true);
    setInfoMsg(null);
    try {
      const res = await fetch("/api/client-field", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId,
          field,
          value: infoDraft,
          previous: previous ?? "",
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      noteActor(body);
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
       * matches what a reload would show. The text is the server's
       * signed one (T58), never the unsigned draft. */
      const written =
        typeof body.value === "string" ? body.value : infoDraft;
      const trimmed = written.trim() || null;
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
  const ensurePassList = useCallback(
    (clientId: string) => {
      const have = passLists[clientId];
      if (have?.data || have?.loading) return;
      setPassLists((l) => ({
        ...l,
        [clientId]: { data: null, error: null, loading: true },
      }));
      fetch(`/api/passes?clientId=${encodeURIComponent(clientId)}`)
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
          const passes = (body?.passes ?? []) as PassInfo[];
          /* Claim the sweep's ledger too, so a later sweep does not spend
           * a second call on a client this fetch already answered. */
          passSweepCache.current.set(clientId, passes);
          setPassLists((l) => ({
            ...l,
            [clientId]: {
              data: passes,
              error: null,
              loading: false,
            },
          }));
        })
        .catch((err) => {
          setPassLists((l) => ({
            ...l,
            [clientId]: {
              data: null,
              error: err instanceof Error ? err.message : String(err),
              loading: false,
            },
          }));
        });
    },
    [passLists],
  );

  const openPicker = useCallback(
    (entry: RosterEntry, row: Element | null) => {
      setPassMsg(null);
      /* T55: measured at open time, like the search modal's picker. The
       * estimate sizes the box against the viewport so a picker opened
       * near the bottom rises rather than running off screen; the real
       * height is capped inline by maxHeight. */
      const r = row?.getBoundingClientRect();
      if (r) {
        const capHeight = Math.min(window.innerHeight * 0.48, 420);
        const top = Math.min(
          r.bottom + 6,
          Math.max(window.innerHeight - capHeight - 8, 16),
        );
        setPickerPos({
          top,
          right: Math.max(window.innerWidth - r.right, 8),
          maxHeight: Math.min(window.innerHeight - top - 8, capHeight),
        });
      } else {
        setPickerPos(null);
      }
      setPickerFor(entry.clientId);
      ensurePassList(entry.clientId);
    },
    [ensurePassList],
  );

  /** T56: the Membership modal's own read, /api/membership. A success is
   *  cached for the session (the M's reasons do not change mid-class); a
   *  failure is not, so the modal's "Try again" and a reopen both refetch.
   *  `force` is that retry: it refetches even over a cached success. */
  const ensureMemberInfo = useCallback(
    (clientId: string, force = false) => {
      const have = memberInfo[clientId];
      if (have?.loading || (have?.data && !force)) return;
      setMemberInfo((m) => ({
        ...m,
        [clientId]: { data: null, error: null, loading: true },
      }));
      fetch(`/api/membership?clientId=${encodeURIComponent(clientId)}`)
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
          const contracts = (body?.contracts ?? []) as ContractInfo[];
          const passes = (body?.passes ?? []) as MembershipPass[];
          setMemberInfo((m) => ({
            ...m,
            [clientId]: {
              data: { contracts, passes },
              error: null,
              loading: false,
            },
          }));
        })
        .catch((err) => {
          setMemberInfo((m) => ({
            ...m,
            [clientId]: {
              data: null,
              error: err instanceof Error ? err.message : String(err),
              loading: false,
            },
          }));
        });
    },
    [memberInfo],
  );

  /** The M chip's tap (T52): the Membership modal. Since T56 it reads
   *  /api/membership (contracts and used-up passes included), not the
   *  picker's active-only pass cache. */
  const openMember = useCallback(
    (entry: RosterEntry) => {
      setPickerFor(null);
      setSortMenuOpen(false);
      setMemberView({
        clientId: entry.clientId,
        name: entry.name,
        member: entry.member === true,
      });
      ensureMemberInfo(entry.clientId);
    },
    [ensureMemberInfo],
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
  /** What the search modal lists: EVERY match, in both modes (T42).
   *  Booking mode used to hide people already on the roster, which read
   *  as "nobody found" for the very person standing there; now they
   *  show with a "signed up" / "checked in" / "waitlist" chip and no add
   *  action. `walkIns` still scopes the pass sweep to the bookable ones. */
  const shownResults = found;
  /** The active class's standing for a search result (T42): who is on
   *  the roster and whether they are in, and who is queued, from the
   *  waitlist already loaded for a full class (never fetched for this). */
  const rosterStatus = useMemo(() => {
    const m = new Map<string, "checked in" | "signed up" | "waitlist">();
    for (const en of entries) {
      m.set(en.clientId, en.checkedIn ? "checked in" : "signed up");
    }
    for (const w of waitlist ?? []) {
      if (!m.has(w.clientId)) m.set(w.clientId, "waitlist");
    }
    return m;
  }, [entries, waitlist]);

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
    /* T42: the attach rows carry no pass cell any more (Pete: "don't need
     * all the info here"), so a sale's search sweeps nothing. */
    if (attachMode) return;
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
  }, [walkIns, attachMode]);

  const activeClass = classes.find((c) => c.classId === activeId) ?? null;
  activeStartsAtRef.current = activeClass?.startsAt ?? "";
  /** T46: the selected class sits on a day after the studio's current
   *  one. Check-in closes (chip disabled, tapCheckIn refuses); booking,
   *  waitlist moves and cancellations stay open. A class later TODAY is
   *  not future in this sense and behaves exactly as before. */
  const futureClass = activeClass !== null && isFutureDay(activeClass.startsAt);
  /** Today's studio date, once per render, for the calendar and the
   *  past/future banner. */
  const todayKey = studioToday();
  /** The selected class sits on a day BEFORE the studio's current one.
   *  Read from the class, like futureClass, never from viewDate: while a
   *  picked day is still loading the roster on screen is the old
   *  class's, and captioning today's roster "Editing a past class" is
   *  the wrong banner over the right rows. */
  const pastClass =
    activeClass !== null && activeClass.startsAt.slice(0, 10) < todayKey;
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
        noteActor(body);
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
        noteActor(body);
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
        : subject.source === "walkin" || subject.source === "guest"
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
      noteActor(body);
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
      } else if (subject.source === "guest") {
        /* T59c: back to the guest modal, at its confirm sheet, with the
         * agreement on the person. Nothing has been written yet. */
        setGuestPick({
          person: { ...subject.client, waiverSigned: true, notes: newNotes },
          standing: subject.standing,
        });
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
        : waiverPrompt.source === "walkin" || waiverPrompt.source === "guest"
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
      /* T63 (Pete, live, a future day): the member's OWN visit is never
       * put on a guest pass from here, on any day, however the line was
       * rendered. The picker routes a guest pass to the guest modal
       * (T59c), and this is the invariant behind it: a pass list whose
       * guest pass came back without a Remaining count rendered as an
       * ordinary line and one tap burned it on the member (T57's
       * accident by another door). Judged by name, the one mark a guest
       * pass carries. */
      const target = passLists[entry.clientId]?.data?.find((p) => p.id === clientServiceId);
      if (target && isGuestPass(target.name)) {
        setPassMsg(
          `A guest pass checks in a guest, not ${entry.name.split(" ")[0]}. Nothing was changed.`,
        );
        return;
      }
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
        noteActor(body, entry.clientId);
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
    [passSavingId, refreshRoster, noteActor, passLists],
  );

  /**
   * T59c: the guest flow's page-side handlers. Opening captures the
   * member's row and the guest pass as the picker showed them; the pick
   * runs the waiver gate FIRST, exactly as the walk-in add does (T19):
   * a guest with no released waiver meets the T18 dialog over the
   * modal, and only a recorded agreement selects them. The answer
   * handler notes a fallback or an ended sign-in like every write, and
   * refreshes the rows a REAL write changed: the member's pass cache is
   * dropped so the chevron and the Guest action recompute against
   * Mindbody's list (the pass at zero leaves it, T57), and the guest's
   * too so their row's own picker still offers their passes for a
   * reversal.
   */
  const openGuestFlow = useCallback(
    (member: RosterEntry, pass: PassInfo & { id: number }) => {
      setPickerFor(null);
      setPassMsg(null);
      setGuestPick(null);
      setGuestFlow({ member, pass });
    },
    [],
  );

  const closeGuestFlow = useCallback(() => {
    setGuestFlow(null);
    setGuestPick(null);
  }, []);

  const pickGuest = useCallback((pick: GuestPick) => {
    if (pick.person.waiverSigned === false) {
      setWaiverPrompt({
        source: "guest",
        client: pick.person,
        standing: pick.standing,
      });
      return;
    }
    setGuestPick(pick);
  }, []);

  const onGuestAnswer = useCallback(
    (
      answer: {
        steps?: { sale?: unknown; guest: unknown; member: unknown };
        staffSessionEnded?: boolean;
        reason?: string;
        ignored?: boolean;
      },
      pick: GuestPick,
      landed: boolean,
    ) => {
      const flow = guestFlow;
      noteActor(answer);
      if (answer.reason === "staff") {
        /* The sign-in ended under the write: the gate is coming back
         * and the modal has nothing left to say. */
        setTeacher(null);
        closeGuestFlow();
        return;
      }
      if (flow === null) return;
      if (landed) {
        setGuestBy((g) => ({ ...g, [pick.person.id]: flow.member.name }));
      }
      const memberDone = answer.steps?.member === "done";
      /* T62: an ignored pass id still made (or changed) the guest's
       * visit, on their own pass: their row and their pass list are
       * stale, and the member's pass is whatever Mindbody says now. */
      /* T63: any answer past the sale may have changed both accounts
       * (the guest's new $0 pass, the member's returned one), so both
       * lists are re-read, not just dropped (refetchPassList). */
      const saleDone = answer.steps?.sale === "done";
      if (landed || memberDone || saleDone || answer.ignored === true) {
        refreshClientState(flow.member.clientId);
        refetchPassList(pick.person.id);
      }
    },
    [guestFlow, noteActor, closeGuestFlow, refreshClientState, refetchPassList],
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
    /* T69 (Pete: "do not show Guest Pass in the dropdown ... The guest
     * icon is a much cleaner implementation"): a guest pass is never a
     * line here. It checks a guest in, not the member, and the
     * person-plus on the row is its one way in; `changePass` still
     * refuses one by name should any reach it. */
    const others = (passes ?? []).filter(
      (p): p is PassInfo & { id: number } =>
        p.id !== null &&
        p.id !== entry.clientServiceId &&
        !isGuestPass(p.name),
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
          className={pickerPos ? "pass-dd dd-fixed" : "pass-dd"}
          style={
            pickerPos
              ? {
                  top: pickerPos.top,
                  right: pickerPos.right,
                  maxHeight: pickerPos.maxHeight,
                }
              : undefined
          }
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
   * the total, credit IS the method here; otherwise a live card on
   * file. No cash here: this dialog is one primary action, and a cash
   * sale has a whole screen. T82 retired rule 1, so the server no
   * longer refuses a card that credit could have covered (the store's
   * pay screen offers the choice Pete asked for). This dialog's
   * preference for credit is now ITS OWN, not the server's: it has no
   * tender chooser to offer, and spending a balance before a card is
   * the right default for a one-tap sale. */
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
                  ? " Sell the pack in Buy, on account balance."
                  : " Sell the pass in Buy, on account balance, then attach " +
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
         * that names the live balance (a credit line over it, or since
         * T82 an under-$10 card sale on an account that already holds
         * credit) refreshes the method gate, T24's freshBalance move, so
         * the retry runs on credit instead of failing identically. */
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
        noteActor(aBody, entry.clientId);
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
        noteActor(cBody, entry.clientId);
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

  /* ------------------------------------------------------------------
   * T88: buy and check in. There is nothing to charge with -- no card
   * on file, or an expired one, and no covering credit -- so instead of
   * telling the teacher to go and use Buy, this takes her there with the
   * pass she already chose on the ticket and the check-in remembered.
   * The sale is then the ORDINARY sale (cash, a typed card, account,
   * a discount): nothing here is a second payment path.
   * ---------------------------------------------------------------- */

  /** Is the no-tender state the one this offer is for? Only a settled
   *  answer counts: while the card read is in flight, or after it
   *  failed, what the client has is unknown, and the offer would be a
   *  guess. */
  const payNoTender =
    payDialog !== null &&
    payDialog.flavor === "unpaid" &&
    payMethod === null &&
    payProfile !== null &&
    !payProfile.loading &&
    payProfile.error === null &&
    (payCard === null || payCard.expired);
  const payBuyOffer =
    payNoTender &&
    /* T88 review: and a SETTLED price. Until the pricing loop answers,
     * credit that covers the total still reads as no tender, and the
     * offer would send a teacher to buy for cash what the balance on
     * the account would have paid. A suppressed or refused price has
     * settled, and still earns the offer. */
    !payPricing &&
    payStage === null &&
    !payMoneyMoved &&
    paySelected !== null &&
    payDialog !== null &&
    payDialog.entry.visitId !== null;

  /** The tap: close the dialog, attach the row's client to the Buy
   *  screen, and remember the check-in the sale is for. Writes nothing;
   *  the sale the teacher runs next is what moves money. */
  const buyAndCheckIn = () => {
    if (payFlight.current || !payBuyOffer) return;
    if (!payDialog || !paySelected) return;
    const { entry, classId } = payDialog;
    if (entry.visitId === null) return;
    const cls = classes.find((c) => c.classId === classId) ?? null;
    const nonce = ++pendingNonce.current;
    const pending = {
      nonce,
      visitId: entry.visitId,
      classId,
      clientId: entry.clientId,
      clientName: entry.name,
      itemType: paySelected.type,
      itemId: paySelected.id,
      productId: paySelected.productId,
      note: cls
        ? `Then check ${entry.name} in to ${cls.name} at ${clockTime(cls.startsAt)}.`
        : `Then check ${entry.name} in to this class.`,
    };
    pendingRef.current = pending;
    setPendingCheckIn(pending);
    setPendingResult(null);
    /* Closed inline, as the finished gesture is: closePayDialog reads
     * payStage from a stale closure. */
    payGen.current += 1;
    payPriceGen.current += 1;
    setPayDialog(null);
    setPayOutcome(null);
    setPayPriced(null);
    setPayPriceError(null);
    setPayPricing(false);
    setPaySelectedId(null);
    setPayProfile(null);
    setSaleClient({
      id: entry.clientId,
      name: entry.name,
      balance: entry.balance,
    });
    openSale("shelf");
  };

  /** The pending check-in cannot happen any more: the ticket no longer
   *  holds that pass, the attached client changed, or the teacher left
   *  the sale without selling it. One quiet line, and nobody is checked
   *  in. */
  const dropPendingCheckIn = (reason: "cart" | "client" | "left") => {
    const pending = pendingRef.current;
    if (!pending || pendingFlight.current) return;
    pendingRef.current = null;
    setPendingCheckIn(null);
    setPendingResult(null);
    flashBanner(
      reason === "left"
        ? /* T88 review: what is certain here is that nobody was checked
             in, not that nothing was sold: a sale that failed part way
             through (T90's partial) can leave the pass bought. */
          `Not checked in: ${pending.clientName} stays unpaid. If the pass was sold, attach it with the payment chevron.`
        : "Not checked in: the sale was changed.",
    );
  };

  /**
   * The sale settled. If it sold the remembered pass to the remembered
   * client, this is T25's stages (b) and (c) exactly -- find the new
   * purchase instance, assign it to the visit, sign in -- through the
   * same routes the card path uses, pessimistic and never retried. A
   * sale for somebody else, or one that no longer carried the pass,
   * checks nobody in and says so.
   */
  const finishPendingCheckIn = async (sales: readonly SoldSale[]) => {
    const pending = pendingRef.current;
    if (pendingFlight.current) return;
    if (!pending) {
      /* T88 review: nothing was waiting on this sale, so the LAST
       * check-in's outcome must not ride along on its done screen. */
      setPendingResult(null);
      return;
    }
    const sold = sales.find(
      (sale) =>
        sale.clientId === pending.clientId &&
        sale.productIds.some((id) => String(id) === String(pending.itemId)),
    );
    if (!sold) {
      pendingRef.current = null;
      setPendingCheckIn(null);
      const line = `Not checked in: this sale did not sell the pass to ${pending.clientName}.`;
      setPendingResult({ ok: false, text: line });
      flashBanner(line);
      return;
    }
    pendingFlight.current = true;
    pendingRef.current = null;
    setPendingCheckIn(null);
    setPendingResult({ ok: true, text: `Checking ${pending.clientName} in...` });
    try {
      /* Stage (b): the purchase instance. The pass list carries no
       * PaymentDate, so the instance is T25's rule -- the NEWEST id
       * carrying the option's ProductId -- which is the same "what was
       * not there before" answer and the one already proven here. */
      try {
        const pr = await fetch(
          `/api/passes?clientId=${encodeURIComponent(pending.clientId)}`,
        );
        const pBody = await pr.json();
        if (!pr.ok) throw new Error(pBody?.error ?? `HTTP ${pr.status}`);
        const fresh: PassInfo[] = pBody?.passes ?? [];
        /* The chevron's caches first, so the by-hand finish works
         * whatever happens below. */
        passSweepCache.current.set(pending.clientId, fresh);
        setPassLists((l) => ({
          ...l,
          [pending.clientId]: { data: fresh, error: null, loading: false },
        }));
        if (pending.productId === null) {
          throw new Error(
            "this pricing option carries no ProductId, so the new " +
              "purchase could not be identified",
          );
        }
        const instance = fresh
          .filter(
            (x): x is PassInfo & { id: number } =>
              x.id !== null && x.productId === pending.productId,
          )
          .reduce<(PassInfo & { id: number }) | null>(
            (newest, x) => (newest === null || x.id > newest.id ? x : newest),
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
            visitId: pending.visitId,
            clientServiceId: instance.id,
            clientId: pending.clientId,
          }),
        });
        const aBody = await ar.json();
        if (!ar.ok) throw new Error(aBody?.error ?? `HTTP ${ar.status}`);
        noteActor(aBody, pending.clientId);
        if (aBody?.suppressed) {
          throw new Error(
            `the write was suppressed (${aBody.suppressed}) after the sale went through`,
          );
        }
      } catch (err) {
        const line =
          `Paid, but the check-in failed: the pass was not attached to ` +
          `this visit; it stays on ${pending.clientName}'s account, and ` +
          `the row stays unpaid. Attach it with the payment chevron, ` +
          `then check in. (${err instanceof Error ? err.message : String(err)})`;
        setPendingResult({ ok: false, text: line });
        flashBanner(line);
        await refreshRoster(pending.classId);
        return;
      }
      /* Stage (c): the sign-in, the same write the chip makes. */
      try {
        const cr = await fetch("/api/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            visitId: pending.visitId,
            signedIn: true,
            clientId: pending.clientId,
          }),
        });
        const cBody = await cr.json();
        if (!cr.ok) throw new Error(cBody?.error ?? `HTTP ${cr.status}`);
        noteActor(cBody, pending.clientId);
      } catch (err) {
        const line =
          `Paid, but the check-in failed: the pass is on the visit and ` +
          `the check-in tap will finish it. (${
            err instanceof Error ? err.message : String(err)
          })`;
        setPendingResult({ ok: false, text: line });
        flashBanner(line);
        await refreshRoster(pending.classId);
        return;
      }
      setPendingResult({
        ok: true,
        text: `${pending.clientName} is paid and checked in.`,
      });
      await refreshRoster(pending.classId);
    } finally {
      pendingFlight.current = false;
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

  /**
   * One attach-mode row (T32, reshaped in T42). The WHOLE row is the tap
   * target (Pete: "tapping on the row at all should select the client";
   * the person-check button is gone): nothing here books, charges or
   * checks anyone in, so there is no waiver gate, no pass cell, no info
   * icon and no M -- "don't need all the info here". A class row shows
   * only what the class says, its standing chip; a search row shows the
   * email and phone line instead, since duplicate names are real. The
   * chip sits in its own grid column so the chips line up down the list.
   */
  const attachRowItem = ({ client, status }: AttachRow) => {
    /* Search rows carry the contact line whether or not they also
     * happen to be on the picked roster; class rows never do. */
    const contact = attachTab === "class" ? "" : contactLine(client);
    return (
      <li key={`attach-${client.id}`}>
        <div
          className="rrow rrow-tap"
          role="button"
          tabIndex={0}
          /* T90 review: in recipient mode the row does not attach
             anybody to the sale, so it must not say it does. */
          aria-label={
            recipientFor !== null
              ? `Buy this for ${client.name}`
              : `Attach ${client.name}`
          }
          onClick={() => attachSaleClient(client)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              attachSaleClient(client);
            }
          }}
        >
          <div className="cell-name">
            <span className="name-text">
              <Hit
                text={client.name}
                q={attachTab === "class" ? "" : foundFor}
              />
            </span>
            {contact ? (
              <span className="contact-line">
                <Hit text={contact} q={foundFor} />
              </span>
            ) : null}
          </div>
          {/* Their standing in the picked class, and TEXT rather than
              a control: attaching a sale moves no attendance. */}
          <span className="cell-chip">
            {status !== null ? (
              <span
                className={status === "checked in" ? "mini-in" : "mini-signed"}
              >
                {status}
              </span>
            ) : null}
          </span>
          {/* T52 (Pete: "the search results should have the profile
              icon/button so a user can verify more info if needed"):
              the roster's profile icon, on every attach row, class or
              search. Opens the profile only; the stopPropagation keeps
              it off the row's attach tap. */}
          <div className="cell-actions">
            <button
              className="row-icon"
              onClick={(e) => {
                e.stopPropagation();
                openProfile(client.id, client.name);
              }}
              aria-label={`Profile for ${client.name}`}
              title="Client profile"
            >
              <PersonIcon />
            </button>
          </div>
        </div>
      </li>
    );
  };

  /* T46: the calendar control beside the class dropdown, LEFT of it since
     T81. A 76px cell in the header's own idiom, the glyph alone on every
     day (T61; the date was text beside it from T46). Rendered from a const so the
     header without a class (a picked day with nothing on it) can still
     carry it: the button that got a teacher onto another day must never
     vanish with that day's empty schedule. */
  /* T60: the roster list, for the header tap that scrolls it to the top.
     Smooth so the teacher sees the list travel rather than jump, unless
     the device asks for reduced motion (T60 review: WebKit drops the
     animation on its own for that setting, Chromium does not). */
  const rosterRef = useRef<HTMLUListElement>(null);
  const scrollRosterToTop = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rosterRef.current?.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  /* T61 (Pete: "there is no reason for Fri Sep 4 to be shown next to
     the calendar icon"): the glyph alone on every day. The accent
     outline is the signal that another day is showing; the date itself
     lives in the label and tooltip, and the roster's banner says what
     that day allows. */
  const calendarLabel = viewDate
    ? `${viewLoading ? "Loading" : "Viewing"} ${dayKeyLabel(viewDate)}. Change day`
    : "Change day";
  const calendarButton = (
    <button
      className={viewDate ? "cal-btn viewing" : "cal-btn"}
      aria-haspopup="dialog"
      aria-expanded={calOpen}
      aria-label={calendarLabel}
      title={calendarLabel}
      onClick={() => {
        setClassPickerOpen(false);
        setSortMenuOpen(false);
        setPickerFor(null);
        /* Open on the month of the day being viewed, else this month. */
        const k = viewDate ?? todayKey;
        setCalMonth({ y: Number(k.slice(0, 4)), m: Number(k.slice(5, 7)) });
        setCalOpen(true);
      }}
    >
      <CalendarIcon />
    </button>
  );

  /**
   * T85: the nav bar's items. Which screen is showing is the only thing
   * that decides what is lit; what an item does is the same function the
   * screen's own control called, so the bar can never mean something
   * different from the screen.
   *
   * Mid-charge, the two items that would leave the payment step are off
   * with the reason, and Pay stays lit and inert: money is moving and the
   * outcome renders on the surface it is on (the guard the sale header's
   * Back and the bar's Back to items both had).
   */
  const onPay = saleOpen && saleMode === "pay";
  const leaveWhy = saleNav.charging ? "Charging..." : null;
  const navItems: NavItem[] = [
    {
      key: "signin",
      label: "Sign-in",
      icon: <SignInIcon />,
      on: !saleOpen,
      why: leaveWhy,
      onTap: () => {
        /* The cart and its client survive, exactly as the Back this
         * replaces left them: closing the overlay renders nothing, it
         * does not unmount the sale. T88: a check-in waiting on a sale
         * that has not happened is dropped here, with its line. */
        dropPendingCheckIn("left");
        setSaleMode("shelf");
        setSaleOpen(false);
      },
    },
    {
      key: "buy",
      label: "Buy",
      icon: <BuyIcon />,
      on: saleOpen && saleMode === "shelf",
      why: leaveWhy,
      onTap: () => openSale("shelf"),
    },
    {
      key: "pay",
      label: "Pay",
      icon: <PayIcon />,
      on: onPay,
      /* The shelf Pay's own reason, so the two say the same thing; the
       * tap is the shelf Pay's own handler, so T51's walk-in dialog and
       * T53's opt-in ask here too. Opening the overlay in the same tick
       * is what lets either dialog render. */
      why: saleNav.payWhy,
      onTap: () => {
        setSaleOpen(true);
        saleNav.payTap();
      },
    },
  ];
  /* Settings (the dev drawer) only when /api/devlog answered: on the
   * counter iPad the bar is four items, and the drawer is not reachable
   * at all. It sits before Profile (Pete: "swap position of Dev and
   * Profile"). */
  if (devAvailable) {
    navItems.push({
      key: "dev",
      label: "Settings",
      icon: <SettingsIcon />,
      on: devOpen,
      why: null,
      onTap: () => setDevOpen((o) => !o),
    });
  }
  /* Profile is labelled with the signed-in teacher's own name (Pete:
   * "Change Profile to say the currently logged in teacher's name"). */
  navItems.push({
    key: "profile",
    label: teacher.name,
    icon: <ProfileIcon />,
    on: staffOpen,
    why: null,
    onTap: () => {
      setPickerFor(null);
      setSortMenuOpen(false);
      setStaffOpen(true);
    },
  });

  return (
    <main className="shell">
      {config?.configError ? <p className="note">{config.configError}</p> : null}

      {/* The mode banner is shared with the sale overlay (T23): ONE
          component, one wording, so "is this live" reads the same on
          every screen. */}
      <ModeBanner config={config} />
      {actorBanner ? (
        <p className="pass-note actor-banner" role="status">
          {actorBanner}
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

      {viewError ? <p className="note">{viewError}</p> : null}

      {/* No classes in the window (an empty around-now window at 3am, or
          a picked day with nothing on it): the line takes the class's
          slot in a header row that still carries the calendar button, or
          there would be no way onto another day, or back from one, but a
          reload. */}
      {classes.length === 0 && !error ? (
        <header className="class-header">
          {calendarButton}
          <p className="muted class-none">
            {viewDate && !viewLoading
              ? viewError
                ? `Could not load ${dayKeyLabel(viewDate)}.`
                : `No classes on ${dayKeyLabel(viewDate)}.`
              : "No classes in the next few hours."}
          </p>
        </header>
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
          {/* T70: the mockup's top bar (Roster.dc.html): one 76px row of
              cells split by hairlines. The class picker fills, then the
              day control, the three counters, Buy, the sun (light/dark)
              and the account icon. */}
          {/* The class is its own dropdown (Pete, fourth live test), the
              Buy view's picker idiom: the current class IS the control,
              so the separate "Change class" button is gone. The list
              carries each class's booked count as a badge; the collapsed
              line does not, because the header's counters already say it
              for the class in front of you. */}
          {/* T52 (Pete): "the calendar icon should be butted up against
              the class selector". One group, the dropdown and the day
              control sharing an edge, like an input with an addon. T81
              (Pete): "the calendar icon should be to the left of the
              class selector", so the day control leads the group. */}
          <div className="class-group">
          {calendarButton}
          <div className="class-pick">
            <button
              className="class-pick-btn"
              aria-haspopup="dialog"
              aria-expanded={classPickerOpen}
              aria-label="Change class"
              onClick={() => setClassPickerOpen((o) => !o)}
            >
              <span className="class-current">
                <span className="class-when">
                  {dayDate(activeClass.startsAt)} ·{" "}
                  {clockTime(activeClass.startsAt)}
                </span>
                <span className="class-title">
                  {activeClass.name}
                  {activeClass.teacher ? `, ${activeClass.teacher}` : ""}
                </span>
              </span>
              <ChevronDownIcon size={22} />
            </button>
            {classPickerOpen ? (
              <>
                <div
                  className="pass-scrim"
                  role="presentation"
                  onClick={() => setClassPickerOpen(false)}
                />
                <div
                  className="pass-dd class-pick-dd"
                  role="dialog"
                  aria-label="Classes around now"
                >
                  {classes.length === 0 ? (
                    <p className="pass-empty">
                      No classes in the next few hours.
                    </p>
                  ) : (
                    classes.map((c) => {
                      const current = c.classId === activeId;
                      /* The around-now window can straddle midnight, so
                       * a class on another day than the one showing
                       * keeps its date under the time. */
                      const otherDay =
                        dayDate(c.startsAt) !== dayDate(activeClass.startsAt);
                      return (
                        <button
                          key={`pick-${c.classId}`}
                          className={
                            current ? "pass-opt class-opt current" : "pass-opt class-opt"
                          }
                          aria-pressed={current}
                          onClick={() => {
                            selectClass(c.classId);
                            setClassPickerOpen(false);
                          }}
                        >
                          <span className="class-opt-time">
                            {clockTime(c.startsAt)}
                            {otherDay ? (
                              <span className="class-opt-day">
                                {dayDate(c.startsAt)}
                              </span>
                            ) : null}
                          </span>
                          <span className="pass-opt-text">
                            <span className="pass-opt-name">{c.name}</span>
                            {c.teacher ? (
                              <span className="class-opt-teacher">
                                {c.teacher}
                              </span>
                            ) : null}
                          </span>
                          {/* The count badge: gold when anyone is
                              booked, the quiet pair at zero, so
                              "selected" (the filled row) and "busy"
                              can never be confused (2.4). */}
                          {c.booked !== null ? (
                            <span
                              className={
                                c.booked > 0
                                  ? "class-opt-count"
                                  : "class-opt-count zero"
                              }
                            >
                              {c.capacity !== null
                                ? `${c.booked}/${c.capacity}`
                                : `${c.booked}`}
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            ) : null}
          </div>
          </div>
          {/* T60 (Pete): "the position of signed up/checked in/waitlist
              and Buy/TeacherName/personicon should be swapped with each
              other". The counters sit against the class, and Buy and
              the account icon hold the far right. */}
          <div className="counters" aria-label="Counts for the selected class">
          {/* A plain stat, not a button: its list IS the roster below,
              and a modal copying the screen behind it earned nothing
              (Pete, 2026-08-29). Checked-in and waitlist keep their
              panels; the waitlist's is the only home its entries have. */}
          <div className="counter counter-stat">
            <span className="counter-label">signed up</span>
            <span className="counter-num">{entries.length}</span>
          </div>
          <button
            className="counter"
            onClick={() => setCounterModal("checkedIn")}
            aria-haspopup="dialog"
          >
            <span className="counter-label">checked in</span>
            <span className="counter-num ok">
              {entries.filter((e) => e.checkedIn).length}
            </span>
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
            <span className="counter-label">waitlist</span>
            <span className="counter-num">
              {waitlist !== null
                ? waitlist.length
                : classFull
                  ? waitlistError
                    ? "?"
                    : "..."
                  : 0}
            </span>
          </button>
          </div>
          {/* T85: the header's Buy button is gone. It was the accent cell
              here while the sale screen's way back was a "Back" in its own
              header, which is exactly the inconsistency Pete named; both
              are the nav bar's items now, in the same place on every
              screen. "Buy" also does not need saying on the Buy screen. */}
          {/* T70: light or dark, stored for this iPad; until a teacher
              taps it the screen follows the device's own setting. */}
          <button
            className="class-theme"
            aria-label="Switch between light and dark"
            title="Light / dark"
            onClick={() => toggleTheme()}
          >
            <SunIcon />
          </button>
          {/* T85: the account icon is the nav bar's Profile item now
              (Pete: "no reason the teacher profile icon shouldn't be
              available in all those"). It opened the same modal from one
              screen only; Profile opens it from all three. */}
        </header>
      ) : null}

      {/* The search bar (T16, live again in T81): typing runs the search
          after the debounce once the query is long enough, and Enter or
          the Search button runs it at once; the results open in their
          own modal, whose bar shares this query. */}
      <div className="search-bar">
        <div className="search-wrap">
          <input
            className="search"
            value={query}
            onChange={(e) => {
              liveSeeded.current = null;
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
            placeholder="Search for a walk-in"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={clearSearch}
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>
        <button
          className="search-go"
          onClick={submitSearch}
          aria-label="Search"
          title="Search"
        >
          <SearchIcon />
        </button>
        {/* T91 (Pete): "It can be accessed with a New Client button in the
            sign-in page, to the right of the magnifying glass." The same
            T59b form the "Nobody found" state opens, with the same
            prefill rule, so a teacher who already knows the person is new
            does not have to search for nobody first. On create the person
            lands as the walk-in result, which is what "search" does. */}
        <button
          className="search-new-client"
          onClick={() =>
            setNewClient({ ...namePrefill(query), for: "search" })
          }
          title="Register a new student in Mindbody"
        >
          <PersonPlusIcon />
          <span>New client</span>
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
        <div
          className="roster-head"
          /* T60 (Pete): "tapping on the Name/Payment/Balance header area
             should scroll the student list to the very top". Since T55
             the list is the scroll container and this row stays put
             above it, so it is the natural "back to the top" target for
             a teacher thirty rows down. The sort control, its scrim and
             its menu keep their own taps (T60 review: only those, not
             the whole actions column, which is 328px of head above the
             check-in chips and scrolls like the rest). */
          role="button"
          tabIndex={0}
          aria-label="Scroll to the top of the list"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button, .pass-scrim, .sort-dd")) return;
            scrollRosterToTop();
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              scrollRosterToTop();
            }
          }}
        >
          <span aria-hidden="true">Name</span>
          {/* T71: the badge column, no label. */}
          <span aria-hidden="true" />
          <span aria-hidden="true">Payment</span>
          <span className="cell-bal" aria-hidden="true">
            Account
          </span>
          {/* The chip column: no label needed. */}
          <span aria-hidden="true" />
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

      {/* T61 review: while a picked day is on the wire the previous
          class and its rows stay on screen (T46 review R5/R6) and the
          day control is already outlined for the new day, so this quiet
          line is the one thing saying the tap took. It carries the
          "Loading Fri Sep 4..." wording the header's Viewing line had
          until T61, in the roster's banner slot rather than the header
          Pete cleared. */}
      {viewDate && viewLoading ? (
        <p className="muted day-loading" role="status">
          Loading {dayKeyLabel(viewDate)}...
        </p>
      ) : null}

      {/* T46: the day banner. Warn pair, 16px, above the list: a past
          day's edits are real (T46), a future day's
          check-in is closed. The mode banner at the top is untouched. */}
      {activeClass && (pastClass || futureClass) ? (
        <p className="day-banner" role="status">
          {futureClass
            ? "A future class. Booking only; check-in opens on the day."
            : "Editing a past class. Every change is recorded with your name."}
        </p>
      ) : null}

      <ul
        className="roster"
        ref={rosterRef}
        /* T55: the list is the scroll container. The picker is
           position: fixed, so scrolling would slide its row out from
           under it; close it instead (unless a save is in flight, when
           the dropdown is showing the outcome). */
        onScroll={
          pickerFor !== null && passSavingId === null
            ? () => setPickerFor(null)
            : undefined
        }
      >
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
            : (failed[entry.clientId] ?? actorNotes[entry.clientId] ?? null);
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
            <>
              <CheckIcon size={17} /> checked in
            </>
          ) : working ? (
            <>
              <span className="spinner" aria-label="working" /> checking in
            </>
          ) : failed[entry.clientId] ? (
            "failed"
          ) : noWaiver ? (
            "no waiver"
          ) : entry.paid ? (
            "check in"
          ) : (
            "unpaid"
          );

          /* T59c review: the Guest action's presence changes the payment
           * cell's shape (see .cell-pay.has-guest), so it is decided
           * once, here, for the cell's class and the button both. */
          const guestPass = futureClass
            ? null
            : usableGuestPass(passLists[entry.clientId]?.data ?? null);

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
                          : !working && actorNotes[entry.clientId]
                            ? "subline actor-note"
                            : "subline"
                      }
                    >
                      {statusMsg}
                    </span>
                  ) : history ? (
                    <span className="subline">{history}</span>
                  ) : null}
                </div>
                {/* T71: the M badge and the info icon in a fixed column
                    of their own between the name and the payment (Pete:
                    "lined up in the same column rather than just to the
                    right of the names"); T70 had them trailing the name.
                    Two slots in a set order, the M slot empty on a
                    non-member row so the info icons line up too. */}
                <span className="cell-icons">
                  {/* T52: the M is a button (Pete: "clicking on an 'M'
                      icon should show more info about their
                      membership"), opening the Membership modal. */}
                  {entry.member ? (
                    <button
                      className="m-chip-btn"
                      title="Member (Mindbody's membership flag). Tap for details."
                      aria-label={`Member (Mindbody's membership flag). Tap for details about ${entry.name}.`}
                      aria-haspopup="dialog"
                      onClick={(e) => {
                        e.stopPropagation();
                        openMember(entry);
                      }}
                    >
                      <span className="m-chip">M</span>
                    </button>
                  ) : (
                    <span className="m-slot" aria-hidden="true" />
                  )}
                  {/* On EVERY row: dimmed when the client has no red
                      alert, no yellow alert and no notes, because adding
                      the first one starts here too; bright when any
                      exist. */}
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

                <div className={guestPass ? "cell-pay has-guest" : "cell-pay"}>
                  {/* Two lines: the pass name, and under it the remaining/
                      expiry facts that used to be their own grid columns
                      (T15). No pass, no sub-line. */}
                  {/* T59c: a guest checked in on someone's pass reads
                      the pass name with "Guest of <member>" on the facts
                      line. T62: the name comes from the server's
                      guest_visits marker first (it survives a reload),
                      and the page's own memory of this class view is
                      the fallback when there is no database. T63: the
                      pass is the guest's OWN $0 Guest Pass now, so the
                      name is Mindbody's, shortened like every other
                      row's, and only the facts line says whose guest. */}
                  {(() => {
                    const host =
                      entry.pricingOption && isGuestPass(entry.pricingOption)
                        ? (entry.guestOf?.name ?? guestBy[entry.clientId] ?? null)
                        : null;
                    return (
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
                    {host ? (
                      <span className="pass-facts">Guest of {host}</span>
                    ) : entry.pricingOption ? (
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
                    );
                  })()}
                  {/* T59c: the Guest action, beside the chevron, only
                      while the cached pass list (the sweep's, the same
                      source as the chevron) holds a guest pass with a
                      session left. Not on a future day: the flow signs
                      two people in, and check-in is closed there (T46).
                      T59c review: the two icons share one right-pinned
                      group that stacks when both are present, so the
                      pass name keeps the width it had with the chevron
                      alone (T54: no ellipsis). */}
                  <span className="pay-icons">
                  {(() => {
                    const guest = guestPass;
                    return guest ? (
                      <button
                        className="row-icon guest-btn"
                        disabled={passSavingId !== null}
                        aria-haspopup="dialog"
                        aria-label={`Check in a guest on ${entry.name}'s guest pass`}
                        title="Guest"
                        onClick={(e) => {
                          e.stopPropagation();
                          openGuestFlow(entry, guest);
                        }}
                      >
                        <PersonPlusIcon />
                      </button>
                    ) : null;
                  })()}
                  {/* The payment-change chevron renders only when there is
                      something to change TO: at least one pass OTHER than
                      the one paying now, and a row with no visit id has
                      nothing to reassign at all. T57: counted against the
                      current pass's id, not the list length. The list is
                      ShowActiveOnly, so a pass the change just used up (a
                      guest pass at 0 remaining) drops out of it; counting
                      the length then hid the chevron on the one row whose
                      change most needs undoing.
                      The pass count comes from the background sweep (which
                      shares the dropdown's cache); until it answers for
                      this client no control renders -- it appears when
                      known, rather than offering a dropdown that could
                      only say "no other passes". */}
                  {(() => {
                    const known = passLists[entry.clientId]?.data ?? null;
                    /* T69: a guest pass is not a line in the picker, so
                     * a member whose only other pass is one gets no
                     * chevron; the person-plus beside it is the control. */
                    const showControl =
                      entry.visitId !== null &&
                      known !== null &&
                      known.some(
                        (p) =>
                          p.id !== null &&
                          p.id !== entry.clientServiceId &&
                          !isGuestPass(p.name),
                      );
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
                            openPicker(entry, e.currentTarget.closest(".rrow"));
                          }
                        }}
                      >
                        <ChevronDownIcon />
                      </button>
                    ) : null;
                  })()}
                  </span>
                  {pickerFor === entry.clientId
                    ? renderPassDropdown(entry)
                    : null}
                </div>

                <span
                  className={
                    entry.balance !== null && entry.balance < 0
                      ? "cell-bal neg"
                      : entry.balance !== null && entry.balance > 0
                      ? "cell-bal pos"
                      : "cell-bal"
                  }
                >
                  {entry.balance !== null && entry.balance !== 0
                    ? money(entry.balance)
                    : ""}
                </span>

                {/* The chip's own fixed column (T70, Roster.dc.html): the
                    tap line stays straight whatever the actions cell
                    beside it holds. */}
                <span className="cell-chip">
                  {entry.checkedIn && !working ? (
                    /* T81 (Pete: "clicking checked in should bring up the
                       checkout popup"): the chip itself opens the
                       check-out confirm, and the arrow that did is gone.
                       Same chip to look at (it is a state, not a
                       control), the title saying what a tap does. It
                       renders on EVERY checked-in row, waiver state
                       included (audited for T15): the waiver gate lives
                       in tapCheckIn and applies to check-IN only, and a
                       no-waiver client checked in by mistake must be
                       sign-out-able, or the mistake is permanent. */
                    <button
                      className={chipClass}
                      onClick={() => setCheckingOut(entry)}
                      aria-label={`Check out ${entry.name}`}
                      title="Tap to check out"
                    >
                      {chipLabel}
                    </button>
                  ) : (
                    <button
                      /* T46: on a future day the chip is a closed door,
                         not a target: muted pair, disabled, and the
                         reason in its title. tapCheckIn refuses too. */
                      className={
                        futureClass && !working ? "chip future" : chipClass
                      }
                      disabled={working || futureClass}
                      title={futureClass ? "Check-in opens on the day" : undefined}
                      onClick={() => tapCheckIn(entry)}
                      aria-label={`Check in ${entry.name}`}
                    >
                      {chipLabel}
                    </button>
                  )}
                </span>
                <div className="cell-actions">
                  {/* Since T81 a checked-in row's check-out is the chip
                      itself; this slot holds the trash on a row that is
                      not checked in, and a spacer otherwise, so the Buy
                      bag keeps its column. */}
                  {!entry.checkedIn && !working ? (
                    /* Not checked in: the quiet trash cancels the BOOKING
                       (behind a confirm) rather than a sign-in. */
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
                    className="row-icon sell"
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
                    <SellIcon />
                  </button>
                  {/* The client profile (T42): the same basic facts as
                      Mindbody's client-info page, in a modal, read at
                      open. */}
                  <button
                    className="row-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      openProfile(entry.clientId, entry.name);
                    }}
                    aria-label={`Profile for ${entry.name}`}
                    title="Client profile"
                  >
                    <PersonIcon />
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
      {/* T59b: the sign-up form, one layer above the search modal. On
          success the new person becomes a search result row and the
          walk-in path (waiver gate included) carries on from there;
          nothing about them is kept here. */}
      {/* T59c: the guest modal, over the roster and under the waiver
          dialog and the sign-up form (both render later and stack
          above it). Everything it needs is captured at open. */}
      {guestFlow && activeClass ? (
        <GuestModal
          member={{
            clientId: guestFlow.member.clientId,
            name: guestFlow.member.name,
            visitId: guestFlow.member.visitId,
            checkedIn:
              entries.find((e) => e.clientId === guestFlow.member.clientId)
                ?.checkedIn ?? guestFlow.member.checkedIn,
          }}
          pass={guestFlow.pass}
          classId={activeClass.classId}
          className={activeClass.name}
          classStartsAt={activeClass.startsAt}
          roster={entries
            .filter((e) => e.clientId !== guestFlow.member.clientId)
            .map((e) => ({
              person: rosterAsResult(e),
              standing: {
                visitId: e.visitId,
                checkedIn: e.checkedIn,
                paid: e.paid,
                pricingOption: e.pricingOption,
              },
            }))}
          minQueryLength={settings.minQueryLength}
          searchLimit={settings.searchLimit}
          selected={guestPick}
          onPick={pickGuest}
          onUnpick={() => setGuestPick(null)}
          onNewClient={(first, last) =>
            setNewClient({ first, last, for: "guest" })
          }
          layerAbove={waiverPrompt !== null || newClient !== null}
          suppressionReason={
            config?.dryRun
              ? "Dry run is on: nothing is sent to Mindbody."
              : config && config.writeClientIds.length > 0
                ? "The write guard is on: only the listed test clients are written."
                : null
          }
          onClose={closeGuestFlow}
          onAnswer={onGuestAnswer}
          onRemoved={(pick) => {
            /* T62: the guest's visit is gone (or the removal was
             * suppressed and their row stands): either way the roster is
             * the answer, and their own pass, spent by the ignored write
             * and given back by the removal, is re-read on demand. */
            refreshClientState(pick.person.id);
          }}
        />
      ) : null}
      {newClient ? (
        <NewClientModal
          initialFirst={newClient.first}
          initialLast={newClient.last}
          onClose={() => setNewClient(null)}
          onCreated={(client, note) => {
            const target = newClient.for;
            setNewClient(null);
            if (target === "guest") {
              /* T59c: the new person is the guest. They have no release
               * yet, so pickGuest opens the waiver dialog first. */
              if (note) {
                setActorBanner(note);
                if (actorBannerTimer.current) clearTimeout(actorBannerTimer.current);
                actorBannerTimer.current = setTimeout(
                  () => setActorBanner(null),
                  20_000,
                );
              }
              pickGuest({ person: client, standing: null });
              return;
            }
            if (target === "sale") {
              /* T91: the Buy screen asked, so the new person is ATTACHED
               * to the sale exactly as an attach-modal row tap attaches
               * them. The walk-in flag clears itself once a client is
               * attached (SaleScreen), and the cart is untouched, which
               * is the whole point of the third entry: a walk-in with a
               * pass in the ticket becomes a real client without losing
               * the ticket. The amber note rides the sale screen's own
               * note slot rather than the roster's row messages. */
              setSaleClient({
                id: client.id,
                name: client.name,
                balance: client.balance,
              });
              setSaleClientNote(note);
              return;
            }
            setFound((rows) => [
              client,
              ...rows.filter((r) => r.id !== client.id),
            ]);
            /* T91: the form is now reachable from the sign-in bar as well
             * as from inside the results modal, so the modal may not be
             * open at all, and the box may be empty. Open it on the new
             * person, otherwise the row this just made lands where nobody
             * is looking. The box is seeded with their name as well as the
             * title: the live search (T81) keys on the box, and a title
             * with an empty box reads as a query of nothing and clears the
             * results on the next tick. */
            if (!query.trim()) {
              liveSeeded.current = client.name;
              setQuery(client.name);
              setSearchTitle(client.name);
            }
            setSearchOpen(true);
            if (note) setBookMsg((m) => ({ ...m, [client.id]: note }));
          }}
        />
      ) : null}
      {searchOpen ? (
        <div className="modal-scrim" onClick={closeSearch} role="presentation">
          <div
            className={
              attachMode
                ? "modal modal-list modal-search attach-mode"
                : "modal modal-list modal-search"
            }
            role="dialog"
            aria-modal="true"
            aria-label={
              recipientFor !== null
                ? "Who is this item for?"
                : attachMode
                ? "Attach a client to the sale"
                : searchTitle
                  ? `Search results for ${searchTitle}`
                  : "Search for a walk-in"
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
            <div className="modal-head">
              <p className="modal-kicker">{attachMode ? "Sale" : "Walk-in"}</p>
              <p className="modal-title">
                {recipientFor !== null
                  ? "Who is this for?"
                  : attachMode
                  ? "Attach a client to the sale"
                  : searchTitle
                    ? `Results for "${searchTitle}"`
                    : "Search for a walk-in"}
              </p>
            </div>
            {/* Attach mode opens the modal BEFORE any search exists, so
                the search bar renders here: the same query state, the
                same submitSearch, the same live search (T81) as the
                page's own bar. It sits at the TOP of the modal (T32),
                above the class picker and the rows: it is the one control
                that is always useful, and a bar that moves down the modal
                as the rows change is a bar a teacher has to look for. */}
            {/* T73 (Pete): the walk-in modal carries the bar too, "so it
                can be redone"; the same state and rules in both modes. */}
            {(
              <div className="search-bar">
                <div className="search-wrap">
                  <input
                    className="search"
                    value={query}
                    onChange={(e) => {
                      liveSeeded.current = null;
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
                    placeholder={
                      recipientFor !== null
                        ? "Who is this item for?"
                        : attachMode
                          ? "Who is the sale for?"
                          : "Search for a walk-in"
                    }
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
                      onClick={clearSearch}
                    >
                      <CloseIcon />
                    </button>
                  ) : null}
                </div>
                <button
                  className="search-go"
                  onClick={submitSearch}
                  aria-label="Search"
                  title="Search"
                >
                  <SearchIcon />
                </button>
              </div>
            )}
            {attachMode && searchMsg ? (
              <p className="search-quiet">{searchMsg}</p>
            ) : null}
            {/* The segment and the rows (T27 round three, T32, T42,
                reshaped in T87, attach mode ONLY): one "All | Class"
                segment under the search bar. Class is the class the
                sign-in screen has selected, everyone booked in it, its
                roster already in memory (`entries`, zero calls),
                alphabetical by last name and filtered by the typed query
                with no minimum length; All is the live Mindbody search
                (T81) with a standing chip on anyone who is on that
                roster. Tapping a row attaches. */}
            {attachMode
              ? (() => {
                  const inClass = attachTab === "class";
                  const q = query.trim().toLowerCase();
                  const onRoster = new Map(
                    entries.map((en) => [en.clientId, en] as const),
                  );
                  const rosterRow = (en: RosterEntry): AttachRow => ({
                    client: rosterAsResult(en),
                    status: en.checkedIn ? "checked in" : "signed up",
                  });
                  const rows: AttachRow[] = inClass
                    ? entries
                        .filter(
                          (en) => !q || en.name.toLowerCase().includes(q),
                        )
                        .sort(byLastThenFirst)
                        .map(rosterRow)
                    : found.map((f) => {
                        const en = onRoster.get(f.id);
                        return en
                          ? { client: f, status: rosterRow(en).status }
                          : { client: f, status: null };
                      });
                  const searched = !inClass && searchTitle !== "";
                  /* The one quiet line under the rows, or in their place:
                     the class's own states first, then the search's. */
                  const line = inClass
                    ? entries.length === 0
                      ? "Nobody is booked yet."
                      : rows.length === 0
                        ? "Nobody in this class matches."
                        : null
                    : searchError
                      ? null
                      : searched && !searching && rows.length === 0
                        ? "Nobody found. Check the spelling, or try fewer letters."
                        : !searched && !searching
                          ? attachSearchHint(config)
                          : null;
                  return (
                    <div className="attach-quick">
                      {/* T90: re-opening the modal on a line that already
                          has a recipient offers the row that takes it
                          off. It names who pays, since that is where the
                          line goes back to. */}
                      {recipientFor?.clear ? (
                        <button
                          type="button"
                          className="attach-clear"
                          onClick={clearLineRecipient}
                        >
                          {saleClient
                            ? `For ${saleClient.name} (this client)`
                            : "For whoever is paying"}
                        </button>
                      ) : null}
                      {/* T87 (Pete: "instead of a class selector and all
                          the buttons, just use All | Class"): two cells,
                          the selected one filled with the accent. No
                          class dropdown: the class is the sign-in
                          screen's, named on that screen already. */}
                      <div
                        className="attach-tabs"
                        role="radiogroup"
                        aria-label="Who to show"
                      >
                        {ATTACH_TABS.map((tb) => (
                          <button
                            key={tb.value}
                            type="button"
                            className={
                              attachTab === tb.value
                                ? "attach-tab on"
                                : "attach-tab"
                            }
                            role="radio"
                            aria-checked={attachTab === tb.value}
                            onClick={() => pickAttachTab(tb.value)}
                          >
                            {tb.label}
                          </button>
                        ))}
                      </div>
                      {/* One scroll region of a FIXED height (T42, Pete:
                          "should stay the same size always"): the modal
                          used to shrink while a search was in flight.
                          The last rows stay put, dimmed, under a quiet
                          "Searching..." line until the answer replaces
                          them. */}
                      <div
                        className={
                          searching ? "attach-rows searching" : "attach-rows"
                        }
                        aria-busy={searching || searchMore}
                      >
                        {autoWidened && !inClass ? (
                          <p className="attach-line attach-widened" role="status">
                            Nobody in class matched. Showing everyone.
                          </p>
                        ) : null}
                        {searching ? (
                          <p className="attach-line">
                            <span className="spinner" aria-label="working" />{" "}
                            Searching Mindbody...
                          </p>
                        ) : null}
                        {line ? (
                          <p className="attach-line">{line}</p>
                        ) : null}
                        {searchError ? (
                          <p className="note">{searchError}</p>
                        ) : null}
                        {rows.length > 0 ? (
                          <ul className="roster" onPointerDown={noteListTap}>
                            {rows.map(attachRowItem)}
                          </ul>
                        ) : null}
                        {/* The paging sentinel and its quiet line: only
                            while the search says there is more. */}
                        {!inClass && !searchPage.done ? (
                          <div
                            className="attach-more"
                            ref={setSearchSentinel}
                          >
                            {searchMore ? (
                              <>
                                <span className="spinner" aria-label="working" />{" "}
                                Loading more...
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })()
              : null}
            {/* A class-level fact, said once here rather than stamped on
                every result row: with the class full, every add offers
                the waiting list instead. Booking flow only; a sale does
                not care whether the class is full. */}
            {/* T73: the walk-in body is ONE scroll region of a fixed
                height, like attach mode's (Pete: "it should always be
                the same height. currently it expands until a certain
                height"): messages, the head and the rows all live in
                it, so the modal is the same box whether the search
                found nobody or forty people. */}
            {!attachMode ? (
            <div className="search-body">
            {classFull && shownResults.length > 0 ? (
              <p className="muted">Class is full. Adding goes to the waiting list.</p>
            ) : null}
            {searching ? (
              <p className="muted">
                <span className="spinner" aria-label="working" /> Searching
                Mindbody...
              </p>
            ) : null}
            {searchError ? (
              <p className="note">{searchError}</p>
            ) : null}
            {/* T81: the modal open with no search behind it, the query
                back under the minimum (or the bar's X pressed): the
                hint, not "Nobody found" and a New client button for a
                name nobody has finished typing. */}
            {!searching && !searchTitle ? (
              <p className="muted">
                Type at least {settings.minQueryLength} letters.
              </p>
            ) : null}
            {!searching && !searchError && searchTitle && shownResults.length === 0 ? (
              <>
                <p className="muted">
                  Nobody found. Check the spelling, or try fewer letters.
                </p>
                {/* T59b: the person standing there may simply not exist
                    yet. The form prefills from the search when it looked
                    like a name (two words, no digits or @). Booking mode
                    only; the attach modal gets this in T59c. */}
                <div className="modal-actions new-client-actions">
                  <button
                    className="modal-confirm go"
                    onClick={() => {
                      setNewClient({
                        ...namePrefill(searchTitle),
                        for: "search",
                      });
                    }}
                  >
                    New client
                  </button>
                </div>
              </>
            ) : null}
            {/* The booking flow's results list. Attach mode renders its
                own rows above through attachRowItem. Since T42 the whole
                row is the add target again for a walk-in (Pete: "remove
                the + icon and make the whole row clickable"): the tap
                goes through tapWalkIn with every gate it always had (the
                waiver, the unpaid confirm, a full class's waitlist
                confirm), and someone already on the roster or the
                waiting list gets a chip and no tap at all. The Buy bag
                left these rows; it stays on the roster's. */}
            {shownResults.length > 0 ? (
              <>
                <div className="roster-head">
                  <span aria-hidden="true">Name</span>
                  <span aria-hidden="true">Passes</span>
                  <span className="cell-bal" aria-hidden="true">
                    Account
                  </span>
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                </div>
                <ul
                  /* Keyed by the query so a new search remounts the list
                   * at the top: the old scroll position carried over, and
                   * a list opening already scrolled to its sentinel asked
                   * Mindbody for page two unbidden (T42 review).
                   * T81 review: the query these ROWS are for
                   * (`foundFor`), not the one being typed. Keyed on
                   * searchTitle the list remounted the moment the live
                   * search fired, 300-900ms before its answer: the
                   * rows were the same names in brand new nodes, so the
                   * list jumped to the top and a press in progress was
                   * broken (a pointerdown on a node that no longer
                   * exists never becomes a click) in exactly the window
                   * the tap guard exists to protect. */
                  key={`results-${foundFor}`}
                  className="roster modal-roster"
                  onPointerDown={noteListTap}
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
                    const standing = rosterStatus.get(client.id) ?? null;
                    /* A row already in the class (or queued for it) is not
                     * an add target: the chip says where they stand. */
                    const tappable =
                      standing === null && !working && bookingIds.length === 0;
                    /* Under the name: the email and phone line (T42), and
                     * under that an in-flight call or an outcome message. */
                    const contact = contactLine(client);
                    const subline = working ? "Talking to Mindbody..." : (msg ?? null);
                    /* The pass summary, once the background fetch has
                     * landed: the same two-line format as the roster's
                     * payment cell. With more than one current pass the
                     * cell grows the roster's chevron and which pass will
                     * pay becomes choosable (T17): the choice is LOCAL --
                     * rendered here, sent only when the row books --
                     * defaulting to the list's first pass, which is what
                     * the summary always showed. Only passes carrying an
                     * id are choosable; a pass Mindbody returned without
                     * one cannot be named on a booking call. */
                    const passList = passLists[client.id]?.data ?? null;
                    /* T63: a guest pass is never choosable for the
                     * MEMBER's own booking here either (T59c and T62 left
                     * this picker as the one door still open to T57's
                     * accident), and never the shown default. The guest
                     * flow is the member's roster row. */
                    const choosable = (passList ?? []).filter(
                      (p): p is PassInfo & { id: number } =>
                        p.id !== null && !isGuestPass(p.name),
                    );
                    const chosenId = walkinPassChoice[client.id];
                    const chosen =
                      chosenId !== undefined
                        ? (choosable.find((p) => p.id === chosenId) ?? null)
                        : null;
                    const shownPass =
                      chosen ?? passList?.find((p) => !isGuestPass(p.name)) ?? null;
                    const pickerOpen = walkinPicker?.id === client.id;
                    const rowClass = [
                      "rrow",
                      tappable ? "rrow-tap" : "",
                      bookingIds.length > 0 && !working ? "row-dim" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const addLabel = classFull
                      ? `Add ${client.name} to the waitlist`
                      : `Add ${client.name} to this class`;
                    return (
                      <li key={`walkin-${client.id}`}>
                        {/* While ONE row's booking is in flight every
                            other row dims: the single-flight lock already
                            made them inert, this makes it visible. */}
                        <div
                          className={rowClass}
                          role={tappable ? "button" : undefined}
                          tabIndex={tappable ? 0 : undefined}
                          aria-label={tappable ? addLabel : undefined}
                          title={tappable ? (classFull ? "Add to waitlist" : "Add to this class") : undefined}
                          onClick={tappable ? () => tapWalkIn(client) : undefined}
                          onKeyDown={
                            tappable
                              ? (e) => {
                                  /* Only the ROW's own keys: a keydown
                                   * bubbles up from the profile icon, the
                                   * pass chevron and the picker's options
                                   * inside the row, and Enter on any of
                                   * them booked the client while the
                                   * preventDefault swallowed the button's
                                   * own click (T42 review). */
                                  if (e.target !== e.currentTarget) return;
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    tapWalkIn(client);
                                  }
                                }
                              : undefined
                          }
                        >
                          <div className="cell-name">
                            {/* The name owns the row's whole first line and
                                NEVER ellipsizes: it is the one column a
                                teacher cannot read truncated. An absurdly
                                long name wraps; "..." is not an option
                                here (T17). */}
                            <span className="name-text">
                              <Hit text={client.name} q={foundFor} />
                            </span>
                            {contact ? (
                              <span className="contact-line">
                                <Hit text={contact} q={foundFor} />
                              </span>
                            ) : null}
                            {/* T42 review: the info icon left the search
                                rows, and with it the only cue that a
                                client carries an alert, which T20 put
                                there because a red alert is exactly what
                                a teacher must see BEFORE the add tap. The
                                alert text itself rides under the name
                                instead, red for red. */}
                            {/* T58: the tag stays out of the summary
                                line; the signature lives in the views. */}
                            {client.redAlert ? (
                              <span className="subline stop-text">
                                Alert: {stripSignatures(client.redAlert)}
                              </span>
                            ) : client.yellowAlert ? (
                              <span className="subline">
                                Note: {stripSignatures(client.yellowAlert)}
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
                                action beyond updating this cell, and the
                                stopPropagation keeps it off the row's
                                add tap. */}
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
                                : client.balance !== null && client.balance > 0
                                ? "cell-bal pos"
                                : "cell-bal"
                            }
                          >
                            {client.balance !== null && client.balance !== 0
                              ? money(client.balance)
                              : ""}
                          </span>
                          {/* The standing chip column (T42): fixed, so
                              chips line up down the list. A row being
                              booked shows the spinner here. */}
                          <span className="cell-chip">
                            {working ? (
                              <span className="spinner" aria-label="working" />
                            ) : standing === "checked in" ? (
                              <span className="mini-in">checked in</span>
                            ) : standing !== null ? (
                              <span className="mini-signed">{standing}</span>
                            ) : null}
                          </span>
                          <div className="cell-actions">
                            <button
                              className="row-icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                openProfile(client.id, client.name);
                              }}
                              aria-label={`Profile for ${client.name}`}
                              title="Client profile"
                            >
                              <PersonIcon />
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                  {/* The paging sentinel (T42): only while the search
                      says there is more; the observer asks for the next
                      page as it scrolls into view. */}
                  {!searchPage.done ? (
                    <li className="attach-more" ref={setSearchSentinel}>
                      {searchMore ? (
                        <>
                          <span className="spinner" aria-label="working" />{" "}
                          Loading more...
                        </>
                      ) : null}
                    </li>
                  ) : null}
                </ul>
              </>
            ) : null}
            </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* The client profile modal (T42): what the person icon on a roster
          or search row opens, above the search modal when it came from
          there. Read-only, fetched at open; Escape and the scrim close. */}
      {profileView ? (
        <div
          className="modal-scrim profile-scrim"
          onClick={closeProfile}
          role="presentation"
        >
          <div
            className="modal modal-list modal-profile"
            role="dialog"
            aria-modal="true"
            aria-label={`Profile for ${profileView.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="row-icon modal-x"
              aria-label="Close profile"
              onClick={closeProfile}
            >
              <CloseIcon />
            </button>
            <div className="modal-head">
              <p className="modal-kicker">Client</p>
              <p className="modal-title">{profileView.name}</p>
            </div>
            <div className="profile-scroll">
              <ClientProfileCard
                profile={profileState.profile}
                loading={profileState.loading}
                error={profileState.error}
                onOptIn={saveOptIn}
                optInMsg={optInMsg}
                onCard={() => {
                  setCardMsg(null);
                  setCardOpen(true);
                }}
                cardMsg={cardMsg}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* T84: the card box, over the profile modal it was opened from.
          Mounted only while open, so nothing typed into it outlives it. */}
      {profileView && cardOpen && profileState.profile ? (
        <CardModal
          clientId={profileState.profile.clientId}
          name={profileView.name}
          current={profileState.profile.card}
          onClose={() => setCardOpen(false)}
          onSaved={cardSaved}
        />
      ) : null}

      {/* The Membership modal (T52): what the roster's M chip opens.
          T56: what the M rests on, from /api/membership. "Contracts"
          (the autopay agreements, with AutopayStatus and dates), then
          "Passes" (as before, plus unexpired passes with nothing left,
          shown as used up in the muted colour and never offered as
          payment), then a closing line that always names the flag, and
          when neither list explains it, says where to look. Read-only;
          the X, the scrim and Escape close it. */}
      {memberView
        ? (() => {
            const info = memberInfo[memberView.clientId];
            const data = info?.data ?? null;
            const contractWhen = (c: ContractInfo): string => {
              const from = wallDate(c.startDate ?? c.agreementDate);
              const to = wallDate(c.endDate);
              if (from && to) {
                return `${from} to ${to}${c.autoRenewing ? ", renews" : ""}`;
              }
              if (from) return `since ${from}${c.autoRenewing ? ", renews" : ""}`;
              if (to) return `${c.autoRenewing ? "renews" : "ends"} ${to}`;
              return c.autoRenewing ? "auto-renewing" : "";
            };
            return (
              <div
                className="modal-scrim"
                onClick={() => setMemberView(null)}
                role="presentation"
              >
                <div
                  className="modal modal-list modal-member"
                  role="dialog"
                  aria-modal="true"
                  aria-label={`Membership for ${memberView.name}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="row-icon modal-x"
                    aria-label="Close"
                    onClick={() => setMemberView(null)}
                  >
                    <CloseIcon />
                  </button>
                  <div className="modal-head">
                    <p className="modal-kicker">Membership</p>
                    <p className="modal-title">{memberView.name}</p>
                  </div>
                  {data === null ? (
                    info?.error ? (
                      <>
                        <p className="note">
                          Could not read the membership: {info.error}
                        </p>
                        <div className="modal-actions">
                          <button
                            className="modal-cancel"
                            onClick={() =>
                              ensureMemberInfo(memberView.clientId, true)
                            }
                          >
                            Try again
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="muted">
                        <span className="spinner" aria-label="working" />{" "}
                        Reading the membership from Mindbody...
                      </p>
                    )
                  ) : (
                    <>
                      <p className="member-label">Contracts</p>
                      {/* Only the contracts that are not Inactive (Pete:
                          "i don't need to see Inactive contracts"): a
                          member renewed every six months for five years
                          listed nine dead ones above the live one. A
                          suspended contract and one with no status stay,
                          since either is worth a look. */}
                      {(() => {
                        const shown = data.contracts.filter(
                          (c) => (c.status ?? "").toLowerCase() !== "inactive",
                        );
                        const hidden = data.contracts.length - shown.length;
                        return shown.length === 0 ? (
                        <p className="modal-note member-none">
                          {hidden > 0
                            ? `No active contract (${hidden} inactive not shown).`
                            : "No contracts."}
                        </p>
                      ) : (
                        <ul className="profile-passes member-passes">
                          {shown.map((c, i) => (
                            <li
                              key={c.id ?? `${c.name}-${i}`}
                              className="profile-pass"
                            >
                              <span className="profile-pass-name">{c.name}</span>
                              <span className="profile-pass-meta">
                                {c.status ?? "Status unknown"}
                                {contractWhen(c)
                                  ? ` · ${contractWhen(c)}`
                                  : ""}
                              </span>
                            </li>
                          ))}
                          {hidden > 0 ? (
                            <li className="profile-pass member-hidden-note">
                              <span className="profile-pass-meta">
                                {hidden} inactive not shown
                              </span>
                            </li>
                          ) : null}
                        </ul>
                      );
                      })()}
                      <p className="member-label">Passes</p>
                      {data.passes.length === 0 ? (
                        <p className="modal-note member-none">No passes.</p>
                      ) : (
                        <ul className="profile-passes member-passes">
                          {data.passes.map((p, i) => (
                            <li
                              key={p.id ?? `${p.name}-${i}`}
                              className={
                                p.usedUp
                                  ? "profile-pass member-usedup"
                                  : "profile-pass"
                              }
                            >
                              <span className="profile-pass-name">{p.name}</span>
                              <span className="profile-pass-meta">
                                {p.usedUp
                                  ? `Used up${
                                      p.expires
                                        ? `, exp ${wallDate(p.expires)}`
                                        : ""
                                    }`
                                  : /* fakeUnlimited applies everywhere a
                                       pass renders: a membership's 99999
                                       is not a count. */
                                    (p.remaining === null ||
                                    fakeUnlimited(p.count, p.remaining)
                                      ? "Unlimited"
                                      : p.count !== null
                                        ? `${p.remaining} of ${p.count} left`
                                        : `${p.remaining} left`) +
                                    (p.expires
                                      ? ` · expires ${wallDate(p.expires)}`
                                      : " · no expiry")}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {memberView.member ? (
                        <p className="member-flag">
                          Mindbody flags this client as a member.
                          {data.contracts.length === 0 &&
                          data.passes.length === 0
                            ? " Nothing here explains it; check the Contracts tab on their Mindbody profile."
                            : ""}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })()
        : null}

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
            className="modal modal-list modal-counter"
            role="dialog"
            aria-modal="true"
            aria-label={
              counterModal === "checkedIn"
                ? "Everyone checked in"
                : "The waiting list"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="row-icon modal-x"
              aria-label="Close"
              onClick={() => setCounterModal(null)}
            >
              <CloseIcon />
            </button>
            <div className="modal-head">
              <p className="modal-kicker">
                {clockTime(activeClass.startsAt)} · {activeClass.name}
              </p>
              <p className="modal-title">
                {counterModal === "checkedIn"
                  ? `Checked in (${entries.filter((e) => e.checkedIn).length} of ${entries.length})`
                  : `Waiting list${waitlist !== null ? ` (${waitlist.length})` : ""}`}
              </p>
            </div>

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
            {/* T52 (Pete: "the info view should not have a big Close
                button, just an X like other modals"). Rests while a
                save is on the wire, like the scrim and Cancel. */}
            <button
              className="row-icon modal-x"
              aria-label="Close"
              disabled={infoSaving}
              onClick={closeInfoView}
            >
              <CloseIcon />
            </button>
            {/* T70 (Dialogs.dc.html): the kicker names the loudest thing
                in the view, in the stop colour when it is a red alert. */}
            <div className="modal-head">
              <p className={infoView.redAlert ? "modal-kicker stop" : "modal-kicker"}>
                {infoView.redAlert ? "Red alert" : "Alerts and notes"}
              </p>
              <p className="modal-title">{infoView.name}</p>
            </div>
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
                        /* T58: the editor shows plain text; the tags
                           come back on the server's side. */
                        setInfoDraft(stripSignatures(s.text));
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
                     views render pre-wrap. T58: under it, who the save
                     will be signed as, so the signature is no surprise. */
                  <>
                    <textarea
                      className="notes-edit"
                      value={infoDraft}
                      onChange={(e) => setInfoDraft(e.target.value)}
                      disabled={infoSaving}
                      aria-label={`Edit ${s.label.toLowerCase()}`}
                      autoFocus
                    />
                    <p className="note-signed-as">Saved as {teacher.name}</p>
                  </>
                ) : s.text ? (
                  /* T58: entry by entry, each signed one with its name
                     and date under it. */
                  <NoteText text={s.text} className={s.textClass} />
                ) : (
                  <p className="info-none">None.</p>
                )}
              </div>
            ))}
            {infoMsg ? (
              <p className="pass-note modal-note-gap">{infoMsg}</p>
            ) : null}
            {/* Cancel and Save are a decision pair and stay; the lone
                Close they alternated with is the X now (T52). */}
            {infoEditing !== null ? (
              <div className="modal-actions">
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
              </div>
            ) : null}
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
            {/* T52: the X closes with no action, in both shapes; it rests
                while an agreement is being recorded, as the scrim does. */}
            <button
              className="row-icon modal-x"
              aria-label="Close"
              disabled={waiverSaving}
              onClick={closeWaiverDialog}
            >
              <CloseIcon />
            </button>
            {/* Titled the way Mindbody's own dialog is: the document name
                on top, the person as the line beneath it. */}
            <div className="modal-head">
              <p className="modal-kicker">
                {waiverText ? "Read and agree" : "Waiver needed"}
              </p>
              <p className="modal-title">Liability Waiver</p>
            </div>
            <div className="modal-entity">
              <span className="modal-entity-name">{waiverName}</span>
              <span className="modal-entity-facts">
                {waiverText
                  ? "To read and agree to."
                  : "Has not signed the waiver."}
              </span>
            </div>
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
                    ) : waiverPrompt.source === "guest" ? (
                      "Record agreement and continue"
                    ) : (
                      "Record agreement and check in"
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* The consequence, the one stop-coloured line (2.5). */}
                <p className="modal-consequence">
                  {waiverPrompt.source === "walkin"
                    ? "No liability waiver on file. They cannot be added to the class until they have read and agreed to it."
                    : waiverPrompt.source === "promote"
                      ? "No liability waiver on file. They cannot be promoted into the class until they have read and agreed to it."
                      : waiverPrompt.source === "guest"
                        ? "No liability waiver on file. They cannot be checked in as a guest until they have read and agreed to it."
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
                        : waiverPrompt.source === "guest"
                          ? "guest check-in will go through normally."
                          : "row will check in normally."}
                  </p>
                ) : (
                  <p className="muted">
                    Hand them the iPad to read the studio&apos;s waiver, or
                    have them sign it in the Mindbody app. Recording an
                    agreement here requires the full text to be read first.
                  </p>
                )}
                {/* The big Close left with T52; the X above is the way
                    out, and with the text unavailable there is no
                    second action to pair a button with. */}
                {!waiverFetchError ? (
                  <div className="modal-actions">
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
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* T46: the calendar. A month grid in the app's own idiom rather
          than the OS date picker: 64px previous/next, a weekday header,
          64px day cells (44px on a narrow screen, the icon idiom), today
          ringed, the chosen day filled with the accent, Today and Cancel
          at the foot. Pure UI: the pick is what fetches, once per day.
          Escape and the scrim close it. */}
      {calOpen ? (
        <div
          className="modal-scrim"
          onClick={() => setCalOpen(false)}
          role="presentation"
        >
          <div
            className="modal modal-cal"
            role="dialog"
            aria-modal="true"
            aria-label="Pick a day"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="row-icon modal-x"
              aria-label="Close"
              onClick={() => setCalOpen(false)}
            >
              <CloseIcon />
            </button>
            <div className="cal-head">
              <button
                className="cal-nav"
                aria-label="Previous month"
                onClick={() =>
                  setCalMonth(({ y, m }) =>
                    m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 },
                  )
                }
              >
                <ChevronLeftIcon />
              </button>
              <p className="modal-title cal-title">
                {keyToDate(dateKey(calMonth.y, calMonth.m, 1)).toLocaleDateString(
                  [],
                  { month: "long", year: "numeric" },
                )}
              </p>
              <button
                className="cal-nav"
                aria-label="Next month"
                onClick={() =>
                  setCalMonth(({ y, m }) =>
                    m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 },
                  )
                }
              >
                <ChevronRightIcon />
              </button>
            </div>
            <div className="cal-grid" role="grid" aria-label="Days">
              {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                <span key={`wd-${d}`} className="cal-wd" aria-hidden="true">
                  {d}
                </span>
              ))}
              {(() => {
                /* Leading blanks to the month's first weekday, then the
                 * days. Pure y/m/d arithmetic: no instant, no zone. */
                const first = keyToDate(dateKey(calMonth.y, calMonth.m, 1));
                const lead = first.getDay();
                const count = new Date(calMonth.y, calMonth.m, 0).getDate();
                const cells: ReactNode[] = [];
                for (let i = 0; i < lead; i++) {
                  cells.push(<span key={`blank-${i}`} className="cal-blank" />);
                }
                const selected = viewDate ?? todayKey;
                for (let d = 1; d <= count; d++) {
                  const key = dateKey(calMonth.y, calMonth.m, d);
                  const isToday = key === todayKey;
                  const isSel = key === selected;
                  cells.push(
                    <button
                      key={key}
                      className={
                        "cal-day" +
                        (isToday ? " today" : "") +
                        (isSel ? " sel" : "")
                      }
                      aria-pressed={isSel}
                      aria-label={dayKeyLabel(key) + (isToday ? ", today" : "")}
                      onClick={() => pickViewDate(key)}
                    >
                      {d}
                    </button>,
                  );
                }
                return cells;
              })()}
            </div>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setCalOpen(false)}>
                Cancel
              </button>
              <button
                className="modal-confirm go"
                onClick={() => pickViewDate(null)}
              >
                Today
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
            <button
              className="row-icon modal-x"
              aria-label="Close"
              onClick={() => setCheckingOut(null)}
            >
              <CloseIcon />
            </button>
            {/* T70 (Dialogs.dc.html, 2.5): who and what state in a card,
                then the consequence as the only stop-coloured line. */}
            <div className="modal-head">
              <p className="modal-kicker">Check out</p>
              <p className="modal-title">Check out {checkingOut.name}?</p>
            </div>
            <div className="modal-entity">
              <span className="modal-entity-name">{checkingOut.name}</span>
              <span className="modal-entity-facts">
                {entityFacts(checkingOut)}
              </span>
            </div>
            <p className="modal-consequence">Marks them as not attended.</p>
            <p className="muted">Only do it if the check-in was a mistake.</p>
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
            <button
              className="row-icon modal-x"
              aria-label="Close"
              disabled={cancelBusy}
              onClick={() => {
                setCancelling(null);
                setCancelMsg(null);
              }}
            >
              <CloseIcon />
            </button>
            <div className="modal-head">
              <p className="modal-kicker">Remove from class</p>
              <p className="modal-title">
                Remove {cancelling.entry.name} from this class?
              </p>
            </div>
            <div className="modal-entity">
              <span className="modal-entity-name">{cancelling.entry.name}</span>
              <span className="modal-entity-facts">
                {entityFacts(cancelling.entry)}
              </span>
            </div>
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
            {/* T52: the X only while no stage is on the wire; the
                Close / Not now / Cancel button below is a decision
                control and keeps its wording. */}
            {payStage === null ? (
              <button
                className="row-icon modal-x"
                aria-label="Close"
                onClick={closePayDialog}
              >
                <CloseIcon />
              </button>
            ) : null}
            <div className="modal-head">
              <p className="modal-kicker">
                {payDialog.flavor === "renewal"
                  ? "Last session used"
                  : "Pay and check in"}
              </p>
              <p className="modal-title">
                {payDialog.flavor === "renewal"
                  ? "Sell the next pack?"
                  : payDialog.entry.name}
              </p>
            </div>
            {payDialog.flavor === "renewal" ? (
              <div className="modal-entity">
                <span className="modal-entity-name">{payDialog.entry.name}</span>
                <span className="modal-entity-facts">
                  {entityFacts(payDialog.entry)}
                </span>
              </div>
            ) : null}

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
                  .sort(payOptionOrder)
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
                covers the total (this dialog's own preference since T82
                retired rule 1, see payMethod), otherwise the stored
                card. A missing method renders its reason rather than
                disappearing. */}
            <p className="pay-method-line">
              {payMethod === "credit"
                ? `Pays with account balance (${
                    payBalance !== null ? money(payBalance) : ""
                  }).`
                : payMethod === "storedcard" && payCard
                  ? `Pays with the stored card ...${payCard.lastFour}.`
                  : payMethodReason}
            </p>
            {/* T88: with nothing to charge with, "use Buy" was an
                instruction where an action belongs. The line stays for
                every other case. */}
            {payBuyOffer ? null : (
              <p className="pay-cash-note">For cash, use Buy.</p>
            )}

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
              {payBuyOffer ? (
                /* T88: the Charge control's own slot, so the one primary
                   action is where it always is. It opens Buy with this
                   client and this pass; nothing is written by the tap. */
                <button
                  className="modal-confirm pay-charge"
                  onClick={buyAndCheckIn}
                >
                  Buy and check in
                </button>
              ) : !payMoneyMoved ? (
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
            <button
              className="row-icon modal-x"
              aria-label="Close"
              onClick={() => setWaitlistPrompt(null)}
            >
              <CloseIcon />
            </button>
            {/* T70 (2.5): the class summary is the entity card rather
                than a count folded into the title. */}
            <div className="modal-head">
              <p className="modal-kicker">Waiting list</p>
              <p className="modal-title">This class is full.</p>
            </div>
            {activeClass ? (
              <div className="modal-entity">
                <span className="modal-entity-name">{activeClass.name}</span>
                <span className="modal-entity-facts">
                  {[
                    `${dayDate(activeClass.startsAt)} · ${clockTime(activeClass.startsAt)}`,
                    activeClass.teacher || null,
                    activeClass.capacity !== null && activeClass.booked !== null
                      ? `${activeClass.booked} of ${activeClass.capacity}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            ) : null}
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

      {/* The sale overlay (T23). ALWAYS mounted so its cart survives
          leaving the screen and reopens where it left off; `open` is what
          shows it. It sits below every modal scrim, so the search modal
          in attach mode, the info view, and the dev drawer all stack
          above it as usual; the nav bar (T85) stacks ABOVE it, because it
          is the same bar on every screen. */}
      <SaleScreen
        open={saleOpen}
        onClose={() => {
          /* T88: Escape or the scrim leaves the sale too, and a pending
             check-in no sale has earned goes with it. A settled sale has
             already cleared it, so Done cannot trip this. */
          dropPendingCheckIn("left");
          setSaleOpen(false);
        }}
        mode={saleMode}
        onModeChange={setSaleMode}
        onNavState={setSaleNav}
        config={config}
        client={saleClient}
        onRequestAttach={openAttachSearch}
        /* T91: the Buy screen's New client entries. page.tsx owns the
           form, as it owns the attach modal, so the modal stacks above
           the sale overlay the same way. */
        onRequestNewClient={() =>
          setNewClient({ first: "", last: "", for: "sale" })
        }
        clientNote={saleClientNote}
        onClientNoteRead={readSaleClientNote}
        onRequestRecipient={openRecipientSearch}
        recipientPick={recipientPick}
        onDetachClient={() => {
          setSaleClient(null);
          setSaleClientNote(null);
        }}
        modalAbove={
          searchOpen ||
          infoView !== null ||
          waiverPrompt !== null ||
          profileView !== null ||
          /* T91: the New client form is a layer above the sale too, so
             Escape peels the form and not the whole overlay. */
          newClient !== null
        }
        onContractPurchased={refreshClientState}
        onSaleCompleted={refreshClientState}
        onStaffSessionEnded={() => setTeacher(null)}
        /* T88: the sale that finishes a check-in. `onSold` carries every
           sale the charge made (T90), which is how the pass is matched to
           the client it was sold to. */
        onSold={(sales) => void finishPendingCheckIn(sales)}
        pendingCheckIn={
          pendingCheckIn
            ? {
                nonce: pendingCheckIn.nonce,
                clientId: pendingCheckIn.clientId,
                itemType: pendingCheckIn.itemType,
                itemId: pendingCheckIn.itemId,
                note: pendingCheckIn.note,
              }
            : null
        }
        pendingCheckInResult={pendingResult}
        onPendingCheckInDrop={dropPendingCheckIn}
      />

      <StaffModal
        open={staffOpen}
        teacher={teacher}
        onClose={() => setStaffOpen(false)}
        /* The modal's second argument is `hasPin` (T80) and this one's is
         * a gate notice (T89), so the teacher alone is passed on. */
        onTeacherChange={(t) => setTeacher(t)}
      />

      <DevDrawer
        open={devOpen}
        onOpenChange={setDevOpen}
        onAvailableChange={setDevAvailable}
        /* T89: the counter now talks to the other studio. The banner is
           re-read at once rather than at the next 30 second tick, and
           the teacher goes back to the gate, because the server has
           just ended every staff session: a token belongs to the site
           that issued it. */
        onTargetSwitched={(_next, notice) => {
          readConfig();
          setTeacher(null, notice);
        }}
        onConfigChanged={readConfig}
      />

      {/* T85: the one nav bar, the last child and fixed to the bottom on
          every screen. It is rendered here rather than inside either
          screen so that it IS the same element in all three states: the
          roster behind the overlay, the shelf, and the payment step. */}
      <NavBar items={navItems} />
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
  /** T50: the signed-in teacher. `undefined` until /api/teacher has
   *  answered (nothing renders, as with the device check: a flash of
   *  the gate at a signed-in counter is as wrong as a flash of the
   *  roster at a locked one); null renders the gate; a teacher renders
   *  the desk. */
  const [teacher, setTeacher] = useState<Teacher | null | undefined>(
    undefined,
  );
  /** T50 review: the server's line for why the gate came back after a
   *  refused write (its sign-in ended), cleared by the next sign-in. */
  const [gateNotice, setGateNotice] = useState<string | null>(null);
  /** T80: the teacher who just signed in and has no comp PIN (Pete:
   *  "when a teacher first signs in, if they have not set up a PIN they
   *  should be prompted to do so"). Set from the sign-in's own answer,
   *  so the prompt is a consequence of signing in and not of every
   *  reload; "Not now" clears it for this sign-in only, and the next
   *  one asks again. */
  const [pinPrompt, setPinPrompt] = useState<Teacher | null>(null);
  /** T80: "PIN set", for the roster's banner once it is up. */
  const [pinFlash, setPinFlash] = useState<string | null>(null);
  /** T50 review: the mode banner is on every screen, the gate included;
   *  a teacher signing in must not wonder whether the counter is live.
   *  Read once here; FrontDesk reads its own copy as before. */
  const [gateConfig, setGateConfig] = useState<ModeConfig | null>(null);
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

  /* T50: who is signed in, asked once the device is open. Sessions live
   * in server memory (a restart forgets them) and run out at two
   * hours, so the answer can be null at any start; that is the gate,
   * not an error. A failed read is treated the same: the gate can be
   * signed through, a blank screen cannot. */
  useEffect(() => {
    if (phase !== "open") return;
    let cancelled = false;
    setTeacher(undefined);
    fetch("/api/teacher")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled) setTeacher(body?.teacher ?? null);
      })
      .catch(() => {
        if (!cancelled) setTeacher(null);
      });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  /* T89: read whenever the gate could be showing (so a sign-out after a
   * target switch does not leave the gate's banner naming the studio the
   * counter just left) and every 30 seconds after that, which is how an
   * iPad sitting on the gate learns about a switch made elsewhere. */
  useEffect(() => {
    if (phase !== "open") return;
    let cancelled = false;
    const read = () =>
      fetch("/api/config")
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!cancelled && body) setGateConfig(body);
        })
        .catch(() => undefined);
    void read();
    const timer = setInterval(read, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, teacher]);

  /* The one shared chokepoint for "a data fetch answered 401": wrap
   * window.fetch while the app is open. Every call site (FrontDesk, the
   * dev drawer's polling) goes through it, so none of them needs its own
   * 401 handling and a future fetch cannot forget it. The wrapper only
   * OBSERVES same-origin /api responses; it never alters them. A 401
   * carrying `reason: "teacher"` is the comp gate (T48: a wrong PIN, or
   * a comp token that ran out), which the comp dialog handles itself;
   * it is not the device session gone. One carrying `reason: "staff"`
   * is a write refused for want of a Mindbody sign-in (T50: the server
   * restarted or the two hours ran out): the teacher is dropped and
   * the sign-in gate comes back, with the device still open. Any other
   * 401 is the lock. */
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
          const body = await response
            .clone()
            .json()
            .catch(() => null);
          if (body?.reason === "staff") {
            setGateNotice(
              typeof body.error === "string" && body.error ? body.error : null,
            );
            setTeacher(null);
          } else if (!body || body.reason !== "teacher") {
            setPhase("locked");
          }
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
  if (teacher === undefined) return null;
  /* T50: the sign-in gate. The roster, search and Buy are not rendered
   * until someone is signed in; the same form as the account modal,
   * full-screen and not dismissable. */
  if (teacher === null) {
    return (
      <>
        <div className="staff-gate-banner">
          <ModeBanner config={gateConfig} />
        </div>
        <StaffModal
          open
          required
          teacher={null}
          notice={gateNotice}
          onClose={() => undefined}
          onTeacherChange={(t, hasPin) => {
            setGateNotice(null);
            /* T80: false is "no PIN and one could be stored"; null is
             * "PINs are unavailable here", which prompts for nothing. */
            if (t && hasPin === false) setPinPrompt(t);
            setTeacher(t);
          }}
        />
      </>
    );
  }
  /* T80: the PIN prompt stands between the sign-in and the roster, so
   * the teacher who will need a PIN at the first comp of the shift is
   * asked once, while they are still at the counter and not mid-queue.
   * It is a prompt and not a gate: "Not now" goes straight through. */
  if (pinPrompt !== null) {
    return (
      <>
        <div className="staff-gate-banner">
          <ModeBanner config={gateConfig} />
        </div>
        <PinModal
          open
          teacher={pinPrompt}
          mode="set"
          onClose={() => setPinPrompt(null)}
          onDone={() => {
            setPinPrompt(null);
            setPinFlash("PIN set");
          }}
        />
      </>
    );
  }
  return (
    <FrontDesk
      teacher={teacher}
      onTeacherChange={(t, notice) => {
        /* T89: a sign-out with a reason (the studio target changed) says
         * so on the gate; every other call passes no notice and clears
         * whatever was there. */
        setGateNotice(notice ?? null);
        setTeacher(t);
      }}
      initialFlash={pinFlash}
      onInitialFlashShown={() => setPinFlash(null)}
    />
  );
}

/**
 * useSearchParams in a client component must sit under a Suspense boundary
 * (Next requires it for the static shell). The page is fully client-side,
 * so the fallback flashes at most once, before hydration.
 */
export default function FrontDeskPage() {
  /* T70: follows the iPad's own light/dark setting until the sun toggle
   * stores a choice (src/app/theme.ts). */
  useEffect(() => watchSystemTheme(), []);
  /* T98: the one subscription to the visible band, so every modal is
   * centred and sized inside what the teacher can SEE with the iOS
   * keyboard up (src/app/viewport.ts). Mounted here, once, never per
   * modal. */
  useVisualViewport();
  return (
    <Suspense fallback={null}>
      <AuthGate />
    </Suspense>
  );
}
