"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * The sale screen (T23, PLAN 2.1 UI). A full-screen overlay over the
 * roster: receipt-style cart on the left, category chips and the item
 * shelf on the right, per the approved mockup (counter-refresh panel 5).
 *
 * Since T24 the payment seam is live: the method cards light up per real
 * availability (card on file, balance covering the total), and the Charge
 * button POSTs /api/checkout, the one route that moves money -- always
 * from an explicit tap, always pessimistic, with suppression, failure,
 * the under-$10 split failure and an unanswered write each rendered as
 * exactly what they are. The whole payment area still lives behind the
 * <PaymentPanel> boundary, apart from the cart and the pricing loop.
 *
 * Pricing is live and pessimistic: every cart change debounces ~400ms and
 * then asks Mindbody, the SERVER total is what renders, and the two
 * honest failure shapes render loudly -- `disagrees` as a stop-treatment
 * error showing both numbers (the design doc: never swallow a pricing
 * mismatch), `suppressed` as the amber dry-run notice where totals would
 * be, never a made-up number.
 */

/** Mirrors /api/config's payload, as page.tsx holds it. */
export interface ModeConfig {
  dryRun: boolean;
  target: string;
  siteId: string | null;
  configError: string | null;
  writeClientIds: string[];
  banner: string | null;
  /** T38: the server's STUDIO_TAX_RATE, mirrored for the while-pricing
   *  estimate only. Null before the config loads and on the lock
   *  screen's trimmed answer; a line with no rate of its own then shows
   *  its tax as pending rather than guessing one. */
  studioTaxRate?: number | null;
}

/**
 * The mode banner, shared verbatim between the roster page and the sale
 * overlay: a teacher mid-sale must not have to leave the screen to know
 * whether the counter is live.
 */
export function ModeBanner({ config }: { config: ModeConfig | null }) {
  if (!config || config.configError) return null;
  return (
    <p className={config.dryRun ? "banner" : "banner live"}>
      {config.dryRun
        ? "Dry run. Nothing is written to Mindbody."
        : "LIVE. Taps check real students in."}{" "}
      {config.target === "prod" ? "Production" : "Sandbox"} site {config.siteId}.
      {!config.dryRun && config.writeClientIds.length > 0
        ? ` Writes limited to client ${config.writeClientIds.join(", ")}.`
        : ""}
    </p>
  );
}

/** Mirrors src/lib/sale.ts CatalogItem, as /api/catalog serves it. */
interface ShelfItem {
  id: string | number;
  name: string;
  price: number;
  taxExempt: boolean;
  /** The item's own tax rate at the studio, when Mindbody returned one.
   *  Rides every cart line so expectedTotal taxes each line at ITS rate
   *  (the sandbox taxes at 13%, not Fremont's 10.35%; found live). */
  taxRate: number | null;
  type: "Product" | "Service" | "Package";
  categoryId: number | null;
}

/** Mirrors src/lib/sale.ts AutopayScheduleInfo. */
interface AutopayScheduleInfo {
  frequencyType: string | null;
  frequencyValue: number | null;
  frequencyTimeUnit: string | null;
}

/** Mirrors src/lib/sale.ts ContractSummary, as /api/catalog serves it.
 *  A contract is NOT a shelf item: it never enters the cart, and sells
 *  through the dedicated dialog below. */
interface ContractInfo {
  id: number;
  name: string;
  description: string | null;
  firstPaymentTotal: number | null;
  recurringPaymentTotal: number | null;
  totalContractTotal: number | null;
  depositAmount: number | null;
  autopayEnabled: boolean;
  autopaySchedule: AutopayScheduleInfo | null;
  numberOfAutopays: number | null;
  autopayTriggerType: string | null;
  actionUponCompletionOfAutopays: string | null;
  clientsChargedOn: string | null;
  clientsChargedOnSpecificDate: string | null;
  agreementTerms: string | null;
  soldOnline: boolean;
}

interface ShelfCategory {
  label: string;
  categoryIds: number[];
}

/** Mirrors src/lib/bundles.ts CounterBundle, as /api/catalog serves it. */
interface ShelfBundle {
  name: string;
  lines: { type: "Product" | "Service"; id: string | number; quantity: number }[];
}

interface CatalogState {
  categories: ShelfCategory[];
  bundles: ShelfBundle[];
  products: ShelfItem[];
  passes: ShelfItem[];
  /** T30: packages ride the cart like any shelf item. */
  packages: ShelfItem[];
  /** T30: contracts feed the Memberships chip and its dialog only. */
  contracts: ContractInfo[];
}

/** A bundle every line of which resolved against the loaded catalog; only
 *  these render. `total` is the local sum of line prices, shelf-display
 *  only: the cart's real total still comes from /api/price-cart line by
 *  line, exactly as if each item had been tapped individually. */
interface ResolvedBundle {
  name: string;
  total: number;
  items: { item: ShelfItem; quantity: number }[];
}

/**
 * The pinned Favorites chip. Not a Mindbody category: its shelf is the
 * per-device starred items plus the hardcoded bundles, both resolved
 * against the already-loaded catalog, zero extra calls. The label cannot
 * collide with categories.ts (labels there are hand-picked).
 */
const FAVORITES_LABEL = "Favorites";

/** T30's two extra chips. Not Mindbody categories: Packages is fed by
 *  /sale/packages and Memberships by /sale/contracts, both riding the
 *  same /api/catalog response. Each renders only when it has content.
 *  Labels cannot collide with categories.ts (hand-picked there). */
const PACKAGES_LABEL = "Packages";
const MEMBERSHIPS_LABEL = "Memberships";

/** T39.2: rail entries shown before the rest fold behind "more". Seven
 *  is the canvas's count and what a 768px-tall column holds at 64px
 *  entries with 6px gaps. The fold only happens when it hides at least
 *  two: "more" takes a slot of its own, so folding one entry behind it
 *  saves nothing and costs a tap. The studio's rail is exactly eight
 *  (Favorites, five categories, Packages, Memberships), which is the
 *  case that bit. */
const RAIL_LIMIT = 7;

/** One starred type+id pair, as persisted. Packages star like anything
 *  else on the shelf (T30): they are ordinary cart items. */
interface FavPair {
  type: "Product" | "Service" | "Package";
  id: string | number;
}

/** localStorage key, PER TARGET: sandbox stars must never render on the
 *  studio's shelf (item ids differ per site, so at best they would miss;
 *  at worst a sandbox id could collide with an unrelated prod item). */
function favoritesKey(target: string): string {
  return `pos.favorites.${target}`;
}

/** Same key shape the cart uses, so an item is one identity everywhere. */
function itemKey(type: string, id: string | number): string {
  return `${type}-${id}`;
}

/** /api/catalog's payload into shelf state. Shared by the first load and
 *  T38's Recheck, so the two cannot drift. */
function parseCatalog(body: any): CatalogState {
  return {
    categories: body?.categories ?? [],
    bundles: body?.bundles ?? [],
    products: body?.products ?? [],
    passes: body?.passes ?? [],
    packages: body?.packages ?? [],
    contracts: body?.contracts ?? [],
  };
}

/** One rung-up line. Keyed by type+id so re-tapping an item bumps its
 *  quantity instead of adding a duplicate line. */
interface CartEntry {
  key: string;
  item: ShelfItem;
  quantity: number;
}

/** Mirrors src/lib/sale.ts PricedCart, as /api/price-cart returns it. */
interface PricedResult {
  /** True when the cart has no client and no POS_HOUSE_CLIENT_ID is
   *  configured: Mindbody refuses to price a client-less cart (confirmed
   *  live 2026-08-30), so the route answered instantly with only the
   *  local expectedTotal. Rendered as a muted estimate, never an error
   *  and NEVER a chargeable total. */
  needsClient?: boolean;
  suppressed: boolean;
  subTotal: number | null;
  discountTotal: number | null;
  taxTotal: number | null;
  grandTotal: number | null;
  expectedTotal: number;
  disagrees: boolean;
  /** T30: true when the cart holds a package line. The server skips the
   *  strict disagree assertion for these carts (a package row carries no
   *  usable tax info), so the receipt shows a quiet "priced by Mindbody"
   *  line and the server total stands as the only number. */
  packagePricing?: boolean;
  usedPaymentStub: boolean;
  /** T38: present only when `disagrees` is true; one entry per cart
   *  line, both sides' pricing. Diagnostic, never charged. */
  lineAudit?: LineAudit[];
}

/** Mirrors src/lib/sale.ts LineAudit. Built server-side only for a
 *  disagreeing cart (Pete, fifth live test: $130.20 ours against
 *  Mindbody's $258.85, and the stop could not say which line). A null
 *  Mindbody side means no line of theirs matched ours by id, which is
 *  the loudest finding here: the item we sent is not the item priced. */
interface LineAudit {
  name: string | null;
  type: "Product" | "Service" | "Package";
  metadataId: string;
  quantity: number;
  ourPrice: number;
  /** 0 for an exempt line; null when the catalog carried no rate and the
   *  server taxed it at the studio fallback. */
  ourTaxRate: number | null;
  ourExtended: number;
  theirPrice: number | null;
  theirTaxRate: number | null;
  theirQuantity: number | null;
}

/** The client a sale is for, when attached. A subset of the search
 *  result shape, so page.tsx maps into it without this file importing
 *  page types. */
export interface SaleClient {
  id: string;
  name: string;
  balance: number | null;
}

/** Keep in sync with src/lib/sale.ts MAX_LINE_QUANTITY (the server
 *  rejects past it; this clamp is only what keeps the steppers honest). */
const MAX_LINE_QUANTITY = 99;

/** How long a cart holds still before it is priced. Long enough that a
 *  run of +/+/+ taps costs one metered Test call, short enough that the
 *  total never feels stale. */
const PRICE_DEBOUNCE_MS = 400;

function money(n: number): string {
  return n.toLocaleString([], { style: "currency", currency: "USD" });
}

/** A tax rate as the audit table prints it: "10.35%", "no tax". */
function pct(rate: number | null): string {
  if (rate === null) return "no rate";
  if (rate === 0) return "no tax";
  return `${(rate * 100).toLocaleString([], { maximumFractionDigits: 2 })}%`;
}

/** Mirrors src/lib/sale.ts roundToCents (not imported: that module pulls
 *  the server-side Mindbody client, which has no place in the browser
 *  bundle). Same epsilon, same half-up, so the estimate lands on the
 *  same cent expectedTotal would. */
function roundToCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * T38: what the browser can say about a cart BEFORE Mindbody answers
 * (Pete: "loading items to the cart should optimistically be added.
 * currently it's a bit slow due to the network request being awaited").
 * The cart already carries each line's shelf price, exemption and own
 * tax rate; the one thing it may lack is a rate for a line the catalog
 * returned none for, and for that the server's fallback rides in on
 * /api/config. With no fallback in hand the estimate stops at the
 * subtotal and says tax is pending: a rate invented here would be a
 * number with no source, and the design doc's rule is that no such
 * number reaches the screen.
 *
 * Same arithmetic as expectedTotal (per-line rate, one round at the end)
 * so the estimate and the assertion the server makes agree to the cent
 * when the catalog is current. This is an ESTIMATE: it renders muted and
 * labelled, the totals swap to Mindbody's the moment they land, and
 * nothing in the payment seam can read it. `chargeable` requires a
 * fresh server price and did not change.
 */
function estimateCart(
  cart: readonly CartEntry[],
  fallbackRate: number | null,
): { subTotal: number; taxTotal: number | null; grandTotal: number | null } {
  let subTotal = 0;
  let total = 0;
  let taxKnown = true;
  for (const line of cart) {
    const extended = line.item.price * line.quantity;
    subTotal += extended;
    const rate = line.item.taxExempt
      ? 0
      : (line.item.taxRate ?? fallbackRate);
    if (rate === null) {
      taxKnown = false;
      continue;
    }
    total += extended * (1 + rate);
  }
  subTotal = roundToCents(subTotal);
  if (!taxKnown) return { subTotal, taxTotal: null, grandTotal: null };
  const grandTotal = roundToCents(total);
  return {
    subTotal,
    taxTotal: roundToCents(grandTotal - subTotal),
    grandTotal,
  };
}

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

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        d="M5 12h14"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        d="M12 5v14M5 12h14"
      />
    </svg>
  );
}

/** The favorite star. Outline at rest; the `.shelf-star.on` CSS fills it
 *  with the warn/gold token. */
function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8L12 3.6z"
      />
    </svg>
  );
}

/** Stored-card icon, from the mockup's method card. */
function CardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="30"
      height="30"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  );
}

/** Account-credit icon: a coin with a dollar sign. Deliberately NOT a
 *  rectangle -- the earlier note shape read as a second credit card next
 *  to the stored-card button (Pete, fourth live test). */
function CreditIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="30"
      height="30"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path
        strokeWidth="1.8"
        d="M12 6.6v10.8M14.7 9.6c-.5-.8-1.5-1.3-2.7-1.3-1.6 0-2.8.8-2.8 1.9 0 2.5 5.6 1.2 5.6 3.8 0 1.1-1.2 1.9-2.8 1.9-1.2 0-2.2-.5-2.7-1.3"
      />
    </svg>
  );
}

/** Cash icon, from the mockup's method card. */
function CashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="30"
      height="30"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="7" width="20" height="10" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

/** The card on file, as /api/stored-card serves it. */
export interface StoredCardInfo {
  lastFour: string;
  expMonth: string | null;
  expYear: string | null;
  expired: boolean;
}

/** The attached client's payment profile as /api/stored-card serves it,
 *  with its fetch lifecycle. Held by SaleScreen, refetched after every
 *  charge that may have moved money (a sale spends credit, so the number
 *  beside the name goes stale the moment it completes). */
interface CardLookup {
  /** Who this lookup is FOR: a stale answer for the previous client must
   *  never gate the current one's methods. */
  clientId: string;
  loading: boolean;
  card: StoredCardInfo | null;
  /** Account credit, as of this lookup. Null when Mindbody reports none
   *  or the read failed. */
  balance: number | null;
  error: string | null;
}

/** A source of tender. Comp is deliberately absent: it is a whole-sale
 *  gesture with its own hold, not a tender line, and /api/checkout
 *  refuses it inside a split for the same reason. */
type TenderSource = "storedcard" | "credit" | "cash";

/**
 * T35: one line of the tender against the amount due. A whole sale is
 * one line; a split is two, which is the maximum /api/checkout accepts.
 * `cents` is what was ENTERED, in integer cents so lines can only sum
 * exactly: only cash may be entered above what it covers, and that
 * surplus is the teacher's change, never money charged.
 */
interface TenderLine {
  id: number;
  source: TenderSource;
  cents: number;
}

/** Keep in sync with src/lib/sale.ts CARD_MINIMUM_USD. The server
 *  refuses a card leg under it regardless; this mirror only lets the
 *  Charge button grey with the reason instead of a round trip. */
const CARD_MINIMUM_USD = 10;

/** What the last Charge tap came back as. Every shape here is an HONEST
 *  outcome: suppression is amber and never a receipt, a split failure is
 *  a stop block, an unanswered write says it may have gone through. */
type ChargeResult =
  | { kind: "paid"; summary: string; detail: string | null }
  | { kind: "suppressed"; mode: string }
  | { kind: "split"; message: string; mindbody: string }
  | { kind: "ambiguous"; message: string }
  | { kind: "error"; message: string };

/** Hold-to-arm duration for the Comp method: long enough that a graze
 *  cannot select it, short enough to not feel broken. */
const COMP_HOLD_MS = 700;

/**
 * THE T24 SEAM, now live, and since the second live test the whole LEFT
 * column: the tender block above the receipt, the receipt itself (passed
 * in, so the cart and pricing loop stay outside the seam), the comp hold,
 * the charge button and the outcome panel. The invariants inherited from
 * T23 are kept verbatim: never charge an empty, in-flight, suppressed, or
 * disagreeing cart; the button restates the server's number or none. On
 * top of them: nothing fires without an explicit tap, one charge can be
 * in flight at a time (ref-guarded, button disabled), and a failed or
 * ambiguous outcome renders with enough truth that re-tapping cannot
 * quietly double-charge.
 *
 * T35 replaced the method row, the cash-tender modal and split mode with
 * ONE model: tender lines against an amount due; T36 put the amount
 * editor back in a modal, in the old cash modal's idiom, generalized to
 * every source. What that left alone is the money: the request shapes, the
 * single flight, the availability rules, the honest outcomes and the
 * server's authority over every number are all exactly as they were.
 */
