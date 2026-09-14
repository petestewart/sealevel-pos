"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { actorFallbackLine } from "./actornote";
import { toggleTheme } from "./theme";

import {
  COMP_DETAIL_MAX,
  COMP_DETAIL_MIN,
  COMP_KIND_LABELS,
  COMP_KINDS,
  compHeadline,
  compNeedsDetail,
  compReasonLine,
  compValid,
  DISCOUNT_PERCENT_MAX,
  DISCOUNT_PERCENT_MIN,
  discountCents,
  discountPercentLabel,
  discountRefusal,
  isFullDiscount,
  isPinShape,
  PIN_MAX,
  PIN_MIN,
  subtotalCents,
  type CompKind,
  type CompReason,
  type Discount,
  type DiscountLine,
} from "@/lib/comp";

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
  /** T89: who asked for the dry run, "env" (the server) or "browser"
   *  (this iPad's own, which the banner names). Absent before the config
   *  loads and null when nothing is suppressed. */
  dryRunSource?: string | null;
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
  /** T41: whether POS_HOUSE_CLIENT_ID is set on the server, which is
   *  what an anonymous (unattached) sale rides: Mindbody prices and
   *  charges nothing without a client (confirmed live 2026-08-30).
   *  Absent on the lock screen's trimmed answer and before config loads. */
  houseClient?: boolean;
}

/**
 * T41: the attach modal's footer sentence, in page.tsx, promised "close
 * to sell anonymously" while the Pay button stayed disabled on Pete's
 * counter, because anonymous needs the house client and his server had
 * none. The sentence now depends on the same flag the totals read.
 * Exported for page.tsx; null config (not loaded yet) makes no promise.
 */
export function attachSearchHint(config: ModeConfig | null): string {
  if (config?.houseClient === true) {
    return "Search for the client the sale is for, or close to sell anonymously.";
  }
  if (config?.houseClient === false) {
    return (
      "Search for the client the sale is for. Anonymous sales need " +
      "POS_HOUSE_CLIENT_ID set on the server."
    );
  }
  return "Search for the client the sale is for.";
}

/** T41: the one line the totals area shows for an unattached cart when no
 *  house client is configured. Names the variable, because "attach a
 *  client" alone hid that anonymous was ever an option. */
export const NEEDS_HOUSE_CLIENT_LINE =
  "Anonymous sales need POS_HOUSE_CLIENT_ID set on the server; attach a " +
  "client instead.";

/**
 * The mode banner, shared verbatim between the roster page and the sale
 * overlay: a teacher mid-sale must not have to leave the screen to know
 * whether the counter is live.
 */
/** The mode line's text, which is also the key its dismissal is stored
 *  under: any change of mode (dry run, target, site, the guard) brings a
 *  hidden banner back. */
function modeLine(config: ModeConfig): string {
  return (
    (config.dryRun
      ? /* T89: a dry run this browser asked for says so, since the
           counter beside it may be writing for real. */
        config.dryRunSource === "browser"
        ? "Dry run on this iPad. Nothing is written to Mindbody."
        : "Dry run. Nothing is written to Mindbody."
      : "LIVE. Taps check real students in.") +
    ` ${config.target === "prod" ? "Production" : "Sandbox"} site ${config.siteId}.` +
    (!config.dryRun && config.writeClientIds.length > 0
      ? ` Writes limited to client ${config.writeClientIds.join(", ")}.`
      : "")
  );
}

/** The mode line a teacher hid, shared by the banner's three homes (the
 *  roster, the sale overlay, the sign-in gate) and by nothing else: in
 *  memory only, so a reload shows the banner again. */
let hiddenModeLine: string | null = null;
const bannerListeners = new Set<() => void>();

/** The mode banner, with an X (Pete: "have an X on the right so I can
 *  hide it"). Hiding lasts until the page reloads or the line changes
 *  (dry run, target, site, the guard), so a counter that switched to
 *  sandbox or dry run cannot keep a stale dismissal. */
export function ModeBanner({ config }: { config: ModeConfig | null }) {
  const line = config && !config.configError ? modeLine(config) : null;
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    bannerListeners.add(l);
    return () => {
      bannerListeners.delete(l);
    };
  }, []);
  if (line === null || hiddenModeLine === line) return null;
  return (
    <p className={config!.dryRun ? "banner" : "banner live"}>
      <span className="banner-text">{line}</span>
      <button
        type="button"
        className="banner-x"
        aria-label="Hide this banner"
        title="Hide until the page reloads or the mode changes"
        onClick={() => {
          hiddenModeLine = line;
          bannerListeners.forEach((l) => l());
        }}
      >
        <CloseIcon />
      </button>
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
  /** T74: a pass's sub-category label (the shelf config's group), null
   *  when ungrouped. Absent on products and packages. */
  group?: string | null;
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
  /** T76: the rail section this entry lives under (categories.ts
   *  CounterSection). Optional only so an older payload still draws a
   *  rail (see `sectionOf`). */
  section?: string;
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
  /** T74: pass sub-category labels in rail order, only those with a
   *  visible pass. Empty means the Passes shelf is one plain grid. */
  passGroups: string[];
  /** T76: the shared favorites from app_settings, or null when nothing
   *  is stored for this target (no database, no row), in which case the
   *  device's own localStorage list applies. */
  favorites: FavPair[] | null;
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

/** T76: the rail's top level after Favorites, in its fixed order. Passes
 *  and Retail are SECTIONS whose children are the pass sub-categories
 *  (plus Packages and Memberships) and the retail categories; Rentals is
 *  a leaf. The strings are categories.ts's `section` names, so the
 *  Passes header and the config entry that IS Passes share one label.
 *  The T39.2 "more" fold (RAIL_LIMIT) was retired here: the hierarchy
 *  holds every entry without folding. */
const PASSES_SECTION = "Passes";
const RETAIL_SECTION = "Retail";
const RENTALS_SECTION = "Rentals";
type RailSection =
  | typeof PASSES_SECTION
  | typeof RETAIL_SECTION
  | typeof RENTALS_SECTION;

/** A category's section, tolerating the pre-T76 payload (no `section`):
 *  no ids is Passes, a rental-sounding label is Rentals, the rest is
 *  Retail. The T67 harness feeds that older shape. */
function sectionOf(c: ShelfCategory): RailSection {
  if (
    c.section === PASSES_SECTION ||
    c.section === RETAIL_SECTION ||
    c.section === RENTALS_SECTION
  ) {
    return c.section;
  }
  if (c.categoryIds.length === 0) return PASSES_SECTION;
  return /rental|towel/i.test(c.label) ? RENTALS_SECTION : RETAIL_SECTION;
}

/** T76: "TEACHER ..." retail items are the staff's own stock (Food/Drink
 *  carries a TEACHER-prefixed twin of several drinks). A retail child
 *  with any of them gets General | Teacher sub-tabs: General hides
 *  them, Teacher shows them alone. Case-insensitive, trimmed. */
function isTeacherItem(item: ShelfItem): boolean {
  return /^teacher\b/i.test(item.name.trim());
}

/** One starred type+id pair, as persisted. Packages star like anything
 *  else on the shelf (T30): they are ordinary cart items. The shared
 *  list (T76) carries string ids; a device's older localStorage list
 *  may carry a pass's numeric id; itemKey stringifies, so both match. */
interface FavPair {
  type: "Product" | "Service" | "Package";
  id: string | number;
}

/** localStorage key, PER TARGET: sandbox stars must never render on the
 *  studio's shelf (item ids differ per site, so at best they would miss;
 *  at worst a sandbox id could collide with an unrelated prod item).
 *  Since T76 this is the fallback behind the shared list in the
 *  database: what the screen uses when /api/catalog serves no
 *  favorites, and what a star tap keeps writing so nothing regresses
 *  without a database. */
function favoritesKey(target: string): string {
  return `pos.favorites.${target}`;
}

/** A stored or served favorites list, kept only if it is one. */
function readFavPairs(parsed: unknown): FavPair[] {
  return Array.isArray(parsed)
    ? parsed.filter(
        (p): p is FavPair =>
          p !== null &&
          typeof p === "object" &&
          (p.type === "Product" ||
            p.type === "Service" ||
            p.type === "Package") &&
          (typeof p.id === "string" || typeof p.id === "number"),
      )
    : [];
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
    passGroups: Array.isArray(body?.passGroups) ? body.passGroups : [],
    favorites: Array.isArray(body?.favorites)
      ? readFavPairs(body.favorites)
      : null,
  };
}

/** T74's label for passes the payload left ungrouped. Since T76 every
 *  pass on the Passes shelf carries a group (the rule fills what no T74
 *  group names), so this is a fallback for an older payload only; it is
 *  never a group label (shelfconfig's RESERVED_GROUP_LABEL refuses it). */
const OTHER_GROUP_LABEL = "Other";

/** One block of the grid: a kicker (null for the bare grid) over its
 *  items, or over contracts for the Memberships block (a contract is
 *  not a shelf item, T30; it renders its own card and opens the
 *  membership dialog). */
interface ShelfSection {
  label: string | null;
  items: ShelfItem[];
  contracts: ContractInfo[];
}

/**
 * T76: the Passes section's children in rail order: the pass groups
 * with an item on the Passes shelf (the payload's order: the fixed
 * labels, custom labels after), an Other fallback when a pass carries
 * no known group, then Packages and Memberships when they have
 * something to sell. Pete's list did not name the last two; they have
 * nowhere else to live.
 */
function passChildren(catalog: CatalogState, passes: ShelfItem[]): string[] {
  const groups = catalog.passGroups.filter((g) =>
    passes.some((i) => i.group === g),
  );
  const other = passes.some((i) => !i.group || !groups.includes(i.group));
  return [
    ...groups,
    ...(other ? [OTHER_GROUP_LABEL] : []),
    ...(catalog.packages.length > 0 ? [PACKAGES_LABEL] : []),
    ...(catalog.contracts.length > 0 ? [MEMBERSHIPS_LABEL] : []),
  ];
}

/**
 * The Passes shelf's blocks: with no child chosen, every child under
 * its kicker (the T74 "All" rendering); a chosen child's block alone,
 * unlabelled. A child the catalog no longer offers reads as All.
 */
function passSections(
  catalog: CatalogState,
  passes: ShelfItem[],
  children: string[],
  child: string | null,
): ShelfSection[] {
  const groups = children.filter(
    (l) =>
      l !== OTHER_GROUP_LABEL && l !== PACKAGES_LABEL && l !== MEMBERSHIPS_LABEL,
  );
  const block = (label: string): ShelfSection => {
    if (label === PACKAGES_LABEL) {
      return { label, items: catalog.packages, contracts: [] };
    }
    if (label === MEMBERSHIPS_LABEL) {
      return { label, items: [], contracts: catalog.contracts };
    }
    if (label === OTHER_GROUP_LABEL) {
      return {
        label,
        items: passes.filter((i) => !i.group || !groups.includes(i.group)),
        contracts: [],
      };
    }
    return { label, items: passes.filter((i) => i.group === label), contracts: [] };
  };
  if (child !== null && children.includes(child)) {
    return [{ ...block(child), label: null }];
  }
  return children.map(block);
}

/**
 * T41: what one category button shows. "Passes" (the entry with no
 * category ids) is every pricing option the server left unrouted; any
 * other button is its retail products plus the pricing options
 * /api/catalog stamped with its id (towel and mat rentals are services
 * in a service category, never products). One function for the shelf
 * and the rail, so the rail can hide exactly the buttons whose shelf
 * would be empty.
 */
function categoryShelf(
  catalog: CatalogState,
  category: ShelfCategory,
): ShelfItem[] {
  if (category.categoryIds.length === 0) {
    return catalog.passes.filter((p) => p.categoryId === null);
  }
  const wanted = (p: ShelfItem) =>
    p.categoryId !== null && category.categoryIds.includes(p.categoryId);
  return [...catalog.products.filter(wanted), ...catalog.passes.filter(wanted)];
}

/**
 * One rung-up line. Keyed by type+id AND recipient (cartKey below), so
 * re-tapping an item bumps its quantity instead of adding a duplicate
 * line, and the same item bought for two different people is two lines.
 */
interface CartEntry {
  key: string;
  item: ShelfItem;
  quantity: number;
  /**
   * T90 (Pete: "another client can be selected and the pass is
   * attributed to them"): who this line is FOR, when it is not the
   * client paying. Null for the ordinary line. The ticket reads
   * "Drop In (Alison Stewart)", and the charge sends the line with its
   * `forClientId` so /api/checkout files it as its own Mindbody sale
   * under that client (one ClientId per cart; see src/lib/sale.ts
   * groupByRecipient).
   */
  forClient?: SaleRecipient | null;
}

/** T90: a line's recipient, as the search modal picked them. */
export interface SaleRecipient {
  id: string;
  name: string;
}

/** The cart key: the item's identity, plus whose line it is. */
function cartKey(item: ShelfItem, forClientId: string | null): string {
  return `${itemKey(item.type, item.id)}:${forClientId ?? "self"}`;
}

/** How the ticket, the pay screen, the done screen and the receipt lines
 *  all name a line: "Drop In", or "Drop In (Alison Stewart)". */
function lineLabel(line: CartEntry): string {
  return line.forClient ? `${line.item.name} (${line.forClient.name})` : line.item.name;
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
  /** T75: the shelf's pre-tax sum, the figure `disagrees` compares. */
  expectedSubtotal: number;
  /** T79: the server's spread of the armed discount (0 without one),
   *  and whether Mindbody's DiscountTotal disagreed with it; `disagrees`
   *  covers that case too. */
  expectedDiscount?: number;
  discountDisagrees?: boolean;
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

/* T70: the icons are the mockups' (docs/design/mockups/visual-pass/
 * Buy.dc.html, Payment.dc.html): inline SVG, stroke 2, SQUARE caps, no
 * fill, in currentColor so each takes its cell's colour. Square caps are
 * part of the look; the round 2.4 strokes they replace are gone. */
function Icon(props: { d?: string; size?: number; children?: ReactNode }) {
  const size = props.size ?? 20;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      aria-hidden="true"
    >
      {props.children}
      {props.d ? <path d={props.d} /> : null}
    </svg>
  );
}

function CloseIcon() {
  return <Icon d="M6 6l12 12M18 6 6 18" />;
}

/** Two arcs with arrowheads (the common "refresh" glyph), round caps so
 *  the arrowheads read cleanly at 22px; the square-capped house Icon
 *  drew this one badly (Pete: "the icon you're using is poor quality"). */
function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

/** T76: the section header's disclosure mark, pointing right when the
 *  section is closed and turned down by CSS when it is open. */
function ChevronIcon() {
  return (
    <span className="cat-chev" aria-hidden="true">
      <Icon size={20} d="M9 6l6 6-6 6" />
    </span>
  );
}

function MinusIcon() {
  return <Icon d="M5 12h14" />;
}

/** T82 (Pete): "in the number pad entry for amounts (discount, cash)
 *  change 'del' to a delete icon (backspace with X)". The house Icon at
 *  24: the tab pointing left at the entry it deletes from, with the X
 *  inside it. The key keeps its size and its stop colour; the word it
 *  replaces rides the aria-label. */
function BackspaceIcon() {
  return (
    <Icon
      d="M9.5 5H20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9.5L3 12l6.5-7zM12.5 9.5l5 5M17.5 9.5l-5 5"
      size={24}
    />
  );
}

function PlusIcon() {
  return <Icon d="M12 5v14M5 12h14" size={22} />;
}

/** The sun cell in the header: light becomes dark and back (theme.ts). */
function SunIcon() {
  return (
    <Icon
      d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
      size={22}
    >
      <circle cx="12" cy="12" r="4" />
    </Icon>
  );
}

/** The check on the bar's Charged state and the done block. */
function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

/* T51 (Pete: "'Card', 'Cash' and 'Account' should have icons next to
 * them"): a card with its stripe, a banknote, a person for the account,
 * the first two as Payment.dc.html draws them. */
function CardIcon() {
  return (
    <Icon d="M2 10h20" size={24}>
      <rect x="2" y="5" width="20" height="14" />
    </Icon>
  );
}

function CashIcon() {
  return (
    <Icon size={24}>
      <rect x="2" y="6" width="20" height="12" />
      <circle cx="12" cy="12" r="2.5" />
    </Icon>
  );
}

function AccountIcon() {
  return (
    <Icon d="M4 21c0-4 3.6-6 8-6s8 2 8 6" size={24}>
      <circle cx="12" cy="8" r="4" />
    </Icon>
  );
}

/** The favorite star (Buy.dc.html). Outline at rest; `.shelf-star.on`
 *  fills it with the gold token. */
function StarIcon() {
  return (
    <Icon
      d="m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.9-5 2.9 1-5.6-4-3.9 5.5-.8Z"
      size={18}
    />
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
  /** T53: the email on file and the two email consent flags, from the
   *  same read (they ride the client row the card does). The flags are
   *  null until the read lands or when it failed: unknown is not false,
   *  and the gate treats the two differently. */
  email: string | null;
  sendAccountEmails: boolean | null;
  sendPromotionalEmails: boolean | null;
}

/** T53: what the pay surface knows about emailing a receipt: the address
 *  it would go to, and the reason it cannot (null when it can). Computed
 *  by SaleScreen from the attach-time lookup and the gate's outcome. */
interface ReceiptState {
  email: string | null;
  why: string | null;
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
  | {
      kind: "paid";
      summary: string;
      detail: string | null;
      /** T39.7: the done block's figures, captured at the tap because
       *  the cart is cleared in the same commit. Display only: the
       *  total is the server's answer (or the rehearsed figure it
       *  confirmed), the count is the cart's, the change is what the
       *  drawer owes back on a cash over-tender. */
      total: number;
      count: number;
      changeCents: number;
      comped: boolean;
      /** T43: the reason the teacher gave for a discount, for the done
       *  screen's "Comped: <reason>" or "Discount $60.00 (60%): <reason>"
       *  line. Null on an undiscounted sale. */
      compReason: CompReason | null;
      /** T79: the discount as the server recorded it: the dollars off
       *  the pre-tax subtotal, that subtotal, and the percent label.
       *  Null on an undiscounted sale. */
      discount: { amount: number; subtotal: number; percent: string } | null;
      /** T49: the amber line when the sale ran as the studio account
       *  after the signed-in teacher's token was refused; else null. */
      actorNote: string | null;
      /** T53: "Receipt emailed to x" when Mindbody confirmed one,
       *  "Receipt requested for x" when it was asked for and the
       *  answer carries no confirmation (a cart checkout never does);
       *  null when no receipt was requested. */
      receiptLine: string | null;
    }
  /* T90: `summary` is the route's own sentence for a ticket where some
     carts went out and some were suppressed (the write guard judges each
     cart by its own client id). Null on the ordinary whole-ticket
     suppression. */
  | { kind: "suppressed"; mode: string; summary?: string | null }
  | { kind: "split"; message: string; mindbody: string }
  | { kind: "ambiguous"; message: string }
  | { kind: "error"; message: string };


/** T43: a discount needs a reason; T45: the reason is a KIND from
 *  comp.ts's closed list and an optional note. The dialog's draft is
 *  that shape with nothing chosen yet; compValid (shared with
 *  /api/checkout) says when it is complete, so what the dialog accepts
 *  is what the route accepts. T79 dropped the Teacher kind and its
 *  picker. */
interface CompDraft {
  kind: CompKind | null;
  detail: string;
}
const EMPTY_COMP_DRAFT: CompDraft = { kind: null, detail: "" };

/** T79: the amount step's draft. `mode` is the segment (Whole sale is
 *  percent 100 with the keys off); `entry` the digits typed since the
 *  dialog opened, accumulating into CENTS for an amount (2-0-0-0 reads
 *  $20.00, the T36 pad's idiom) and into whole percent for a percent. */
type DiscountDraftMode = "amount" | "percent" | "whole";
interface DiscountDraft {
  mode: DiscountDraftMode;
  entry: string;
}
const EMPTY_DISCOUNT_DRAFT: DiscountDraft = { mode: "amount", entry: "" };

/** A teacher as /api/teacher/verify names them: id and name. */
interface StaffChoice {
  id: number;
  name: string;
}

/** T48/T79: an armed discount carries the discount, its reason AND who
 *  is discounting: the teacher /api/teacher/verify named for the PIN
 *  typed in the dialog, and the one-shot token it signed, which the
 *  charge hands to /api/checkout. The state shape is the rule: there is
 *  no way to hold an armed discount with nobody behind it. It lives in
 *  SaleScreen (it is cart state: the pricing loop sends it) and the
 *  panel reads and sets it through props. */
interface ArmedDiscount {
  discount: Discount;
  reason: CompReason;
  teacher: StaffChoice;
  token: string;
}

/** The discount dialog's steps (T48): the amount and reason (T43/T45/
 *  T79), then the PIN, then "Discounting as <name>" with the button that
 *  arms; `enroll` is the side form reached from the PIN step to set or
 *  change a PIN through a Mindbody sign-in. */
type CompStep = "reason" | "pin" | "ready" | "enroll";

const EMPTY_ENROLL = { username: "", password: "", pin: "", confirm: "" };

/** The reason a complete draft describes. The caller has checked
 *  compValid; a null kind here is a programming error, not a state. */
function draftToReason(d: CompDraft): CompReason | null {
  if (d.kind === null) return null;
  return { kind: d.kind, detail: d.detail.trim() };
}

/** T79: the discount a draft describes against a cart's pre-tax subtotal
 *  (in cents), or null while nothing valid is entered. The clamps are
 *  parseDiscount's, so the server accepts exactly what this returns. */
function draftToDiscount(d: DiscountDraft, subtotal: number): Discount | null {
  if (subtotal <= 0) return null;
  if (d.mode === "whole") return { mode: "percent", value: 100 };
  const n = d.entry === "" ? 0 : Number(d.entry);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (d.mode === "percent") {
    return n >= DISCOUNT_PERCENT_MIN && n <= DISCOUNT_PERCENT_MAX
      ? { mode: "percent", value: n }
      : null;
  }
  return n <= subtotal ? { mode: "amount", value: n / 100 } : null;
}

/**
 * T90: one Mindbody sale this charge made. A ticket with no line for
 * another client makes exactly one; a ticket with lines for two other
 * people makes three, the paying client's first. Reported up through
 * `onSold` so a caller can act on what each client just bought (T88).
 */
export interface SoldSale {
  /** The client the sale was filed under: the recipient, or the payer. */
  clientId: string | null;
  /** The recipient, or null when the line was the payer's own. */
  forClientId: string | null;
  saleId: string | null;
  /** Every line's metadataId, as the cart sent them. */
  productIds: string[];
  total: number;
}

/** T79: the discount's lines, as the spread reads a cart entry. */
function discountLines(cart: readonly CartEntry[]): DiscountLine[] {
  return cart.map((l) => ({ price: l.item.price, quantity: l.quantity }));
}

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
   * T70: the ticket's tender slot, under its Total (Payment.dc.html).
   * The panel renders one "<Method> received $X" line per tender and the
   * change or the shortfall through it, so the ticket reads the lines
   * this render computed. T85 leaves this portal alone: the slot is in
   * the ticket, which is another column.
   */
  ticketSlot: HTMLElement | null;
  /** T39.6: what SaleScreen wants said above the figures in pay mode --
   *  the suppressed notice, the disagree stop with T38's audit table --
   *  so the figures never stand next to a total they contradict. The
   *  ticket keeps its own copy. */
  notice: ReactNode;
  /** Clear the cart: the sale is recorded on Mindbody's side. T90: with
   *  every sale it made, one per recipient (T88 will read it). */
  onSold: (sales: readonly SoldSale[]) => void;
  /** The paid receipt's Done: close the overlay back to the roster. */
  onDone: () => void;
  /** T49: a charge answered that the signed-in teacher's Mindbody token
   *  is no longer valid and the staff session has ended; the header
   *  control goes back to "Sign in". */
  onStaffSessionEnded: () => void;
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
  /** T79: the armed discount, SaleScreen's state (the pricing loop sends
   *  it with the cart), read here and set through `onDiscountChange`:
   *  the dialog arms it, a tap on the armed control, a client change,
   *  a completed sale, leaving pay mode and an emptied cart clear it. */
  discount: ArmedDiscount | null;
  onDiscountChange: (next: ArmedDiscount | null) => void;
  /** T53: whether a receipt can be emailed, and where. The toggle
   *  below the tender reads it; the Charge tap sends the toggle. */
  receipt: ReceiptState;
}) {
  const {
    cart,
    priced,
    pricing,
    client,
    cardLookup,
    visible,
    ticketSlot,
    notice,
    onSold,
    onDone,
    onStaffSessionEnded,
    onClientDataStale,
    onBusyChange,
    onModalChange,
    cartResetNonce,
    discount: comp,
    onDiscountChange: setComp,
    receipt,
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
   *  disarms it. The two can never both be set.
   *
   *  T43 (Pete: "is there a way to force the teacher to write a reason
   *  for comping?"): an armed comp IS its reason. The state is the
   *  reason or null, not a boolean beside a string, so no render can
   *  find comp armed with nothing written; `chargeable` still checks the
   *  text in the same render, belt and braces. */
  /* T79: `comp` is the armed discount (SaleScreen's state, see the
   * props). `comped` is the 100% case, the one that reads "Comped",
   * takes no tender and sends method comp; `discounted` is any armed
   * discount, whose remainder is paid the ordinary way. The spread is
   * recomputed from the CART on every render, so a line added under an
   * armed discount re-spreads it (the amounts on screen are only ever
   * the browser's copy; the server spreads again from the lines). */
  const cartSubtotalCents = subtotalCents(discountLines(cart));
  const armedCents =
    comp === null ? 0 : discountCents(discountLines(cart), comp.discount);
  const comped =
    comp !== null && isFullDiscount(discountLines(cart), comp.discount);
  const discounted = comp !== null;
  /** The reason dialog the Discount tap opens (T43): open, the amount
   *  draft (T79) and the reason draft the chips and the note field
   *  build. Nothing arms until the button on the ready step is tapped
   *  with both drafts complete and, since T48, a PIN verified. */
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonDraft, setReasonDraft] = useState<CompDraft>(EMPTY_COMP_DRAFT);
  const [discountDraft, setDiscountDraft] = useState<DiscountDraft>(
    EMPTY_DISCOUNT_DRAFT,
  );
  const discountDraftRef = useRef(discountDraft);
  discountDraftRef.current = discountDraft;
  const [reasonStep, setReasonStep] = useState<CompStep>("reason");
  /** T48: the PIN step. The digits typed (never sent anywhere but
   *  /api/teacher/verify, never kept once answered), the line under the
   *  dots, the lockout, and once a PIN matched, who it named and the
   *  token to charge with. */
  const [pinEntry, setPinEntry] = useState("");
  const pinEntryRef = useRef("");
  /** The signed-in teacher's PIN length, read from /api/teacher when the
   *  PIN step opens (Pete: "I should not have to click Done, it should
   *  automatically enable Done on the last digit"): at that many digits
   *  the entry submits itself. Null (a PIN set before the length was
   *  recorded, no database, or the read failed) keeps the Done key. */
  const [pinLength, setPinLength] = useState<number | null>(null);
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [pinShake, setPinShake] = useState(0);
  const [pinBusy, setPinBusy] = useState(false);
  const pinBusyRef = useRef(false);
  const [pinLockedUntil, setPinLockedUntil] = useState<number | null>(null);
  const [pinNow, setPinNow] = useState(() => Date.now());
  const [verified, setVerified] = useState<{
    teacher: StaffChoice;
    token: string;
  } | null>(null);
  /** T48: the enrollment form's fields and outcome. The password lives
   *  in this state only until the post answers. */
  const [enroll, setEnroll] = useState(EMPTY_ENROLL);
  const [enrollMsg, setEnrollMsg] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  useEffect(() => {
    if (pinLockedUntil === null) return;
    const t = setInterval(() => setPinNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pinLockedUntil]);
  const pinLockedFor =
    pinLockedUntil !== null
      ? Math.max(0, Math.ceil((pinLockedUntil - pinNow) / 1000))
      : 0;
  const pinKeysOff = pinBusy || pinLockedFor > 0;
  /** T71: the note field, focused once a kind is chosen. It is disabled
   *  until then (Pete: "greyed out until the category is chosen"), so
   *  autoFocus on open would land nowhere; the focus follows the chip
   *  tap instead, and only for the kinds that need the note written. */
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!reasonOpen || reasonDraft.kind === null) return;
    if (!compNeedsDetail(reasonDraft.kind)) return;
    noteRef.current?.focus();
  }, [reasonOpen, reasonDraft.kind]);
  /** Choose a kind. T79: no kind brings anything else up any more. */
  const chooseKind = (kind: CompKind) => {
    setReasonDraft((d) => ({ ...d, kind }));
  };
  /* ---------------- T79: the amount step's keypad ------------------ */
  /** The discount the drafts describe right now, against the cart's
   *  pre-tax subtotal, or null while the entry is incomplete. */
  const draftDiscount = draftToDiscount(discountDraft, cartSubtotalCents);
  const draftOffCents =
    draftDiscount === null
      ? 0
      : discountCents(discountLines(cart), draftDiscount);
  const draftFull =
    draftDiscount !== null &&
    isFullDiscount(discountLines(cart), draftDiscount);
  /** The segment. Switching drops the digits: an entry typed as cents
   *  means nothing as a percent. Whole sale needs no digits. */
  const chooseMode = (mode: DiscountDraftMode) => {
    setDiscountDraft((d) => (d.mode === mode ? d : { mode, entry: "" }));
  };
  /** A key on the amount step's pad (or the keyboard standing in for
   *  it). Amount digits accumulate into cents and clamp at the subtotal
   *  (the pad's clamp: nothing above the cap is ever held); percent
   *  digits accumulate into a whole number and a key that would pass
   *  100 is refused. Whole sale takes no key. */
  const discountTap = (key: string) => {
    const d = discountDraftRef.current;
    if (d.mode === "whole") return;
    let next: string;
    if (key === "back") {
      next = d.entry.slice(0, -1);
    } else {
      const raw = (d.entry + key).replace(/^0+(?=\d)/, "");
      if (raw.length > 7) return;
      const n = Number(raw);
      if (d.mode === "percent") {
        if (n > DISCOUNT_PERCENT_MAX) return;
        next = raw;
      } else {
        next = String(Math.min(n, cartSubtotalCents));
      }
    }
    if (next === "0") next = "";
    setDiscountDraft({ mode: d.mode, entry: next });
  };
  /** A quick cell SETS the entry, as the pad's chips do: $5 / $10 / $20
   *  for an amount (clamped at the subtotal), 10 / 25 / 50 for a
   *  percent. */
  const discountChip = (value: number) => {
    const d = discountDraftRef.current;
    if (d.mode === "whole") return;
    const entry =
      d.mode === "percent"
        ? String(Math.min(DISCOUNT_PERCENT_MAX, value))
        : String(Math.min(cartSubtotalCents, value * 100));
    setDiscountDraft({ mode: d.mode, entry });
  };
  /** The figure the entry reads as, for the head: "$60.00" or "60%". */
  const discountEntered =
    discountDraft.mode === "whole"
      ? "100%"
      : discountDraft.mode === "percent"
        ? `${discountDraft.entry === "" ? 0 : Number(discountDraft.entry)}%`
        : money((discountDraft.entry === "" ? 0 : Number(discountDraft.entry)) / 100);
  /** The running effect (the brief's line): "Discount $60.00, they pay
   *  $40.00" before tax, or "Comped, they pay $0.00" at 100%. */
  const discountEffect =
    draftDiscount === null
      ? cartSubtotalCents <= 0
        ? "Nothing to discount."
        : discountDraft.mode === "percent"
          ? `Enter 1 to 100 percent of the ${money(cartSubtotalCents / 100)} subtotal.`
          : `Enter up to ${money(cartSubtotalCents / 100)}, the subtotal before tax.`
      : draftFull
        ? `Comped, they pay ${money(0)}.`
        : `Discount ${money(draftOffCents / 100)}, they pay ${money(
            (cartSubtotalCents - draftOffCents) / 100,
          )} before tax.`;
  /* The keyboard stands in for the amount pad on the reason step, but
   * only while the note is not focused (the note takes its own keys). */
  useEffect(() => {
    if (!reasonOpen || reasonStep !== "reason") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.activeElement === noteRef.current) return;
      if (/^[0-9]$/.test(e.key)) discountTap(e.key);
      else if (e.key === "Backspace") discountTap("back");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    /* discountTap reads the draft through a ref; the subtotal is the
     * only closed-over value that can change. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reasonOpen, reasonStep, cartSubtotalCents]);
  /** Whether the pointer went down on the reason dialog's scrim, so the
   *  scrim closes on a real tap on it and not on the click a touch
   *  pointer fires when the hold that opened the dialog lifts. */
  const reasonScrimDown = useRef(false);
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
  /** The double-fire lock. State alone re-renders too late for a fast
   *  double tap; the ref is checked synchronously in the handler. */
  const inFlight = useRef(false);

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
  /* T82: credit is a tender like any other, so a balance that covers the
   * total no longer refuses the card (rule 1 and assumption P2 are
   * retired: "Credit should be an option, not forced"). This survives for
   * the ONE card sale that would BUY credit -- a total under the $10 card
   * minimum goes out as a $10 credit purchase plus a debit -- where
   * credit that already covers the total must be spent instead of adding
   * a second $10. The attach snapshot (or a split failure's fresher
   * report) gates the button; /api/checkout re-reads the balance
   * server-side and never trusts this number. */
  const cardWouldBuyCredit =
    balance !== null &&
    total !== null &&
    total < CARD_MINIMUM_USD &&
    balance >= total;
  const spendCreditFirst = `Spend the ${money(balance ?? 0)} on account: a card sale under $${CARD_MINIMUM_USD} would buy more credit`;

  const totalCents = total === null ? null : Math.round(total * 100);
  const balanceCents = balance === null ? null : Math.round(balance * 100);

  const clientId = client?.id ?? null;

  /**
   * T90: whether any line is bought for somebody else. Two things turn
   * on it: the card on file and the account balance are the PAYING
   * client's and a recipient's cart cannot draw on them (v6 has no
   * per-item payer and PayerClientId needs a stored "Pays for"
   * relationship, T63), so both tiles are greyed with the reason in
   * words; and the charge sends each line's recipient so the route can
   * file one Mindbody sale per person. Never attempted and then read
   * back from the error: a refusal is not proof it would have charged
   * nothing.
   */
  const hasOtherClient = cart.some((line) => line.forClient);
  const otherClientWhy = hasOtherClient
    ? `The card on file pays only for ${
        client ? client.name : "the client on the sale"
      }. Take cash, a card at the reader, or a gift card for lines bought for someone else.`
    : null;

  /** T53: the "Email receipt" toggle. On by default whenever a receipt
   *  CAN go (the reason below is null), so the ordinary opted-in sale
   *  needs no tap; reset per client, since a choice made for one person
   *  is not the next one's. What is sent is `sendEmail` below, decided
   *  in the same render as `chargeable`, never from a ref or an effect. */
  const [wantReceipt, setWantReceipt] = useState(true);
  useEffect(() => {
    setWantReceipt(true);
  }, [clientId]);
  /* T82: a comp receipts like any other sale (Pete: "Receipts should get
   * emailed even with comp, today it disallows it"), so the discount is
   * not read here and the toggle is not greyed by one. What still decides
   * is `receipt.why`: somebody to email, an address, and their opt-in. */
  const sendEmail = receipt.why === null && wantReceipt;

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

  /** Close the reason dialog with nothing armed and the draft gone, and
   *  report the close upward exactly as dismissPad does: the dialog owns
   *  Escape while open, so a reset that closes it must not leave
   *  SaleScreen believing something still blocks Escape. */
  /** Everything the dialog's later steps hold, back to nothing: the
   *  digits, the verified teacher and token, the enrollment fields
   *  (password included). Run on open and on close, so no state from
   *  one comp can reach the next. */
  const resetCompSteps = useCallback(() => {
    setReasonStep("reason");
    pinEntryRef.current = "";
    setPinEntry("");
    setPinMsg(null);
    setVerified(null);
    setEnroll(EMPTY_ENROLL);
    setEnrollMsg(null);
  }, []);
  const closeReason = useCallback(() => {
    setReasonOpen(false);
    setReasonDraft(EMPTY_COMP_DRAFT);
    setDiscountDraft(EMPTY_DISCOUNT_DRAFT);
    resetCompSteps();
    onModalChange(false);
  }, [onModalChange, resetCompSteps]);

  /** Blank the whole tender: every line, the amount modal, the discount
   *  and its dialog. Used by each of the reset paths below and by a
   *  completed sale. */
  const resetTender = useCallback(() => {
    setLines([]);
    setComp(null);
    setCompCleared(false);
    dismissPad();
    closeReason();
  }, [dismissPad, closeReason, setComp]);

  /* T79: the discount is cart state, so a change to it (armed, removed,
   * or a different figure) moves the total under every tender line the
   * same way a cart edit does: the lines go, and an open keypad with
   * them. */
  const discountKey =
    comp === null ? "" : `${comp.discount.mode}:${comp.discount.value}`;
  useEffect(() => {
    setLines([]);
    dismissPad();
  }, [discountKey, dismissPad]);

  /* T79: a cart edit under an armed discount re-spreads it (the figures
   * are recomputed from the cart on every render), unless the cart can
   * no longer carry it: a package line arrived, or a dollar amount now
   * exceeds the smaller subtotal. Then the discount is dropped and the
   * quiet line says so, since the server would refuse it anyway and a
   * silently clamped figure is not the one the teacher entered. */
  useEffect(() => {
    if (comp === null || cart.length === 0) return;
    const lines = discountLines(cart);
    const bad =
      discountRefusal(cart.map((l) => ({ type: l.item.type }))) !== null ||
      (comp.discount.mode === "amount" &&
        Math.round(comp.discount.value * 100) > subtotalCents(lines));
    if (bad) {
      setComp(null);
      setCompCleared(true);
    }
  }, [cart, comp, setComp]);

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
    /* T43: a reason dialog left open by a hold that landed just before
     * Back to items goes the same way, with its draft. */
    closeReason();
    if (discounted) {
      setComp(null);
      setCompCleared(true);
    }
  }, [visible, discounted, dismissPad, closeReason, setComp]);

  /* Source availability. An unavailable source renders greyed WITH the
   * reason, never hidden (PLAN 2.2: "account credit ($12) greyed out
   * beats a failure"). */
  const cardReason = otherClientWhy
    ? otherClientWhy
    : !client
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
  const creditReason = otherClientWhy
    ? otherClientWhy
    : !client
      ? "Attach a client"
      : balance === null || balance <= 0
        ? "No account balance"
        : null;
  const creditLabel =
    balance !== null && balance > 0
      ? `Account (${money(balance)})`
      : "Account";

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
    if (dueCents !== null && dueCents <= 0) return "Nothing left to cover";
    if (source === "credit") return creditReason;
    if (source === "storedcard") {
      if (cardReason !== null) return cardReason;
      /* T82: the under-$10 guard, not rule 1. A whole-sale card payment
       * (the card as the first and therefore only line) under the $10
       * minimum buys $10 of credit on the way, which /api/checkout
       * refuses outright when the account already holds enough; greyed
       * with that reason beats a certain 409. A split's card leg cannot
       * reach the credit purchase (the server refuses a leg under the
       * minimum), so it is not asked here. */
      if (lines.length === 0 && cardWouldBuyCredit) return spendCreditFirst;
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
      /* T82's under-$10 guard again, for a card that has BECOME the whole
       * sale (the other line was removed under it). */
      if (lines.length === 1 && cardWouldBuyCredit) return spendCreditFirst;
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
    /* T43 review: never while the reason dialog is open. The scrim covers
       the Charge button, but a keyboard Tab leaves the dialog and lands on
       it, and Enter there charged the tender the teacher was in the middle
       of replacing with a comp. */
    !reasonOpen &&
    /* T43: a discount charges only with its reason written. The state
       shape already makes an armed discount carry one; this re-checks
       the text in the SAME render that enables the button, so no state
       slip could ever leave a reasonless discount chargeable. T48: and
       only with a teacher and their token behind it, checked the same
       way for the same reason. */
    (comp === null ||
      (comp.teacher.id > 0 &&
        comp.token.length > 0 &&
        compValid({ kind: comp.reason.kind, detail: comp.reason.detail }))) &&
    (comped
      ? /* T79: a 100% discount takes no tender; the total is $0. */
        lines.length === 0
      : /* Due EXACTLY zero: the lines cover the server's total to the
           cent, no more and no less (cash surplus is change, not
           coverage). */
        dueCents === 0 && tenderValid);

  const sourceLabel = (s: TenderSource) =>
    s === "storedcard" ? "Card" : s === "credit" ? "Account" : "Cash";

  /** One leg of a split, as the Charge button restates it. The cash leg
   *  reads "collect $X cash": the leg amount IS what is collected. */
  const legLabel = (s: TenderSource, usd: number) =>
    s === "storedcard"
      ? `${money(usd)} card`
      : s === "credit"
        ? `${money(usd)} from account`
        : `collect ${money(usd)} cash`;

  const soleLine = lines.length === 1 ? lines[0] : undefined;
  /** The cash line, if one is in the payment: the Cash tile reopens its
   *  keypad (T39.7). */
  const cashLine = lines.find((l) => l.source === "cash");

  /** T79: what a comp puts on the studio, the pre-tax subtotal (tax on
   *  $0 is $0): the figure the Comp button and the done screen carry,
   *  since Mindbody's discounted total is $0.00 and says nothing. */
  const compAmount = cartSubtotalCents / 100;

  const chargeLabel = comped
    ? total === null
      ? "Charge"
      : `Comp ${money(compAmount)}`
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
    /* T43: a comp carries its reason (the route refuses a comp without
     * one, and a reason on any other method). The reason never reaches
     * Mindbody, whose checkout request has no notes field; the route
     * records it in comp_receipts and the server log. */
    const tender = comped
      ? /* T79: a 100% discount pays nothing: method comp, no tender. */
        { method: "comp" as const }
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
    if (tender === null) return;
    /* T79: the discount rides with any tender. T45: the reason as data.
     * T48: the token names who is discounting; the route refuses a
     * discount without a valid one before any Mindbody call. The
     * per-line spread is NOT sent: the route recomputes it. */
    const payment =
      comp !== null
        ? {
            ...tender,
            discount: comp.discount,
            compReason: comp.reason,
            teacherToken: comp.token,
          }
        : tender;
    const isSplit = "split" in payment;
    /* For the done block (T39.7); the cart is gone by the time it renders. */
    const itemCount = cart.reduce((n, l) => n + l.quantity, 0);
    const changeAtTap = changeCents;
    /* T53: the address the receipt was asked for, captured at the tap
     * like the count: the lookup may refetch before the done block
     * renders. */
    const receiptEmailAtTap = sendEmail ? receipt.email : null;
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
            /* T43: on a comp only, the item's name rides along for the
             * comp receipt's record of what was given away. T90 sends it
             * on any ticket holding a line for another client too: the
             * route's partial-outcome sentence names the item and the
             * person. Never forwarded; Mindbody's cart takes ids. */
            ...(comp !== null || hasOtherClient ? { name: line.item.name } : {}),
            /* T90: this line's own Mindbody sale, under this client. */
            ...(line.forClient
              ? {
                  forClientId: line.forClient.id,
                  forClientName: line.forClient.name,
                }
              : {}),
          })),
          ...(clientId ? { clientId } : {}),
          /* T90: display only, for the route's per-cart sentence; every
             decision there is made on the id. */
          ...(hasOtherClient && client ? { clientName: client.name } : {}),
          ...payment,
          /* T53: the toggle, as this render read it. The route ignores
           * it for the house client and for a comp anyway. */
          sendEmail,
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
      /* T49: whatever the outcome, a dead staff token is reported up. */
      if (body?.staffSessionEnded === true) onStaffSessionEnded();
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
              ? `${money(usd)} from account`
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
                  ? "account balance"
                  : "cash";
        /* T90: the sales the route made, in the order it made them.
           One cart answers as it always did, so the fallback below is
           that one sale built from what this tap sent. */
        const soldSales: SoldSale[] = Array.isArray(body?.sales)
          ? body.sales.map((sale: any) => ({
              clientId:
                typeof sale?.clientId === "string" ? sale.clientId : null,
              forClientId:
                typeof sale?.forClientId === "string" ? sale.forClientId : null,
              saleId: typeof sale?.saleId === "string" ? sale.saleId : null,
              productIds: Array.isArray(sale?.productIds)
                ? sale.productIds.map((id: unknown) => String(id))
                : [],
              total: typeof sale?.total === "number" ? sale.total : 0,
            }))
          : [
              {
                clientId,
                forClientId: null,
                saleId:
                  typeof body?.saleId === "string" ? body.saleId : null,
                productIds: cart.map((line) => String(line.item.id)),
                total: typeof body?.total === "number" ? body.total : 0,
              },
            ];
        onSold(soldSales);
        /* The sale stands, so every client number this screen holds is a
         * pre-sale snapshot: drop the one learned from a refusal and let
         * the refetch onClientDataStale triggers be the answer. */
        setFreshBalance(null);
        onClientDataStale();
        /* T79: the discount as the SERVER recorded it (its own spread
         * and Mindbody's totals), never the browser's copy. */
        const disc = body?.discount;
        setResult({
          kind: "paid",
          total: comped
            ? typeof disc?.subtotal === "number"
              ? disc.subtotal
              : compAmount
            : typeof body?.total === "number"
              ? body.total
              : total,
          count: itemCount,
          changeCents: changeAtTap,
          comped,
          compReason: comp?.reason ?? null,
          discount:
            comp !== null && typeof disc?.amount === "number"
              ? {
                  amount: disc.amount,
                  subtotal:
                    typeof disc.subtotal === "number" ? disc.subtotal : compAmount,
                  percent:
                    typeof disc.percent === "string"
                      ? disc.percent
                      : discountPercentLabel(comp.discount, disc.amount, compAmount),
                }
              : null,
          actorNote: body?.actorFallback
            ? actorFallbackLine(body.actorFallback)
            : null,
          /* T53: the server's word, not the toggle's: `receiptRequested`
           * says the request carried it, `emailReceipt` true says
           * Mindbody confirmed one went. Anything short of that
           * confirmation is "requested", because the done screen must
           * never claim a receipt the response did not confirm. */
          receiptLine:
            body?.receiptRequested === true && receiptEmailAtTap
              ? body?.emailReceipt === true
                ? `Receipt emailed to ${receiptEmailAtTap}.`
                : `Receipt requested for ${receiptEmailAtTap}.`
              : null,
          summary: `Paid ${money(body?.total ?? total)} by ${methodName}${
            client ? ` for ${client.name}` : ""
          }.`,
          detail: [
            /* T90: a ticket that became more than one Mindbody sale
               lists every one of them, with whose it was; a single-sale
               ticket reads exactly as it always did. */
            Array.isArray(body?.sales) && body.sales.length > 1
              ? body.sales
                  .map(
                    (sale: any) =>
                      `Sale ${sale?.saleId ?? "unknown"} for ${
                        sale?.name ?? "the client on the sale"
                      }.`,
                  )
                  .join(" ")
              : body?.saleId
                ? `Sale ${body.saleId}.`
                : null,
            body?.creditPurchased
              ? `Includes a ${money(body.creditPurchased)} account balance purchase (card minimum); the unspent remainder stays on their account.`
              : null,
          ]
            .filter(Boolean)
            .join(" ") || null,
        });
        /* The sale is over: the tender goes with it. */
        resetTender();
      } else if (res.ok && body?.suppressed) {
        /* T90: the write guard judges each cart by its own client id, so
           part of a ticket can go out while the rest is suppressed. The
           route's own sentence says which, and it is shown rather than
           the bare mode. */
        setResult({
          kind: "suppressed",
          mode: String(body.suppressed),
          summary: typeof body?.summary === "string" ? body.summary : null,
        });
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
      } else if (
        res.status === 401 &&
        body?.reason === "teacher" &&
        comp !== null
      ) {
        /* T48: the teacher token was refused (ten minutes ran out
         * between the PIN and the tap, or a restart rotated the key).
         * Nothing was charged and nothing is retried: the discount
         * disarms, and the dialog comes back at the PIN step with the
         * amount and the reason kept, so the fix is the PIN again
         * rather than the whole dialog. */
        setComp(null);
        setReasonDraft({ kind: comp.reason.kind, detail: comp.reason.detail });
        setDiscountDraft(
          comp.discount.mode === "percent"
            ? comp.discount.value === 100
              ? { mode: "whole", entry: "" }
              : { mode: "percent", entry: String(comp.discount.value) }
            : {
                mode: "amount",
                entry: String(Math.round(comp.discount.value * 100)),
              },
        );
        resetCompSteps();
        setReasonStep("pin");
        setPinMsg("Your PIN check ran out. Enter it again.");
        setReasonOpen(true);
        onModalChange(true);
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
    /* T79: a PARTIAL discount survives a tender -- the remainder is
     * exactly what this line is paying, and dropping the discount here
     * repriced the cart at full price under a line entered against the
     * discounted total (the T79 UI run caught it). A 100% discount
     * leaves nothing due, so the guard above already returned and no
     * tender can reach an armed comp. */
    setCompCleared(false);
    setLines((cur) => [...cur, { id, source, cents }]);
    dismissPad();
    clearStaleResult();
  };

  const removeLine = (id: number) => {
    setLines((cur) => cur.filter((l) => l.id !== id));
    if (padFor === id) dismissPad();
    setCompCleared(false);
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

  /* T43: the reason dialog owns Escape the same way, and closes as
   * Cancel: nothing armed, the draft gone. */
  useEffect(() => {
    if (!reasonOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeReason();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reasonOpen, closeReason]);

  /* T67 (Pete: "get rid of the feature that forces holding down 'Comp
   * this sale'. the popup is enough friction"): a plain tap opens the
   * reason dialog. Nothing is armed by the tap itself; only Comp in the
   * dialog, with a reason complete and a PIN verified, arms. The 700ms
   * hold that used to gate this (T39.6, T43) is gone with its timer,
   * its click-swallowing ref and the "hold to arm" hint. */
  const openComp = () => {
    if (!visible || charging) return;
    setReasonDraft(EMPTY_COMP_DRAFT);
    setDiscountDraft(EMPTY_DISCOUNT_DRAFT);
    resetCompSteps();
    setReasonOpen(true);
    onModalChange(true);
    setCompCleared(false);
  };
  /** Next on the reason step (T48): on to the PIN. Refused, and the
   *  dialog left on the reason, unless both drafts are complete (T79: a
   *  valid amount or percent; a kind, and the note for trade and
   *  other); the button is disabled on the same test, so this guard is
   *  for a keyboard Enter on an incomplete draft. */
  const toPinStep = () => {
    if (
      !compValid(reasonDraft) ||
      draftDiscount === null ||
      charging ||
      reasonDraft.kind === null
    ) {
      return;
    }
    pinEntryRef.current = "";
    setPinEntry("");
    setPinMsg(null);
    setVerified(null);
    setReasonStep("pin");
  };
  /** Back from the PIN step keeps the reason; the digits go. */
  const backToReason = () => {
    if (pinBusy) return;
    pinEntryRef.current = "";
    setPinEntry("");
    setPinMsg(null);
    setReasonStep("reason");
  };
  /** A key on the PIN step's pad, or the keyboard standing in for it. */
  const pinTap = (key: string) => {
    if (pinBusyRef.current || pinLockedFor > 0) return;
    setPinMsg(null);
    const cur = pinEntryRef.current;
    const next =
      key === "back"
        ? cur.slice(0, -1)
        : cur.length >= PIN_MAX
          ? cur
          : cur + key;
    pinEntryRef.current = next;
    setPinEntry(next);
    /* The last digit IS Done when the teacher's PIN length is known. */
    if (key !== "back" && pinLength !== null && next.length === pinLength) {
      void submitPin();
    }
  };
  /* Read the signed-in teacher's PIN length when the PIN step opens; a
   * local call, not metered. Any failure leaves null and the Done key. */
  useEffect(() => {
    if (reasonStep !== "pin") return;
    let live = true;
    fetch("/api/teacher")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!live) return;
        const n = b?.pinLength;
        setPinLength(
          typeof n === "number" && Number.isInteger(n) && n >= PIN_MIN && n <= PIN_MAX
            ? n
            : null,
        );
      })
      .catch(() => {
        if (live) setPinLength(null);
      });
    return () => {
      live = false;
    };
  }, [reasonStep]);
  /** Done on the PIN step: one post to /api/teacher/verify. A match
   *  moves to "Comping as <name>" with the token in hand; a miss clears
   *  the digits and says so; the lockout counts down under the dots. */
  const submitPin = async () => {
    const digits = pinEntryRef.current;
    if (pinBusyRef.current || pinLockedFor > 0 || !isPinShape(digits)) return;
    pinBusyRef.current = true;
    setPinBusy(true);
    setPinMsg(null);
    try {
      const res = await fetch("/api/teacher/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: digits }),
      });
      const body = await res.json().catch(() => ({}));
      pinEntryRef.current = "";
      setPinEntry("");
      if (
        res.ok &&
        body?.ok === true &&
        typeof body?.teacher?.id === "number" &&
        typeof body?.token === "string" &&
        body.token.length > 0
      ) {
        setVerified({
          teacher: { id: body.teacher.id, name: String(body.teacher.name ?? "") },
          token: body.token,
        });
        setReasonStep("ready");
        return;
      }
      if (res.status === 429) {
        const secs = Number(body?.retryAfterSeconds ?? 30);
        setPinLockedUntil(
          Date.now() + (Number.isFinite(secs) ? secs : 30) * 1000,
        );
        setPinNow(Date.now());
      } else if (res.status === 401) {
        setPinMsg("That PIN does not match any teacher.");
        setPinShake((g) => g + 1);
      } else {
        setPinMsg(
          typeof body?.error === "string"
            ? body.error
            : "Could not check that PIN. Try again.",
        );
      }
    } catch {
      pinEntryRef.current = "";
      setPinEntry("");
      setPinMsg("Could not reach the server. Try again.");
    } finally {
      pinBusyRef.current = false;
      setPinBusy(false);
    }
  };
  /** "Set up or change your PIN": the enrollment form. */
  const toEnrollStep = () => {
    if (pinBusy) return;
    setEnroll(EMPTY_ENROLL);
    setEnrollMsg(null);
    setReasonStep("enroll");
  };
  const backToPin = () => {
    if (enrollBusy) return;
    setEnroll(EMPTY_ENROLL);
    setEnrollMsg(null);
    setReasonStep("pin");
  };
  /** T80 (Pete: "there should be an additional box to re-enter and
   *  verify the new PIN"): the second box must match, here and at the
   *  route. The quiet line shows only once both boxes hold something,
   *  so it does not accuse a half-typed PIN. */
  const enrollMismatch =
    enroll.pin.length > 0 &&
    enroll.confirm.length > 0 &&
    enroll.pin !== enroll.confirm;
  const enrollValid =
    enroll.username.trim().length >= 3 &&
    enroll.password.length > 0 &&
    isPinShape(enroll.pin) &&
    enroll.confirm === enroll.pin;
  /** Save PIN: one post to /api/teacher/enroll with the Mindbody login
   *  and the chosen PIN. Success returns to the PIN step with the name
   *  Mindbody gave; the password is dropped either way. */
  const submitEnroll = async () => {
    if (enrollBusy || !enrollValid) return;
    setEnrollBusy(true);
    setEnrollMsg(null);
    const sent = enroll;
    try {
      const res = await fetch("/api/teacher/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: sent.username.trim(),
          password: sent.password,
          pin: sent.pin,
          confirm: sent.confirm,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok === true && body?.teacher) {
        setEnroll(EMPTY_ENROLL);
        setEnrollMsg(null);
        pinEntryRef.current = "";
        setPinEntry("");
        setPinMsg(`PIN set for ${String(body.teacher.name ?? "you")}. Enter it to go on.`);
        setReasonStep("pin");
        return;
      }
      /* A taken PIN (409) was a good sign-in: keep the password so the
       * fix is another PIN, and clear both PIN boxes so the fix is
       * typing a new one twice (T80). Any other refusal drops the
       * password instead. */
      if (res.status === 409) {
        setEnroll((e) => ({ ...e, pin: "", confirm: "" }));
      } else {
        setEnroll((e) => ({ ...e, password: "" }));
      }
      if (res.status === 429) {
        const secs = Number(body?.retryAfterSeconds ?? 30);
        setEnrollMsg({
          text: `Too many attempts. Try again in ${Number.isFinite(secs) ? secs : 30}s.`,
          ok: false,
        });
      } else {
        setEnrollMsg({
          text:
            typeof body?.error === "string"
              ? body.error
              : "Could not set that PIN. Try again.",
          ok: false,
        });
      }
    } catch {
      setEnroll((e) => ({ ...e, password: "" }));
      setEnrollMsg({ text: "Could not reach the server. Try again.", ok: false });
    } finally {
      setEnrollBusy(false);
    }
  };
  /** Discount (or Comp) on the ready step: arm the discount WITH its
   *  reason and the verified teacher. The button exists only on that
   *  step, so this guard is for a stray keyboard Enter. */
  const confirmComp = () => {
    const reason = draftToReason(reasonDraft);
    if (
      reason === null ||
      !compValid(reasonDraft) ||
      draftDiscount === null ||
      charging ||
      verified === null
    ) {
      return;
    }
    /* The discount moves the total, so no tender line entered against
     * the old one survives it (the discountKey effect clears them too). */
    setLines([]);
    dismissPad();
    setComp({
      discount: draftDiscount,
      reason,
      teacher: verified.teacher,
      token: verified.token,
    });
    setCompCleared(false);
    clearStaleResult();
    closeReason();
  };
  /* T48: the keyboard stands in for the PIN pad on the PIN step only.
   * The enroll step has real inputs and the reason step its note field,
   * so neither is listened to here. */
  const reasonStepRef = useRef(reasonStep);
  reasonStepRef.current = reasonStep;
  useEffect(() => {
    if (!reasonOpen || reasonStep !== "pin") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) pinTap(e.key);
      else if (e.key === "Backspace") pinTap("back");
      else if (e.key === "Enter") void submitPin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    /* pinTap and submitPin read refs, so the closure is never stale. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reasonOpen, reasonStep, pinLockedFor > 0]);
  /** T79: why the cart cannot take a discount right now, or null: a
   *  package line (Mindbody ignores a discount on one). Read at the tap
   *  and shown in the quiet line rather than opening the dialog. */
  const discountBlock = discountRefusal(
    cart.map((l) => ({ type: l.item.type })),
  );
  const [discountRefused, setDiscountRefused] = useState<string | null>(null);
  useEffect(() => {
    if (discountBlock === null) setDiscountRefused(null);
  }, [discountBlock]);
  /** Tap on Discount this sale: an armed discount is removed (the
   *  reason goes with it; the next tap asks again), an unarmed one
   *  opens the dialog, unless the cart refuses one. */
  const compClick = () => {
    if (discounted) {
      setComp(null);
      clearStaleResult();
    } else if (discountBlock !== null) {
      setDiscountRefused(discountBlock);
    } else {
      setDiscountRefused(null);
      openComp();
    }
  };

  /* ONE shared quiet line under the tender: the first real problem with
   * what is on screen, else what is still owed, else the detail of what
   * is armed. The full reason also sits on each control's title attr. */
  const tenderNote = comp !== null && comped
    ? /* The canvas's line (0.2): the sale is on the studio, and since
         T43 the reason sits beside it so what was written is on the
         surface before Charge. */
      `Nothing to pay, on the studio. Comped: ${compReasonLine(comp.reason)}. By ${comp.teacher.name}.`
    : comp !== null && firstLineProblem === null && (dueCents === null || dueCents <= 0 || lines.length === 0)
      ? /* T79: a partial discount, before a tender is chosen: what is
           off and why, then the ordinary lines take over. */
        `Discount ${money(armedCents / 100)} (${discountPercentLabel(
          comp.discount,
          armedCents / 100,
          compAmount,
        )}): ${compReasonLine(comp.reason)}. By ${comp.teacher.name}.` +
        (dueCents !== null && dueCents > 0 && lines.length === 0
          ? ` ${money(dueCents / 100)} to pay.`
          : "")
    : discountRefused !== null
      ? discountRefused
    : compCleared
      ? "Discount was cleared."
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
                ? `Account: ${creditReason}`
                : (cardDetail ?? "")
            : "";

  /* T39.8 dropped T33's tile icons for 1a's plain tiles; T51 brings a
     glyph back beside each name at Pete's ask ("'Card', 'Cash' and
     'Account' should have icons next to them"). The label text is as it
     was; the icon rides in the name span and inherits its colour. */
  const sources: { s: TenderSource; label: string; icon: ReactNode }[] = [
    /* Credit leads when there IS credit, and is absent when there is not
       (Pete, fourth live test). */
    ...(creditVisible
      ? [{ s: "credit" as TenderSource, label: "Account", icon: <AccountIcon /> }]
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
   * The one control that moves money, at the payment column's foot (T85:
   * the bar it used to be portalled into is gone), so it is gated by the
   * `chargeable` of this very render. T82: it reads "Finalize Sale" in
   * every state, with no amount and no count (Pete: "the Charge/Comp
   * button should always say 'Finalize Sale' ... No need for it to
   * contain the total items and dollar amount"). The figures above and
   * the quiet line beside it carry the numbers; a button that changed
   * its word and its figure with the tender was three labels for one
   * act. Not `disabled` but aria-disabled, like the shelf's Pay, so its
   * title can say why it cannot be tapped; the click guard and
   * doCharge's own checks refuse the tap either way. The label a screen
   * reader and the tooltip get when it IS armed is still the full
   * sentence (`chargeLabel`: "Charge $43.50", "Comp $107.45"), so what
   * the tap will do is never hidden, only off the face of the button.
   */
  const primaryLabel = "Finalize Sale";
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
          ? /* T82 review: with nothing tendered the quiet line is not a
               reason -- it is the card detail ("Card ...4242"), which is
               what this title then read. The Due figure and the button's
               own "Due $107.45" are both gone, so the ONLY place left
               that says what is unpaid and what to do about it is this
               title. Say both. With a line already in the tender the
               quiet line does name the remainder or the problem, and it
               stays the title. */
            lines.length === 0
            ? `${money(dueCents / 100)} still to pay. Choose how they are paying.`
            : tenderNote || `${money(dueCents / 100)} still to pay`
          : firstLineProblem ?? (lines.length === 0 && !comped ? "Choose how they are paying" : "Not ready to charge");
  const primary =
    result?.kind === "paid" ? (
      /* T70 (Payment.dc.html): after the write the primary fills --ok
         with the check and "Charged" and the amount, inert: the done
         block above carries Done. Only a completed sale reaches it;
         suppression is never success and never fills green. */
      <span className="pay-primary done" role="status">
        <CheckIcon />
        <span>{result.comped ? "Comped" : "Charged"}</span>
        <span className="btn-amt">{money(result.total)}</span>
      </span>
    ) : (
      <button
        className={
          (primaryOn ? "pay-primary" : "pay-primary off") +
          (charging ? " busy" : "")
        }
        aria-disabled={!primaryOn}
        aria-label={primaryOn ? chargeLabel : `${primaryLabel}: ${primaryWhy ?? ""}`}
        title={primaryOn ? chargeLabel : (primaryWhy ?? undefined)}
        onClick={() => {
          if (!primaryOn) return;
          void doCharge();
        }}
      >
        {charging ? (
          /* One word through the whole tap: the spinner says the write is
             in flight, the label does not change under the thumb. */
          <>
            <span className="spinner" aria-label="working" />
            <span>{primaryLabel}</span>
          </>
        ) : (
          <span>{primaryLabel}</span>
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
            /* T39.7: the prototype's done shape (plan 0.3), for the ONE
               branch that is a completed sale: the check, the charged
               line, and the change from the drawer, which is the figure
               a teacher most needs after a cash sale. The summary and the
               sale id stay under it; the button is Done, not New sale,
               and still returns to the roster (T33). Suppression never
               reaches this branch. */
            <div className="pay-done" role="status">
              <span className="pay-done-check" aria-hidden="true">
                <CheckIcon />
              </span>
              <p className="pay-done-title">Sale complete</p>
              <p className="pay-done-charged">
                {result.comped ? "Comped" : "Charged"} {money(result.total)}{" "}
                {"\u00b7"} {result.count} {result.count === 1 ? "item" : "items"}
                {result.changeCents > 0 ? (
                  <span className="pay-done-change">
                    Change {money(result.changeCents / 100)} from the drawer
                  </span>
                ) : null}
              </p>
              {result.compReason ? (
                /* T43: the reason, under the charged line, so the done
                   screen says why the sale was on the studio. T79: a
                   partial discount names its figure and share. */
                <>
                  <p className="pay-done-reason">
                    {result.comped
                      ? `Comped: ${compHeadline(result.compReason)}`
                      : `Discount ${money(result.discount?.amount ?? 0)} (${
                          result.discount?.percent ?? ""
                        }): ${compHeadline(result.compReason)}`}
                  </p>
                  {result.compReason.detail ? (
                    <p className="pay-done-reason-detail">
                      {result.compReason.detail}
                    </p>
                  ) : null}
                </>
              ) : null}
              <p className="pay-done-line">{result.summary}</p>
              {result.detail ? (
                <p className="pay-done-detail">{result.detail}</p>
              ) : null}
              {result.actorNote ? (
                /* T49: the sale stands; who Mindbody recorded it under
                   is the one thing that differs, and it is said. */
                <p className="pay-done-detail actor-note">{result.actorNote}</p>
              ) : null}
              {result.receiptLine ? (
                /* T53: emailed only when confirmed, else requested. */
                <p className="pay-done-detail pay-done-receipt">
                  {result.receiptLine}
                </p>
              ) : null}
              {/* Done means the sale is finished, so it goes back to the
                  roster (Pete, fourth live test): the counter's resting
                  screen is the sign-in view, not an empty cart. The
                  receipt is cleared first so reopening Buy starts clean. */}
              <button
                className="pay-done-btn"
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
              {/* T82: two figures, not three (Pete: "Remove the 'Due'
                  section at the bottom right"). Total is the server's and
                  Change is over-tendered cash, lit only when there is
                  any. What is still unpaid is said in words by the quiet
                  line in the foot and by Finalize Sale's title, which is
                  where a teacher who cannot charge looks for the why. */}
              <div className="pay-figures">
                <div className="pay-fig">
                  <span className="pay-fig-label">Total</span>
                  <span className="pay-fig-amt">
                    {total !== null ? money(total) : "--"}
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
                  /* Layout plan 2.7: tapping Cash when a cash line is
                     already in the payment opens THAT line's keypad
                     rather than refusing, so Exact / $5 / $10 / $20 stay
                     one tap from the surface. Card and Credit keep T35's
                     refusal with its reason: their amount is a clamp,
                     and the keypad is a tap away on the line itself. */
                  const reopen =
                    s === "cash" && cashLine !== undefined && reason === "Already in the payment";
                  const off = reason !== null && !reopen;
                  /* T82: the note carries INFORMATION or nothing. T35's
                     reason when a tile cannot add a line stays, and so
                     does the cash tile's "tap to change it"; the three
                     amount notes are gone (Pete: "Remove the 'Take $230
                     in cash' line"), with "Applies first", which was
                     rule 1's word and is no longer true of credit. The
                     amount a tap adds is the remaining due, which the
                     figures and the quiet line already carry. Credit
                     keeps its balance badge. */
                  const shown = off
                    ? reason
                    : reopen
                      ? "In the payment. Tap to change it."
                      : null;
                  /* In the payment: the selected marker (--accent-bg and
                     the 4px accent edge), whether or not the tile can
                     still take a tap. */
                  const inPayment = usedSources.has(s);
                  return (
                    <button
                      key={s}
                      className={
                        (off ? "pay-tile off" : "pay-tile") + (inPayment ? " in" : "")
                      }
                      disabled={off || charging}
                      onClick={() =>
                        reopen && cashLine !== undefined
                          ? openPad(cashLine.id)
                          : addLine(s)
                      }
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
                        {icon}
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

              {/* T70: the body under the cards (Payment.dc.html): the
                  tender rows, the hint, the receipt row, the notices and
                  the foot, padded as a group; the figures and the cards
                  above run edge to edge. */}
              <div className="pay-body">
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
                          <CloseIcon />
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

              {/* T53: the receipt toggle (Pete: "receive an email
                  receipt"). The filter-toggle idiom, 64px, accent while
                  on; off and disabled with its reason when there is
                  nobody to email, no address or no opt-in. A discount
                  never disables it (T82).

                  T82 also draws the state (Pete: "'Email reciept' should
                  have a checkbox to the left of it to indicate when its
                  toggled on and off in addition to the color change"):
                  a 24px square on the rule, filled with the accent and
                  the check when on. Drawn from tokens, not a native
                  checkbox, because a native one cannot be coloured in
                  both palettes and cannot be told not to take a tap of
                  its own inside the button. It is decoration over
                  aria-pressed, which is what a screen reader reads. */}
              <button
                type="button"
                className={
                  sendEmail ? "receipt-toggle on" : "receipt-toggle"
                }
                aria-pressed={sendEmail}
                disabled={receipt.why !== null || charging}
                title={receipt.why ?? "Email a receipt for this sale"}
                onClick={() => setWantReceipt((v) => !v)}
              >
                <span className="receipt-toggle-name">
                  <span
                    className={sendEmail ? "receipt-box on" : "receipt-box"}
                    aria-hidden="true"
                  >
                    {sendEmail ? <CheckIcon /> : null}
                  </span>
                  Email receipt
                </span>
                <span className="receipt-sub">
                  {receipt.why !== null
                    ? receipt.why
                    : sendEmail
                      ? `to ${receipt.email}`
                      : "Off"}
                </span>
              </button>

              {/* Bug-1 branch (b): no client, no house client, so Mindbody
                  could not price the cart and there is no total to charge.
                  The local estimate on the ticket is never chargeable. */}
              {cart.length > 0 && !pricing && priced?.needsClient ? (
                <p className="muted-note">{NEEDS_HOUSE_CLIENT_LINE}</p>
              ) : null}

              {result?.kind === "suppressed" ? (
                /* Suppression is never success: amber, no check, the
                   cart and the tender untouched. A dry run takes the
                   canvas's word for it ("Sale rehearsed", plan 0.3), which
                   is exactly what a dry run is; a write-guard suppression
                   is not a rehearsal and keeps its own wording. */
                <div className="pass-note t-suppressed" role="status">
                  {result.mode === "dry-run" ? (
                    <p className="pay-rehearsed">Sale rehearsed</p>
                  ) : null}
                  {result.summary
                    ? /* T90: part of the ticket went out and part did
                         not. The route's sentence names which, and it
                         replaces the whole-ticket wording, which would
                         be a lie here. */
                      result.summary
                    : result.mode === "dry-run"
                      ? "Dry run: nothing was charged."
                      : "Write guard: nothing was charged."}{" "}
                  {result.summary
                    ? "Nothing was retried; the cart is untouched."
                    : "The write was suppressed on the server; the cart is untouched."}
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

              {/* The foot (0.2), pushed to the bottom under a hairline:
                  the quiet line at the left, then Discount, then the
                  primary (T85: the action bar is gone, so the one control
                  that moves money is this column's foot, beside the
                  control it was always read with). Discount is
                  deliberately out of the tender list, and a tap only
                  opens the reason and PIN dialog (T67), so nobody comps a
                  sale by grazing a control; it lives only here, in pay
                  mode (layout plan 2.9). */}
              <div className="pay-foot">
                <p className="pay-quiet">{tenderNote || " "}</p>
                <button
                  className={discounted ? "comp-hold on" : "comp-hold"}
                  disabled={charging}
                  onClick={compClick}
                  aria-pressed={discounted}
                  title={
                    discounted
                      ? "Tap to remove the discount"
                      : (discountBlock ?? "Discount this sale")
                  }
                >
                  {comped
                    ? "Comped. Tap to unselect."
                    : discounted
                      ? `Discount ${money(armedCents / 100)}. Tap to remove.`
                      : "Discount"}
                </button>
                {primary}
              </div>
              </div>
            </>
          )}

          {/* T85: after the write the done block is the surface, and the
              --ok "Charged $X" segment the bar used to carry stands in a
              foot of its own, where the primary was. */}
          {result?.kind === "paid" ? (
            <div className="pay-foot pay-foot-done">{primary}</div>
          ) : null}
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
            className="modal modal-amount modal-pad"
            role="dialog"
            aria-modal="true"
            aria-label={`${sourceLabel(padLine.source)} amount`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* T70: the keypad panel's three columns (Payment.dc.html):
                the kicker with the live entry, the due, the chips and
                the change line at the left; the 3x4 keys; Done. Still
                the T36 modal (Pete: "having it be a modal is def
                better"), with the panel's 2px accent border. */}
            <div className="pad-left">
            <p className="modal-title pad-head">
              <span className="pad-kicker">
                {padLine.source === "cash"
                  ? "Cash received"
                  : `${sourceLabel(padLine.source)} amount`}
              </span>
              <span className="pad-entered-amt">{money(draftCents / 100)}</span>
            </p>
            <div className="pad-row">
              <span className="pad-label">Amount due</span>
              <span className="pad-amt">
                {padDueCents !== null ? money(padDueCents / 100) : "--"}
              </span>
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
                Change due{" "}
                <span className="pad-change-amt">{money(padSurplus / 100)}</span>
              </p>
            ) : padSurplus !== null && padSurplus < 0 ? (
              <p className="pad-change short">
                Short{" "}
                <span className="pad-change-amt">{money(-padSurplus / 100)}</span>
              </p>
            ) : (
              <p className="pad-change muted-note">
                {padCap !== null
                  ? `${sourceLabel(padLine.source)} tops out at ${money(padCap / 100)}.`
                  : "Cash may be more than the due; the change shows here."}
              </p>
            )}
            </div>

            <div className="pad-keys">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0"].map(
                (k) => (
                  <button key={k} className="pad-key" onClick={() => padTap(k)}>
                    {k}
                  </button>
                ),
              )}
              <button
                className="pad-key del"
                aria-label="Delete last digit"
                title="Delete"
                onClick={() => padTap("back")}
              >
                <BackspaceIcon />
              </button>
            </div>

            <div className="modal-actions">
              <button className="modal-confirm go" onClick={applyPad}>
                Done
              </button>
              <button className="modal-cancel" onClick={dismissPad}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* T43: the discount dialog. A tap on Discount opens it (T67);
          nothing is armed until the button on the ready step is tapped
          with the amount (T79) and the reason complete (T45) and a PIN
          verified (T48: amount and reason, then PIN, then "Discounting
          as <name>"). Cancel, Escape and the scrim leave nothing armed
          and drop the drafts and the digits. It stacks like the keypad
          (the same scrim) and owns Escape the same way. The reason never
          reaches Mindbody; the route keeps it. */}
      {reasonOpen ? (
        <div
          className="modal-scrim"
          role="presentation"
          /* T43 review: the scrim closes only on a click whose pointer
             went DOWN on it. The dialog opens while the hold's finger is
             still on Comp, and on a touch pointer the click the browser
             fires when that finger lifts is hit-tested at the lift, which
             is now this scrim; taken as a click it closed the dialog the
             moment it opened. (A mouse never showed it: the pointer's
             leave aborted the hold and the click went to the common
             ancestor.) */
          onPointerDown={(e) => {
            reasonScrimDown.current = e.target === e.currentTarget;
          }}
          onClick={() => {
            const down = reasonScrimDown.current;
            reasonScrimDown.current = false;
            if (down) closeReason();
          }}
        >
          <div
            className={
              reasonStep === "reason"
                ? "modal modal-sale modal-amount modal-reason reason-sized"
                : "modal modal-sale modal-amount modal-reason"
            }
            role="dialog"
            aria-modal="true"
            aria-label={
              reasonStep === "pin"
                ? "Who is discounting this?"
                : reasonStep === "enroll"
                  ? "Set up your PIN"
                  : "Discount this sale"
            }
            onClick={(e) => e.stopPropagation()}
          >
            {reasonStep === "reason" ? (
              <>
                <p className="modal-title">Discount this sale</p>
            <div className="pad-row">
              <span className="pad-label">Subtotal before tax</span>
              <span className="pad-amt">{money(cartSubtotalCents / 100)}</span>
            </div>
            {/* T79: the amount step. The T70 pad panel's shape inside
                T68's one fixed box: the entry column at the left (the
                head with the live figure, the Amount | Percent | Whole
                sale segment, the running effect, the quick cells, the
                reason chips and the note), the 3x4 keys at the right.
                Nothing here moves when a segment or a chip is tapped. */}
            <div className="reason-body discount-body">
            <div className="pad-left discount-left">
              <p className="pad-head discount-head">
                <span className="pad-kicker">Discount</span>
                <span className="pad-entered-amt">{discountEntered}</span>
              </p>
              <div
                className="pad-chips discount-modes"
                role="radiogroup"
                aria-label="Discount as"
              >
                {(
                  [
                    ["amount", "Amount"],
                    ["percent", "Percent"],
                    ["whole", "Whole sale"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    role="radio"
                    className={
                      discountDraft.mode === mode ? "pad-chip on" : "pad-chip"
                    }
                    aria-checked={discountDraft.mode === mode}
                    onClick={() => chooseMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p
                className={
                  draftDiscount === null
                    ? "pad-change muted-note discount-effect"
                    : "pad-change discount-effect"
                }
                role="status"
              >
                {discountEffect}
              </p>
              {/* The quick cells (the pad's chips): $5 / $10 / $20 for
                  an amount, 10% / 25% / 50% for a percent; none for
                  Whole sale, which needs no figure. A cell SETS the
                  entry. */}
              <div className="pad-chips discount-quick">
                {(discountDraft.mode === "percent"
                  ? [10, 25, 50]
                  : [5, 10, 20]
                ).map((v) => (
                  <button
                    key={v}
                    className="pad-chip"
                    disabled={
                      discountDraft.mode === "whole" || cartSubtotalCents <= 0
                    }
                    onClick={() => discountChip(v)}
                  >
                    {discountDraft.mode === "percent" ? `${v}%` : `$${v}`}
                  </button>
                ))}
              </div>
              {/* T45: the chips choose a KIND (Pete: "we aren't saving an
                  enum with the row"), never paste text. T79: three, no
                  Teacher. */}
              <div className="pad-chips reason-chips">
                {COMP_KINDS.map((kind) => (
                  <button
                    key={kind}
                    className={
                      reasonDraft.kind === kind ? "pad-chip on" : "pad-chip"
                    }
                    aria-pressed={reasonDraft.kind === kind}
                    onClick={() => chooseKind(kind)}
                  >
                    {COMP_KIND_LABELS[kind]}
                  </button>
                ))}
              </div>
              {/* T71: the note is greyed out and inert until a kind is
                  chosen, and the placeholder no longer says "(optional)":
                  for Trade and Other it is required (T67), for the rest
                  the empty field is the answer. T79: one 64px line. */}
              <textarea
                ref={noteRef}
                className="reason-input reason-note-field"
                value={reasonDraft.detail}
                maxLength={COMP_DETAIL_MAX}
                autoComplete="off"
                rows={1}
                disabled={reasonDraft.kind === null}
                placeholder={
                  reasonDraft.kind === null
                    ? "Choose a reason first"
                    : reasonDraft.kind === "trade"
                      ? /* Trade is the one reason whose note has a
                           question to answer; every other one asks for
                           the note in Pete's words (T82). */
                        "What was traded?"
                      : "Add a note"
                }
                aria-label="Note for the discount"
                onChange={(e) =>
                  setReasonDraft((d) => ({ ...d, detail: e.target.value }))
                }
                onKeyDown={(e) => {
                  /* Enter still means Next (T43); a note is one line of
                   * reason, not prose, so the field never takes a
                   * newline. */
                  if (e.key === "Enter") {
                    e.preventDefault();
                    toPinStep();
                  }
                }}
              />
            </div>
            <div className="pad-keys">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0"].map(
                (k) => (
                  <button
                    key={k}
                    className="pad-key"
                    disabled={discountDraft.mode === "whole"}
                    onClick={() => discountTap(k)}
                  >
                    {k}
                  </button>
                ),
              )}
              <button
                className="pad-key del"
                aria-label="Delete last digit"
                title="Delete"
                disabled={discountDraft.mode === "whole"}
                onClick={() => discountTap("back")}
              >
                <BackspaceIcon />
              </button>
            </div>
            </div>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={closeReason}>
                Cancel
              </button>
              <button
                className="modal-confirm go"
                disabled={!compValid(reasonDraft) || draftDiscount === null}
                title={
                  draftDiscount === null
                    ? discountDraft.mode === "percent"
                      ? "Enter 1 to 100 percent"
                      : "Enter an amount"
                    : compValid(reasonDraft)
                      ? "Next: your PIN"
                      : reasonDraft.kind === null
                        ? "Choose a reason"
                        : `Write at least ${COMP_DETAIL_MIN} characters`
                }
                onClick={toPinStep}
              >
                Next
              </button>
            </div>
              </>
            ) : null}

            {/* T48: the PIN step. Every discount asks, whatever POS_PIN
                says (Pete: "comp just let me right through without
                entering a PIN ... that's exactly what we don't want").
                Six slots for a 4 to 6 digit PIN, the amount pad's keys,
                Done once four are in; a miss clears the digits and says
                so, the lockout counts down in the same line. */}
            {reasonStep === "pin" ? (
              <>
                <p className="modal-title">Who is discounting this?</p>
                <p className="reason-sub">Enter your PIN.</p>
                <div
                  key={`dots-${pinShake}`}
                  className={
                    pinMsg !== null && pinLockedFor === 0 && pinEntry === ""
                      ? "lock-dots pin-dots shake"
                      : "lock-dots pin-dots"
                  }
                  aria-label={`${pinEntry.length} digits entered`}
                >
                  {Array.from({ length: PIN_MAX }).map((_, i) => (
                    <span
                      key={i}
                      className={i < pinEntry.length ? "lock-dot" : "lock-dot empty"}
                    />
                  ))}
                </div>
                {pinLockedFor > 0 ? (
                  <p className="lock-msg">
                    Too many attempts. Try again in {pinLockedFor}s.
                  </p>
                ) : pinMsg ? (
                  <p className="lock-msg">{pinMsg}</p>
                ) : (
                  <p className="lock-msg lock-msg-empty" aria-hidden="true">
                    &nbsp;
                  </p>
                )}
                <div className="pad-keys">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => (
                    <button
                      key={k}
                      className="pad-key"
                      disabled={pinKeysOff}
                      onClick={() => pinTap(k)}
                    >
                      {k}
                    </button>
                  ))}
                  <button
                    className="pad-key"
                    aria-label="Delete last digit"
                    disabled={pinKeysOff}
                    onClick={() => pinTap("back")}
                  >
                    &#9003;
                  </button>
                  <button
                    className="pad-key"
                    disabled={pinKeysOff}
                    onClick={() => pinTap("0")}
                  >
                    0
                  </button>
                  <span aria-hidden="true" />
                </div>
                <button
                  className="reason-link"
                  disabled={pinBusy}
                  onClick={toEnrollStep}
                >
                  Set up or change your PIN
                </button>
                <div className="modal-actions">
                  <button
                    className="modal-cancel"
                    disabled={pinBusy}
                    onClick={backToReason}
                  >
                    Back
                  </button>
                  <button
                    className="modal-confirm go"
                    disabled={pinKeysOff || pinEntry.length < PIN_MIN}
                    title={
                      pinEntry.length < PIN_MIN
                        ? `Enter ${PIN_MIN} to ${PIN_MAX} digits`
                        : "Check this PIN"
                    }
                    onClick={() => void submitPin()}
                  >
                    {pinBusy ? "Checking..." : "Done"}
                  </button>
                </div>
              </>
            ) : null}

            {/* T48: the PIN matched. Who is discounting is on the
                surface before the button that arms it, and only the
                button here arms. T79: the figure is restated too. */}
            {reasonStep === "ready" && verified !== null ? (
              <>
                <p className="modal-title">
                  {draftFull ? "Comp this sale" : "Discount this sale"}
                </p>
            <div className="pad-row">
              <span className="pad-label">Subtotal before tax</span>
              <span className="pad-amt">{money(cartSubtotalCents / 100)}</span>
            </div>
                <p className="reason-who">
                  {draftFull ? "Comping" : "Discounting"} as{" "}
                  {verified.teacher.name}
                </p>
                <p className="reason-note">{discountEffect}</p>
                {(() => {
                  const r = draftToReason(reasonDraft);
                  return r ? (
                    <p className="reason-note">{compReasonLine(r)}</p>
                  ) : null;
                })()}
                <div className="modal-actions">
                  <button className="modal-cancel" onClick={closeReason}>
                    Cancel
                  </button>
                  <button
                    className="modal-confirm go"
                    disabled={charging || draftDiscount === null}
                    title={draftFull ? "Comp this sale" : "Discount this sale"}
                    onClick={confirmComp}
                  >
                    {draftFull ? "Comp" : "Discount"}
                  </button>
                </div>
              </>
            ) : null}

            {/* T48: enrollment. A Mindbody sign-in proves who is choosing
                the PIN (Pete: "is it possible to use a mindbody sign in
                for identification of the teacher?"); the password goes
                to /api/teacher/enroll once and is kept nowhere. */}
            {reasonStep === "enroll" ? (
              <>
                <p className="modal-title">Set up your PIN</p>
                <p className="reason-sub">
                  Sign in to Mindbody once so we know it is you, then choose
                  a PIN of {PIN_MIN} to {PIN_MAX} digits. Your password is
                  checked with Mindbody and not kept.
                </p>
                <input
                  className="reason-input"
                  type="email"
                  autoComplete="username"
                  autoFocus
                  placeholder="Mindbody username (email)"
                  aria-label="Mindbody username"
                  value={enroll.username}
                  disabled={enrollBusy}
                  onChange={(e) =>
                    setEnroll((v) => ({ ...v, username: e.target.value }))
                  }
                />
                <input
                  className="reason-input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Mindbody password"
                  aria-label="Mindbody password"
                  value={enroll.password}
                  disabled={enrollBusy}
                  onChange={(e) =>
                    setEnroll((v) => ({ ...v, password: e.target.value }))
                  }
                />
                <input
                  className="reason-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={PIN_MAX}
                  placeholder={`New PIN (${PIN_MIN} to ${PIN_MAX} digits)`}
                  aria-label="New PIN"
                  value={enroll.pin}
                  disabled={enrollBusy}
                  onChange={(e) =>
                    setEnroll((v) => ({
                      ...v,
                      pin: e.target.value.replace(/\D/g, "").slice(0, PIN_MAX),
                    }))
                  }
                />
                {/* T80: the same PIN again, so a typo cannot become the
                    PIN a teacher then cannot guess back. */}
                <input
                  className="reason-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={PIN_MAX}
                  placeholder="Re-enter PIN"
                  aria-label="Re-enter PIN"
                  value={enroll.confirm}
                  disabled={enrollBusy}
                  onChange={(e) =>
                    setEnroll((v) => ({
                      ...v,
                      confirm: e.target.value
                        .replace(/\D/g, "")
                        .slice(0, PIN_MAX),
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitEnroll();
                  }}
                />
                {enrollMismatch ? (
                  <p className="reason-note">PINs do not match</p>
                ) : null}
                {enrollMsg ? (
                  <p className={enrollMsg.ok ? "reason-note" : "lock-msg"}>
                    {enrollMsg.text}
                  </p>
                ) : null}
                <div className="modal-actions">
                  <button
                    className="modal-cancel"
                    disabled={enrollBusy}
                    onClick={backToPin}
                  >
                    Back
                  </button>
                  <button
                    className="modal-confirm go"
                    disabled={!enrollValid || enrollBusy}
                    title={
                      enrollValid
                        ? "Check the sign-in and save the PIN"
                        : "Fill in the sign-in and the same PIN twice"
                    }
                    onClick={() => void submitEnroll()}
                  >
                    {enrollBusy ? "Checking..." : "Save PIN"}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      </div>

      {/* T70: the ticket's tender lines, under its Total, through the
          ticket's slot (Payment.dc.html: "this is the counter's actual
          question and it belongs on the receipt side"). Same render as
          the figures, so the change here is the change up there. */}
      {visible && ticketSlot && result?.kind !== "paid" && (lines.length > 0 || comped)
        ? createPortal(
            <div className="t-tender">
              {comped ? (
                <div className="t-line t-muted">
                  <span>Comped, on the studio</span>
                  <span className="amt">{total !== null ? money(total) : "--"}</span>
                </div>
              ) : (
                lines.map((line) => (
                  <div className="t-line t-muted" key={line.id}>
                    <span>{sourceLabel(line.source)} received</span>
                    <span className="amt">{money(line.cents / 100)}</span>
                  </div>
                ))
              )}
              {!comped && changeCents > 0 ? (
                <div className="t-line t-change">
                  <span>Change due</span>
                  <span className="amt">{money(changeCents / 100)}</span>
                </div>
              ) : !comped && dueCents !== null && dueCents > 0 ? (
                <div className="t-line t-still">
                  <span>Still due</span>
                  <span className="amt">{money(dueCents / 100)}</span>
                </div>
              ) : null}
            </div>,
            ticketSlot,
          )
        : null}
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
  | {
      kind: "paid";
      summary: string;
      detail: string | null;
      /** T49: see ChargeResult.actorNote. */
      actorNote: string | null;
    }
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
  /** T49: see PaymentPanel's onStaffSessionEnded. */
  onStaffSessionEnded: () => void;
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
    onStaffSessionEnded,
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
      if (body?.staffSessionEnded === true) onStaffSessionEnded();
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
          actorNote: body?.actorFallback
            ? actorFallbackLine(body.actorFallback)
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
        className="modal modal-sale modal-contract"
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
            {outcome.actorNote ? (
              <p className="pay-done-detail actor-note">{outcome.actorNote}</p>
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

/**
 * T85: what the nav bar's Pay item needs from the sale, reported upward
 * whenever it changes. `payWhy` is the reason Pay cannot be entered (the
 * item's title, aria-disabled when it is not null) and `payTap` is the
 * shelf Pay button's own handler, gates included, so the bar and the
 * button can never disagree about what a tap does. `charging` locks
 * every item that would leave the pay screen.
 */
export interface SaleNavState {
  payWhy: string | null;
  charging: boolean;
  payTap: () => void;
}

export default function SaleScreen(props: {
  open: boolean;
  onClose: () => void;
  /** T85: which screen the nav bar is on. The mode lives in page.tsx,
   *  because the bar is rendered there and "Buy" and "Pay" are two of
   *  its five items; the overlay only reads it and asks for changes. */
  mode: "shelf" | "pay";
  onModeChange: (mode: "shelf" | "pay") => void;
  /** T85: called whenever the nav bar's reading of Pay changes. */
  onNavState: (state: SaleNavState) => void;
  config: ModeConfig | null;
  client: SaleClient | null;
  /** Opens the existing search modal in attach mode (page.tsx owns it). */
  onRequestAttach: () => void;
  onDetachClient: () => void;
  /**
   * T90: open that SAME modal to pick who ONE line is for ("Who is this
   * for?"). `hasRecipient` tells page.tsx to offer the row that clears
   * it. The pick comes back through `recipientPick`; the cart is this
   * component's, so nothing about who is attached moves.
   */
  onRequestRecipient?: (lineKey: string, hasRecipient: boolean) => void;
  /**
   * T90: the answer to the last onRequestRecipient. `nonce` is what makes
   * a repeat pick of the same person on the same line arrive; a null
   * `client` is the clear row. Applied once and then left alone.
   */
  recipientPick?: {
    nonce: number;
    lineKey: string;
    client: SaleRecipient | null;
  } | null;
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
  /** T49: a money write answered that the signed-in teacher's token is
   *  no longer valid; page.tsx clears the header control. */
  onStaffSessionEnded?: () => void;
}) {
  const {
    open,
    onClose,
    mode,
    onModeChange,
    onNavState,
    config,
    client,
    onRequestAttach,
    onDetachClient,
    onRequestRecipient,
    recipientPick,
    modalAbove,
    onContractPurchased,
    onSaleCompleted,
    onStaffSessionEnded,
  } = props;

  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  /** The active top-level cell: Favorites, or a section name (T76:
   *  Passes, Retail, Rentals). Defaults once the catalog lands:
   *  Favorites when it has anything to show, else the first section
   *  with a shelf (see the effect below). */
  const [activeCat, setActiveCat] = useState<string | null>(null);
  /** T76: the chosen child of the active section (a pass group label,
   *  Packages, Memberships, or a retail category label); null shows the
   *  whole section under kickers. */
  const [activeChild, setActiveChild] = useState<string | null>(null);
  /** T76: the open section. An accordion: opening one closes the other,
   *  and a section stays open while Favorites or Rentals is shown, so a
   *  teacher coming back finds it as they left it. */
  const [expanded, setExpanded] = useState<RailSection | null>(null);
  /** T76: the retail child's General | Teacher sub-tab. Resets with the
   *  rail selection, so every child starts on General. */
  const [retailTab, setRetailTab] = useState<"general" | "teacher">("general");
  useEffect(() => {
    setRetailTab("general");
  }, [activeCat, activeChild]);

  /** A top-level tap: select it and, for a section, open it (closing
   *  the other) with no child chosen, which is the section's All view. */
  const tapTop = useCallback((label: string) => {
    setActiveCat(label);
    setActiveChild(null);
    if (label === PASSES_SECTION || label === RETAIL_SECTION) setExpanded(label);
  }, []);

  const tapChild = useCallback((section: RailSection, label: string) => {
    setActiveCat(section);
    setActiveChild(label);
    if (section === PASSES_SECTION || section === RETAIL_SECTION) {
      setExpanded(section);
    }
  }, []);

  /**
   * The stars. Since T76 the source of truth is the SHARED list in the
   * database, served on the catalog payload (`favorites`); a star on
   * one iPad shows on the next load of every other. With nothing stored
   * (no database, no row yet) the per-device localStorage list applies,
   * exactly as before T76, and the first star tap on that device
   * uploads it (the one-time migration). Held as the stored pairs so
   * re-saving never mangles an id's string/number type; the Set of keys
   * is derived. Storage failing (private mode, an iPad with site data
   * blocked) degrades to an empty, non-persisting shelf, the same
   * try/catch posture as settings.ts.
   */
  const [favorites, setFavorites] = useState<FavPair[]>([]);
  const favKey = config ? favoritesKey(config.target) : null;
  /** Where the current list came from: the device until the catalog
   *  serves a stored list or a PUT reports it stored. A ref, so the
   *  localStorage load below can never overwrite a served list. */
  const favSource = useRef<"local" | "db">("local");
  /** The list as the screen shows it, mirrored in a ref so a PUT sends
   *  the latest taps and not the list of the closure it was queued
   *  from; the last list the server confirmed (or served), which is
   *  what a failed PUT reverts to; and the single flight: a star while
   *  a PUT is out marks the list dirty, and the flight sends the whole
   *  list once more when it lands, so two PUTs never race each other
   *  and a later star is never lost to an earlier answer. */
  const favLatest = useRef<FavPair[]>([]);
  const favConfirmed = useRef<FavPair[]>([]);
  const favFlying = useRef(false);
  const favDirty = useRef(false);
  const showFavorites = useCallback((list: FavPair[]) => {
    favLatest.current = list;
    setFavorites(list);
  }, []);
  /** T76: the quiet line under a star that could not be saved (the PUT
   *  failed and the tap was undone). Cleared by the next tap or by a
   *  rail change. */
  const [favNotice, setFavNotice] = useState<string | null>(null);
  useEffect(() => {
    setFavNotice(null);
  }, [activeCat, activeChild]);

  useEffect(() => {
    if (favKey === null || favSource.current === "db") return;
    let list: FavPair[] = [];
    try {
      const raw = window.localStorage.getItem(favKey);
      list = readFavPairs(raw ? JSON.parse(raw) : []);
    } catch {
      list = [];
    }
    favConfirmed.current = list;
    showFavorites(list);
  }, [favKey, showFavorites]);

  /** The catalog landing (the first load, a recheck, Refresh) sets the
   *  shelf AND, when the payload carries a stored list, the favorites,
   *  in ONE batch: the default-cell effect then sees Favorites with its
   *  content on the same render, instead of choosing Passes a tick
   *  before the shared stars arrive (which a trailing effect did, seen
   *  on a fresh device in the T76 harness). A served list wins over the
   *  device's own: it is what every other iPad sees. Not while a PUT is
   *  in flight, though: the list on its way out is newer than the one
   *  the catalog read a moment ago. */
  const landCatalog = useCallback(
    (fresh: CatalogState) => {
      if (fresh.favorites) {
        favSource.current = "db";
        if (!favFlying.current) {
          favConfirmed.current = fresh.favorites;
          showFavorites(fresh.favorites);
        }
      }
      setCatalog(fresh);
    },
    [showFavorites],
  );

  const favSet = useMemo(
    () => new Set(favorites.map((f) => itemKey(f.type, f.id))),
    [favorites],
  );

  const persistFavorites = useCallback(
    (list: FavPair[]) => {
      if (favKey === null) return;
      try {
        window.localStorage.setItem(favKey, JSON.stringify(list));
      } catch {
        /* Not persistable here; the star still works for this visit. */
      }
    },
    [favKey],
  );

  /** The whole list to the shared one, one PUT at a time. A migration
   *  is the first PUT from a device whose list came from localStorage
   *  while the table had none. A failure undoes every tap since the
   *  last confirmed list, quietly: the shared list is the truth, and a
   *  star that only this iPad can see would mislead the next one. */
  const pushFavorites = useCallback(async () => {
    if (favFlying.current) {
      favDirty.current = true;
      return;
    }
    favFlying.current = true;
    try {
      do {
        favDirty.current = false;
        const sent = favLatest.current;
        const migrating =
          favSource.current === "local" && favConfirmed.current.length > 0;
        try {
          const r = await fetch("/api/favorites", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              favorites: sent.map((f) => ({ type: f.type, id: String(f.id) })),
            }),
          });
          const body = await r.json().catch(() => null);
          if (!r.ok || body?.ok !== true) {
            throw new Error(body?.error ?? `HTTP ${r.status}`);
          }
          favConfirmed.current = sent;
          if (body.stored === true) {
            favSource.current = "db";
            if (body.migrated === true || migrating) {
              console.info(
                `[favorites] this device's list of ${sent.length} is now the shared favorites`,
              );
            }
          }
        } catch (err) {
          const back = favConfirmed.current;
          favDirty.current = false;
          showFavorites(back);
          persistFavorites(back);
          setFavNotice(
            `The star was not saved to the shared favorites and was undone (${
              err instanceof Error ? err.message : String(err)
            }).`,
          );
        }
      } while (favDirty.current);
    } finally {
      favFlying.current = false;
    }
  }, [persistFavorites, showFavorites]);

  const toggleFavorite = useCallback(
    (item: ShelfItem) => {
      const key = itemKey(item.type, item.id);
      const prev = favLatest.current;
      const next = prev.some((f) => itemKey(f.type, f.id) === key)
        ? prev.filter((f) => itemKey(f.type, f.id) !== key)
        : [...prev, { type: item.type, id: item.id }];
      /* Optimistic on screen and in the device's own store (the
       * no-database path is exactly the pre-T76 behaviour), then the
       * whole list to the shared one. */
      setFavNotice(null);
      showFavorites(next);
      persistFavorites(next);
      void pushFavorites();
    },
    [persistFavorites, pushFavorites, showFavorites],
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

  /** T41 (Pete: "when a category has no items it should not even display
   *  in the UI as a button at all"), kept through T76: only a cell with
   *  something to sell reaches the rail. The Passes shelf is every
   *  unrouted pricing option; its children are the pass groups with an
   *  item there plus Packages and Memberships; Retail's children are the
   *  retail categories with a shelf, in config order; Rentals is its
   *  category when it has anything. Empty while the catalog loads, and
   *  the rail does not render then either. */
  const passesCategory = useMemo(
    () => catalog?.categories.find((c) => sectionOf(c) === PASSES_SECTION) ?? null,
    [catalog],
  );
  const passesShelf = useMemo(
    () => (catalog && passesCategory ? categoryShelf(catalog, passesCategory) : []),
    [catalog, passesCategory],
  );
  const passKids = useMemo(
    () => (catalog ? passChildren(catalog, passesShelf) : []),
    [catalog, passesShelf],
  );
  const retailCategories = useMemo(
    () =>
      catalog
        ? catalog.categories.filter(
            (c) =>
              sectionOf(c) === RETAIL_SECTION &&
              categoryShelf(catalog, c).length > 0,
          )
        : [],
    [catalog],
  );
  /** The Rentals cell renders whenever the catalog names the category,
   *  empty or not (Pete: "Rentals was supposed to be a main category as
   *  well"): a main category that hides itself when nothing routes to
   *  it looked like a missing one. Empty, its shelf says so. */
  const rentalsCategory = useMemo(
    () =>
      catalog
        ? (catalog.categories.find((c) => sectionOf(c) === RENTALS_SECTION) ??
          null)
        : null,
    [catalog],
  );
  /** The top-level cells with something to show, in rail order after
   *  Favorites (which has its own rule: always rendered). */
  const railSections = useMemo<RailSection[]>(() => {
    const out: RailSection[] = [];
    if (passKids.length > 0) out.push(PASSES_SECTION);
    if (retailCategories.length > 0) out.push(RETAIL_SECTION);
    if (rentalsCategory) out.push(RENTALS_SECTION);
    return out;
  }, [passKids, retailCategories, rentalsCategory]);

  /** The default cell, decided when the catalog lands: Favorites when it
   *  has anything to show, else the first section with a shelf, opened.
   *  Later star changes never yank the selection around (the early
   *  return). T41: a cell that lost its last item on a recheck falls
   *  back the same way rather than leaving an active button the rail
   *  no longer shows. */
  useEffect(() => {
    if (!catalog) return;
    const stillShown =
      activeCat === FAVORITES_LABEL ||
      railSections.some((section) => section === activeCat);
    if (activeCat !== null && stillShown) return;
    const fallback = favoritesHasContent
      ? FAVORITES_LABEL
      : (railSections[0] ?? null);
    setActiveCat(fallback);
    setActiveChild(null);
    if (fallback === PASSES_SECTION || fallback === RETAIL_SECTION) {
      setExpanded(fallback);
    }
  }, [catalog, favoritesHasContent, railSections, activeCat]);

  /** A chosen child the reloaded catalog no longer offers (a recheck
   *  emptied the group, a category lost its last item) drops to its
   *  section's All view rather than an empty shelf. */
  useEffect(() => {
    if (activeChild === null) return;
    const kids =
      activeCat === PASSES_SECTION
        ? passKids
        : activeCat === RETAIL_SECTION
          ? retailCategories.map((c) => c.label)
          : [];
    if (!kids.includes(activeChild)) setActiveChild(null);
  }, [activeCat, activeChild, passKids, retailCategories]);

  const [cart, setCart] = useState<CartEntry[]>([]);
  /** T79: the armed discount, cart state: the pricing loop below sends
   *  it with the lines, and the panel arms and clears it through props.
   *  Cleared with an emptied cart (the loop) and a completed sale (the
   *  panel's reset). */
  const [armedDiscount, setArmedDiscount] = useState<ArmedDiscount | null>(
    null,
  );
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
   * entered in pay mode survives leaving it. Reset to shelf on every open
   * and on every close (Done included), so Buy never opens on the
   * previous sale's tender.
   *
   * T85: the mode is page.tsx's state, because the nav bar renders there
   * and Buy and Pay are two of its items; these two names are the whole
   * of what that changes inside this component.
   */
  const saleMode = mode;
  const setSaleMode = onModeChange;
  /** T70: the ticket's tender slot, handed to PaymentPanel (see the
   *  panel's `ticketSlot`). A callback
   *  ref into state, since the element exists only after the first
   *  commit. */
  const [ticketSlot, setTicketSlot] = useState<HTMLElement | null>(null);
  /** Every close goes through here so the mode resets with it. */
  const close = useCallback(() => {
    setSaleMode("shelf");
    onClose();
  }, [onClose, setSaleMode]);
  const leavePay = useCallback(() => setSaleMode("shelf"), [setSaleMode]);

  /**
   * T51: an anonymous sale is a CHOICE, not the absence of one. Pete,
   * from the first live sales: "there should be some friction when
   * making a walkin sale. if there is no client attached and the user
   * clicks pay, a popup should appear warning them there is no user and
   * asking them to confirm this is a walkin sale." So the sale carries an
   * explicit walk-in flag: set by the header's Walk-in button or by the
   * dialog's "Continue as walk-in", cleared when a client is attached
   * (the effect below), when the cart is emptied and when a sale
   * completes. Nothing on the server reads it: an anonymous cart still
   * rides POS_HOUSE_CLIENT_ID exactly as T41 left it, and the flag only
   * decides whether Pay asks first.
   */
  const [walkIn, setWalkIn] = useState(false);
  /** T51: the friction dialog, up when Pay was tapped with nobody
   *  attached and no walk-in declared. Scrim, X and Escape stay in shelf
   *  mode with nothing changed. */
  const [walkInPrompt, setWalkInPrompt] = useState(false);
  useEffect(() => {
    if (client !== null) setWalkIn(false);
  }, [client]);
  const cancelWalkInPrompt = useCallback(() => setWalkInPrompt(false), []);

  /**
   * T53: the opt-in gate (Pete: "popup should gate the sale so the
   * teacher sees it and adds their opt in or moves on. if the client is
   * already opted in this whole popup should skip"). `consentPrompt` is
   * the dialog; `consentAskedFor` is the client it has been answered
   * for, so it shows at most once per sale per client: a Not now or a
   * save keeps it quiet until a different client is attached or the
   * sale ends. Scrim, X and Escape are a dismissal, not an answer: the
   * sale stays in shelf mode and Pay asks again.
   */
  const [consentPrompt, setConsentPrompt] = useState(false);
  const [consentAskedFor, setConsentAskedFor] = useState<string | null>(null);
  const [consentAccount, setConsentAccount] = useState(true);
  const [consentPromo, setConsentPromo] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  /** The opt-in write went out suppressed (dry run or the write guard):
   *  the flag is NOT set in Mindbody, and the receipt toggle says why. */
  const [consentSuppressed, setConsentSuppressed] = useState<{
    clientId: string;
    mode: string;
  } | null>(null);
  const cancelConsentPrompt = useCallback(() => {
    setConsentPrompt(false);
    setConsentError(null);
  }, []);


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
    setPriced(null);
    setPriceError(null);
    setCartResetNonce((n) => n + 1);
    setCartPrompt(null);
    /* T51: a walk-in was declared for THIS cart; the next one asks again. */
    setWalkIn(false);
    /* T53: and so was the opt-in question. */
    setConsentAskedFor(null);
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

  /** T51: Escape peels the walk-in dialog like the other confirms, and
   *  a dismissal declares nothing: the sale stays in shelf mode. */
  useEffect(() => {
    if (!walkInPrompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelWalkInPrompt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [walkInPrompt, cancelWalkInPrompt]);

  /**
   * T38: the second way out, for the disagree stop specifically. The
   * likeliest cause of "our math says X, Mindbody says Y" is a shelf
   * priced from the two-minute catalog cache after the studio changed a
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
        /* T90: the cart key carries the recipient now, so the catalog is
           asked for the ITEM's identity. */
        const item = byKey.get(itemKey(line.item.type, line.item.id));
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
      landCatalog(fresh);
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
  }, [rechecking, landCatalog]);

  /** Fetch the shelf once per screen life; the route caches server-side
   *  for two minutes anyway (T75). A failure renders with a retry button. */
  const loadCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    fetch("/api/catalog")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        landCatalog(parseCatalog(body));
        /* The default cell is picked by the effect above, which also
           knows whether Favorites has anything to show. */
      })
      .catch((e) =>
        setCatalogError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setCatalogLoading(false));
  }, [landCatalog]);

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
        : {
            clientId,
            loading: true,
            card: null,
            balance: null,
            error: null,
            email: null,
            sendAccountEmails: null,
            sendPromotionalEmails: null,
          },
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
            email: typeof body?.email === "string" ? body.email : null,
            sendAccountEmails:
              typeof body?.sendAccountEmails === "boolean"
                ? body.sendAccountEmails
                : null,
            sendPromotionalEmails:
              typeof body?.sendPromotionalEmails === "boolean"
                ? body.sendPromotionalEmails
                : null,
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
            email: null,
            sendAccountEmails: null,
            sendPromotionalEmails: null,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [clientId, profileNonce]);

  /* T79: the discount is priced WITH the cart (the mode and the value;
   * the route spreads it over the lines itself), so an armed, removed
   * or changed discount reprices like a cart edit. The key is the
   * effect's dependency rather than the object, since the panel hands
   * back a new object per arm. */
  const armedDiscountKey =
    armedDiscount === null
      ? ""
      : `${armedDiscount.discount.mode}:${armedDiscount.discount.value}`;
  useEffect(() => {
    const gen = ++priceGen.current;
    if (cart.length === 0) {
      setPriced(null);
      setPriceError(null);
      setPricing(false);
      /* T79: an emptied cart has nothing to discount. */
      setArmedDiscount(null);
      return;
    }
    setPricing(true);
    setPriceError(null);
    const discount =
      armedDiscountKey === ""
        ? null
        : {
            mode: armedDiscountKey.split(":")[0] as Discount["mode"],
            value: Number(armedDiscountKey.split(":")[1]),
          };
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
              /* T90: the route prices one cart per recipient and answers
                 the sum of Mindbody's grand totals. */
              ...(line.forClient ? { forClientId: line.forClient.id } : {}),
            })),
            ...(clientId ? { clientId } : {}),
            ...(discount ? { discount } : {}),
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
  }, [cart, clientId, armedDiscountKey]);

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
        walkInPrompt ||
        consentPrompt ||
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
    walkInPrompt,
    consentPrompt,
    contractDialog,
    pricing,
    charging,
    saleMode,
    leavePay,
    close,
  ]);

  /* T82 gave every line its own stepper and X; Pete then asked for them
   * only on the line tapped (`revealedKey`, below), which is T39.4's
   * select-to-reveal again with the 44px icon squares.
   */

  const addItem = useCallback((item: ShelfItem) => {
    /* T90: a shelf tap always bumps the SELF line, never a line bought
       for somebody else: "re-tapping the shelf item bumps the self
       line". The other client's line is reached through its own row. */
    const key = cartKey(item, null);
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
    setCart((lines) => {
      const next = [...lines];
      for (const { item, quantity } of bundle.items) {
        const key = cartKey(item, null);
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

  /* Select-to-reveal, back (Pete, live, on every line wearing its
   * controls: "the items on the right should only show the +/1/X
   * buttons when i click on one to make it show"). One line at a time;
   * the same tap again puts them away; a removed line clears it. */
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  /* A tap anywhere outside the revealed row puts its controls away
   * (Pete: "if i click anywhere else on the screen, the +/-/X buttons
   * should disappear"). pointerdown on the document, so a tap that
   * lands on a shelf card both adds the item and hides the controls;
   * the row itself (its controls included) is excluded so the stepper
   * keeps working. */
  useEffect(() => {
    if (revealedKey === null) return;
    const away = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el && el.closest(".t-row.sel")) return;
      setRevealedKey(null);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [revealedKey]);
  const removeLine = useCallback((key: string) => {
    setRevealedKey((k) => (k === key ? null : k));
    setCart((lines) => lines.filter((l) => l.key !== key));
  }, []);

  /**
   * T90: put a line on somebody else's account, or take it off theirs.
   * The recipient is never the client paying (picking them is how the
   * line comes back to the payer), and the line is re-keyed, so the same
   * item for two people is two lines; a re-key that collides with a line
   * that already exists merges the quantities instead of holding two
   * rows Mindbody would price as one.
   */
  const setLineRecipient = useCallback(
    (key: string, next: SaleRecipient | null) => {
      setCart((lines) => {
        const at = lines.findIndex((l) => l.key === key);
        const line = at < 0 ? undefined : lines[at];
        if (!line) return lines;
        const recipient =
          next !== null && next.id !== (client?.id ?? null) ? next : null;
        const nextKey = cartKey(line.item, recipient?.id ?? null);
        if (nextKey === line.key) return lines;
        const rest = lines.filter((l) => l.key !== key);
        const existing = rest.findIndex((l) => l.key === nextKey);
        const merge = existing < 0 ? undefined : rest[existing];
        if (merge) {
          const merged = [...rest];
          merged[existing] = {
            ...merge,
            quantity: Math.min(
              merge.quantity + line.quantity,
              MAX_LINE_QUANTITY,
            ),
          };
          setRevealedKey(nextKey);
          return merged;
        }
        const moved: CartEntry = {
          ...line,
          key: nextKey,
          forClient: recipient,
        };
        const out = [...lines];
        out[at] = moved;
        setRevealedKey(nextKey);
        return out;
      });
    },
    [client],
  );
  /* A line cannot be "for" the person paying. Attaching somebody who is
     already a line's recipient (attaching when nobody was attached keeps
     the cart, so this is reachable) brings that line back to the payer,
     rather than leaving a second cart addressed to the same client. */
  useEffect(() => {
    const id = client?.id ?? null;
    if (id === null) return;
    for (const line of cartRef.current) {
      if (line.forClient?.id === id) setLineRecipient(line.key, null);
    }
  }, [client, setLineRecipient]);
  /* The pick, applied once per nonce. An effect rather than a callback
     because the modal that made it belongs to page.tsx. */
  const pickApplied = useRef<number | null>(null);
  useEffect(() => {
    if (!recipientPick) return;
    if (pickApplied.current === recipientPick.nonce) return;
    pickApplied.current = recipientPick.nonce;
    setLineRecipient(recipientPick.lineKey, recipientPick.client);
  }, [recipientPick, setLineRecipient]);

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
  /**
   * T51 lifted this out of the Pay button so the walk-in dialog can
   * enter pay mode too; a hook, so it sits above the `!open` return.
   * Into pay mode: the rail and grid give way to the payment surface,
   * the cart stays put, and the ticket's rows lose their controls (the
   * pay-mode ticket is read-only; the way to a cart edit is Back to
   * items). The ticket starts from its first row, and T38's cue counts
   * the rest.
   */
  const enterPay = useCallback(() => {
    setSaleMode("pay");
    linesRef.current?.scrollTo({ top: 0 });
  }, [setSaleMode]);

  /**
   * T53 review: pay mode is entered for ONE "sale for", and both gates
   * (T51's walk-in dialog, T53's opt-in) run on the Pay tap for that
   * one. The header's attach, detach and walk-in controls stay live in
   * pay mode, so swapping the client there (detach Alida, attach Bob;
   * or withdraw the walk-in) would carry the surface, and its Charge,
   * to a client neither gate saw. So a change of who the sale is for
   * while in pay mode drops back to shelf mode, and the next Pay tap
   * asks whatever that person needs asking. Only a CHANGE while already
   * in pay mode (a hook, so above the `!open` return): the walk-in
   * dialog's Continue sets the flag and enters
   * pay mode in one render, and a sale's own reset (onSold clears the
   * walk-in flag under the done screen) comes with an emptied cart.
   */
  const saleFor = client !== null ? `client:${client.id}` : walkIn ? "walk-in" : "";
  const saleForRef = useRef<{ mode: typeof saleMode; who: string } | null>(null);
  useEffect(() => {
    const prev = saleForRef.current;
    saleForRef.current = { mode: saleMode, who: saleFor };
    if (
      prev !== null &&
      prev.mode === "pay" &&
      saleMode === "pay" &&
      prev.who !== saleFor &&
      cart.length > 0
    ) {
      leavePay();
    }
  }, [saleMode, saleFor, cart.length, leavePay]);

  /* T53: the gate's reading of the record, and what it does about it.
   * Below enterPay and the lookup because it calls the one and reads
   * the other. */
  /** The attach-time lookup for THIS client, once it has landed; null
   *  while loading or for a previous client. */
  const clientLookup =
    client !== null && cardLookup !== null && cardLookup.clientId === client.id
      ? cardLookup
      : null;
  const lookupLanded = clientLookup !== null && !clientLookup.loading;
  /** What the record says, once read: true, false, or null for a read
   *  that failed (unknown is skipped, not asked: a teacher must not be
   *  made to ask a question the answer to which we cannot save). */
  const accountEmailsOnFile: boolean | null = lookupLanded
    ? clientLookup.error
      ? null
      : clientLookup.sendAccountEmails === true
    : null;
  /** T53: whether Pay opens the gate: a named client, not yet asked
   *  this sale, whose record is still being read or reads as not opted
   *  in. Never with the walk-in dialog: that one needs no client. */
  const payNeedsConsent =
    client !== null &&
    consentAskedFor !== client.id &&
    (!lookupLanded || accountEmailsOnFile === false);
  const openConsentPrompt = useCallback(() => {
    setConsentError(null);
    setConsentPrompt(true);
  }, []);
  /* The boxes open pre-set to what Mindbody holds (account is the one
   * being asked for, so it opens ticked), the moment the record lands. */
  useEffect(() => {
    if (!consentPrompt || !lookupLanded) return;
    /* No email on file, no account box: the state matches the disabled,
     * unticked box it renders as, so a save can never write the flag
     * for an address that does not exist (harness scenario E). */
    setConsentAccount(Boolean(clientLookup.email));
    setConsentPromo(clientLookup.sendPromotionalEmails === true);
  }, [consentPrompt, lookupLanded, clientLookup]);
  /* The gate opened before the record landed (Pay tapped within the
   * lookup's half second): once it does, an opted-in or unreadable
   * client is waved through without a question. */
  useEffect(() => {
    if (!consentPrompt) return;
    if (client === null) {
      setConsentPrompt(false);
      return;
    }
    if (!lookupLanded || accountEmailsOnFile === false) return;
    setConsentAskedFor(client.id);
    setConsentPrompt(false);
    enterPay();
  }, [consentPrompt, client, lookupLanded, accountEmailsOnFile, enterPay]);
  useEffect(() => {
    if (!consentPrompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !consentBusy) cancelConsentPrompt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [consentPrompt, consentBusy, cancelConsentPrompt]);
  /** Not now, and Continue without after a failure: answered, nothing
   *  written, on to pay mode with no receipt. */
  const skipConsent = useCallback(() => {
    if (client !== null) setConsentAskedFor(client.id);
    setConsentPrompt(false);
    setConsentError(null);
    enterPay();
  }, [client, enterPay]);
  /**
   * Save and continue: ONE /api/client-consent write carrying the boxes
   * that differ from the record (a box left as Mindbody has it is not
   * sent, so an unticked "news and offers" can never revoke an opt-in
   * the client made elsewhere), then pay mode. Nothing changed is Not
   * now. A refusal stays in the dialog with its reason; a suppressed
   * write is honest about the flag not being set and continues.
   */
  const saveConsent = useCallback(async () => {
    if (client === null || !lookupLanded || consentBusy) return;
    const flags: {
      sendAccountEmails?: boolean;
      sendPromotionalEmails?: boolean;
    } = {};
    /* Read the box as rendered: with no email on file it is off. */
    const accountTicked = consentAccount && Boolean(clientLookup.email);
    if (accountTicked !== (clientLookup.sendAccountEmails === true)) {
      flags.sendAccountEmails = accountTicked;
    }
    if (consentPromo !== (clientLookup.sendPromotionalEmails === true)) {
      flags.sendPromotionalEmails = consentPromo;
    }
    if (Object.keys(flags).length === 0) {
      skipConsent();
      return;
    }
    const clientId = client.id;
    setConsentBusy(true);
    setConsentError(null);
    try {
      const res = await fetch("/api/client-consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, ...flags }),
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* handled by the status below */
      }
      if (body?.staffSessionEnded === true || body?.reason === "staff") {
        /* T50: the sign-in gate is coming back over this; the opt-in
         * is simply not saved, and the question stands for next time. */
        onStaffSessionEnded?.();
        setConsentPrompt(false);
        return;
      }
      if (!res.ok || body?.ok !== true) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      if (body?.suppressed) {
        setConsentSuppressed({ clientId, mode: String(body.suppressed) });
      } else {
        setConsentSuppressed(null);
        /* The record now says what was saved; the toggle reads it from
         * here, and the post-sale refetch re-reads it from Mindbody. */
        setCardLookup((prev) =>
          prev && prev.clientId === clientId
            ? {
                ...prev,
                sendAccountEmails:
                  flags.sendAccountEmails ?? prev.sendAccountEmails,
                sendPromotionalEmails:
                  flags.sendPromotionalEmails ?? prev.sendPromotionalEmails,
              }
            : prev,
        );
      }
      setConsentAskedFor(clientId);
      setConsentPrompt(false);
      enterPay();
    } catch (e) {
      setConsentError(e instanceof Error ? e.message : String(e));
    } finally {
      setConsentBusy(false);
    }
  }, [
    client,
    lookupLanded,
    clientLookup,
    consentBusy,
    consentAccount,
    consentPromo,
    skipConsent,
    enterPay,
    onStaffSessionEnded,
  ]);
  /** T53: what the pay surface may do about a receipt, from the same
   *  record the gate read. The reason is the toggle's own words. */
  const receipt: ReceiptState =
    client === null
      ? {
          email: null,
          why: walkIn
            ? "No client to email on a walk-in sale"
            : "Attach a client to email a receipt",
        }
      : !lookupLanded
        ? { email: null, why: "Reading their email settings" }
        : clientLookup.error
          ? { email: clientLookup.email, why: "Could not read their email settings" }
          : !clientLookup.email
            ? { email: null, why: "No email on file" }
            : clientLookup.sendAccountEmails !== true
              ? {
                  email: clientLookup.email,
                  why:
                    consentSuppressed?.clientId === client.id
                      ? `Opt-in not saved (${consentSuppressed.mode})`
                      : "Not opted in to account emails",
                }
              : { email: clientLookup.email, why: null };
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
       column leaves it, which moves when the totals area changes shape
       (estimate to server rows, a stop appearing). A ResizeObserver on
       the box itself catches every one of those without listing them;
       the cart dependency stays for the row count changing inside an
       unchanged box. T82: no row reveals anything any more, so the
       selection is no longer a dependency. */
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
  }, [cart, open, measureLines]);

  const cartCount = cart.reduce((n, l) => n + l.quantity, 0);
  /**
   * T39.5: the shelf's Pay, the cart column's foot since T85. Since T82
   * the button's face is the word alone and the amount is in its title,
   * where it is still the SERVER's grandTotal and nothing else: while
   * T38's estimate is on the ticket there is no figure to give, because
   * a number on the one button that moves money must never be the
   * browser's. `payWhy` is the reason it is disabled, or
   * null; it is the button's title, so a greyed Pay says why when asked.
   * Pay enters pay mode (T39.6); the charge itself is the panel's, in
   * the payment column's foot.
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
                  ? "No house client for an anonymous sale; attach a client"
                  : priced.grandTotal === null
                    ? "No total yet"
                    : null;
  const payAmount =
    payWhy === null && priced !== null ? priced.grandTotal : null;
  /** T51: whether Pay asks first. Nobody attached and no walk-in
   *  declared is the one case; with the flag set (the header's Walk-in
   *  button, or the dialog's own Continue) Pay goes straight through. */
  const payNeedsWalkInConfirm = client === null && !walkIn;
  /**
   * T85: the shelf Pay's whole handler, in one place because the nav
   * bar's Pay item taps it too. Both gates belong to the tap, not to the
   * button: T51's walk-in dialog and T53's opt-in ask before pay mode
   * opens, whichever control was tapped.
   */
  const payTap = useCallback(() => {
    if (payWhy !== null) return;
    if (payNeedsWalkInConfirm) {
      setWalkInPrompt(true);
      return;
    }
    if (payNeedsConsent) {
      openConsentPrompt();
      return;
    }
    enterPay();
  }, [
    payWhy,
    payNeedsWalkInConfirm,
    payNeedsConsent,
    openConsentPrompt,
    enterPay,
  ]);
  /* T85: what the nav bar needs, reported up. An effect after paint is
   * exactly what the T39.6 portal existed to avoid for the CHARGE
   * button, and it stays avoided: the charge is gated by `chargeable`
   * inside the render that computed it, in the payment column's foot.
   * This reports the nav item's enabled state and the tap it delegates
   * to, neither of which can move money by itself. */
  useEffect(() => {
    onNavState({ payWhy, charging, payTap });
  }, [onNavState, payWhy, charging, payTap]);

  if (!open) return null;

  const onFavorites = activeCat === FAVORITES_LABEL;
  const onPasses = activeCat === PASSES_SECTION;
  const onRetail = activeCat === RETAIL_SECTION;
  /** T76: the chosen retail child and its items; the General | Teacher
   *  sub-tabs render only when a TEACHER item is among them. */
  const retailChild =
    onRetail && activeChild !== null
      ? (retailCategories.find((c) => c.label === activeChild) ?? null)
      : null;
  const retailChildItems =
    catalog && retailChild ? categoryShelf(catalog, retailChild) : [];
  const teacherTabs = retailChildItems.some(isTeacherItem);
  /** What the grid shows, as blocks. Favorites is the starred items
   *  (bundles render after them); Passes is its children under kickers
   *  or one child alone (passSections); Retail is its categories under
   *  kickers or one category alone, filtered by the sub-tab when it has
   *  one; Rentals is its category. */
  const shelfSections: ShelfSection[] = onFavorites
    ? [{ label: null, items: starredItems, contracts: [] }]
    : onPasses && catalog
      ? passSections(catalog, passesShelf, passKids, activeChild)
      : onRetail && catalog
        ? retailChild
          ? [
              {
                label: null,
                items: teacherTabs
                  ? retailChildItems.filter(
                      (i) => isTeacherItem(i) === (retailTab === "teacher"),
                    )
                  : retailChildItems,
                contracts: [],
              },
            ]
          : retailCategories.map((c) => ({
              label: c.label,
              items: categoryShelf(catalog, c),
              contracts: [],
            }))
        : activeCat === RENTALS_SECTION && catalog && rentalsCategory
          ? [
              {
                label: null,
                items: categoryShelf(catalog, rentalsCategory),
                contracts: [],
              },
            ]
          : [];
  const shelfEmpty =
    shelfSections.every(
      (section) => section.items.length === 0 && section.contracts.length === 0,
    ) &&
    (!onFavorites || resolvedBundles.length === 0);

  /** T74: one shelf card, shared by every section of the grid. The
   *  markup is exactly the card the grid always drew; only its home
   *  moved, so a sectioned Passes shelf and a plain one draw the same
   *  thing. */
  const shelfCard = (item: ShelfItem) => {
    const key = itemKey(item.type, item.id);
    const starred = favSet.has(key);
    const count = inCart.get(key) ?? 0;
    return (
      <div
        className={count > 0 ? "shelf-cell has-qty" : "shelf-cell"}
        key={`${item.type}-${item.id}`}
      >
        <button
          className={count > 0 ? "shelf-item in-cart" : "shelf-item"}
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
        {/* T82: the quantity on the item itself (Pete: "Add + and - ...
            So a user can adjust quanityt in the cart or on the item
            itself"), the ticket's stepper along the card's bottom edge
            and only for a card the cart holds. Siblings of the add
            button, never inside it: nested buttons are invalid HTML and
            double-fire. The card's body still adds one, so the strip is
            the only way DOWN, and minus stops at one; removing the line
            is the ticket's X. */}
        {count > 0 ? (
          <div className="shelf-qty">
            <button
              className="shelf-qty-btn"
              disabled={count <= 1 || charging}
              aria-label={`One fewer ${item.name}`}
              title={`One fewer ${item.name}`}
              onClick={(e) => {
                e.stopPropagation();
                bumpQuantity(key, -1);
              }}
            >
              <MinusIcon />
            </button>
            <span className="shelf-qty-n" aria-live="polite">
              {count}
            </span>
            <button
              className="shelf-qty-btn"
              disabled={count >= MAX_LINE_QUANTITY || charging}
              aria-label={`One more ${item.name}`}
              title={`One more ${item.name}`}
              onClick={(e) => {
                e.stopPropagation();
                bumpQuantity(key, 1);
              }}
            >
              <PlusIcon />
            </button>
            {/* Pete: "the individual cards should also have a X to
                remove the item from the cart." */}
            <button
              className="shelf-qty-btn shelf-qty-x"
              disabled={charging}
              aria-label={`Remove ${item.name} from the sale`}
              title={`Remove ${item.name}`}
              onClick={(e) => {
                e.stopPropagation();
                removeLine(key);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}
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
  };

  /** T30: a contract is NOT a cart item; tapping its card opens the
   *  dedicated purchase dialog instead of ringing anything up. The card
   *  shows the recurring amount, the honest headline of an autopay.
   *  Since T76 it renders inside any Passes block (the Memberships
   *  child, or its kicker in the All view). */
  const contractCard = (c: ContractInfo) => (
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
            <span className="shelf-amt">{money(c.firstPaymentTotal)}</span>
          ) : (
            ""
          )}
        </span>
      </span>
    </button>
  );


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
  const inPay = saleMode === "pay";
  /** T39.4: the tax row's label carries the rate only when the server
   *  sent one (`/api/config`'s studioTaxRate, T38); never a literal. */
  const taxLabel =
    config?.studioTaxRate != null ? `Tax ${pct(config.studioTaxRate)}` : "Tax";
  /** T51: the Walk-in button carries the same reason Pay would, since
   *  declaring a walk-in with no house client to ride declares nothing
   *  Pay can use. The server's gate is unchanged (T41). */
  const walkInWhy =
    config?.houseClient === false
      ? "No house client for an anonymous sale; attach a client"
      : null;
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
                (l) => itemKey(l.item.type, l.item.id) === itemKey(a.type, a.metadataId),
              );
              const unmatched =
                a.theirPrice === null &&
                a.theirTaxRate === null &&
                a.theirQuantity === null;
              const priceOff =
                a.theirPrice !== null && a.theirPrice !== a.ourPrice;
              /* T75: the tax rate is shown for the record and never
                 marked bad; tax left the assertion (see
                 expectedSubtotal in src/lib/sale.ts). */
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
                      {"= "}
                      {money(a.ourExtended)} before tax
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
                        <span className="audit-sub">
                          {a.theirTaxRate !== null
                            ? `${pct(a.theirTaxRate)} tax`
                            : "tax not stated"}
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
  /** The stop's first sentence, the same in the ticket and above the
   *  figures. T79: a discount Mindbody priced differently names the two
   *  discount figures instead of the subtotals. */
  const disagreeText = (t: PricedResult): string =>
    t.discountDisagrees
      ? `The discount disagrees: ours ${money(t.expectedDiscount ?? 0)}, ` +
        `Mindbody's ${money(t.discountTotal ?? 0)}. Do not charge; this is ` +
        "a bug to report."
      : `Prices disagree before tax. The shelf says ${money(
          t.expectedSubtotal,
        )}, Mindbody says ${
          t.subTotal !== null ? money(t.subTotal) : "nothing"
        }. Do not charge; this is a bug to report.`;
  /** T79: the ticket's discount line, under Subtotal: "Comped" when the
   *  discount takes the whole subtotal, else "Discount (60%)", with
   *  Mindbody's DiscountTotal (which the check just proved equal to
   *  ours) as a negative figure. Nothing without an armed discount. */
  const discountRow = (t: PricedResult): ReactNode => {
    if (
      armedDiscount === null ||
      t.discountTotal === null ||
      t.discountTotal <= 0
    ) {
      return null;
    }
    const sub = t.subTotal ?? t.expectedSubtotal;
    const full = t.discountTotal >= sub;
    return (
      <div className="t-line t-discount">
        <span>
          {full
            ? "Comped"
            : `Discount (${discountPercentLabel(
                armedDiscount.discount,
                t.discountTotal,
                sub,
              )})`}
        </span>
        <span className="amt">-{money(t.discountTotal)}</span>
      </div>
    );
  };
  const payNotice: ReactNode =
    cart.length > 0 && !pricing && totals?.suppressed ? (
      <div className="pass-note t-suppressed">
        Suppressed (dry run or write guard): Mindbody did not price this
        cart, so there is no total to show. Nothing was written.
      </div>
    ) : cart.length > 0 && !pricing && totals?.disagrees ? (
      <div className="sale-stop">
        {disagreeText(totals)}
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
          {/* T85 (Pete: "'Buy' doesn't need to display on the buy page"):
              the title is gone. The nav bar's lit Buy item says which
              screen this is, from the same place on every screen, and the
              header's width goes to who the sale is for. */}

          {/* Who the sale is for, first in the header (Pete, fourth live
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
                    : `${money(attachedBalance)} on account`}
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
          ) : walkIn ? (
            /* T51: the declared walk-in wears the attached card's shape
               (Pete: "the display that normally shows a client name
               should say 'Walk-in sale'. the usual X can be there to
               cancel that and have the option to attach a client
               again"). The X clears the flag and the slot goes back to
               the two buttons. */
            <div className="sale-for attached sale-for-walkin">
              <span className="sale-for-who">
                <span className="sale-for-label">Sale for</span>
                <span className="sale-for-name">Walk-in sale</span>
              </span>
              <button
                className="row-icon sale-for-clear"
                aria-label="Cancel the walk-in sale"
                title="Cancel walk-in"
                /* Same lock as detach: no client change mid-charge. */
                disabled={charging}
                onClick={() => setWalkIn(false)}
              >
                <CloseIcon />
              </button>
            </div>
          ) : (
            /* T51: two buttons in the slot, Attach a client and Walk-in
               (Pete: "there should be a walk-in button next to the attach
               a client button"). The row takes the header's slack as the
               single card did. */
            <div className="sale-for-row">
              {/* A real button, not receipt text: the old dashed monospace
                  line was not recognizable as tappable in live testing,
                  which orphaned the whole attach flow (and with it stored
                  card and credit). Solid surface, icon, verb-first label. */}
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
                    for stored card or account balance
                  </span>
                </span>
              </button>
              <button
                className="sale-walkin"
                /* With no house client on the server a walk-in cannot
                   price or pay (T41), so the button is off with that
                   reason, the same words Pay would give. */
                disabled={charging || walkInWhy !== null}
                title={walkInWhy ?? "Sell to a walk-in with no client attached"}
                onClick={() => setWalkIn(true)}
              >
                Walk-in
              </button>
            </div>
          )}

          {/* T85: the header's Back is gone with the action bar's Back
              to items. Both were a move between screens, and every move
              between screens is the nav bar's now: Sign-in returns to the
              roster (the cart survives, as Back's did), Buy returns to
              the shelf. The mid-charge lock lives on the bar's items. */}
          {/* T70: the sun cell (Buy.dc.html), the one theme control on
              this screen; theme.ts stores the choice and sets the
              attribute the two palette blocks key on. */}
          {/* T75 (Pete: "add a refresh"; then "Refresh should not take
              up a slot. put a small refresh icon at the top right"): a
              64px icon cell in the header, left of the sun. It refetches
              the catalog past the server cache, the same recheckPrices
              the disagree stop uses, so cart lines are rebuilt from the
              fresh shelf too. */}
          <button
            className="sale-sun sale-refresh"
            type="button"
            disabled={rechecking}
            onClick={() => void recheckPrices()}
            aria-label="Refresh the catalog from Mindbody"
            title="Refresh the catalog from Mindbody"
          >
            {rechecking ? (
              <span className="spinner" aria-label="working" />
            ) : (
              <RefreshIcon />
            )}
          </button>
          <button
            className="sale-sun"
            type="button"
            onClick={() => toggleTheme()}
            aria-label="Switch between light and dark"
            title="Light / dark"
          >
            <SunIcon />
          </button>
        </div>

        <div className={inPay ? "sale-panes pay" : "sale-panes"}>
          {/* RAIL (T39.2, T76): the first column, a hierarchy. Favorites
              first; then Passes and Retail, sections that open on a tap
              (an accordion) to show their children as indented 48px
              cells, the section header itself being the All view; then
              Rentals, a leaf; and the T75 Refresh cell at the foot,
              sticky so it stays there when the rail scrolls. Only a cell
              with something to sell renders (T41). Under 1040px the CSS
              lays the top level out as a row and the open section's
              children as a second row of chips (the `order` rules and
              the break element). */}
          {catalog && !catalogLoading && !catalogError ? (
            <nav className="sale-cats" role="tablist" aria-label="Categories">
              <button
                role="tab"
                aria-selected={onFavorites}
                className={onFavorites ? "cat-chip on" : "cat-chip"}
                onClick={() => tapTop(FAVORITES_LABEL)}
              >
                {FAVORITES_LABEL}
              </button>
              {railSections.map((section) => {
                const isSection = section !== RENTALS_SECTION;
                const label =
                  section === RENTALS_SECTION
                    ? (rentalsCategory?.label ?? RENTALS_SECTION)
                    : section;
                const selected = activeCat === section && activeChild === null;
                const open = isSection && expanded === section;
                const kids =
                  section === PASSES_SECTION
                    ? passKids
                    : section === RETAIL_SECTION
                      ? retailCategories.map((c) => c.label)
                      : [];
                return (
                  <Fragment key={section}>
                    <button
                      role="tab"
                      aria-selected={selected}
                      aria-expanded={isSection ? open : undefined}
                      className={[
                        "cat-chip",
                        isSection ? "section" : "",
                        selected ? "on" : "",
                        open ? "open" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => tapTop(section)}
                    >
                      {label}
                      {isSection ? <ChevronIcon /> : null}
                    </button>
                    {open
                      ? kids.map((kid) => {
                          const on = activeCat === section && activeChild === kid;
                          return (
                            <button
                              key={kid}
                              role="tab"
                              aria-selected={on}
                              className={on ? "cat-chip child on" : "cat-chip child"}
                              onClick={() => tapChild(section, kid)}
                            >
                              {kid}
                            </button>
                          );
                        })
                      : null}
                  </Fragment>
                );
              })}
              {/* The line break before the children's row under 1040px;
                  nothing in the column layout. */}
              <span className="rail-break" aria-hidden="true" />
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
                {/* T76: the General | Teacher sub-tabs over a retail
                    child that carries TEACHER items (Food/Drink). The
                    T74 sub-chip idiom, 48px; no All, since General is
                    the default and hides the teacher stock. Rendered
                    outside the empty check so a tab is reachable even
                    when the other one is empty. */}
                {teacherTabs ? (
                  <div
                    className="shelf-subchips"
                    role="tablist"
                    aria-label="Who the stock is for"
                  >
                    {(["general", "teacher"] as const).map((tab) => (
                      <button
                        key={tab}
                        role="tab"
                        aria-selected={retailTab === tab}
                        className={retailTab === tab ? "sub-chip on" : "sub-chip"}
                        onClick={() => setRetailTab(tab)}
                      >
                        {tab === "general" ? "General" : "Teacher"}
                      </button>
                    ))}
                  </div>
                ) : null}
                {favNotice !== null ? (
                  <p className="muted fav-notice" role="status">
                    {favNotice}
                  </p>
                ) : null}
                {shelfEmpty ? (
                  <p className="muted">
                    {onFavorites
                      ? "Star items on any shelf, and configure bundles in src/lib/bundles.ts."
                      : activeCat === RENTALS_SECTION
                        ? "No rental came back from Mindbody. A rental is a pricing option or product named with Rental or Towel, or in the Towel and Mat category."
                        : "Nothing sellable in this category."}
                  </p>
                ) : (
                  <>
                    {shelfSections.map((section, index) => {
                      const grid = (
                        <div
                          className="shelf-grid"
                          key={section.label ?? "grid"}
                        >
                          {section.items.map(shelfCard)}
                          {section.contracts.map(contractCard)}
                          {/* Bundles, after the starred items. One card,
                              one tap, every line into the cart. Only the
                              Favorites shelf has any, and it is always a
                              single section, so they land in the grid
                              they always did. */}
                          {onFavorites && index === shelfSections.length - 1
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
                      );
                      /* An unlabelled section is the bare grid, so the
                         markup without groups is unchanged. A labelled
                         one carries its kicker: the roster head's 16px
                         uppercase muted idiom. A block with nothing in
                         it (a section's All view never has one, but a
                         child list can) draws nothing. */
                      if (section.items.length === 0 && section.contracts.length === 0) {
                        return null;
                      }
                      return section.label === null ? (
                        grid
                      ) : (
                        <section
                          className="shelf-section"
                          key={section.label}
                          aria-label={section.label}
                        >
                          <h3 className="shelf-kicker">{section.label}</h3>
                          {grid}
                        </section>
                      );
                    })}
                  </>
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
            ticketSlot={ticketSlot}
            notice={payNotice}
            onSold={() => {
              setCart([]);
              /* T51: the walk-in declaration was for the sale just made. */
              setWalkIn(false);
              /* T53: so was the gate's answer; the next sale asks again. */
              setConsentAskedFor(null);
            }}
            onDone={close}
            onStaffSessionEnded={() => onStaffSessionEnded?.()}
            onBusyChange={setCharging}
            onModalChange={setPayModalOpen}
            cartResetNonce={cartResetNonce}
            onClientDataStale={onClientDataStale}
            discount={armedDiscount}
            onDiscountChange={setArmedDiscount}
            receipt={receipt}
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
                  <>
                    <span className="t-more" aria-live="polite">
                      {hiddenBelow} more below
                    </span>
                    {/* T39.8: two facts, one separator; "2 more below 9
                        items" read as one phrase. */}
                    <span className="t-head-sep" aria-hidden="true">
                      &middot;
                    </span>
                  </>
                ) : null}
                <span className="t-head-count">
                  {cartCount} {cartCount === 1 ? "item" : "items"}
                </span>
              </span>
            </div>

            {cart.length === 0 ? (
              <div className="t-lines-wrap">
                <p className="t-empty">Nothing on the ticket yet. Tap an item.</p>
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
                {cart.map((line) => (
                  /* T82: every line carries its controls. The row is not
                     a tap target at all any more (it was a div with the
                     button role, because a <button> may not contain the
                     buttons the controls are), so nothing bubbles and
                     nothing needs stopping: the stepper changes the
                     quantity and the X removes the line, each on its own
                     44px square. In pay mode the row is read-only, as it
                     has been since T39.6. */
                  <div
                    className={
                      revealedKey === line.key && !inPay ? "t-row sel" : "t-row"
                    }
                    key={line.key}
                  >
                    <div
                      className="t-row-main"
                      role={inPay ? undefined : "button"}
                      tabIndex={inPay ? undefined : 0}
                      aria-expanded={inPay ? undefined : revealedKey === line.key}
                      aria-label={inPay ? undefined : `${line.item.name}, tap for quantity and remove`}
                      onClick={() =>
                        inPay
                          ? undefined
                          : setRevealedKey((k) => (k === line.key ? null : line.key))
                      }
                      onKeyDown={(e) => {
                        if (inPay) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setRevealedKey((k) => (k === line.key ? null : line.key));
                        }
                      }}
                    >
                      <div className="t-line">
                        {/* T90 (Pete: "Item says client's name : Drop In
                            (Alison Stewart)"), and "the price should be
                            further to the right in the line item,
                            hopefully that makes room for the name": the
                            X slot at the row's right edge is gone, so
                            the figure is flush right and the name column
                            takes the rest, ellipsized with its full text
                            on the title. The name is the item's weight,
                            never bold. */}
                        <span className="t-name" title={lineLabel(line)}>
                          {lineLabel(line)}
                        </span>
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
                      {inPay || revealedKey !== line.key ? null : (
                        <div className="t-ctl" onClick={(e) => e.stopPropagation()}>
                          {/* T90 (Pete: "instead of - 1 + X, the options
                              are - 1 + Other Client. a - when there is a
                              1 is an X and removes the item"): one
                              control fewer, and the minus IS the remove
                              at quantity one. The glyph changes with it,
                              so nothing says "one fewer" while it means
                              "gone". */}
                          <button
                            className={
                              line.quantity <= 1 ? "t-ctl-btn t-ctl-x" : "t-ctl-btn"
                            }
                            disabled={charging}
                            aria-label={
                              line.quantity <= 1
                                ? `Remove ${lineLabel(line)}`
                                : `One fewer ${line.item.name}`
                            }
                            title={
                              line.quantity <= 1
                                ? `Remove ${lineLabel(line)}`
                                : `One fewer ${line.item.name}`
                            }
                            onClick={() =>
                              line.quantity <= 1
                                ? removeLine(line.key)
                                : bumpQuantity(line.key, -1)
                            }
                          >
                            {line.quantity <= 1 ? <CloseIcon /> : <MinusIcon />}
                          </button>
                          <span className="t-ctl-qty" aria-live="polite">
                            {line.quantity}
                          </span>
                          <button
                            className="t-ctl-btn"
                            disabled={line.quantity >= MAX_LINE_QUANTITY || charging}
                            aria-label={`One more ${line.item.name}`}
                            title={`One more ${line.item.name}`}
                            onClick={() => bumpQuantity(line.key, 1)}
                          >
                            <PlusIcon />
                          </button>
                          {/* The recipient control: text, not a filled
                              button, and it opens the SAME live search
                              the attach modal uses ("Who is this for?").
                              Re-tapping opens it again with the row that
                              clears it. */}
                          <button
                            className={line.forClient ? "t-for on" : "t-for"}
                            disabled={charging}
                            aria-label={
                              line.forClient
                                ? `Bought for ${line.forClient.name}. Change who this is for`
                                : `Buy ${line.item.name} for another client`
                            }
                            title={
                              line.forClient
                                ? `Bought for ${line.forClient.name}`
                                : "Buy this for another client"
                            }
                            onClick={() =>
                              onRequestRecipient?.(
                                line.key,
                                line.forClient ? true : false,
                              )
                            }
                          >
                            {line.forClient ? line.forClient.name : "Other Client"}
                          </button>
                        </div>
                      )}
                    </div>
                    {/* T82's own X square is gone (T90): removing is
                        the minus at quantity one, which is one control
                        fewer on the row and the slot the price needed to
                        sit further right. One tap, no confirm, as it was:
                        the line is one tap to put back, and Empty cart
                        keeps the confirm because it destroys the whole
                        ticket. */}
                  </div>
                ))}
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
                    {/* No spinner while Mindbody prices (Pete: "they are
                        supposed to be optimistically added and then
                        handled async"): the lines and the Estimated
                        total above are the answer until the server's
                        figures replace them. */}
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
                    {/* T41: one honest line. The server answered
                        needsClient because POS_HOUSE_CLIENT_ID is unset
                        (with it set, an unattached cart prices and pays
                        as cash or comp like any other); the config flag
                        says the same thing before any pricing call. */}
                    <p className="muted-note">{NEEDS_HOUSE_CLIENT_LINE}</p>
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
                        {disagreeText(totals)}
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
                    {/* T79: the discount, between Subtotal and tax, as
                        Mindbody priced it. */}
                    {discountRow(totals)}
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
                {/* T70: the tender lines' slot (Payment.dc.html). The
                    panel fills it in pay mode through a portal; empty in
                    shelf mode. */}
                <span className="t-tender-slot" ref={setTicketSlot} />
                </div>
              </>
            )}
              </div>
            {/* T85: the bar's two shelf controls, now the cart column's
                foot: Pay under Empty cart, both the width of the column,
                outside the ticket's own scroll so neither can be scrolled
                out of reach. In pay mode the payment column's foot
                carries the primary instead, so this one is not rendered:
                two Pay buttons on one screen is the ambiguity the nav bar
                exists to end. */}
            {inPay ? null : (
              <div className="t-foot">
                {/* T51's Empty cart, behind T38's confirm exactly. */}
                <button
                  className="t-foot-empty"
                  disabled={cart.length === 0 || charging}
                  onClick={() => setClearPrompt(cartCount)}
                >
                  Empty cart
                </button>
                {/* T82: the word only, no count and no amount (Pete, of
                    its pay-mode twin: "No need for it to contain the
                    total items and dollar amount"; the two controls are
                    read as one pair and the ticket above carries both
                    figures already). The count and the total stay in the
                    ticket's head and totals, and the title still says
                    the amount or why the tap is refused. The pricing
                    spinner stays: it is the one thing the ticket cannot
                    say in the foot's place. */}
                <button
                  className={payWhy === null ? "t-foot-pay" : "t-foot-pay off"}
                  aria-disabled={payWhy !== null}
                  title={payWhy ?? `Pay ${money(payAmount ?? 0)}`}
                  onClick={payTap}
                >
                  <span>Pay</span>
                </button>
              </div>
            )}
          </div>
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
          onStaffSessionEnded={() => onStaffSessionEnded?.()}
          modalAbove={modalAbove}
        />
      ) : null}

      {cartPrompt ? (
        <div className="modal-scrim" role="presentation" onClick={keepCart}>
          <div
            className="modal modal-sale"
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

      {/* T51: the friction on Pay with nobody attached and no walk-in
          declared. The house confirm shape with the modal-x, since a
          dismissal here is an ordinary "not that": scrim, X and Escape
          leave the sale in shelf mode with nothing declared. Attach a
          client opens the same attach modal the header button does;
          Continue declares the walk-in and enters pay mode. */}
      {walkInPrompt ? (
        <div
          className="modal-scrim"
          role="presentation"
          onClick={cancelWalkInPrompt}
        >
          <div
            className="modal modal-sale modal-walkin"
            role="dialog"
            aria-modal="true"
            aria-label="No client attached"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="row-icon modal-x"
              aria-label="Close"
              onClick={cancelWalkInPrompt}
            >
              <CloseIcon />
            </button>
            <p className="modal-title">No client attached</p>
            <p className="modal-note">
              This will be recorded as a walk-in sale under the studio&apos;s
              walk-in account. Attach a client if you know who this is.
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => {
                  setWalkInPrompt(false);
                  onRequestAttach();
                }}
              >
                Attach a client
              </button>
              <button
                className="modal-confirm go"
                onClick={() => {
                  setWalkInPrompt(false);
                  setWalkIn(true);
                  enterPay();
                }}
              >
                Continue as walk-in
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* T53: the opt-in gate, the walk-in dialog's shape. While the
          record is still being read it says so and waits; once read, an
          opted-in client never sees it (the effect above waves them
          through). Scrim, X and Escape dismiss without answering. */}
      {consentPrompt && client !== null ? (
        <div
          className="modal-scrim"
          role="presentation"
          onClick={consentBusy ? undefined : cancelConsentPrompt}
        >
          <div
            className="modal modal-sale modal-consent"
            role="dialog"
            aria-modal="true"
            aria-label="Email receipt?"
            aria-busy={consentBusy || !lookupLanded}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="row-icon modal-x"
              aria-label="Close"
              disabled={consentBusy}
              onClick={cancelConsentPrompt}
            >
              <CloseIcon />
            </button>
            <p className="modal-title">Email receipt?</p>
            {!lookupLanded ? (
              <p className="modal-note">
                <span className="spinner" aria-label="working" /> Reading{" "}
                {client.name}&apos;s email settings...
              </p>
            ) : (
              <>
                <p className="modal-note consent-who">
                  <span className="consent-name">{client.name}</span>
                  {clientLookup.email ? (
                    <span className="consent-email">{clientLookup.email}</span>
                  ) : (
                    <span className="consent-email consent-none">
                      No email on file
                    </span>
                  )}
                </p>
                {!clientLookup.email ? (
                  <p className="consent-hint">
                    Add an email to their profile in Mindbody first; the
                    receipt has nowhere to go without one.
                  </p>
                ) : null}
                <div className="consent-opts">
                  <label
                    className={
                      clientLookup.email ? "consent-opt" : "consent-opt off"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={consentAccount && Boolean(clientLookup.email)}
                      disabled={!clientLookup.email || consentBusy}
                      onChange={(e) => setConsentAccount(e.target.checked)}
                    />
                    <span>Send receipts and account emails</span>
                  </label>
                  <label className="consent-opt">
                    <input
                      type="checkbox"
                      checked={consentPromo}
                      disabled={consentBusy}
                      onChange={(e) => setConsentPromo(e.target.checked)}
                    />
                    <span>Send studio news and offers</span>
                  </label>
                </div>
                {consentError ? (
                  <div className="sale-stop consent-error" role="alert">
                    Could not save the opt-in: {consentError}
                  </div>
                ) : null}
                <div className="modal-actions">
                  <button
                    className="modal-cancel"
                    disabled={consentBusy}
                    onClick={skipConsent}
                  >
                    {consentError ? "Continue without" : "Not now"}
                  </button>
                  <button
                    className="modal-confirm go"
                    disabled={consentBusy}
                    onClick={() => void saveConsent()}
                  >
                    {consentBusy ? (
                      <span className="spinner" aria-label="saving" />
                    ) : consentError ? (
                      "Try again"
                    ) : (
                      "Save and continue"
                    )}
                  </button>
                </div>
              </>
            )}
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
            className="modal modal-sale"
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