function PaymentPanel(props: {
  cart: readonly CartEntry[];
  priced: PricedResult | null;
  pricing: boolean;
  client: SaleClient | null;
  cardLookup: CardLookup | null;
  /**
   * T39.6: whether the payment surface is on screen. SaleScreen keeps this
   * panel MOUNTED in both modes and hides it in shelf mode, so the tender
   * lines and the keypad survive Back to items without lifting T35's
   * state out of here. Going hidden dismisses an open keypad (reported
   * up, so Escape is not left blocked) and clears an armed comp: comp is
   * never armed while invisible (T33's rule, layout plan 5).
   */
  visible: boolean;
  /**
   * T39.6: the bar's primary slot. In pay mode the panel renders the
   * bar's `Due $X` / `Charge $total` button THROUGH this element (a
   * portal), so the button and `chargeable` come out of the same render:
   * the bar reads the gate the panel computed, never a copy reported by
   * an effect after paint. Null until the bar has mounted.
   */
  barSlot: HTMLElement | null;
  /** T39.6: what SaleScreen wants said above the figures in pay mode --
   *  the suppressed notice, the disagree stop with T38's audit table --
   *  so the figures never stand next to a total they contradict. The
   *  ticket keeps its own copy. */
  notice: ReactNode;
  /** Clear the cart: the sale is recorded on Mindbody's side. */
  onSold: () => void;
  /** The paid receipt's Done: close the overlay back to the roster. */
  onDone: () => void;
  /**
   * A charge finished in a state that may have moved money, so everything
   * this screen shows about the client (credit above all, and the roster
   * underneath) is now a stale snapshot. Fired for a completed sale, for
   * the credit-purchased split failure, and for an ambiguous outcome --
   * never for a definite refusal or a suppressed write, where nothing
   * changed. Re-reading is the honest move in all three: it is a read,
   * and it cannot make a wrong number righter than the truth.
   */
  onClientDataStale: () => void;
  /** Mirrors the in-flight charge up to SaleScreen so ambient Escape
   *  cannot close the overlay while money is moving. */
  onBusyChange: (busy: boolean) => void;
  /** Mirrors an open payment surface up to SaleScreen so the Escape that
   *  closes it cannot also close the overlay. Since T36 that surface is
   *  the amount modal: one keypad over a scrim, for whichever tender
   *  line was tapped. */
  onModalChange: (open: boolean) => void;
  /** Bumped by SaleScreen when "Empty cart" is confirmed on a client
   *  change (third live test): the cart is gone, so every tender line and
   *  any armed comp goes with it. */
  cartResetNonce: number;
}) {
  const {
    cart,
    priced,
    pricing,
    client,
    cardLookup,
    visible,
    barSlot,
    notice,
    onSold,
    onDone,
    onClientDataStale,
    onBusyChange,
    onModalChange,
    cartResetNonce,
  } = props;

  /**
   * T35: ONE tender model. There is no split MODE and no single-method
   * arming any more -- there is a LIST of tender lines against an amount
   * due, and a split is simply the case where the list has two. Tapping a
   * source adds a line pre-filled with the whole remaining due, clamped by
   * that source's rule, so the ordinary whole-sale case is one tap and no
   * typing.
   *
   * Amounts live in integer CENTS throughout, so lines can only ever sum
   * exactly; the dollars figures below are derived for display and for
   * the request, never accumulated.
   */
  const [lines, setLines] = useState<readonly TenderLine[]>([]);
  const nextLineId = useRef(1);
  /** Comp stays OUT of the list: it is a whole-sale gesture with its own
   *  hold, not a tender. Arming it clears the lines; adding a line
   *  disarms it. The two can never both be set. */
  const [comped, setComped] = useState(false);
  /** The amount modal: the id of the tender line it is editing, or null.
   *  ONE keypad for every source, over a scrim (T36, Pete: "having it be
   *  a modal is def better than this"), so opening it moves nothing in
   *  the payment column. No OS keyboard anywhere in the payment seam. */
  const [padFor, setPadFor] = useState<number | null>(null);
  /** Digits typed since the modal opened, accumulating into CENTS
   *  (2-0-0-0 reads $20.00), exactly as the cash tender field did. Empty
   *  means nothing was typed, and Done then leaves the line as it was. */
  const [entry, setEntry] = useState("");
  const [charging, setCharging] = useState(false);
  const [result, setResult] = useState<ChargeResult | null>(null);
  /** T39.6: leaving pay mode with comp armed clears it (never armed while
   *  invisible), and the surface says so ONCE on return, in the quiet
   *  line, until the next tender gesture. */
  const [compCleared, setCompCleared] = useState(false);
  /** A bare tap on Comp (which arms on a hold, not a tap) shows how in
   *  the quiet line rather than doing nothing. */
  const [compHint, setCompHint] = useState(false);
  /** The double-fire lock. State alone re-renders too late for a fast
   *  double tap; the ref is checked synchronously in the handler. */
  const inFlight = useRef(false);
  const compTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* While a pricing call (or its debounce) is pending, `priced` still
   * holds the PREVIOUS cart's totals. Treat that as no total at all: the
   * Charge button must never restate a number the current cart has not
   * earned, stale-but-disabled included. */
  const total =
    !pricing && priced && !priced.suppressed && !priced.disagrees
      ? priced.grandTotal
      : null;

  /** A fresher balance than the attach snapshot, learned from a split
   *  failure's report: it is what lets Account credit light up so the
   *  honest retry (spend the credit that now exists) is available while
   *  the dangerous one (buy it again) is not. */
  const [freshBalance, setFreshBalance] = useState<number | null>(null);

  const card = cardLookup?.card ?? null;
  /* Freshest first: a refusal's reported balance, then the profile lookup
   * (refetched after every charge), then the attach snapshot the roster
   * row supplied. Only lookups for THIS client count. */
  const lookedUpBalance =
    cardLookup && cardLookup.clientId === (client?.id ?? null)
      ? cardLookup.balance
      : null;
  const balance = freshBalance ?? lookedUpBalance ?? client?.balance ?? null;
  /* The attach snapshot (or a split failure's fresher report) gates the
   * button; /api/checkout re-reads the balance server-side and never
   * trusts this number. */
  const balanceCoversTotal =
    balance !== null && total !== null && balance >= total;

  const totalCents = total === null ? null : Math.round(total * 100);
  const balanceCents = balance === null ? null : Math.round(balance * 100);

  const clientId = client?.id ?? null;

  /** Close the amount modal without touching the lines, and tell
   *  SaleScreen the payment surface is closed -- otherwise a modal
   *  dismissed by a reset rather than by its own Cancel would leave
   *  Escape blocked. This IS Cancel: the amount the line had when the
   *  modal opened stands. */
  const dismissPad = useCallback(() => {
    setPadFor(null);
    setEntry("");
    onModalChange(false);
  }, [onModalChange]);

  /** Blank the whole tender: every line, the amount modal, and comp. Used by
   *  each of the reset paths below and by a completed sale. */
  const resetTender = useCallback(() => {
    setLines([]);
    setComped(false);
    setCompCleared(false);
    setCompHint(false);
    dismissPad();
  }, [dismissPad]);

  /* ANY client change -- detach, attach, or the per-row Buy button
   * switching straight from one client to another -- invalidates the
   * tender: the lines were chosen against the OLD client's card, credit
   * and total, and a line armed for client A must not stay armed for
   * client B (whose card or credit may not even exist; the server would
   * refuse, but the button must not offer it). */
  useEffect(() => {
    setFreshBalance(null);
    resetTender();
  }, [clientId, resetTender]);

  /* A cart EDIT retires a stale receipt; warnings stay until dismissed.
   * The empty cart is skipped deliberately: a successful charge clears the
   * cart in the same commit that sets the receipt, and this effect firing
   * on that clear would wipe the receipt before the teacher saw it.
   *
   * The tender lines go with the edit: every amount in them was entered
   * against the OLD cart's total, and a stale line that happened to cover
   * the new one would let the Charge button fire on numbers nobody chose.
   * Comp survives, as it always has: it is a gesture about the whole sale,
   * and the button restates whatever the fresh total turns out to be. */
  useEffect(() => {
    if (cart.length === 0) return;
    setResult((r) => (r?.kind === "paid" ? null : r));
    setLines([]);
    dismissPad();
  }, [cart, dismissPad]);

  /* "Empty cart" on the client-change dialog: the cart SaleScreen just
   * cleared was what the tender was for, so nothing stays armed, comp
   * included. */
  useEffect(() => {
    if (cartResetNonce === 0) return;
    resetTender();
  }, [cartResetNonce, resetTender]);

  useEffect(() => {
    return () => {
      if (compTimer.current) clearTimeout(compTimer.current);
    };
  }, []);

  /* PaymentPanel unmounts when the overlay closes; an amount modal that
   * was somehow open must not leave SaleScreen believing something still
   * blocks Escape on the next open. */
  useEffect(() => {
    return () => onModalChange(false);
  }, [onModalChange]);

  /* T39.6: the panel going HIDDEN (Back to items, Escape out of pay mode)
   * is a path that leaves pay mode, so it dismisses an open keypad and
   * reports the close upward like every other one (T35 review), and it
   * clears an armed comp: comp arms only in pay mode and is never armed
   * while invisible. The comp button itself cannot be held while hidden
   * (display: none takes no pointer), and every mode switch is a discrete
   * event whose effects React flushes before paint, so no frame ever
   * shows the shelf with comp armed behind it. The lines stay: a
   * last-second towel must not cost a re-entered split (layout plan 2.5). */
  useEffect(() => {
    if (visible) return;
    dismissPad();
    setCompHint(false);
    if (comped) {
      setComped(false);
      setCompCleared(true);
    }
  }, [visible, comped, dismissPad]);

  /* Source availability. An unavailable source renders greyed WITH the
   * reason, never hidden (PLAN 2.2: "account credit ($12) greyed out
   * beats a failure"). */
  const cardReason = !client
    ? "Attach a client"
    : cardLookup?.loading
      ? "Checking for a card..."
      : cardLookup?.error
        ? "Card check failed"
        : !card
          ? "No card on file"
          : card.expired
            ? `Card ...${card.lastFour} is expired`
            : null;
  const cardDetail = card && !card.expired ? `Card ...${card.lastFour}` : null;

  /* Credit's own gate is the client and the balance EXISTING. Whether the
   * balance covers the whole total is no longer a blocker: a credit line
   * clamps to min(balance, due) and a second line pays the rest, which is
   * the T28 reversal of assumption P2 (partial credit) made ordinary. */
  const creditReason = !client
    ? "Attach a client"
    : balance === null || balance <= 0
      ? "No credit on account"
      : null;
  const creditLabel =
    balance !== null && balance > 0
      ? `Account credit (${money(balance)})`
      : "Account credit";

  /**
   * Whether Credit is OFFERED at all (Pete, fourth live test: "if there's
   * no balance, it shouldn't be a visible option"). Most sales are to
   * people with no account credit, and a permanently greyed button is
   * noise on the one row that has to be read at a glance.
   *
   * The one exception is the split-failure seam: a $10 credit purchase
   * certainly went through, and if the balance read that follows it
   * failed, the number here is null. Hiding the honest retry (spend the
   * credit that now exists) is the worst outcome on that screen, so the
   * source stays while that warning is up.
   */
  const creditVisible =
    (balance !== null && balance > 0) || result?.kind === "split";

  /* A source that is no longer on screen must not stay in the tender:
   * credit can vanish under the teacher (the post-sale profile refetch
   * reports the balance the sale just spent). */
  useEffect(() => {
    if (creditVisible) return;
    setLines((cur) =>
      cur.some((l) => l.source === "credit")
        ? cur.filter((l) => l.source !== "credit")
        : cur,
    );
  }, [creditVisible]);

  /* An amount modal whose LINE has gone must not stay open in name only.
   * Every deliberate path (removeLine, Cancel, Done, the resets)
   * dismisses it, but the credit-visibility filter above removes a line
   * WITHOUT going through them: after it fires, this panel renders no
   * modal while SaleScreen still believes one owns Escape, so the next
   * Escape press is eaten instead of closing the overlay. Reachable: a
   * modal left open on a credit line while a charge comes back
   * ambiguous, whose balance refetch then drops the credit to zero. */
  useEffect(() => {
    if (padFor === null) return;
    if (lines.some((l) => l.id === padFor)) return;
    dismissPad();
  }, [padFor, lines, dismissPad]);

  /* ---------------------- T35: the tender math ---------------------- */

  /**
   * What each line actually COVERS of the total. Only cash may be given
   * more than it owes, so a line's covered amount is its entered amount
   * capped by what is still unpaid; the surplus is change, never money
   * charged. Cash covers LAST, whatever its position in the list (T36
   * review): the other line is clamped to its cap and recomputed as the
   * remainder on Done, so it is exactly what the teacher chose to spend
   * from it, and only cash can be the line with a surplus. With cash
   * first in the list and entered above the whole total, list order
   * gave cash everything and left the partner uncovered, which refused
   * the tender with "Re-enter the amounts" and showed a different change
   * figure from the one the modal had just promised. The indexes stay
   * aligned with `lines`: the request legs read `coverage[i]`.
   */
  const coverage = useMemo(() => {
    const covered: number[] = lines.map(() => 0);
    let remaining = totalCents ?? 0;
    const order = [
      ...lines.map((_, i) => i).filter((i) => lines[i]?.source !== "cash"),
      ...lines.map((_, i) => i).filter((i) => lines[i]?.source === "cash"),
    ];
    for (const i of order) {
      const line = lines[i] as TenderLine;
      const c =
        totalCents === null ? 0 : Math.max(0, Math.min(line.cents, remaining));
      covered[i] = c;
      remaining -= c;
    }
    return covered;
  }, [lines, totalCents]);

  const coveredCents = coverage.reduce((sum, c) => sum + c, 0);
  const dueCents = totalCents === null ? null : totalCents - coveredCents;
  /** Over-tendered cash, which is the teacher's change to hand back. */
  const changeCents = lines.reduce(
    (sum, line, i) => sum + Math.max(0, line.cents - (coverage[i] ?? 0)),
    0,
  );

  /**
   * The most a line may be TYPED to. Cash is uncapped (null) -- it is the
   * only source that may exceed what it owes. Card caps at the total;
   * credit caps at the total and the account balance both. A clamped
   * source can never be entered above its cap: the modal clamps every
   * keystroke AND every chip, so no entry above the cap is ever held.
   *
   * With a second line present that line is recomputed as the remainder
   * (see applyPad), so the cap here is the whole total less one cent --
   * the cent that keeps the other line from falling to zero. Removing it
   * with its x is how a split becomes a whole-sale payment.
   */
  const capFor = (source: TenderSource): number | null => {
    if (source === "cash") return null;
    if (totalCents === null) return 0;
    const room = Math.max(0, totalCents - (lines.length === 2 ? 1 : 0));
    if (source === "credit") {
      return balanceCents === null ? 0 : Math.min(room, balanceCents);
    }
    return room;
  };

  const usedSources = new Set(lines.map((l) => l.source));

  /** Why this source cannot ADD a line right now, or null. */
  const addReason = (source: TenderSource): string | null => {
    if (usedSources.has(source)) return "Already in the payment";
    /* Two lines is the maximum because /api/checkout accepts one method
     * or exactly two legs. Greyed WITH that reason, never hidden. */
    if (lines.length >= 2) return "Two parts is the maximum";
    /* T38: while the ticket shows the browser's estimate the sources
     * stay greyed with the reason. A tender line pre-fills from the due,
     * and the due is null until Mindbody's number lands; a line taken
     * against an estimate would be exactly the stale amount the cart-edit
     * reset exists to prevent. */
    if (total === null) {
      return pricing ? "Pricing with Mindbody..." : "No total to pay yet";
    }
    if (dueCents !== null && dueCents <= 0) return "Nothing left to pay";
    if (source === "credit") return creditReason;
    if (source === "storedcard") {
      if (cardReason !== null) return cardReason;
      /* Rule 1 of the $10 minimum: when credit covers the total, credit
       * IS the method and the card is not offered. It applies to a
       * WHOLE-sale card payment only -- adding the card as the first and
       * therefore only line -- because a deliberate two-leg split is the
       * opposite of the ambiguity rule 1 guards against (the T28
       * reversal). /api/checkout takes the same reading. */
      if (lines.length === 0 && balanceCoversTotal) {
        return `Credit covers this (${money(balance as number)})`;
      }
    }
    return null;
  };

  /**
   * Why a line already in the tender cannot be charged, or null. This is
   * T33's methodOffered check, extended to the new model: availability is
   * read off the same reasons the source buttons are greyed by, in the
   * SAME render that enables the Charge button, so the two can never
   * disagree even for the one frame before a disarm effect runs.
   */
  const lineReason = (line: TenderLine, index: number): string | null => {
    if (line.cents <= 0) return "Enter an amount";
    const covered = coverage[index] ?? 0;
    /* A non-cash line whose entered amount is not fully covered means the
     * total moved under it; only cash may exceed its coverage. Unreachable
     * in normal use (every path that changes the total clears the lines),
     * and refused here rather than silently charging a different figure
     * from the one on screen. */
    if (line.source !== "cash" && covered !== line.cents) {
      return "Re-enter the amounts against the current total";
    }
    if (covered <= 0) return "Enter an amount";
    if (line.source === "credit") {
      if (creditReason !== null) return creditReason;
      if (balanceCents === null || balanceCents < line.cents) {
        return `Only ${money(balance ?? 0)} on account`;
      }
      return null;
    }
    if (line.source === "storedcard") {
      if (cardReason !== null) return cardReason;
      /* Rule 1 again, for a card that has BECOME the whole sale (the
       * other line was removed under it). */
      if (lines.length === 1 && balanceCoversTotal) {
        return `Credit covers this (${money(balance as number)})`;
      }
      /* The $10 minimum bites on a card LEG of a split, which the server
       * refuses outright; a whole-sale card under $10 is fine, since that
       * is PLAN 2.3's credit-purchase path. */
      if (lines.length === 2 && covered < CARD_MINIMUM_USD * 100) {
        return `The card leg is under the $${CARD_MINIMUM_USD} card minimum`;
      }
      return null;
    }
    return null;
  };

  const lineReasons = lines.map((line, i) => lineReason(line, i));
  const firstLineProblem = lineReasons.find((r) => r !== null) ?? null;

  const tenderValid =
    lines.length > 0 &&
    lines.length <= 2 &&
    usedSources.size === lines.length &&
    firstLineProblem === null;

  const chargeable =
    cart.length > 0 &&
    !pricing &&
    total !== null &&
    !charging &&
    (comped
      ? lines.length === 0
      : /* Due EXACTLY zero: the lines cover the server's total to the
           cent, no more and no less (cash surplus is change, not
           coverage). */
        dueCents === 0 && tenderValid);

  const sourceLabel = (s: TenderSource) =>
    s === "storedcard" ? "Card" : s === "credit" ? "Credit" : "Cash";

  /** One leg of a split, as the Charge button restates it. The cash leg
   *  reads "collect $X cash": the leg amount IS what is collected. */
  const legLabel = (s: TenderSource, usd: number) =>
    s === "storedcard"
      ? `${money(usd)} card`
      : s === "credit"
        ? `${money(usd)} credit`
        : `collect ${money(usd)} cash`;

  const soleLine = lines.length === 1 ? lines[0] : undefined;

  const chargeLabel = comped
    ? total === null
      ? "Charge"
      : `Comp ${money(total)}`
    : total === null
      ? "Charge"
      : lines.length === 2
        ? `Charge ${legLabel(
            (lines[0] as TenderLine).source,
            (coverage[0] ?? 0) / 100,
          )} + ${legLabel(
            (lines[1] as TenderLine).source,
            (coverage[1] ?? 0) / 100,
          )}`
        : soleLine === undefined
          ? "Charge"
          : soleLine.source === "cash"
            ? `Record ${money(total)} cash`
            : `Charge ${money(total)}`;

  const doCharge = async () => {
    /* Single flight: the ref refuses a second tap even in the same
     * render tick, and the button is disabled for every later one. */
    if (inFlight.current || !chargeable) return;
    /**
     * The one payment instruction this tap sends, in the two shapes
     * /api/checkout has always accepted and which T35 does not touch:
     * one line is `{ method, cashTendered? }`, two lines are
     * `{ split: { legs } }`. A cash leg sends what it COVERS, never the
     * over-tendered figure; the tendered figure rides as `cashTendered`
     * on a single-line sale only (the route refuses it beside a split,
     * where a leg's amount already IS what is collected).
     */
    const legs = lines.map((line, i) => ({
      method: line.source,
      amount: (coverage[i] ?? 0) / 100,
    }));
    const payment = comped
      ? { method: "comp" as const }
      : legs.length === 2
        ? { split: { legs } }
        : soleLine !== undefined && legs[0] !== undefined
          ? {
              method: soleLine.source,
              ...(soleLine.source === "cash"
                ? { cashTendered: soleLine.cents / 100 }
                : {}),
            }
          : null;
    if (payment === null) return;
    const isSplit = "split" in payment;
    inFlight.current = true;
    setCharging(true);
    onBusyChange(true);
    setResult(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: cart.map((line) => ({
            type: line.item.type,
            metadataId: line.item.id,
            quantity: line.quantity,
            price: line.item.price,
            taxExempt: line.item.taxExempt,
            taxRate: line.item.taxRate,
          })),
          ...(clientId ? { clientId } : {}),
          ...payment,
        }),
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* fall through to the status-code handling below */
      }
      /* Any answer carrying the live balance refreshes the credit gate:
       * a method-stage refusal ("credit covers this") and the split
       * failure both name the number the next decision must be made on. */
      if (typeof body?.creditBalance === "number") {
        setFreshBalance(body.creditBalance);
      }
      if (body === null && (res.ok || res.status >= 500)) {
        /* A 200 whose body could not be read, or a 500-class answer with
         * no readable verdict (a gateway 502/504 serves HTML): the route
         * may have run, and charged, before the answer was lost, so this
         * must NOT render as "not charged". Only a readable refusal or a
         * 4xx earns the definite error branch below. */
        setResult({
          kind: "ambiguous",
          message: res.ok
            ? "The server answered but the outcome could not be read."
            : `The server's answer (HTTP ${res.status}) carried no readable outcome.`,
        });
        onClientDataStale();
      } else if (res.ok && body?.ok === true) {
        /* The paid summary names how it was paid; a split names BOTH
         * legs, amounts included, so the drawer count and the statement
         * both have their line. */
        const legDesc = (m: TenderSource, usd: number) =>
          m === "storedcard"
            ? `${money(usd)} on the stored card${card ? ` ...${card.lastFour}` : ""}`
            : m === "credit"
              ? `${money(usd)} account credit`
              : `${money(usd)} cash`;
        const methodName = isSplit
          ? legs.map((leg) => legDesc(leg.method, leg.amount)).join(" + ")
          : comped
            ? "comp"
            : soleLine === undefined
              ? "the payment"
              : soleLine.source === "storedcard"
                ? `stored card${card ? ` ...${card.lastFour}` : ""}`
                : soleLine.source === "credit"
                  ? "account credit"
                  : "cash";
        onSold();
        /* The sale stands, so every client number this screen holds is a
         * pre-sale snapshot: drop the one learned from a refusal and let
         * the refetch onClientDataStale triggers be the answer. */
        setFreshBalance(null);
        onClientDataStale();
        setResult({
          kind: "paid",
          summary: `Paid ${money(body?.total ?? total)} by ${methodName}${
            client ? ` for ${client.name}` : ""
          }.`,
          detail: [
            body?.saleId ? `Sale ${body.saleId}.` : null,
            body?.creditPurchased
              ? `Includes a ${money(body.creditPurchased)} account credit purchase (card minimum); the unspent remainder stays on their account.`
              : null,
          ]
            .filter(Boolean)
            .join(" ") || null,
        });
        /* The sale is over: the tender goes with it. */
        resetTender();
      } else if (res.ok && body?.suppressed) {
        setResult({ kind: "suppressed", mode: String(body.suppressed) });
      } else if (body?.stage === "checkout-after-credit") {
        /* THE seam, rendered verbatim and prominent: the credit exists,
         * the sale does not, and the credit step must not run again. The
         * tender is CLEARED so a bare re-tap of Charge is impossible,
         * and the fresh balance lets Credit light up: the honest retry
         * is spending the credit that now exists, never re-buying it, so
         * there is no retry affordance on the credit step. */
        resetTender();
        /* The credit purchase went through: their balance really did
         * change, whatever happened to the checkout after it. */
        onClientDataStale();
        setResult({
          kind: "split",
          message:
            `The $10 credit purchase succeeded; the checkout failed; ` +
            `their balance is now ${
              typeof body?.creditBalance === "number"
                ? money(body.creditBalance)
                : "unknown (Mindbody did not answer the balance read)"
            }; do NOT re-run the credit step.`,
          mindbody: String(body?.error ?? "no reason returned"),
        });
      } else if (body?.ambiguous === true) {
        setResult({
          kind: "ambiguous",
          message: String(body?.error ?? "The charge did not answer."),
        });
        onClientDataStale();
      } else {
        setResult({
          kind: "error",
          message: String(body?.error ?? `HTTP ${res.status}`),
        });
      }
    } catch {
      /* The request itself died between us and the server: the outcome
       * is UNKNOWN, and the one wrong move is to invite a retry. */
      setResult({ kind: "ambiguous", message: "" });
      onClientDataStale();
    } finally {
      inFlight.current = false;
      setCharging(false);
      onBusyChange(false);
    }
  };

  /** Retire a stale warning when the teacher changes the tender; a paid
   *  receipt stays until Done. */
  const clearStaleResult = () =>
    setResult((r) => (r && r.kind !== "paid" ? r : null));

  /** Tapping a source ADDS a line for the whole remaining due, clamped by
   *  that source's rule: one tap, no typing, for the ordinary whole-sale
   *  case. */
  const addLine = (source: TenderSource) => {
    if (addReason(source) !== null || charging) return;
    if (dueCents === null || dueCents <= 0) return;
    const cents =
      source === "credit"
        ? Math.min(dueCents, balanceCents ?? 0)
        : dueCents;
    if (cents <= 0) return;
    const id = nextLineId.current++;
    /* Adding a tender disarms comp: the sale is being paid for. */
    setComped(false);
    setCompCleared(false);
    setCompHint(false);
    setLines((cur) => [...cur, { id, source, cents }]);
    dismissPad();
    clearStaleResult();
  };

  const removeLine = (id: number) => {
    setLines((cur) => cur.filter((l) => l.id !== id));
    if (padFor === id) dismissPad();
    setCompCleared(false);
    setCompHint(false);
    clearStaleResult();
  };

  /** Tapping a line's amount opens the amount modal for THAT line. Entry
   *  starts empty, register-style: the first digit replaces the figure
   *  rather than appending to it, and an empty entry on Done means the
   *  line keeps the amount it already had. */
  const openPad = (id: number) => {
    setPadFor(id);
    setEntry("");
    onModalChange(true);
    setCompCleared(false);
    setCompHint(false);
    clearStaleResult();
  };

  const padIndex = lines.findIndex((l) => l.id === padFor);
  const padLine = padIndex >= 0 ? lines[padIndex] : undefined;
  const padCap = padLine === undefined ? null : capFor(padLine.source);

  /** Hold a typed or chipped figure to its source's cap. Cash returns
   *  null from capFor and is therefore never clamped: it is the one
   *  source that may be given more than it owes. */
  const clampFor = (source: TenderSource, cents: number) => {
    const cap = capFor(source);
    return cap === null ? cents : Math.min(cents, cap);
  };

  /** What THIS line has to cover for the due to reach zero, given the
   *  other line as it currently stands. It is the modal's "Amount due"
   *  row, the Exact chip's figure, and what a cash surplus is measured
   *  against. */
  const padDueCents =
    padIndex < 0 || dueCents === null
      ? null
      : dueCents + (coverage[padIndex] ?? 0);

  /** The amount the modal would apply: what has been typed, or the
   *  line's existing amount when nothing has been. */
  const draftCents =
    padLine === undefined
      ? 0
      : entry === ""
        ? padLine.cents
        : parseInt(entry, 10);

  /* The OTHER line of a two-line tender, and what Done would recompute it
   * to. Editing one line moves the other, so the modal says so rather
   * than calling a part-payment "short". */
  const padPartner =
    lines.length === 2 && padIndex >= 0 ? lines[1 - padIndex] : undefined;
  const padRest =
    totalCents === null ? null : Math.max(0, totalCents - draftCents);
  const padPartnerCents =
    padPartner === undefined || padRest === null || padRest <= 0
      ? null
      : padPartner.source === "credit"
        ? Math.min(padRest, balanceCents ?? 0)
        : padRest;
  /** Over the due (cash only, since every other source is clamped) is the
   *  teacher's change; under it, on a single-line tender, is short. */
  const padSurplus = padDueCents === null ? null : draftCents - padDueCents;

  /** One key. Digits accumulate into CENTS, and a clamped source is
   *  clamped on every keystroke, so the entry can never hold an amount
   *  above the cap even mid-typing. */
  const padTap = (key: string) => {
    if (padLine === undefined) return;
    if (key === "back") {
      setEntry((cur) => cur.slice(0, -1));
      return;
    }
    const digits = (entry + key).replace(/^0+(?=\d)/, "");
    if (digits.length > 7) return;
    const typed = digits === "" ? 0 : parseInt(digits, 10);
    if (!Number.isFinite(typed)) return;
    const clamped = clampFor(padLine.source, typed);
    setEntry(clamped === typed ? digits : String(clamped));
  };

  /** A chip SETS the amount, as the old cash modal's chips did. Cash
   *  only, per Pete: the other sources can never exceed their due, so a
   *  $20 chip on a $14 card line would only ever be a clamp. */
  const padChip = (cents: number) => {
    if (padLine === undefined) return;
    setEntry(String(Math.max(0, clampFor(padLine.source, cents))));
  };

  /** Done: apply what was typed to the line, and close. Nothing typed
   *  leaves the line exactly as it was -- it does NOT remove it, since
   *  Cancel covers that intent and an editing modal that deletes the row
   *  it was opened on is a trap. */
  const applyPad = () => {
    const line = padLine;
    if (line !== undefined && entry !== "") {
      const cents = clampFor(line.source, parseInt(entry, 10));
      /* Editing one line of a two-line tender RECOMPUTES the other as the
       * remainder (clamped by its own rule), so the lines can only ever
       * sum to the server's total. The one exception is a cash line above
       * the whole total: there is no remainder left to give the other
       * line, so it keeps what it has and the surplus is change. */
      const rest =
        totalCents === null ? null : Math.max(0, totalCents - cents);
      setLines((cur) =>
        cur.map((l) => {
          if (l.id === line.id) return { ...l, cents };
          if (cur.length !== 2 || rest === null || rest <= 0) return l;
          const other =
            l.source === "credit" ? Math.min(rest, balanceCents ?? 0) : rest;
          return { ...l, cents: other };
        }),
      );
      clearStaleResult();
    }
    dismissPad();
  };

  /* Escape closes the amount modal, and closes it as CANCEL (never
   * mid-charge). SaleScreen skips its own overlay-close for the same
   * press via onModalChange. */
  useEffect(() => {
    if (padFor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !charging) dismissPad();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [padFor, charging, dismissPad]);

  /* Comp arms on a HOLD, not a tap: it hands goods over for nothing, so
   * it cannot sit where a fat finger lands. Unselecting is a plain tap
   * (the click handler below); the ref swallows the click the browser
   * fires at the END of a completed hold so arming and disarming cannot
   * happen in the same gesture. */
  const compHeld = useRef(false);
  const armComp = () => {
    /* T39.6: never armed while invisible. The hold cannot start on a
     * hidden button, but a hold that began just before Back to items
     * could complete after it; the timer's callback lands here and is
     * refused. */
    if (!visible) return;
    /* Comp is the whole sale given away, so it cannot coexist with a
     * tender: arming it clears the lines. */
    setLines([]);
    dismissPad();
    setComped(true);
    setCompCleared(false);
    setCompHint(false);
    clearStaleResult();
  };
  const compHoldStart = () => {
    if (compTimer.current) clearTimeout(compTimer.current);
    compTimer.current = setTimeout(() => {
      compTimer.current = null;
      compHeld.current = true;
      armComp();
    }, COMP_HOLD_MS);
  };
  const compHoldEnd = () => {
    if (compTimer.current) {
      clearTimeout(compTimer.current);
      compTimer.current = null;
    }
  };
  /* A pointer that leaves or is cancelled will never produce the click,
   * so the swallow flag must not survive it and eat the NEXT tap. */
  const compHoldAbort = () => {
    compHoldEnd();
    compHeld.current = false;
  };
  const compClick = () => {
    if (compHeld.current) {
      compHeld.current = false;
      return;
    }
    /* A bare tap never ARMS comp; it only disarms an armed one. On an
     * unarmed one it says how, since a button that does nothing when
     * tapped reads as broken (T39.7: the label is the canvas's "Comp
     * this sale", not "Hold to comp"). */
    if (comped) {
      setComped(false);
      clearStaleResult();
    } else {
      setCompHint(true);
    }
  };

  /* ONE shared quiet line under the tender: the first real problem with
   * what is on screen, else what is still owed, else the detail of what
   * is armed. The full reason also sits on each control's title attr. */
  const tenderNote = comped
    ? /* The canvas's line (0.2): the sale is on the studio. */
      "Nothing to pay, on the studio."
    : compCleared
      ? "Comp was cleared."
      : compHint
        ? "Hold Comp this sale for a moment to arm it."
    : firstLineProblem !== null
      ? firstLineProblem
      : dueCents !== null && dueCents > 0 && lines.length >= 2
        ? /* Both slots are taken, so the fix is an amount, not another
             source. */
          `${money(dueCents / 100)} is still unpaid. Adjust an amount, or remove a part.`
        : dueCents !== null && dueCents > 0 && lines.length > 0
          ? `Add a source for the remaining ${money(dueCents / 100)}.`
          : lines.length === 0
            ? cardReason !== null
              ? `Card: ${cardReason}`
              : /* Only for a credit source that is actually on screen: a
                   reason for an absent control explains nothing. */
                creditVisible && creditReason !== null
                ? `Credit: ${creditReason}`
                : (cardDetail ?? "")
            : "";

  const sources: { s: TenderSource; label: string; icon: ReactNode }[] = [
    /* Credit leads when there IS credit, and is absent when there is not
       (Pete, fourth live test). */
    ...(creditVisible
      ? [
          {
            s: "credit" as TenderSource,
            label: "Credit",
            icon: <CreditIcon />,
          },
        ]
      : []),
    { s: "storedcard", label: "Card", icon: <CardIcon /> },
    { s: "cash", label: "Cash", icon: <CashIcon /> },
  ];

  /* The three figures (0.2): Due is settled once the lines cover the
   * total with at least one line present (or the sale is comped), and
   * Change is loud whenever cash was over-tendered. */
  const dueSettled = comped
    ? total !== null
    : dueCents === 0 && lines.length > 0;

  /**
   * T39.6: the bar's primary in pay mode, rendered by THIS component
   * through the portal so it is gated by the `chargeable` of this very
   * render. It reads `Due $X` (disabled, the prototype's label: the
   * disabled state turned into information) while anything is unpaid,
   * `Charge $total` once due is zero, `Comp $total` when comped, and it
   * is the one Charge control on the screen. Not `disabled` but
   * aria-disabled, like the shelf's Pay, so its title can say why; the
   * click guard and doCharge's own checks refuse the tap.
   */
  const primaryLabel = comped ? "Comp" : dueSettled ? "Charge" : "Due";
  const primaryAmount = comped || dueSettled
    ? total
    : dueCents !== null
      ? dueCents / 100
      : null;
  const primaryOn = dueSettled && chargeable;
  const primaryWhy = primaryOn
    ? null
    : charging
      ? "Charging..."
      : total === null
        ? pricing
          ? "Pricing with Mindbody..."
          : "No total to pay yet"
        : dueCents !== null && dueCents > 0
          ? tenderNote || `${money(dueCents / 100)} still to pay`
          : firstLineProblem ?? (lines.length === 0 && !comped ? "Choose how they are paying" : "Not ready to charge");
  const primary =
    result?.kind === "paid" ? null : (
      <button
        className={primaryOn ? "sale-bar-pay" : "sale-bar-pay off"}
        aria-disabled={!primaryOn}
        aria-label={primaryOn ? chargeLabel : `${primaryLabel}: ${primaryWhy ?? ""}`}
        title={primaryOn ? chargeLabel : (primaryWhy ?? undefined)}
        onClick={() => {
          if (!primaryOn) return;
          void doCharge();
        }}
      >
        {charging ? (
          <>
            <span className="spinner" aria-label="working" />
            <span>Charging...</span>
          </>
        ) : (
          <>
            <span>{primaryLabel}</span>
            {primaryAmount !== null ? (
              <span className="sale-bar-amt">{money(primaryAmount)}</span>
            ) : null}
          </>
        )}
      </button>
    );

  return (
    <>
      {/* T39.6: the payment surface, the middle column in pay mode and
          hidden (not unmounted) in shelf mode, so T35's state lives on
          across Back to items. The `hidden` attribute is the whole
          mechanism; .sale-pay[hidden] backs it in the CSS. */}
      <div className="sale-pay" hidden={!visible}>
        <div className="pay-surface">
          {notice}

          {result?.kind === "paid" ? (
            <div className="pay-done" role="status">
              <p className="pay-done-line">{result.summary}</p>
              {result.detail ? (
                <p className="pay-done-detail">{result.detail}</p>
              ) : null}
              {/* Done means the sale is finished, so it goes back to the
                  roster (Pete, fourth live test): the counter's resting
                  screen is the sign-in view, not an empty cart. The
                  receipt is cleared first so reopening Buy starts clean. */}
              <button
                className="class-change"
                onClick={() => {
                  setResult(null);
                  onDone();
                }}
              >
                Done
              </button>
            </div>
          ) : (
            <>
              {/* The three figures (0.2): Total is the server's, Due is
                  what the lines have not covered, Change is over-tendered
                  cash. Due carries the most weight of the three (decided):
                  it is the one figure a teacher checks before charging. */}
              <div className="pay-figures">
                <div className="pay-fig">
                  <span className="pay-fig-label">Total</span>
                  <span className="pay-fig-amt">
                    {total !== null ? money(total) : "--"}
                  </span>
                </div>
                <div
                  className={dueSettled ? "pay-fig due settled" : "pay-fig due"}
                >
                  <span className="pay-fig-label">Due</span>
                  <span className="pay-fig-amt">
                    {comped
                      ? total !== null
                        ? money(0)
                        : "--"
                      : dueCents !== null
                        ? money(dueCents / 100)
                        : "--"}
                  </span>
                </div>
                <div
                  className={changeCents > 0 ? "pay-fig change" : "pay-fig"}
                >
                  <span className="pay-fig-label">Change</span>
                  <span className="pay-fig-amt">
                    {money(changeCents / 100)}
                  </span>
                </div>
              </div>

              {/* T35: tapping a source ADDS a line for the whole remaining
                  due, clamped by that source's rule. The tiles (0.2) carry
                  T35's reason when a source cannot add a line, never
                  hidden; Credit is absent when there is no balance (T33)
                  and wears it as a badge when there is. */}
              <div className="pay-tiles" aria-label="Payment sources">
                {sources.map(({ s, label, icon }) => {
                  const reason = addReason(s);
                  const off = reason !== null;
                  const shown = off
                    ? reason
                    : s === "credit"
                      ? /* The prototype's word for an available Credit:
                           rule 1 makes it the first thing applied. */
                        "Applies first"
                      : null;
                  return (
                    <button
                      key={s}
                      className={off ? "pay-tile off" : "pay-tile"}
                      disabled={off || charging}
                      onClick={() => addLine(s)}
                      title={
                        reason ??
                        (s === "credit"
                          ? creditLabel
                          : s === "storedcard"
                            ? (cardDetail ?? "Card on file")
                            : "Cash")
                      }
                    >
                      <span className="pay-tile-name">
                        <span className="mi">{icon}</span>
                        {label}
                      </span>
                      {shown ? (
                        <span className="pay-tile-reason">{shown}</span>
                      ) : null}
                      {s === "credit" && balance !== null && balance > 0 ? (
                        <span className="pay-tile-badge">{money(balance)}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {lines.length > 0 ? (
                <div className="tender-lines" aria-label="Payment lines">
                  {lines.map((line, i) => {
                    const covers = coverage[i] ?? 0;
                    return (
                      <div
                        className={
                          lineReasons[i] ? "tender-line bad" : "tender-line"
                        }
                        key={line.id}
                      >
                        <span className="tender-src-name">
                          {sourceLabel(line.source)}
                          {/* Over-tendered cash: what the line actually
                              covers, under the name (0.2). Only cash can
                              exceed its coverage; the surplus is Change. */}
                          {line.cents > covers ? (
                            <span className="tender-sub">
                              covers {money(covers / 100)}
                            </span>
                          ) : null}
                        </span>
                        <button
                          className={
                            padFor === line.id ? "tender-amt on" : "tender-amt"
                          }
                          disabled={charging}
                          onClick={() => openPad(line.id)}
                          aria-label={`${sourceLabel(line.source)} amount ${money(line.cents / 100)}, tap to change`}
                          title="Tap to change this amount"
                        >
                          {money(line.cents / 100)}
                        </button>
                        <button
                          className="tender-x"
                          disabled={charging}
                          onClick={() => removeLine(line.id)}
                          aria-label={`Remove the ${sourceLabel(line.source)} payment`}
                          title="Remove this payment"
                        >
                          &#215;
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <p className="pay-hint">
                {lines.length > 0
                  ? "Tap an amount to change it."
                  : "Choose how they are paying."}
              </p>

              {/* Bug-1 branch (b): no client, no house client, so Mindbody
                  could not price the cart and there is no total to charge.
                  The local estimate on the ticket is never chargeable. */}
              {cart.length > 0 && !pricing && priced?.needsClient ? (
                <p className="muted-note">
                  Attach a client (or set a house client) to charge.
                </p>
              ) : null}

              {result?.kind === "suppressed" ? (
                <div className="pass-note t-suppressed" role="status">
                  {result.mode === "dry-run"
                    ? "Dry run: nothing was charged."
                    : "Write guard: nothing was charged."}{" "}
                  The write was suppressed on the server; the cart is untouched.
                  <button
                    className="class-change pay-dismiss"
                    onClick={() => setResult(null)}
                  >
                    OK
                  </button>
                </div>
              ) : result?.kind === "split" ? (
                <div className="sale-stop pay-split" role="alert">
                  <p className="pay-split-head">{result.message}</p>
                  <p className="pay-split-why">Mindbody said: {result.mindbody}</p>
                  <button
                    className="class-change pay-dismiss"
                    onClick={() => setResult(null)}
                  >
                    Understood
                  </button>
                </div>
              ) : result?.kind === "ambiguous" ? (
                <div className="sale-stop" role="alert">
                  The charge may or may not have gone through. Check the dev
                  drawer or Mindbody before charging again.
                  {result.message ? ` (${result.message})` : ""}
                  <button
                    className="class-change pay-dismiss"
                    onClick={() => setResult(null)}
                  >
                    Understood
                  </button>
                </div>
              ) : result?.kind === "error" ? (
                <div className="sale-stop" role="alert">
                  Not charged: {result.message}
                  <button
                    className="class-change pay-dismiss"
                    onClick={() => setResult(null)}
                  >
                    OK
                  </button>
                </div>
              ) : null}

              {/* The foot (0.2), pushed to the bottom under a hairline: the
                  quiet line at the left, Comp at the right. Comp is
                  deliberately out of the tender list and armed by holding,
                  so nobody comps a sale by grazing a control; and it lives
                  only here, in pay mode (layout plan 2.9). */}
              <div className="pay-foot">
                <p className="pay-quiet">{tenderNote || " "}</p>
                <button
                  className={comped ? "comp-hold on" : "comp-hold"}
                  disabled={charging}
                  onPointerDown={compHoldStart}
                  onPointerUp={compHoldEnd}
                  onPointerLeave={compHoldAbort}
                  onPointerCancel={compHoldAbort}
                  onClick={compClick}
                  onContextMenu={(e) => e.preventDefault()}
                  aria-pressed={comped}
                  title={comped ? "Tap to unselect" : "Hold to comp this sale"}
                >
                  {comped ? "Comped. Tap to unselect." : "Comp this sale"}
                </button>
              </div>
            </>
          )}
        </div>

      {/* T36: the amount modal. T35 put this keypad INLINE in the payment
          column, where it pushed the receipt down the screen; Pete, on
          the live build: "the keypad looks awful and pushes the receipt
          card down. the old keypad design was good ... having it be a
          modal is def better than this." So the old cash modal's shape
          is back -- two head rows, chips, a 3x4 keypad, Cancel and Done
          -- generalized to every source, and nothing in the column moves
          when it opens.

          It edits ONE line. Cancel (and Escape, and the scrim) leave the
          line exactly as it was; Done applies what was typed, and typing
          nothing leaves the amount alone rather than removing the row.
          The clamps are unchanged: card and credit cannot be typed or
          chipped above their cap, and cash is the only source that may
          exceed what it owes. */}
      {padLine !== undefined ? (
        <div
          className="modal-scrim"
          role="presentation"
          onClick={dismissPad}
        >
          <div
            className="modal modal-amount"
            role="dialog"
            aria-modal="true"
            aria-label={`${sourceLabel(padLine.source)} amount`}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">{sourceLabel(padLine.source)}</p>
            <div className="pad-row">
              <span className="pad-label">Amount due</span>
              <span className="pad-amt">
                {padDueCents !== null ? money(padDueCents / 100) : "--"}
              </span>
            </div>
            <div className="pad-row">
              <span className="pad-label">Entered</span>
              <span className="pad-amt">{money(draftCents / 100)}</span>
            </div>

            {/* Chips are CASH ONLY, per Pete ("for cash, it was helpful
                to have $5, $10, $20 buttons (but not for other forms)"):
                card and credit are clamped to the due, so a note chip on
                them could only ever land on the same figure Exact does.
                A chip SETS the amount, as the old modal's did. */}
            {padLine.source === "cash" ? (
              <div className="pad-chips">
                <button
                  className="pad-chip"
                  disabled={padDueCents === null}
                  onClick={() =>
                    padDueCents !== null && padChip(padDueCents)
                  }
                >
                  Exact
                </button>
                {[5, 10, 20].map((usd) => (
                  <button
                    key={usd}
                    className="pad-chip"
                    onClick={() => padChip(usd * 100)}
                  >
                    ${usd}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="pad-keys">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0"].map(
                (k) => (
                  <button key={k} className="pad-key" onClick={() => padTap(k)}>
                    {k}
                  </button>
                ),
              )}
              <button
                className="pad-key"
                aria-label="Delete last digit"
                onClick={() => padTap("back")}
              >
                &#9003;
              </button>
            </div>

            {/* The change math, and only where it is true. On a two-line
                tender the OTHER line absorbs the difference, so the
                modal says what that line becomes rather than calling a
                deliberate part-payment "short". */}
            {padPartnerCents !== null && padPartner !== undefined ? (
              <p className="pad-change muted-note">
                The {sourceLabel(padPartner.source).toLowerCase()} part
                becomes {money(padPartnerCents / 100)}.
              </p>
            ) : padSurplus !== null && padSurplus > 0 ? (
              <p className="pad-change">
                Change due {money(padSurplus / 100)}
              </p>
            ) : padSurplus !== null && padSurplus < 0 ? (
              <p className="pad-change short">
                Short {money(-padSurplus / 100)}
              </p>
            ) : (
              <p className="pad-change muted-note">
                {padCap !== null
                  ? `${sourceLabel(padLine.source)} tops out at ${money(padCap / 100)}.`
                  : "Cash may be more than the due; the change shows here."}
              </p>
            )}

            <div className="modal-actions">
              <button className="modal-cancel" onClick={dismissPad}>
                Cancel
              </button>
              <button className="modal-confirm go" onClick={applyPad}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>

      {/* T39.6: the bar's primary, out through the slot. Only in pay mode
          (the slot is the shelf's Pay otherwise) and only once the bar
          has mounted. */}
      {visible && barSlot ? createPortal(primary, barSlot) : null}
    </>
  );
}

/* =====================================================================
 * T30: the membership (contract) purchase dialog. A contract is not a
 * cart item -- it starts an autopay -- so it sells through its own
 * surface, and NOTHING recurring is ever started without the commitment
 * restated on the confirm button itself ("Charge $X today, then $Y
 * monthly ..."). Payment is the stored card (the schema's StoredCardInfo
 * takes only LastFour); the start date is deliberately today-only, since
 * purchasecontract's StartDate/FirstPaymentOccurs/ProrateDate interplay
 * is documented only in prose and the counter sells memberships that
 * start now (recorded on the T30 ticket).
 * =================================================================== */

/** How often the autopay charges, in words, from the schema's fields
 *  (AutopaySchedule, sale.yml:4757; AutopayTriggerType, 5494). */
function frequencyPhrase(c: ContractInfo): string {
  if (c.autopayTriggerType === "PricingOptionRunsOutOrExpires") {
    /* The schedule is null exactly in this case (sale.yml:5488). */
    return "each time the included pass runs out or expires";
  }
  if (!c.autopaySchedule) {
    /* A null schedule WITHOUT that trigger is a data hole, not the
     * pass-runs-out story; never claim a trigger Mindbody did not
     * state. scheduleProblem() refuses to sell this shape, so the
     * vague phrase only ever reaches the shelf card. */
    return "on the contract's autopay schedule";
  }
  const s = c.autopaySchedule;
  if (s.frequencyType === "MonthToMonth") return "monthly";
  const n = s.frequencyValue ?? 1;
  switch (s.frequencyTimeUnit) {
    case "Monthly":
      return n === 1 ? "monthly" : `every ${n} months`;
    case "Weekly":
      return n === 1 ? "weekly" : `every ${n} weeks`;
    case "Yearly":
      return n === 1 ? "yearly" : `every ${n} years`;
    default:
      return "on the contract's autopay schedule";
  }
}

/**
 * The reason this contract's recurring commitment CANNOT be stated
 * honestly, or null when it can. A recurring purchase whose terms the
 * dialog cannot restate must refuse to sell -- a vague label on the
 * commitment button ("on the contract's autopay schedule") is exactly
 * the thing the T30 confirm exists to prevent. The unsellable shapes:
 * a recurring amount Mindbody did not return, a set-schedule autopay
 * with no schedule, and a frequency time unit outside the schema's
 * Weekly | Monthly | Yearly. Refusing here costs nothing real: these
 * are data holes, and the membership can still be sold from Mindbody
 * itself.
 */
function scheduleProblem(c: ContractInfo): string | null {
  if (!c.autopayEnabled) return null;
  if (c.recurringPaymentTotal === null) {
    return (
      "Mindbody returned no recurring amount for this contract, so the " +
      "commitment cannot be stated here. Sell it from Mindbody instead."
    );
  }
  if (c.recurringPaymentTotal <= 0) return null;
  if (c.autopayTriggerType === "PricingOptionRunsOutOrExpires") return null;
  const s = c.autopaySchedule;
  if (!s) {
    return (
      "Mindbody returned no autopay schedule for this contract, so how " +
      "often it charges cannot be stated here. Sell it from Mindbody " +
      "instead."
    );
  }
  if (s.frequencyType === "MonthToMonth") return null;
  if (
    s.frequencyTimeUnit !== "Weekly" &&
    s.frequencyTimeUnit !== "Monthly" &&
    s.frequencyTimeUnit !== "Yearly"
  ) {
    return (
      "This contract's autopay frequency could not be read from " +
      "Mindbody, so the commitment cannot be stated here. Sell it from " +
      "Mindbody instead."
    );
  }
  return null;
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * When the NEXT recurring charge lands, computed only where the
 * schema's ClientsChargedOn (sale.yml:5502) makes it unambiguous;
 * otherwise a descriptive clause. Returns [startingClause] to append
 * after the frequency, always beginning with a space.
 */
function chargedOnClause(c: ContractInfo): string {
  const today = new Date();
  const next = (day: number): Date => {
    const d = new Date(today.getFullYear(), today.getMonth(), day);
    if (d.getTime() <= today.getTime()) d.setMonth(d.getMonth() + 1);
    return d;
  };
  switch (c.clientsChargedOn) {
    case "OnSaleDate": {
      /* The next charge is one period after today's sign-up. */
      const s = c.autopaySchedule;
      const n = s?.frequencyValue ?? 1;
      const d = new Date(today);
      switch (s?.frequencyTimeUnit) {
        case "Weekly":
          d.setDate(d.getDate() + 7 * n);
          break;
        case "Yearly":
          d.setFullYear(d.getFullYear() + n);
          break;
        default:
          /* Monthly, and MonthToMonth's null schedule both mean a
           * month. */
          d.setMonth(d.getMonth() + n);
      }
      return ` starting ${fmtDay(d)}`;
    }
    case "FirstOfTheMonth":
      return ` starting ${fmtDay(next(1))}`;
    case "FifteenthOfTheMonth":
      return ` starting ${fmtDay(next(15))}`;
    case "LastDayOfTheMonth": {
      let d = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      if (d.getTime() <= today.getTime()) {
        d = new Date(today.getFullYear(), today.getMonth() + 2, 0);
      }
      return ` starting ${fmtDay(d)}`;
    }
    case "SpecificDate": {
      const raw = c.clientsChargedOnSpecificDate;
      const d = raw ? new Date(raw) : null;
      return d && !Number.isNaN(d.getTime())
        ? ` starting ${fmtDay(d)}`
        : "";
    }
    /* The either-or variants depend on a business rule the schema does
     * not state; described, never guessed into a single date. */
    case "FirstOrFifteenthOfTheMonth":
      return ", charged on the next 1st or 15th of the month";
    case "FirstOrSixteenthOfTheMonth":
      return ", charged on the next 1st or 16th of the month";
    case "FifteenthOrEndOfTheMonth":
      return ", charged on the next 15th or end of the month";
    default:
      return "";
  }
}

/**
 * THE commitment sentence, shared verbatim by the confirm button and
 * the paid summary: "Charge $X today, then $Y monthly starting DATE".
 * `firstTotal` is the server-rehearsed first payment when available.
 */
function commitmentText(c: ContractInfo, firstTotal: number | null): string {
  const first = firstTotal ?? c.firstPaymentTotal;
  const firstText = first !== null ? money(first) : "the first payment";
  const recurring = c.recurringPaymentTotal;
  if (!c.autopayEnabled || recurring === null || recurring <= 0) {
    return `Charge ${firstText} today. No recurring payments.`;
  }
  let text =
    `Charge ${firstText} today, then ${money(recurring)} ` +
    frequencyPhrase(c) +
    chargedOnClause(c);
  if (c.numberOfAutopays !== null && c.numberOfAutopays > 0) {
    text += `, for ${c.numberOfAutopays} payment${c.numberOfAutopays === 1 ? "" : "s"}`;
  } else if (c.autopaySchedule?.frequencyType === "SetNumberOfAutopays") {
    /* A set-number schedule whose count Mindbody did not return: say
     * the run is limited without inventing a count, rather than
     * reading as open-ended. */
    text += ", for a set number of payments (see the agreement)";
  }
  if (c.actionUponCompletionOfAutopays === "ContractAutomaticallyRenews") {
    text += ", renewing automatically";
  }
  return text + ".";
}

/** The Test rehearsal's lifecycle inside the dialog. */
interface ContractRehearsal {
  loading: boolean;
  /** The server's first-payment Total from purchasecontract Test: true. */
  total: number | null;
  /** Non-null when the rehearsal was suppressed (prod dry run / write
   *  guard): no server total exists, and the real write would be
   *  suppressed the same way. */
  suppressed: string | null;
  error: string | null;
}

type ContractOutcome =
  | { kind: "paid"; summary: string; detail: string | null }
  | { kind: "suppressed"; mode: string }
  | { kind: "ambiguous"; message: string }
  | { kind: "error"; message: string };

function ContractDialog(props: {
  contract: ContractInfo;
  client: SaleClient | null;
  cardLookup: CardLookup | null;
  onClose: () => void;
  /** Reuses the sale screen's attach flow (the search modal stacks
   *  above this dialog; attaching updates `client` live). */
  onRequestAttach: () => void;
  /** Mirrors the in-flight purchase up to SaleScreen so Escape and Back
   *  cannot close anything while money is moving. */
  onBusyChange: (busy: boolean) => void;
  /** Best-effort cache invalidation after a real purchase. */
  onPurchased: (clientId: string) => void;
  /** True while the attach search modal is stacked above; Escape then
   *  belongs to that layer, not this dialog. */
  modalAbove: boolean;
}) {
  const {
    contract,
    client,
    cardLookup,
    onClose,
    onRequestAttach,
    onBusyChange,
    onPurchased,
    modalAbove,
  } = props;

  const [rehearsal, setRehearsal] = useState<ContractRehearsal | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [outcome, setOutcome] = useState<ContractOutcome | null>(null);
  const inFlight = useRef(false);
  const rehearseGen = useRef(0);
  /** Bumped by the Retry button on a failed rehearsal. */
  const [rehearseNonce, setRehearseNonce] = useState(0);

  const clientId = client?.id ?? null;
  const card = cardLookup?.card ?? null;

  /* An unrenderable schedule refuses the sale outright: nothing
   * recurring starts without its terms stated, so terms that cannot be
   * stated mean no sale from this counter. Checked before everything
   * else -- attaching a client cannot fix it. */
  const schedProblem = scheduleProblem(contract);

  /* Why the purchase cannot proceed yet, or null. The same
   * greyed-with-the-reason posture as the method cards; the server
   * re-checks the client and card at purchase time. */
  const blockReason = schedProblem
    ? schedProblem
    : !client
    ? "A membership needs a client attached."
    : cardLookup?.loading
      ? "Checking for a card on file..."
      : cardLookup?.error
        ? "The card check failed. Detach and re-attach the client to retry."
        : !card
          ? "No card on file. A membership charges the stored card; add a card in Mindbody first."
          : card.expired
            ? `The card on file (ending ${card.lastFour}) is expired.`
            : null;

  /* The Test rehearsal: purchasecontract supports Test: true, so the
   * first-payment total on the confirm is the SERVER's number. Runs
   * whenever the purchasable pair (client, usable card) is in place. */
  useEffect(() => {
    if (clientId === null || blockReason !== null) {
      setRehearsal(null);
      return;
    }
    const gen = ++rehearseGen.current;
    setRehearsal({ loading: true, total: null, suppressed: null, error: null });
    fetch("/api/purchase-contract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractId: contract.id, clientId, test: true }),
    })
      .then(async (r) => {
        const body = await r.json();
        if (rehearseGen.current !== gen) return;
        if (r.ok && body?.ok === true) {
          setRehearsal({
            loading: false,
            total:
              typeof body?.totals?.total === "number"
                ? body.totals.total
                : null,
            suppressed: null,
            error: null,
          });
        } else if (r.ok && body?.suppressed) {
          setRehearsal({
            loading: false,
            total: null,
            suppressed: String(body.suppressed),
            error: null,
          });
        } else {
          setRehearsal({
            loading: false,
            total: null,
            suppressed: null,
            error: String(body?.error ?? `HTTP ${r.status}`),
          });
        }
      })
      .catch((e) => {
        if (rehearseGen.current !== gen) return;
        setRehearsal({
          loading: false,
          total: null,
          suppressed: null,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }, [contract.id, clientId, blockReason, rehearseNonce]);

  /* The commitment, restated with the server's first-payment total once
   * the rehearsal lands. Under suppression no server total exists, so
   * the catalog's figure stands with an explicit "as quoted by Mindbody
   * at charge time" note below. */
  const serverTotal = rehearsal?.total ?? null;
  const commitment = commitmentText(contract, serverTotal);

  const confirmable =
    blockReason === null &&
    !purchasing &&
    rehearsal !== null &&
    !rehearsal.loading &&
    rehearsal.error === null;

  const doPurchase = async () => {
    if (inFlight.current || !confirmable || clientId === null) return;
    inFlight.current = true;
    setPurchasing(true);
    onBusyChange(true);
    setOutcome(null);
    try {
      /* The number the confirm button displayed. The route rehearses
       * again at purchase time and REFUSES if Mindbody now prices the
       * first payment differently: the tap agreed to these words, so a
       * changed price must come back to the screen, never be charged
       * silently. */
      const shownFirst = serverTotal ?? contract.firstPaymentTotal;
      const res = await fetch("/api/purchase-contract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractId: contract.id,
          clientId,
          ...(shownFirst !== null ? { expectedFirstTotal: shownFirst } : {}),
        }),
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* fall through to the status handling below */
      }
      if (body === null && (res.ok || res.status >= 500)) {
        /* Same reading as /api/checkout's caller: an unreadable answer
         * to a money write may have processed. Never "not charged". */
        setOutcome({
          kind: "ambiguous",
          message: res.ok
            ? "The server answered but the outcome could not be read."
            : `The server's answer (HTTP ${res.status}) carried no readable outcome.`,
        });
      } else if (res.ok && body?.ok === true) {
        /* The paid confirmation RESTATES what recurs; a membership that
         * quietly starts an autopay is the one outcome this dialog must
         * never produce. */
        const paidTotal =
          typeof body?.total === "number" ? body.total : serverTotal;
        onPurchased(clientId);
        setOutcome({
          kind: "paid",
          summary:
            `${contract.name} started for ${client?.name ?? "the client"}. ` +
            commitmentText(contract, paidTotal).replace(/^Charge/, "Charged"),
          detail: body?.clientContractId
            ? `Contract ${body.clientContractId} on their account.`
            : null,
        });
      } else if (res.ok && body?.suppressed) {
        setOutcome({ kind: "suppressed", mode: String(body.suppressed) });
      } else if (body?.ambiguous === true) {
        setOutcome({
          kind: "ambiguous",
          message: String(body?.error ?? "The purchase did not answer."),
        });
      } else {
        if (body?.stage === "reprice") {
          /* The price moved between the label and the tap: re-rehearse
           * so the commitment button restates the CURRENT number. */
          setRehearseNonce((n) => n + 1);
        }
        setOutcome({
          kind: "error",
          message: String(body?.error ?? `HTTP ${res.status}`),
        });
      }
    } catch {
      setOutcome({ kind: "ambiguous", message: "" });
    } finally {
      inFlight.current = false;
      setPurchasing(false);
      onBusyChange(false);
    }
  };

  /* The dialog unmounting mid-flight must not leave the overlay
   * believing money is still moving. */
  useEffect(() => {
    return () => onBusyChange(false);
  }, [onBusyChange]);

  /* Escape closes the dialog -- never mid-purchase, and never while the
   * attach search is stacked above (that layer takes the press). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !purchasing && !modalAbove) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [purchasing, modalAbove, onClose]);

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={() => {
        if (!purchasing) onClose();
      }}
    >
      <div
        className="modal modal-contract"
        role="dialog"
        aria-modal="true"
        aria-label={`Start the ${contract.name} membership`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="modal-title">{contract.name}</p>
        {contract.description ? (
          <p className="contract-desc">{contract.description}</p>
        ) : null}

        {/* The terms, from the API's own numbers (Contract model,
            sale.yml:5445): first payment, the recurring amount and
            cadence, and the lifespan total where Mindbody computes one.
            The first payment upgrades to the server-rehearsed total the
            moment the Test call answers. */}
        <div className="contract-rows">
          <div className="contract-row">
            <span>First payment (today)</span>
            <span className="amt">
              {rehearsal?.loading ? (
                <span className="spinner" aria-label="working" />
              ) : serverTotal !== null ? (
                money(serverTotal)
              ) : contract.firstPaymentTotal !== null ? (
                money(contract.firstPaymentTotal)
              ) : (
                "--"
              )}
            </span>
          </div>
          {contract.autopayEnabled &&
          contract.recurringPaymentTotal !== null &&
          contract.recurringPaymentTotal > 0 ? (
            <div className="contract-row">
              <span>Then</span>
              <span className="amt">
                {money(contract.recurringPaymentTotal)}{" "}
                {frequencyPhrase(contract)}
              </span>
            </div>
          ) : contract.autopayEnabled &&
            contract.recurringPaymentTotal === null ? (
            /* Autopay is ON but Mindbody returned no amount: never say
               "none" about a recurring charge that exists. The sale is
               refused above (scheduleProblem). */
            <div className="contract-row">
              <span>Recurring</span>
              <span>amount unavailable</span>
            </div>
          ) : (
            <div className="contract-row">
              <span>Recurring</span>
              <span>none</span>
            </div>
          )}
          {contract.totalContractTotal !== null &&
          contract.totalContractTotal > 0 ? (
            <div className="contract-row">
              <span>Contract total</span>
              <span className="amt">{money(contract.totalContractTotal)}</span>
            </div>
          ) : null}
          <div className="contract-row">
            <span>Starts</span>
            {/* Today only, deliberately: purchasecontract's StartDate is
                omitted (Mindbody defaults it to today) because the
                StartDate / FirstPaymentOccurs / proration semantics are
                prose-only in the spec, and the counter sells memberships
                that start now. Recorded on T30. */}
            <span>Today</span>
          </div>
          <div className="contract-row">
            <span>Payment</span>
            <span>
              {card && !card.expired ? `Stored card ...${card.lastFour}` : "--"}
            </span>
          </div>
        </div>

        {contract.agreementTerms ? (
          <div className="contract-agree" tabIndex={0}>
            {contract.agreementTerms}
          </div>
        ) : null}

        {blockReason !== null ? (
          <div className="pass-note modal-note-gap">
            {blockReason}
            {!client ? (
              <button
                className="class-change contract-attach"
                onClick={onRequestAttach}
              >
                Attach a client
              </button>
            ) : null}
          </div>
        ) : rehearsal?.error ? (
          <div className="sale-stop modal-note-gap">
            Mindbody refused the rehearsal: {rehearsal.error}
            <button
              className="class-change pay-dismiss"
              onClick={() => setRehearseNonce((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        ) : rehearsal?.suppressed ? (
          <p className="pass-note t-suppressed modal-note-gap">
            {rehearsal.suppressed === "dry-run"
              ? "Dry run: Mindbody did not price the first payment; the amount shown is the catalog's, and the first charge is as quoted by Mindbody at charge time. The purchase itself will be suppressed too."
              : "Write guard: Mindbody did not price the first payment for this client; the purchase itself will be suppressed too."}
          </p>
        ) : null}

        {outcome?.kind === "paid" ? (
          <div className="pay-done" role="status">
            <p className="pay-done-line">{outcome.summary}</p>
            {outcome.detail ? (
              <p className="pay-done-detail">{outcome.detail}</p>
            ) : null}
            <button className="class-change" onClick={onClose}>
              Done
            </button>
          </div>
        ) : outcome?.kind === "suppressed" ? (
          <div className="pass-note t-suppressed modal-note-gap" role="status">
            {outcome.mode === "dry-run"
              ? "Dry run: no membership was started and nothing was charged."
              : "Write guard: no membership was started and nothing was charged."}
          </div>
        ) : outcome?.kind === "ambiguous" ? (
          <div className="sale-stop modal-note-gap" role="alert">
            The membership purchase may or may not have gone through, and a
            contract may now exist. Check the client&apos;s account in
            Mindbody for the contract (or the dev drawer) before trying
            again.
            {outcome.message ? ` (${outcome.message})` : ""}
          </div>
        ) : outcome?.kind === "error" ? (
          <div className="sale-stop modal-note-gap" role="alert">
            Not started: {outcome.message}
          </div>
        ) : null}

        {outcome?.kind !== "paid" ? (
          <div className="modal-actions">
            <button
              className="modal-cancel"
              disabled={purchasing}
              onClick={onClose}
            >
              Cancel
            </button>
            {/* THE commitment button: the recurring terms ARE the label,
                so tapping it is agreeing to exactly what it says. */}
            <button
              className="modal-confirm go contract-confirm"
              disabled={!confirmable}
              onClick={() => void doPurchase()}
            >
              {purchasing ? (
                <>
                  <span className="spinner" aria-label="working" /> Starting...
                </>
              ) : schedProblem ? (
                /* Never display a commitment the schedule cannot back;
                   the refusal above says why. */
                "Not sellable here"
              ) : (
                commitment
              )}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function SaleScreen(props: {
  open: boolean;
  onClose: () => void;
  config: ModeConfig | null;
  client: SaleClient | null;
  /** Opens the existing search modal in attach mode (page.tsx owns it). */
  onRequestAttach: () => void;
  onDetachClient: () => void;
  /** True while a modal (search, info view) is stacked above the overlay,
   *  so Escape peels that layer instead of closing the sale. */
  modalAbove: boolean;
  /** T30: called after a REAL contract purchase so page.tsx can drop the
   *  client's pass caches and refresh the roster, best-effort. */
  onContractPurchased?: (clientId: string) => void;
  /** Called after a charge that may have moved money for the attached
   *  client, so page.tsx can drop their pass caches and refresh the
   *  roster: a sale spends credit and can add a pass, and the row behind
   *  the overlay must not keep showing the pre-sale numbers (Pete, fourth
   *  live test). Best-effort; the sale stands whatever happens here. */
  onSaleCompleted?: (clientId: string) => void;
}) {
  const {
    open,
    onClose,
    config,
    client,
    onRequestAttach,
    onDetachClient,
    modalAbove,
    onContractPurchased,
    onSaleCompleted,
  } = props;

  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  /** The active category chip, by label (labels are unique in the
   *  hardcoded list, and FAVORITES_LABEL sits outside it). Defaults once
   *  the catalog lands: Favorites when it has anything to show, else the
   *  first category (see the effect below). */
  const [activeCat, setActiveCat] = useState<string | null>(null);
  /** T39.2: whether the rail shows every category or stops at RAIL_LIMIT
   *  with a "more" entry. Sticky for the session: a teacher who opened
   *  the rest keeps them. */
  const [railExpanded, setRailExpanded] = useState(false);

  /**
   * The per-device stars, loaded from localStorage once the target is
   * known (the key is per target; see favoritesKey). Held as the stored
   * pairs so re-saving never mangles an id's string/number type; the Set
   * of keys is derived. Storage failing (private mode, an iPad with site
   * data blocked) degrades to an empty, non-persisting shelf, the same
   * try/catch posture as settings.ts.
   */
  const [favorites, setFavorites] = useState<FavPair[]>([]);
  const favKey = config ? favoritesKey(config.target) : null;

  useEffect(() => {
    if (favKey === null) return;
    try {
      const raw = window.localStorage.getItem(favKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      setFavorites(
        Array.isArray(parsed)
          ? parsed.filter(
              (p): p is FavPair =>
                p !== null &&
                typeof p === "object" &&
                (p.type === "Product" ||
                  p.type === "Service" ||
                  p.type === "Package") &&
                (typeof p.id === "string" || typeof p.id === "number"),
            )
          : [],
      );
    } catch {
      setFavorites([]);
    }
  }, [favKey]);

  const favSet = useMemo(
    () => new Set(favorites.map((f) => itemKey(f.type, f.id))),
    [favorites],
  );

  const toggleFavorite = useCallback(
    (item: ShelfItem) => {
      setFavorites((prev) => {
        const key = itemKey(item.type, item.id);
        const next = prev.some((f) => itemKey(f.type, f.id) === key)
          ? prev.filter((f) => itemKey(f.type, f.id) !== key)
          : [...prev, { type: item.type, id: item.id }];
        if (favKey !== null) {
          try {
            window.localStorage.setItem(favKey, JSON.stringify(next));
          } catch {
            /* Not persistable here; the star still works for this visit. */
          }
        }
        return next;
      });
    },
    [favKey],
  );

  /** Every sellable thing the catalog loaded, for star lookup and bundle
   *  resolution. Products first, passes after, which is also the order
   *  starred items render in. */
  const allItems = useMemo<ShelfItem[]>(
    () =>
      catalog
        ? [...catalog.products, ...catalog.passes, ...catalog.packages]
        : [],
    [catalog],
  );

  /** A starred pair whose item is missing from today's catalog simply
   *  does not render; the star stays stored for when the item returns. */
  const starredItems = useMemo(
    () => allItems.filter((i) => favSet.has(itemKey(i.type, i.id))),
    [allItems, favSet],
  );

  /** One console.warn per unresolvable bundle per catalog load. The dev
   *  drawer is server-side and bundles never touch the server, so the
   *  console line is the honest cheap signal. */
  const warnedBundles = useRef(new Set<string>());
  useEffect(() => {
    warnedBundles.current = new Set();
  }, [catalog]);

  /** Bundles resolved against the loaded catalog. Any line that fails to
   *  resolve (a per-site id from the other site, a retired item, or a
   *  quantity outside the server's 1..MAX_LINE_QUANTITY integers, which
   *  would put a line in the cart that /api/price-cart refuses on every
   *  call) drops the WHOLE bundle: half a bundle rung up silently would
   *  be worse than none, and bad config should fail at render, not at
   *  ring-up. Ids compare as strings, since config may write a numeric
   *  id where the catalog carries a string barcode or vice versa. */
  const resolvedBundles = useMemo<ResolvedBundle[]>(() => {
    if (!catalog) return [];
    const out: ResolvedBundle[] = [];
    for (const bundle of catalog.bundles) {
      const items: ResolvedBundle["items"] = [];
      let bad: string | null = null;
      for (const line of bundle.lines) {
        const item = allItems.find(
          (i) => i.type === line.type && String(i.id) === String(line.id),
        );
        if (!item) {
          bad = `${line.type} ${line.id} is not in the loaded catalog`;
          break;
        }
        if (
          !Number.isInteger(line.quantity) ||
          line.quantity < 1 ||
          line.quantity > MAX_LINE_QUANTITY
        ) {
          bad =
            `${line.type} ${line.id} has quantity ${line.quantity} ` +
            `(needs a whole 1 to ${MAX_LINE_QUANTITY})`;
          break;
        }
        items.push({ item, quantity: line.quantity });
      }
      if (bad === null && items.length > 0) {
        out.push({
          name: bundle.name,
          total: items.reduce((n, l) => n + l.item.price * l.quantity, 0),
          items,
        });
      } else if (bad !== null && !warnedBundles.current.has(bundle.name)) {
        warnedBundles.current.add(bundle.name);
        console.warn(
          `[favorites] bundle "${bundle.name}" not rendered: ${bad} ` +
            `(bundle ids are per site; see src/lib/bundles.ts)`,
        );
      }
    }
    return out;
  }, [catalog, allItems]);

  const favoritesHasContent =
    starredItems.length > 0 || resolvedBundles.length > 0;

  /** The default chip, decided once per screen life when the catalog
   *  lands: Favorites when it has anything to show, else the first
   *  category. Later star changes never yank the selection around. */
  useEffect(() => {
    if (!catalog) return;
    setActiveCat(
      (cur) =>
        cur ??
        (favoritesHasContent
          ? FAVORITES_LABEL
          : (catalog.categories[0]?.label ?? null)),
    );
  }, [catalog, favoritesHasContent]);

  const [cart, setCart] = useState<CartEntry[]>([]);
  const [priced, setPriced] = useState<PricedResult | null>(null);
  /** True from the moment the cart changes until Mindbody's answer for
   *  THAT cart lands: the debounce window counts, because the total on
   *  screen is stale for all of it. */
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  /** Stale-response guard, the codebase's activeIdRef pattern: only the
   *  newest generation's answer may write state. */
  const priceGen = useRef(0);

  /** True while /api/checkout is in flight: money is moving, so ambient
   *  Escape must not close the overlay out from under the outcome. */
  const [charging, setCharging] = useState(false);

  /** True while the payment panel's amount modal is up: the Escape that
   *  closes it must not also close the overlay. */
  const [payModalOpen, setPayModalOpen] = useState(false);

  /**
   * T39.6: the two modes (layout plan 2.5). Shelf is rail, grid, cart;
   * pay is the payment surface across the rail and grid's width with the
   * cart column unmoved. One screen, no route, nothing unmounted: the
   * PaymentPanel is hidden rather than removed in shelf mode, so a split
   * entered in pay mode survives Back to items. Reset to shelf on every
   * open and on every close (Done included), so Buy never opens on the
   * previous sale's tender.
   */
  const [saleMode, setSaleMode] = useState<"shelf" | "pay">("shelf");
  /** The bar's primary slot, handed to PaymentPanel so it can render the
   *  pay-mode button through it (see the panel's `barSlot`). A callback
   *  ref into state, since the element exists only after the first
   *  commit. */
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (open) setSaleMode("shelf");
  }, [open]);
  /** Every close goes through here so the mode resets with it. */
  const close = useCallback(() => {
    setSaleMode("shelf");
    onClose();
  }, [onClose]);
  const leavePay = useCallback(() => setSaleMode("shelf"), []);

  /** T30: the contract whose purchase dialog is open, or null. The
   *  dialog is its own modal layer; its Escape/scrim handling lives in
   *  ContractDialog, and the overlay's Escape below skips while it is
   *  up. */
  const [contractDialog, setContractDialog] = useState<ContractInfo | null>(
    null,
  );

  /** The attached client's card on file and account credit, fetched on
   *  attach via the guarded /api/stored-card route. Null when nobody is
   *  attached. */
  const [cardLookup, setCardLookup] = useState<CardLookup | null>(null);
  /** Bumped whenever a charge may have changed what Mindbody holds for
   *  this client (their credit above all): the lookup refetches, so the
   *  balance beside their name is the one AFTER the sale. Pete's fourth
   *  live test: a $5 credit spend left $40 on screen until the class was
   *  switched and switched back. */
  const [profileNonce, setProfileNonce] = useState(0);

  /** A charge finished in a state that may have moved money: refetch this
   *  client's profile (the balance chip and the method gates) and tell
   *  page.tsx to refresh the roster row underneath. Both are reads, so
   *  this is safe to fire on an ambiguous outcome too -- and that is
   *  exactly when the truth matters most. */
  const clientIdForStale = client?.id ?? null;
  const onClientDataStale = useCallback(() => {
    setProfileNonce((n) => n + 1);
    if (clientIdForStale !== null) onSaleCompleted?.(clientIdForStale);
  }, [clientIdForStale, onSaleCompleted]);

  /**
   * The keep-or-empty dialog over a client CHANGE with a held cart
   * (Pete's third live test: the cart silently surviving a switch was
   * wrong). Non-null renders it; the switch itself has ALREADY happened
   * by the time it opens -- the dialog only decides the cart's fate, so
   * neither button can lose the new client. `toName` is who is now
   * attached, or null for a detach.
   */
  const [cartPrompt, setCartPrompt] = useState<{
    count: number;
    toName: string | null;
  } | null>(null);
  /** Bumped when "Empty cart" is confirmed; PaymentPanel disarms any
   *  armed method on it (see its cartResetNonce effect). */
  const [cartResetNonce, setCartResetNonce] = useState(0);
  /** The cart as of the latest render, readable inside the client-change
   *  effect without making the cart a dependency (an edit must not
   *  re-open the dialog). */
  const cartRef = useRef<CartEntry[]>([]);
  cartRef.current = cart;
  /** Who was attached before the current render's client, for telling a
   *  from-nobody attach apart from a real switch. */
  const prevClientRef = useRef<SaleClient | null>(null);

  /*
   * Watch the attached client. THE RULE (Pete, third live test): any
   * client CHANGE with a non-empty cart asks before the cart survives --
   * EXCEPT attaching when nobody was attached, which keeps the cart
   * silently: a cart built while anonymous was built for the person now
   * being attached, and Pete's words were "when i change clients", which
   * a first attach is not. Switching A to B, or detaching, opens the
   * dialog; an empty cart never interrupts anything.
   */
  useEffect(() => {
    const prev = prevClientRef.current;
    prevClientRef.current = client;
    if ((prev?.id ?? null) === (client?.id ?? null)) return;
    /* From nobody: keep silently, per the rule above. */
    if (prev === null) return;
    const count = cartRef.current.reduce((n, l) => n + l.quantity, 0);
    if (count === 0) return;
    setCartPrompt({ count, toName: client?.name ?? null });
  }, [client]);

  /** Keep the items: the cart stands and reprices for the new client
   *  through the ordinary pricing loop. Also the scrim/Escape outcome:
   *  dismissal must not destroy anything. */
  const keepCart = useCallback(() => setCartPrompt(null), []);

  /** Start fresh: cart, tender and method all go (the primary action --
   *  Pete asked for a new cart per client as the default). The client
   *  switch already stands either way. */
  const emptyCart = useCallback(() => {
    setCart([]);
    setSelectedKey(null);
    setPriced(null);
    setPriceError(null);
    setCartResetNonce((n) => n + 1);
    setCartPrompt(null);
  }, []);

  /** Escape peels the cart dialog first (keeping the items: Escape is a
   *  dismissal, and a dismissal must not empty a cart), before the
   *  overlay's own Escape handling below. */
  useEffect(() => {
    if (!cartPrompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") keepCart();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cartPrompt, keepCart]);

  /**
   * T38: the always-available way out. Pete, after the $130.20 / $258.85
   * stop: "there needs to be a way out for the teacher if this ever
   * happened ... either way we need a clear button for the cart". The
   * button sits on the receipt whenever it holds anything, not only
   * inside the disagree block, and it CONFIRMS first: it destroys the
   * cart, so a stray tap in a queue must not. Non-null holds the item
   * count for the dialog's wording. Scrim and Escape cancel; only the
   * confirm button empties, and it does exactly what emptyCart does.
   */
  const [clearPrompt, setClearPrompt] = useState<number | null>(null);
  const cancelClear = useCallback(() => setClearPrompt(null), []);
  const confirmClear = useCallback(() => {
    setClearPrompt(null);
    emptyCart();
  }, [emptyCart]);

  useEffect(() => {
    if (clearPrompt === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearPrompt, cancelClear]);

  /**
   * T38: the second way out, for the disagree stop specifically. The
   * likeliest cause of "our math says X, Mindbody says Y" is a shelf
   * priced from the ten-minute catalog cache after the studio changed a
   * price, so Recheck refetches the catalog past that cache
   * (`/api/catalog?refresh=1`), rebuilds every cart line from the fresh
   * item with the same id and quantity, and hands the result to the
   * ORDINARY pricing loop (setCart, the 400ms debounce, the POST): there
   * is no second pricing path, so every rail on the first one still
   * stands. The report says exactly what moved, per line, and names any
   * line whose id the catalog no longer has (dropped: there is nothing
   * to sell it as). It is keyed to the cart array it produced, so any
   * later edit retires it without a clearing call anywhere.
   */
  const [rechecking, setRechecking] = useState(false);
  const [recheckReport, setRecheckReport] = useState<{
    forCart: CartEntry[];
    changes: { name: string; from: number; to: number }[];
    dropped: string[];
    error: string | null;
  } | null>(null);
  const recheckPrices = useCallback(async () => {
    if (rechecking) return;
    setRechecking(true);
    try {
      const r = await fetch("/api/catalog?refresh=1");
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
      const fresh = parseCatalog(body);
      const byKey = new Map<string, ShelfItem>();
      for (const item of [...fresh.products, ...fresh.passes, ...fresh.packages]) {
        byKey.set(itemKey(item.type, item.id), item);
      }
      const changes: { name: string; from: number; to: number }[] = [];
      const dropped: string[] = [];
      const rebuilt: CartEntry[] = [];
      for (const line of cartRef.current) {
        const item = byKey.get(line.key);
        if (!item) {
          dropped.push(line.item.name);
          continue;
        }
        if (item.price !== line.item.price) {
          changes.push({
            name: item.name,
            from: line.item.price,
            to: item.price,
          });
        }
        rebuilt.push({ ...line, item });
      }
      /* The shelf shows the fresh prices too: a teacher who re-adds the
       * dropped item must not get the stale card back. */
      setCatalog(fresh);
      /* Always a NEW array, even when nothing changed: the teacher asked
       * for a recheck, and only a fresh POST can say whether the stop
       * stands. */
      setCart(rebuilt);
      setRecheckReport({ forCart: rebuilt, changes, dropped, error: null });
    } catch (e) {
      setRecheckReport({
        forCart: cartRef.current,
        changes: [],
        dropped: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRechecking(false);
    }
  }, [rechecking]);

  /** Fetch the shelf once per screen life; the route caches server-side
   *  for 10 minutes anyway. A failure renders with a retry button. */
  const loadCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    fetch("/api/catalog")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        setCatalog(parseCatalog(body));
        /* The default chip is picked by the effect above, which also
           knows whether Favorites has anything to show. */
      })
      .catch((e) =>
        setCatalogError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setCatalogLoading(false));
  }, []);

  useEffect(() => {
    if (open && catalog === null && !catalogLoading && catalogError === null) {
      loadCatalog();
    }
  }, [open, catalog, catalogLoading, catalogError, loadCatalog]);

  /**
   * The pricing loop: debounce, then POST the cart, and let only the
   * newest generation's answer land. The effect depends on the cart and
   * the attached client id, so attaching or detaching reprices too (a
   * client can change pricing: memberships, contracts later).
   */
  const clientId = client?.id ?? null;

  /** Card-on-file and account-credit lookup, on attach and again on every
   *  bump of profileNonce (after a charge). The result gates which method
   *  cards light up and what the header chip shows; /api/checkout re-reads
   *  everything server-side and trusts none of it. */
  useEffect(() => {
    if (clientId === null) {
      setCardLookup(null);
      return;
    }
    let alive = true;
    /* A REFETCH for the same client keeps the numbers it already has on
     * screen while it runs: blanking them would flicker the method row and
     * the balance chip to "loading" right after a sale. A client CHANGE
     * blanks, because the previous client's card is not this one's. */
    setCardLookup((prev) =>
      prev && prev.clientId === clientId
        ? { ...prev, loading: true, error: null }
        : { clientId, loading: true, card: null, balance: null, error: null },
    );
    fetch(`/api/stored-card?clientId=${encodeURIComponent(clientId)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        if (alive) {
          setCardLookup({
            clientId,
            loading: false,
            card: body?.card ?? null,
            balance: typeof body?.balance === "number" ? body.balance : null,
            error: null,
          });
        }
      })
      .catch((e) => {
        if (alive) {
          setCardLookup({
            clientId,
            loading: false,
            card: null,
            balance: null,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [clientId, profileNonce]);

  useEffect(() => {
    const gen = ++priceGen.current;
    if (cart.length === 0) {
      setPriced(null);
      setPriceError(null);
      setPricing(false);
      return;
    }
    setPricing(true);
    setPriceError(null);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/price-cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: cart.map((line) => ({
              type: line.item.type,
              metadataId: line.item.id,
              quantity: line.quantity,
              price: line.item.price,
              taxExempt: line.item.taxExempt,
              taxRate: line.item.taxRate,
            })),
            ...(clientId ? { clientId } : {}),
          }),
        });
        const body = await res.json();
        if (priceGen.current !== gen) return;
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setPriced(body as PricedResult);
      } catch (err) {
        if (priceGen.current !== gen) return;
        setPriced(null);
        setPriceError(err instanceof Error ? err.message : String(err));
      } finally {
        if (priceGen.current === gen) setPricing(false);
      }
    }, PRICE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [cart, clientId]);

  /**
   * Escape peels one layer per press, in this order (T39.6, layout plan
   * 2.5): the keypad modal (the panel's own listener dismisses it and
   * `payModalOpen` keeps this handler out of the same press), then any
   * confirm (cart change, Clear cart, the contract dialog, each with its
   * own listener), then pay mode back to shelf, then the overlay, like
   * the X does -- not mid-pricing (a total is on its way, and the screen
   * waits to show it), and never mid-charge: money is moving and its
   * outcome renders HERE, so neither the overlay nor pay mode leaves.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        modalAbove ||
        payModalOpen ||
        cartPrompt ||
        clearPrompt !== null ||
        contractDialog
      ) {
        return;
      }
      if (charging) return;
      if (saleMode === "pay") {
        leavePay();
        return;
      }
      if (!pricing) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    open,
    modalAbove,
    payModalOpen,
    cartPrompt,
    clearPrompt,
    contractDialog,
    pricing,
    charging,
    saleMode,
    leavePay,
    close,
  ]);

  /**
   * T39.4: which cart line is showing its controls. One line at most,
   * selected by a tap on the row, and it is what buys back the column's
   * height: the per-row stepper on every line is gone, so a seven-line
   * cart fits where four used to. Adding from the shelf selects the line
   * it touched (the prototype does this, and it reads well: the row you
   * just changed is the one showing its count); removing a line or
   * emptying the cart clears it. Derived against the cart below, so a
   * key that leaves the cart by any path (recheck dropping a line, a
   * sale clearing it) can never point at a row that is not there.
   */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const addItem = useCallback((item: ShelfItem) => {
    const key = `${item.type}-${item.id}`;
    setSelectedKey(key);
    setCart((lines) => {
      const have = lines.find((l) => l.key === key);
      if (have) {
        return lines.map((l) =>
          l.key === key
            ? { ...l, quantity: Math.min(l.quantity + 1, MAX_LINE_QUANTITY) }
            : l,
        );
      }
      return [...lines, { key, item, quantity: 1 }];
    });
  }, []);

  /** One tap rings up every line of a bundle, bumping quantities exactly
   *  like addItem does (same key, same MAX clamp), so a bundle is nothing
   *  but a saved sequence of taps: the cart, the pricing loop and the
   *  charge path never know bundles exist. */
  const addBundle = useCallback((bundle: ResolvedBundle) => {
    /* T39.4: a bundle touches several lines; the last one it rang up is
       the one left selected, the same as tapping its cards in turn. */
    const last = bundle.items[bundle.items.length - 1];
    if (last) setSelectedKey(`${last.item.type}-${last.item.id}`);
    setCart((lines) => {
      const next = [...lines];
      for (const { item, quantity } of bundle.items) {
        const key = `${item.type}-${item.id}`;
        const idx = next.findIndex((l) => l.key === key);
        const have = idx >= 0 ? next[idx] : undefined;
        if (have) {
          next[idx] = {
            ...have,
            quantity: Math.min(have.quantity + quantity, MAX_LINE_QUANTITY),
          };
        } else {
          next.push({
            key,
            item,
            quantity: Math.min(quantity, MAX_LINE_QUANTITY),
          });
        }
      }
      return next;
    });
  }, []);

  const bumpQuantity = useCallback((key: string, delta: number) => {
    setCart((lines) =>
      lines.map((l) =>
        l.key === key
          ? {
              ...l,
              quantity: Math.min(
                Math.max(l.quantity + delta, 1),
                MAX_LINE_QUANTITY,
              ),
            }
          : l,
      ),
    );
  }, []);

  const removeLine = useCallback((key: string) => {
    setSelectedKey(null);
    setCart((lines) => lines.filter((l) => l.key !== key));
  }, []);

  /** T39.4: the row tap. The selected row again, or nothing, deselects. */
  const toggleSelected = useCallback((key: string) => {
    setSelectedKey((cur) => (cur === key ? null : key));
  }, []);

  /**
   * T38: how many receipt rows are clipped below the scroll box. Pete:
   * "the cart only shows a max of 4 rows, then i can't see what else is
   * put in there" -- the lines had scrolled internally since the second
   * live test, but nothing said so. Measured off the DOM (a row counts
   * once its bottom is past the visible edge) on every cart change,
   * scroll and resize; it drives the fade at the clipped edge and the
   * "N more below" line. Display only.
   */
  const linesRef = useRef<HTMLDivElement | null>(null);
  const [hiddenBelow, setHiddenBelow] = useState(0);
  const measureLines = useCallback(() => {
    const el = linesRef.current;
    if (!el) {
      setHiddenBelow(0);
      return;
    }
    const visibleBottom = el.scrollTop + el.clientHeight;
    let n = 0;
    for (const child of Array.from(el.children)) {
      const row = child as HTMLElement;
      if (row.offsetTop + row.offsetHeight > visibleBottom + 6) n += 1;
    }
    setHiddenBelow(n);
  }, []);
  useEffect(() => {
    measureLines();
    window.addEventListener("resize", measureLines);
    /* T39.4: the lines box is no longer a fixed vh cap but whatever the
       column leaves it, which moves when a row reveals its controls or
       the totals area changes shape (estimate to server rows, a stop
       appearing). A ResizeObserver on the box itself catches every one
       of those without listing them; the cart dependency stays for the
       row count changing inside an unchanged box, and the selection is
       a dependency too (review): in a bounded ticket the box does not
       move when a row reveals its controls, the rows under it do, and
       the observer never fired, so "2 more below" stood while three
       were hidden. */
    const el = linesRef.current;
    const ro =
      el && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => measureLines())
        : null;
    if (el && ro) ro.observe(el);
    return () => {
      window.removeEventListener("resize", measureLines);
      ro?.disconnect();
    };
  }, [cart, selectedKey, open, measureLines]);

  /* Review: the selected row is the one showing its controls, so it has
     to be in the box. Adding from the shelf selects a line that may be
     the sixth row, below the fold, and a tap on a visible row can push
     its own Remove under the edge; either way the reveal was invisible.
     Only the lines box scrolls, and only as far as it must: never the
     column or the overlay, so under 900 a card tap cannot yank the shelf
     away. The scroll event re-measures the cue. */
  useEffect(() => {
    const box = linesRef.current;
    const rowEl = box?.querySelector<HTMLElement>(".t-row.sel");
    if (!box || !rowEl) return;
    const top = rowEl.offsetTop;
    const bottom = top + rowEl.offsetHeight;
    if (bottom > box.scrollTop + box.clientHeight) {
      box.scrollTop = bottom - box.clientHeight;
    }
    if (top < box.scrollTop) box.scrollTop = top;
  }, [selectedKey]);

  if (!open) return null;

  const onFavorites = activeCat === FAVORITES_LABEL;
  const onPackages = activeCat === PACKAGES_LABEL;
  const onMemberships = activeCat === MEMBERSHIPS_LABEL;
  const category =
    catalog?.categories.find((c) => c.label === activeCat) ?? null;
  /** The Favorites shelf is starred items first (bundles render after the
   *  grid maps these); Packages is its own T30 shelf riding the same
   *  cart; Memberships renders contracts instead of shelf items (a
   *  contract never enters the cart); a category shelf is what it
   *  always was. */
  const shelfItems: ShelfItem[] = onFavorites
    ? starredItems
    : onPackages
      ? (catalog?.packages ?? [])
      : onMemberships || catalog === null || category === null
        ? []
        : category.categoryIds.length === 0
          ? catalog.passes
          : catalog.products.filter(
              (p) =>
                p.categoryId !== null &&
                category.categoryIds.includes(p.categoryId),
            );
  const shelfEmpty =
    shelfItems.length === 0 &&
    (!onFavorites || resolvedBundles.length === 0) &&
    !onMemberships;

  /** What the totals area shows, in priority order: the amber suppression
   *  notice, the loud disagreement, a failed call, the spinner, or the
   *  server's numbers. Never a locally computed total dressed as one. */
  const totals = priced;
  const showSpinner = pricing;
  /** T38: the browser's estimate for the pricing wait. Computed only
   *  while the spinner would otherwise be the whole totals area. */
  const estimate = showSpinner
    ? estimateCart(cart, config?.studioTaxRate ?? null)
    : null;
  /** The recheck report, if it is about THIS cart (any later edit makes a
   *  new array and retires it). */
  const report =
    recheckReport !== null && recheckReport.forCart === cart
      ? recheckReport
      : null;
  const cartCount = cart.reduce((n, l) => n + l.quantity, 0);
  const inPay = saleMode === "pay";
  /** T39.4: the selection, only while its line is in the cart; T39.6:
   *  never in pay mode, where the ticket has no controls (the canvas's
   *  pay-mode ticket is read-only, and the way to a cart edit is Back to
   *  items). */
  const selected =
    !inPay && selectedKey !== null && cart.some((l) => l.key === selectedKey)
      ? selectedKey
      : null;
  /** T39.4: the tax row's label carries the rate only when the server
   *  sent one (`/api/config`'s studioTaxRate, T38); never a literal. */
  const taxLabel =
    config?.studioTaxRate != null ? `Tax ${pct(config.studioTaxRate)}` : "Tax";
  /**
   * T39.5: the bar's primary. The amount is the SERVER's grandTotal and
   * nothing else: while T38's estimate is on the ticket the bar reads
   * `Pay` with the count and no figure, because a number on the one
   * button that moves money must never be the browser's. `payWhy` is
   * the reason it is disabled, or null; it is the button's title, so a
   * greyed Pay says why when asked. Pay enters pay mode (T39.6); the
   * charge itself is the panel's, rendered on the bar through the slot.
   */
  const payWhy: string | null = charging
    ? "Charging..."
    : cart.length === 0
      ? "Nothing rung up yet"
      : pricing
        ? "Pricing with Mindbody..."
        : priceError
          ? "Pricing failed; nothing to pay against"
          : priced === null
            ? "No total yet"
            : priced.suppressed
              ? "Suppressed: Mindbody did not price this cart"
              : priced.disagrees
                ? "Totals disagree; do not charge"
                : priced.needsClient
                  ? "Attach a client to price with Mindbody"
                  : priced.grandTotal === null
                    ? "No total yet"
                    : null;
  const payAmount =
    payWhy === null && priced !== null ? priced.grandTotal : null;
  /** T39.3: quantity per shelf card, from the cart's own keys; the count
   *  pill reads it and nothing is fetched. */
  const inCart = new Map(cart.map((l) => [l.key, l.quantity]));

  /**
   * T38's audit table, one element used in two places: inside the
   * ticket's stop, and (T39.6) inside the copy of the stop the payment
   * surface shows above its figures, so the figures never stand next to
   * a total they contradict. `totals` is checked non-null by both.
   */
  const auditTable = totals ? (
    totals.lineAudit && totals.lineAudit.length > 0 ? (
      <div className="audit-wrap">
        <table className="audit">
          <thead>
            <tr>
              <th>Line</th>
              <th>Ours</th>
              <th>Mindbody</th>
            </tr>
          </thead>
          <tbody>
            {totals.lineAudit.map((a, i) => {
              const ours = cart.find(
                (l) => l.key === itemKey(a.type, a.metadataId),
              );
              const unmatched =
                a.theirPrice === null &&
                a.theirTaxRate === null &&
                a.theirQuantity === null;
              const priceOff =
                a.theirPrice !== null && a.theirPrice !== a.ourPrice;
              /* A line the catalog carried no rate
                 for was asserted at the studio
                 fallback, so that is the figure
                 Mindbody's rate is measured against
                 (the second live test's 13% against
                 10.35% is exactly this case). With no
                 fallback in hand, nothing to compare. */
              const ourRate =
                a.ourTaxRate ?? config?.studioTaxRate ?? null;
              const rateOff =
                a.theirTaxRate !== null &&
                ourRate !== null &&
                a.theirTaxRate !== ourRate;
              const qtyOff =
                a.theirQuantity !== null && a.theirQuantity !== a.quantity;
              return (
                <tr key={`${a.type}-${a.metadataId}-${i}`}>
                  <td>
                    {ours?.item.name ?? a.name ?? `${a.type} ${a.metadataId}`}
                    {a.name !== null && ours && a.name !== ours.item.name ? (
                      <span className="audit-sub">
                        Mindbody calls it {a.name}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {money(a.ourPrice)} x{a.quantity}
                    <span className="audit-sub">
                      {a.ourTaxRate === null
                        ? "studio fallback rate"
                        : pct(a.ourTaxRate)}
                      {" = "}
                      {money(a.ourExtended)}
                    </span>
                  </td>
                  <td className={unmatched ? "audit-bad" : undefined}>
                    {unmatched ? (
                      "no line matched: Mindbody priced something else"
                    ) : (
                      <>
                        <span className={priceOff ? "audit-bad" : undefined}>
                          {a.theirPrice !== null ? money(a.theirPrice) : "no price"}
                        </span>{" "}
                        <span className={qtyOff ? "audit-bad" : undefined}>
                          x{a.theirQuantity ?? "?"}
                        </span>
                        <span
                          className={
                            rateOff ? "audit-sub audit-bad" : "audit-sub"
                          }
                        >
                          {pct(a.theirTaxRate)}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ) : null
  ) : null;

  /**
   * T39.6: what the payment surface says above its figures. The amber
   * suppressed notice and the disagree stop (with the audit table and
   * Recheck) render there as well as in the ticket, because in pay mode
   * the figures are the thing on screen and must not stand beside a
   * total the server did not give. Nothing else of the ticket's travels.
   */
  const payNotice: ReactNode =
    cart.length > 0 && !pricing && totals?.suppressed ? (
      <div className="pass-note t-suppressed">
        Suppressed (dry run or write guard): Mindbody did not price this
        cart, so there is no total to show. Nothing was written.
      </div>
    ) : cart.length > 0 && !pricing && totals?.disagrees ? (
      <div className="sale-stop">
        Totals disagree. Our math says {money(totals.expectedTotal)},
        Mindbody says{" "}
        {totals.grandTotal !== null ? money(totals.grandTotal) : "nothing"}.
        Do not charge; this is a bug to report.
        {auditTable}
        <button
          className="audit-recheck"
          disabled={rechecking || charging}
          onClick={() => void recheckPrices()}
        >
          {rechecking ? (
            <>
              <span className="spinner" aria-label="working" /> Rechecking...
            </>
          ) : (
            "Recheck prices"
          )}
        </button>
      </div>
    ) : null;

  /** The balance shown beside the attached name: the profile lookup's
   *  number when it is this client's (it is refetched after every charge,
   *  so it is post-sale), otherwise the snapshot the roster row attached
   *  with. */
  const attachedBalance =
    client === null
      ? null
      : cardLookup !== null &&
          cardLookup.clientId === client.id &&
          cardLookup.balance !== null
        ? cardLookup.balance
        : client.balance;

  return (
    <div className="sale-overlay" role="dialog" aria-label="Buy">
      <div className="sale-shell">
        <ModeBanner config={config} />

        <div className="sale-top">
          <h2 className="sale-title">Buy</h2>

          {/* Who the sale is for, beside the title (Pete, fourth live
              test): identity belongs in the header, and the payment
              column gets the real estate back. Anonymous is fine;
              attaching enables stored card and account credit, and rides
              price-cart. The balance shown is the freshest one known --
              the profile lookup refetches after every charge, so a sale
              that spends credit updates it in place. */}
          {client ? (
            <div className="sale-for attached">
              {/* T39.1: 1a's card. SALE FOR over the name, the balance as
                  a pill: credit says so in the ok pair, owed money keeps
                  the stop pair and its sign. */}
              <span className="sale-for-who">
                <span className="sale-for-label">Sale for</span>
                <span className="sale-for-name">{client.name}</span>
              </span>
              {attachedBalance !== null && attachedBalance !== 0 ? (
                <span
                  className={attachedBalance < 0 ? "bal-chip neg" : "bal-chip"}
                >
                  {attachedBalance < 0
                    ? money(attachedBalance)
                    : `${money(attachedBalance)} credit`}
                </span>
              ) : null}
              <button
                className="row-icon sale-for-clear"
                aria-label={`Detach ${client.name} from this sale`}
                title="Detach"
                /* No client change while money is moving: mid-charge the
                   switch is refused entirely, not queued behind the
                   dialog. Same reason the Back button locks. */
                disabled={charging}
                onClick={onDetachClient}
              >
                <CloseIcon />
              </button>
            </div>
          ) : (
            /* A real button, not receipt text: the old dashed monospace
               line was not recognizable as tappable in live testing,
               which orphaned the whole attach flow (and with it stored
               card and credit). Solid surface, icon, verb-first label. */
            <button
              className="sale-for"
              /* Mid-charge, no client change; see the detach button. */
              disabled={charging}
              onClick={onRequestAttach}
            >
              <PlusIcon />
              <span className="sale-for-who">
                Attach a client
                <span className="sale-for-hint">
                  for stored card or account credit
                </span>
              </span>
            </button>
          )}

          {/* The deliberate Back works mid-pricing (the cart and its
              in-flight answer survive: the component stays mounted) but
              NOT mid-charge: closing would unmount the payment panel and
              its outcome -- the split-failure warning included -- while
              money is moving. */}
          <button
            className="class-change sale-back"
            onClick={close}
            disabled={charging}
            aria-label="Back to the roster"
          >
            <span className="btn-ico">
              <CloseIcon />
            </span>
            Back
          </button>
        </div>

        <div className={inPay ? "sale-panes pay" : "sale-panes"}>
          {/* RAIL (T39.2): the first column, 154px, Favorites pinned first
              and filled when active, Packages and Memberships in T30's
              order after Passes. Past the seventh entry the rest collapse
              behind a muted "more" that expands the rail in place, but
              only when at least two would hide (RAIL_LIMIT); the studio's
              rail is exactly eight and shows whole. Under 1040px the CSS
              folds the same element back into the chip row above the
              grid. */}
          {catalog && !catalogLoading && !catalogError ? (
            <nav className="sale-cats" role="tablist" aria-label="Categories">
              {(() => {
                /* T30: the Packages and Memberships entries slot in
                   right after Passes (the one category with no
                   category ids), each rendered ONLY when it has
                   something to sell; an empty extra entry would be a
                   button that can never show anything. */
                const extras: string[] = [
                  ...(catalog.packages.length > 0 ? [PACKAGES_LABEL] : []),
                  ...(catalog.contracts.length > 0 ? [MEMBERSHIPS_LABEL] : []),
                ];
                const labels = catalog.categories.map((c) => c.label);
                const passesIdx = catalog.categories.findIndex(
                  (c) => c.categoryIds.length === 0,
                );
                labels.splice(
                  passesIdx >= 0 ? passesIdx + 1 : labels.length,
                  0,
                  ...extras,
                );
                const all = [FAVORITES_LABEL, ...labels];
                /* Expanded by the tap, because there is nothing worth
                   folding (see RAIL_LIMIT), or because the active entry
                   would otherwise be hidden behind "more". */
                const expanded =
                  railExpanded ||
                  all.length <= RAIL_LIMIT + 1 ||
                  all.indexOf(activeCat ?? "") >= RAIL_LIMIT;
                const shown = expanded ? all : all.slice(0, RAIL_LIMIT);
                return (
                  <>
                    {shown.map((label) => (
                      <button
                        key={label}
                        role="tab"
                        aria-selected={activeCat === label}
                        className={
                          activeCat === label ? "cat-chip on" : "cat-chip"
                        }
                        onClick={() => setActiveCat(label)}
                      >
                        {label}
                      </button>
                    ))}
                    {expanded ? null : (
                      <button
                        className="cat-chip more"
                        onClick={() => setRailExpanded(true)}
                        aria-label={`Show ${all.length - RAIL_LIMIT} more categories`}
                      >
                        more
                      </button>
                    )}
                  </>
                );
              })()}
            </nav>
          ) : null}

          {/* GRID, the middle column: only the shelf since the second live
              test; the tender and the receipt are the cart column. */}
          <div className="sale-right">
            {catalogLoading ? (
              <p className="muted">
                <span className="spinner" aria-label="working" /> Loading the
                catalog...
              </p>
            ) : catalogError ? (
              <div>
                <p className="note">Catalog unavailable: {catalogError}</p>
                <button className="class-change" onClick={loadCatalog}>
                  Retry
                </button>
              </div>
            ) : catalog ? (
              <>
                {onMemberships ? (
                  /* T30: contracts are NOT cart items -- tapping one
                     opens the dedicated purchase dialog instead of
                     ringing anything up. The card shows the recurring
                     amount, the honest headline of an autopay. */
                  <div className="shelf-grid">
                    {catalog.contracts.map((c) => (
                      <button
                        key={`contract-${c.id}`}
                        className="shelf-item shelf-contract"
                        onClick={() => setContractDialog(c)}
                        aria-label={`Start the ${c.name} membership`}
                      >
                        <span className="shelf-name">
                          {c.name}
                          <span className="shelf-bundle-mark"> membership</span>
                        </span>
                        <span className="shelf-foot">
                          <span className="shelf-price">
                            {c.autopayEnabled &&
                            c.recurringPaymentTotal !== null &&
                            c.recurringPaymentTotal > 0 ? (
                              <>
                                <span className="shelf-amt">
                                  {money(c.recurringPaymentTotal)}
                                </span>{" "}
                                {frequencyPhrase(c)}
                              </>
                            ) : c.firstPaymentTotal !== null ? (
                              <span className="shelf-amt">
                                {money(c.firstPaymentTotal)}
                              </span>
                            ) : (
                              ""
                            )}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : shelfEmpty ? (
                  <p className="muted">
                    {onFavorites
                      ? "Star items on any shelf, and configure bundles in src/lib/bundles.ts."
                      : "Nothing sellable in this category."}
                  </p>
                ) : (
                  <div className="shelf-grid">
                    {shelfItems.map((item) => {
                      const starred = favSet.has(itemKey(item.type, item.id));
                      const count = inCart.get(itemKey(item.type, item.id)) ?? 0;
                      return (
                        <div
                          className="shelf-cell"
                          key={`${item.type}-${item.id}`}
                        >
                          <button
                            className="shelf-item"
                            onClick={() => addItem(item)}
                            aria-label={`Add ${item.name}, ${money(item.price)}`}
                          >
                            <span className="shelf-name">{item.name}</span>
                            <span className="shelf-foot">
                              <span className="shelf-price">
                                <span className="shelf-amt">
                                  {money(item.price)}
                                </span>
                                {item.taxExempt ? (
                                  <span className="shelf-notax"> no tax</span>
                                ) : null}
                                {/* A package's shelf price is a local
                                    component-sum estimate (the API gives a
                                    package no price of its own); the cart
                                    total is Mindbody's, as always. */}
                                {item.type === "Package" ? (
                                  /* "est." because this number is OUR
                                     component-sum guess, not a Mindbody
                                     price; the cart total is Mindbody's. */
                                  <span className="shelf-bundle-mark">
                                    {" "}
                                    package, est.
                                  </span>
                                ) : null}
                              </span>
                              {/* T39.3: how many are rung up, from cart
                                  state. Reads "x2" so a teacher can see a
                                  double tap landed without looking at
                                  the ticket. */}
                              {count > 0 ? (
                                <span
                                  className="shelf-count"
                                  aria-label={`${count} in the cart`}
                                >
                                  &#215;{count}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          {/* Its own tap target beside (not inside) the add
                              button: nested buttons are invalid HTML and
                              double-fire. stopPropagation belt-and-braces. */}
                          <button
                            className={starred ? "shelf-star on" : "shelf-star"}
                            aria-pressed={starred}
                            aria-label={
                              starred
                                ? `Unstar ${item.name}`
                                : `Star ${item.name} as a favorite`
                            }
                            title={starred ? "Unstar" : "Star"}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFavorite(item);
                            }}
                          >
                            <StarIcon />
                          </button>
                        </div>
                      );
                    })}
                    {/* Bundles, after the starred items. One card, one tap,
                        every line into the cart. */}
                    {onFavorites
                      ? resolvedBundles.map((bundle) => (
                          <button
                            key={`bundle-${bundle.name}`}
                            className="shelf-item shelf-bundle"
                            onClick={() => addBundle(bundle)}
                            aria-label={`Add the ${bundle.name} bundle, ${money(bundle.total)}, ${bundle.items.length} items`}
                          >
                            <span className="shelf-name">
                              {bundle.name}
                              <span className="shelf-bundle-mark"> bundle</span>
                            </span>
                            <span className="shelf-foot">
                              <span className="shelf-price">
                                <span className="shelf-amt">
                                  {money(bundle.total)}
                                </span>
                              </span>
                            </span>
                          </button>
                        ))
                      : null}
                  </div>
                )}
              </>
            ) : null}
          </div>

          {/* THE PAYMENT SURFACE (T39.6): the middle column in pay mode,
              across the width the rail and grid share; hidden, not
              unmounted, in shelf mode. The tender, comp, the keypad and
              the outcomes are PaymentPanel's; the cart and the pricing
              loop stay here. */}
          <PaymentPanel
            cart={cart}
            priced={priced}
            pricing={pricing}
            client={client}
            cardLookup={cardLookup}
            visible={inPay}
            barSlot={barSlot}
            notice={payNotice}
            onSold={() => setCart([])}
            onDone={close}
            onBusyChange={setCharging}
            onModalChange={setPayModalOpen}
            cartResetNonce={cartResetNonce}
            onClientDataStale={onClientDataStale}
          />

          {/* CART, the right column (rail, grid, cart is the layout of
              record), the SAME element in both modes: it does not move,
              resize or remount when the mode switches (layout plan 2.5),
              so the teacher's eye keeps its anchor. In pay mode its rows
              are not selectable. */}
          <div className="sale-left">
              <div className="ticket">
            {/* T39.4: 1a's ticket. A head line, the count beside it, and
                no studio heading: the teacher knows where she is. */}
            <div className="t-head">
              <span className="t-head-name">Ticket</span>
              <span>
                {/* T38's cue, here since T39.4: the head never moves, so
                    the cue cannot change the box it measures. */}
                {hiddenBelow > 0 ? (
                  <span className="t-more" aria-live="polite">
                    {hiddenBelow} more below
                  </span>
                ) : null}
                <span className="t-head-count">
                  {cartCount} {cartCount === 1 ? "item" : "items"}
                </span>
              </span>
            </div>

            {cart.length === 0 ? (
              <div className="t-lines-wrap">
                <p className="t-empty">Nothing rung up yet.</p>
                {/* T38: a recheck that dropped every line lands here,
                    and the teacher must still be told what went. */}
                {report && report.dropped.length > 0 ? (
                  <p className="muted-note t-recheck">
                    {report.dropped
                      .map((name) => `${name} is no longer in the catalog and was removed`)
                      .join(". ")}
                    .
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                {/* The lines box takes whatever height the column leaves
                    it (T39.4: flex, not a vh cap), so the totals below
                    never leave the screen for any cart length. T38 made
                    the clipping visible: a fade over the last row and a
                    count riding it while rows are hidden below. */}
                <div
                  className={hiddenBelow > 0 ? "t-lines-wrap more" : "t-lines-wrap"}
                >
                <div className="t-lines" ref={linesRef} onScroll={measureLines}>
                {cart.map((line) => {
                  const sel = line.key === selected;
                  return (
                    /* T39.4: select to reveal. The row is the tap target
                       (a div with the button role: a <button> may not
                       contain the buttons the controls are), and only
                       the selected row shows minus / count / plus and
                       Remove. The controls stop propagation so a tap on
                       plus does not also deselect the row. */
                    <div
                      className={sel ? "t-row sel" : "t-row"}
                      key={line.key}
                      role={inPay ? undefined : "button"}
                      tabIndex={inPay ? undefined : 0}
                      aria-pressed={inPay ? undefined : sel}
                      aria-label={`${line.item.name}, ${line.quantity} at ${money(line.item.price)}${sel ? ", selected" : ""}`}
                      onClick={inPay ? undefined : () => toggleSelected(line.key)}
                      onKeyDown={
                        inPay
                          ? undefined
                          : (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleSelected(line.key);
                              }
                            }
                      }
                    >
                      <div className="t-line">
                        <span className="t-name">{line.item.name}</span>
                        <span className="amt">
                          {money(line.item.price * line.quantity)}
                        </span>
                      </div>
                      {/* The sub-line only above quantity one (0.1): a
                          single item's price IS its total. No "@ 0.00"
                          clause: a zero unit price cannot reach the shelf
                          (the catalog filters it), but a line that
                          somehow carries one reads better bare. */}
                      {line.quantity > 1 && line.item.price > 0 ? (
                        <div className="t-sub-line">
                          {line.quantity} @ {line.item.price.toFixed(2)}
                        </div>
                      ) : null}
                      {sel ? (
                        <div
                          className="t-ctl"
                          onClick={(e) => e.stopPropagation()}
                          /* Keys too (review): Enter on the focused plus
                             bubbled to the row's handler, which deselected
                             the row instead of counting one more. */
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <button
                            className="t-ctl-btn"
                            disabled={line.quantity <= 1 || charging}
                            aria-label={`One fewer ${line.item.name}`}
                            onClick={() => bumpQuantity(line.key, -1)}
                          >
                            <MinusIcon />
                          </button>
                          <span className="t-ctl-qty" aria-live="polite">
                            {line.quantity}
                          </span>
                          <button
                            className="t-ctl-btn"
                            disabled={line.quantity >= MAX_LINE_QUANTITY || charging}
                            aria-label={`One more ${line.item.name}`}
                            onClick={() => bumpQuantity(line.key, 1)}
                          >
                            <PlusIcon />
                          </button>
                          <button
                            className="t-ctl-remove"
                            disabled={charging}
                            aria-label={`Remove ${line.item.name} from the sale`}
                            onClick={() => removeLine(line.key)}
                          >
                            Remove
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                </div>
                </div>

                <div className="t-totals">
                {/* T38: what a recheck found, kept while this cart is the
                    one it rebuilt. Rendered above whatever the totals
                    area then says, since the two are read together: the
                    changes, and whether the stop still stands. */}
                {report ? (
                  <p
                    className={
                      report.error ? "muted-note t-recheck bad" : "muted-note t-recheck"
                    }
                  >
                    {report.error
                      ? `Recheck failed: ${report.error}`
                      : report.changes.length === 0 && report.dropped.length === 0
                        ? "Rechecked against the current catalog: no price changed."
                        : [
                            ...report.changes.map(
                              (c) => `${c.name}: ${money(c.from)} is now ${money(c.to)}`,
                            ),
                            ...report.dropped.map(
                              (name) => `${name} is no longer in the catalog and was removed`,
                            ),
                          ].join(". ") + "."}
                  </p>
                ) : null}

                {/* The totals area. The server's numbers or an honest
                    absence; local math never renders as a total. */}
                {estimate ? (
                  <>
                    {/* T38: the browser's estimate while Mindbody prices
                        the cart, muted and labelled, in the same rows the
                        server's numbers will replace. The payment seam
                        cannot read it: `total` there is null until the
                        server answers, the sources grey with the reason,
                        and Charge stays disabled. */}
                    <div className="t-est" aria-busy="true">
                      <div className="t-line t-muted">
                        <span>Subtotal</span>
                        <span className="amt">{money(estimate.subTotal)}</span>
                      </div>
                      <div className="t-line t-muted">
                        <span>{taxLabel}</span>
                        <span className="amt">
                          {estimate.taxTotal !== null
                            ? money(estimate.taxTotal)
                            : "pending"}
                        </span>
                      </div>
                      <hr className="t-rule" />
                      <div className="t-line t-total t-muted">
                        <span>Estimated</span>
                        <span className="amt">
                          {estimate.grandTotal !== null
                            ? money(estimate.grandTotal)
                            : money(estimate.subTotal) + " + tax"}
                        </span>
                      </div>
                    </div>
                    <p className="t-pricing">
                      <span className="spinner" aria-label="working" /> Pricing
                      with Mindbody...
                    </p>
                  </>
                ) : priceError ? (
                  <div className="sale-stop">
                    Pricing failed: {priceError}
                  </div>
                ) : totals?.needsClient ? (
                  <>
                    {/* Bug-1 branch (b): the LOCAL estimate, muted and
                        labelled as such. The Charge button never sees a
                        total from this state; only a server-priced total
                        charges (the T23/T24 invariant). */}
                    <div className="t-line t-total t-muted">
                      <span>Estimated</span>
                      <span className="amt">
                        {money(totals.expectedTotal)}
                      </span>
                    </div>
                    <p className="muted-note">
                      Estimated. Attach a client to price with Mindbody.
                    </p>
                  </>
                ) : totals?.suppressed ? (
                  <div className="pass-note t-suppressed">
                    Suppressed (dry run or write guard): Mindbody did not
                    price this cart, so there is no total to show. Nothing
                    was written.
                  </div>
                ) : totals ? (
                  <>
                    {totals.disagrees ? (
                      <div className="sale-stop">
                        Totals disagree. Our math says{" "}
                        {money(totals.expectedTotal)}, Mindbody says{" "}
                        {totals.grandTotal !== null
                          ? money(totals.grandTotal)
                          : "nothing"}
                        . Do not charge; this is a bug to report.
                        {/* T38: the per-line audit, so the stop names
                            WHICH line. A line with no Mindbody side is
                            the loudest finding: the item we sent is not
                            the item it priced. Diagnostic only. */}
                        {auditTable}
                        {/* T38: the way out of the stop. Recheck refetches
                            the catalog past its cache and reprices through
                            the ordinary loop; Clear cart is on the foot
                            row above. Neither touches the stop itself:
                            Charge is disabled while `disagrees` is true,
                            and only a fresh server price that agrees
                            lifts it. */}
                        <button
                          className="audit-recheck"
                          disabled={rechecking || charging}
                          onClick={() => void recheckPrices()}
                        >
                          {rechecking ? (
                            <>
                              <span className="spinner" aria-label="working" />{" "}
                              Rechecking...
                            </>
                          ) : (
                            "Recheck prices"
                          )}
                        </button>
                      </div>
                    ) : null}
                    {totals.subTotal !== null ? (
                      <div className="t-line t-muted">
                        <span>Subtotal</span>
                        <span className="amt">{money(totals.subTotal)}</span>
                      </div>
                    ) : null}
                    {totals.taxTotal !== null ? (
                      <div className="t-line t-muted">
                        <span>{taxLabel}</span>
                        <span className="amt">{money(totals.taxTotal)}</span>
                      </div>
                    ) : null}
                    <hr className="t-rule" />
                    <div className="t-line t-total">
                      <span>Total</span>
                      <span className="amt">
                        {totals.grandTotal !== null
                          ? money(totals.grandTotal)
                          : ""}
                      </span>
                    </div>
                    {/* T30 carve-out, the quiet face of it: a package
                        line has no tax basis of its own, so the strict
                        disagree assertion is off for this cart and the
                        server's total simply stands. */}
                    {totals.packagePricing ? (
                      <p className="muted-note">
                        Includes a package; priced by Mindbody.
                      </p>
                    ) : null}
                    {/* The Comp-stub fact is deliberately NOT printed on
                        the receipt any more: it is developer-speak on a
                        teacher screen, and the dev drawer's call log
                        already carries which shape priced the cart. */}
                  </>
                ) : null}
                </div>
              </>
            )}
              </div>
          </div>
        </div>
      </div>

      {/* T39.5: the action bar, the overlay's last child so it sits at
          the bottom of the viewport under the columns (sticky, for the
          narrow fold where the overlay scrolls). Empty cart left, behind
          T38's confirm exactly; the primary right. It stacks BELOW every
          modal scrim (the scrims are z-index 30 in the overlay's own
          stacking context, the bar 5), so nothing on it is tappable
          behind a dialog. */}
      <div className="sale-bar">
        <div className="sale-bar-in">
          {inPay ? (
            /* T39.6: the way back to the shelf, the same quiet control
               Empty cart is in shelf mode. Locked mid-charge like every
               other exit: the outcome renders on the surface. */
            <button
              className="sale-bar-empty"
              disabled={charging}
              onClick={leavePay}
            >
              {"\u2190"} Back to items
            </button>
          ) : (
            <button
              className="sale-bar-empty"
              disabled={cart.length === 0 || charging}
              onClick={() => setClearPrompt(cartCount)}
            >
              Empty cart
            </button>
          )}
          {/* T39.6: the primary's slot. In pay mode PaymentPanel renders
              `Due $X` / `Charge $total` INTO it through a portal, so the
              button is gated by the same render's `chargeable`; in shelf
              mode it is empty and the shelf's Pay stands beside it. */}
          <span className="sale-bar-slot" ref={setBarSlot} />
          {inPay ? null : (
            <button
              className={payWhy === null ? "sale-bar-pay" : "sale-bar-pay off"}
              aria-disabled={payWhy !== null}
              title={payWhy ?? `Pay ${money(payAmount ?? 0)}`}
              onClick={() => {
                if (payWhy !== null) return;
                /* Into pay mode: the rail and grid give way to the
                   payment surface, the cart stays put, and the selection
                   goes (the pay-mode ticket has no controls). */
                setSelectedKey(null);
                setSaleMode("pay");
              }}
            >
              <span>Pay</span>
              {cartCount > 0 ? (
                <span className="sale-bar-count">
                  {"\u00b7"} {cartCount} {cartCount === 1 ? "item" : "items"}
                </span>
              ) : null}
              {payAmount !== null ? (
                <span className="sale-bar-amt">
                  {"\u00b7"} {money(payAmount)}
                </span>
              ) : pricing && cart.length > 0 ? (
                <span className="spinner" aria-label="pricing" />
              ) : null}
            </button>
          )}
        </div>
      </div>

      {/* The keep-or-empty dialog (third live test). The client switch
          already happened; this only decides the cart, so no path out of
          here can lose the attach. Scrim and Escape KEEP the items (a
          dismissal must not destroy a cart); "Empty cart" is the primary
          button because a new cart per client is Pete's default. */}
      {/* T30: the membership purchase dialog. The attach search modal
          stacks above it (modalAbove), so its attach button reuses the
          exact flow the sale's own attach uses; the client prop updates
          live and the dialog rehearses. Busy state rides setCharging so
          Back and Escape lock while the purchase is in flight. */}
      {contractDialog ? (
        <ContractDialog
          contract={contractDialog}
          client={client}
          cardLookup={cardLookup}
          onClose={() => setContractDialog(null)}
          onRequestAttach={onRequestAttach}
          onBusyChange={setCharging}
          onPurchased={(cid) => {
            /* A contract's first payment can spend credit and always
               changes what the client holds: same refresh as a sale. */
            setProfileNonce((n) => n + 1);
            onContractPurchased?.(cid);
          }}
          modalAbove={modalAbove}
        />
      ) : null}

      {cartPrompt ? (
        <div className="modal-scrim" role="presentation" onClick={keepCart}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Start a new cart?"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">Start a new cart?</p>
            <p className="modal-note">
              This cart has {cartPrompt.count}{" "}
              {cartPrompt.count === 1 ? "item" : "items"}.{" "}
              {cartPrompt.toName
                ? `Keep them for ${cartPrompt.toName}?`
                : "Keep them?"}
            </p>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={keepCart}>
                Keep items
              </button>
              <button className="modal-confirm go" onClick={emptyCart}>
                Empty cart
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* T38: Clear cart's confirmation. Same idiom as the dialog above,
          with the stop pairing on the confirm because this one IS
          destructive and was asked for deliberately. Scrim and Escape
          cancel; nothing but the confirm button empties. */}
      {clearPrompt !== null ? (
        <div className="modal-scrim" role="presentation" onClick={cancelClear}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Clear the cart?"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">Clear the cart?</p>
            <p className="modal-note">
              {clearPrompt === 1
                ? "This removes the one item rung up."
                : `This removes all ${clearPrompt} items rung up.`}
              {client ? ` ${client.name} stays attached.` : ""}
            </p>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={cancelClear}>
                Keep items
              </button>
              <button className="modal-confirm" onClick={confirmClear}>
                Clear cart
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
