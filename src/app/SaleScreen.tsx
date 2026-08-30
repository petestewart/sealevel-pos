"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

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

type PayMethod = "storedcard" | "credit" | "cash" | "comp";

/** The methods a T28 split leg may use: the whitelist minus comp. */
type SplitMethod = "storedcard" | "credit" | "cash";

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
 * column: the compact method row above the receipt, the receipt itself
 * (passed in, so the cart and pricing loop stay outside the seam), the
 * charge button, the outcome panel, and the cash-tender modal. The
 * invariants inherited from T23 are kept verbatim: never charge an
 * empty, in-flight, suppressed, or disagreeing cart; the button restates
 * the server's number or none. On top of them: nothing fires without an
 * explicit tap, one charge can be in flight at a time (ref-guarded,
 * button disabled), and a failed or ambiguous outcome renders with
 * enough truth that re-tapping cannot quietly double-charge.
 */
function PaymentPanel(props: {
  cart: readonly CartEntry[];
  priced: PricedResult | null;
  pricing: boolean;
  client: SaleClient | null;
  cardLookup: CardLookup | null;
  /** The receipt ticket, rendered between the method row and the charge
   *  button. SaleScreen still owns the cart and the pricing loop. */
  receipt: ReactNode;
  /** Clear the cart: the sale is recorded on Mindbody's side. */
  onSold: () => void;
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
  /** Mirrors the cash-tender modal up to SaleScreen so the Escape that
   *  closes the modal cannot also close the overlay. */
  onModalChange: (open: boolean) => void;
  /** Bumped by SaleScreen when "Empty cart" is confirmed on a client
   *  change (third live test): the cart is gone, so any armed method
   *  goes with it. The clientId disarm below already cleared tender and
   *  the client-bound methods; this catches cash/comp, which a client
   *  change deliberately leaves armed when the cart is KEPT. */
  cartResetNonce: number;
}) {
  const {
    cart,
    priced,
    pricing,
    client,
    cardLookup,
    receipt,
    onSold,
    onClientDataStale,
    onBusyChange,
    onModalChange,
    cartResetNonce,
  } = props;

  const [method, setMethod] = useState<PayMethod | null>(null);
  /**
   * T28 split mode: pay one sale with TWO methods, one Charge, one
   * server call. Slot A's amount is typed (dollars text); slot B's is
   * the server total minus A, computed and read-only, so the two can
   * only ever sum to the rehearsed total. Comp is excluded (it has its
   * own hold gesture); cash is fine -- in a split the cash leg's amount
   * IS what is collected, so the tender modal never opens here.
   */
  const [splitOn, setSplitOn] = useState(false);
  /** Slot A's dollars, as typed ("30" or "30.00"). Kept as text so a
   *  trailing dot mid-entry does not fight the keyboard. */
  const [splitA, setSplitA] = useState("");
  const [splitAMethod, setSplitAMethod] = useState<SplitMethod | null>(null);
  const [splitBMethod, setSplitBMethod] = useState<SplitMethod | null>(null);
  /** Tendered cash in CENTS, as a digit string (POS-style entry: typing
   *  2-0-0-0 reads $20.00). Display only; never sent to Mindbody. */
  const [tendered, setTendered] = useState("");
  /** The cash-tender modal (second live test: the inline keypad panel is
   *  gone). Opens on selecting Cash, and again from the Charge button
   *  when cash is armed with no tender recorded; its confirm fires the
   *  SAME charge path the Charge button does. */
  const [cashOpen, setCashOpen] = useState(false);
  const [charging, setCharging] = useState(false);
  const [result, setResult] = useState<ChargeResult | null>(null);
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

  /* ANY client change -- detach, attach, or the per-row Buy button
   * switching straight from one client to another -- invalidates the
   * client-bound methods and the balance: a method armed for client A
   * must not stay armed for client B (whose card or credit may not even
   * exist; the server would refuse, but the button must not offer it).
   * A recorded cash tender is against the OLD client's total, so it goes
   * too: with none recorded, the Charge button reopens the modal. */
  const clientId = client?.id ?? null;

  /** Blank the split slots (amount and both methods). Split MODE stays
   *  where it was; only the choices inside it reset. */
  const resetSplitSlots = useCallback(() => {
    setSplitA("");
    setSplitAMethod(null);
    setSplitBMethod(null);
  }, []);

  useEffect(() => {
    setFreshBalance(null);
    setTendered("");
    setMethod((m) => (m === "storedcard" || m === "credit" ? null : m));
    /* Split slots were chosen against the OLD client's card, credit and
     * total; none of it survives a switch. */
    resetSplitSlots();
  }, [clientId, resetSplitSlots]);

  /* A cart EDIT retires a stale receipt; warnings stay until dismissed.
   * The empty cart is skipped deliberately: a successful charge clears the
   * cart in the same commit that sets the receipt, and this effect firing
   * on that clear would wipe the receipt before the teacher saw it (the
   * charge's own success path already cleared the tender).
   *
   * The recorded cash tender goes with the edit too: it was entered
   * against the OLD cart's total in the modal, and if it happened to
   * cover the NEW total the Charge button would record the cash without
   * ever reopening the modal. Cleared, the button reopens it. */
  useEffect(() => {
    if (cart.length === 0) return;
    setResult((r) => (r?.kind === "paid" ? null : r));
    setTendered("");
    /* Split slot A was typed against the OLD cart's total; a new total
     * makes it stale exactly like a recorded tender. */
    resetSplitSlots();
  }, [cart, resetSplitSlots]);

  /* "Empty cart" on the client-change dialog: the cart SaleScreen just
   * cleared was what the armed method was for, so nothing stays armed.
   * Tender is already gone via the clientId disarm above (a dialog only
   * ever follows a client change); setting it again here is harmless and
   * keeps this reset whole on its own. */
  useEffect(() => {
    if (cartResetNonce === 0) return;
    setMethod(null);
    setTendered("");
    resetSplitSlots();
  }, [cartResetNonce, resetSplitSlots]);

  /* Rule 1: when credit covers the total, the card is not offered -- so a
   * stored-card selection made before the balance (or a fresh total) was
   * known cannot stay armed. The server refuses it too. */
  useEffect(() => {
    if (balanceCoversTotal) {
      setMethod((m) => (m === "storedcard" ? null : m));
    }
  }, [balanceCoversTotal]);

  useEffect(() => {
    return () => {
      if (compTimer.current) clearTimeout(compTimer.current);
    };
  }, []);

  /* PaymentPanel unmounts when the overlay closes; a cash modal that
   * was somehow up must not leave SaleScreen believing a modal still
   * blocks Escape on the next open. */
  useEffect(() => {
    return () => onModalChange(false);
  }, [onModalChange]);

  /* Method availability. Unavailable methods render greyed WITH the
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
  const cardReasonFinal =
    cardReason ??
    /* Rule 1 of the $10 minimum: when credit covers the total, credit IS
     * the method and the card is not offered. /api/checkout refuses it
     * server-side too; this grey-out is the honest face of that. */
    (balanceCoversTotal ? `Credit covers this (${money(balance as number)})` : null);
  const cardDetail = card && !card.expired ? `Card ...${card.lastFour}` : null;

  const creditReason = !client
    ? "Attach a client"
    : balance === null || balance <= 0
      ? "No credit on account"
      : total !== null && balance < total
        ? `Only ${money(balance)} on account`
        : null;
  const creditLabel =
    balance !== null && balance > 0
      ? `Account credit (${money(balance)})`
      : "Account credit";

  const tenderedCents = tendered === "" ? null : parseInt(tendered, 10);
  const tenderedUsd = tenderedCents === null ? null : tenderedCents / 100;
  const cashShort =
    method === "cash" &&
    total !== null &&
    tenderedUsd !== null &&
    tenderedUsd < total;

  /* ------------------------- T28: split math ------------------------ */
  /* All in integer cents so the two legs can only ever sum exactly. */
  const totalCents = total === null ? null : Math.round(total * 100);
  const splitACents = (() => {
    if (splitA.trim() === "") return null;
    const n = Number(splitA);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 100);
  })();
  /* Slot A must sit strictly INSIDE (0, total): a leg equal to the total
   * is not a split, and the remainder must stay positive. */
  const splitAInRange =
    totalCents !== null &&
    splitACents !== null &&
    splitACents > 0 &&
    splitACents < totalCents;
  const splitBCents =
    splitAInRange && totalCents !== null && splitACents !== null
      ? totalCents - splitACents
      : null;
  const splitAUsd = splitAInRange && splitACents !== null ? splitACents / 100 : null;
  const splitBUsd = splitBCents !== null ? splitBCents / 100 : null;

  /* Per-leg availability under T24's rules. The base reasons reuse the
   * single-method gates, EXCEPT rule 1 (credit covers the total refuses
   * the card): a deliberate split is not the ambiguity that rule guards
   * against, so `cardReason` (not cardReasonFinal) gates the card here.
   * The server applies the same reading. */
  const splitCreditBase = !client
    ? "Attach a client"
    : balance === null || balance <= 0
      ? "No credit on account"
      : null;
  const splitCardLegUsd =
    splitAMethod === "storedcard"
      ? splitAUsd
      : splitBMethod === "storedcard"
        ? splitBUsd
        : null;
  const splitCreditLegUsd =
    splitAMethod === "credit"
      ? splitAUsd
      : splitBMethod === "credit"
        ? splitBUsd
        : null;
  /* The card minimum applies to the CARD LEG's amount; the server
   * refuses it too, with no credit-purchase dance in a split. */
  const splitCardUnderMin =
    splitCardLegUsd !== null && splitCardLegUsd < CARD_MINIMUM_USD;
  const splitCreditShort =
    splitCreditLegUsd !== null &&
    (balance === null || balance < splitCreditLegUsd);

  const splitReady =
    splitOn &&
    splitAInRange &&
    splitAUsd !== null &&
    splitBUsd !== null &&
    splitAMethod !== null &&
    splitBMethod !== null &&
    splitAMethod !== splitBMethod &&
    !splitCardUnderMin &&
    !splitCreditShort &&
    (splitAMethod !== "storedcard" && splitBMethod !== "storedcard"
      ? true
      : cardReason === null) &&
    (splitAMethod !== "credit" && splitBMethod !== "credit"
      ? true
      : splitCreditBase === null);

  const chargeable =
    cart.length > 0 &&
    !pricing &&
    total !== null &&
    !charging &&
    (splitOn ? splitReady : method !== null && !cashShort);

  /** One leg of the split, as the Charge button restates it. The cash
   *  leg reads "collect $X cash": in split mode there is no tender
   *  modal, the leg amount IS what is collected. */
  const splitLegLabel = (m: SplitMethod, usd: number) =>
    m === "storedcard"
      ? `${money(usd)} card`
      : m === "credit"
        ? `${money(usd)} credit`
        : `collect ${money(usd)} cash`;

  const chargeLabel = splitOn
    ? splitReady &&
      splitAMethod !== null &&
      splitBMethod !== null &&
      splitAUsd !== null &&
      splitBUsd !== null
      ? `Charge ${splitLegLabel(splitAMethod, splitAUsd)} + ${splitLegLabel(splitBMethod, splitBUsd)}`
      : "Charge"
    : total === null
      ? "Charge"
      : method === "cash"
        ? `Record ${money(total)} cash`
        : method === "comp"
          ? `Comp ${money(total)}`
          : `Charge ${money(total)}`;

  const doCharge = async () => {
    /* Single flight: the ref refuses a second tap even in the same
     * render tick, and the button is disabled for every later one. */
    if (inFlight.current || !chargeable) return;
    /* The one payment instruction this tap sends: the split legs (in
     * the teacher's order, amounts only -- the server re-rehearses and
     * charges only if they sum to ITS total), or the single method. */
    const splitBody =
      splitOn &&
      splitAMethod !== null &&
      splitBMethod !== null &&
      splitAUsd !== null &&
      splitBUsd !== null
        ? {
            split: {
              legs: [
                { method: splitAMethod, amount: splitAUsd },
                { method: splitBMethod, amount: splitBUsd },
              ],
            },
          }
        : null;
    if (splitOn ? splitBody === null : method === null) return;
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
          ...(splitBody ?? {
            method,
            ...(method === "cash" && tenderedUsd !== null
              ? { cashTendered: tenderedUsd }
              : {}),
          }),
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
        const legDesc = (m: SplitMethod, usd: number) =>
          m === "storedcard"
            ? `${money(usd)} on the stored card${card ? ` ...${card.lastFour}` : ""}`
            : m === "credit"
              ? `${money(usd)} account credit`
              : `${money(usd)} cash`;
        const methodName = splitBody
          ? splitBody.split.legs
              .map((leg) => legDesc(leg.method, leg.amount))
              .join(" + ")
          : method === "storedcard"
            ? `stored card${card ? ` ...${card.lastFour}` : ""}`
            : method === "credit"
              ? "account credit"
              : String(method);
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
        setMethod(null);
        setTendered("");
        /* A completed split is over: slots blank and the toggle drops
         * back to single, the screen's resting state. */
        resetSplitSlots();
        setSplitOn(false);
      } else if (res.ok && body?.suppressed) {
        setResult({ kind: "suppressed", mode: String(body.suppressed) });
      } else if (body?.stage === "checkout-after-credit") {
        /* THE seam, rendered verbatim and prominent: the credit exists,
         * the sale does not, and the credit step must not run again. The
         * method is DESELECTED so a bare re-tap of Charge is impossible,
         * and the fresh balance lets Account credit light up: the honest
         * retry is spending the credit that now exists, never re-buying
         * it, so there is no retry affordance on the credit step. */
        setMethod(null);
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

  const pickMethod = (m: PayMethod) => {
    setMethod((cur) => (cur === m ? null : m));
    setResult((r) => (r && r.kind !== "paid" ? r : null));
  };

  /** The Split toggle. Entering or leaving split mode is a fresh start
   *  for the whole payment choice: the single method (comp included) and
   *  any recorded tender disarm, and the slots reset. An amount or
   *  method chosen in one mode never survives into the other. */
  const toggleSplit = () => {
    setSplitOn((v) => !v);
    setMethod(null);
    setTendered("");
    resetSplitSlots();
    setResult((r) => (r && r.kind !== "paid" ? r : null));
  };

  /** One slot's compact method picker. Availability follows T24's rules
   *  (greyed with the reason on the title, never hidden); the method the
   *  OTHER slot holds is greyed too, since a split's legs must differ. */
  const renderSlotMethods = (slot: "A" | "B") => {
    const mine = slot === "A" ? splitAMethod : splitBMethod;
    const other = slot === "A" ? splitBMethod : splitAMethod;
    const set = slot === "A" ? setSplitAMethod : setSplitBMethod;
    const options: { m: SplitMethod; label: string; reason: string | null }[] =
      [
        /* cardReason, not cardReasonFinal: rule 1 (credit covers the
         * total refuses the card) does not apply to a deliberate split;
         * the server takes the same reading. */
        { m: "storedcard", label: "Card", reason: cardReason },
        { m: "credit", label: "Credit", reason: splitCreditBase },
        { m: "cash", label: "Cash", reason: null },
      ];
    return options.map(({ m, label, reason }) => {
      const taken = other === m;
      return (
        <button
          key={m}
          className={mine === m ? "split-m on" : "split-m"}
          disabled={charging || reason !== null || taken}
          aria-pressed={mine === m}
          title={reason ?? (taken ? "Used by the other part" : label)}
          onClick={() => set((cur) => (cur === m ? null : m))}
        >
          {label}
        </button>
      );
    });
  };

  /* Comp arms on a HOLD, not a tap: it hands goods over for nothing, so
   * it cannot sit where a fat finger lands. Unselecting is a plain tap
   * (the click handler below); the ref swallows the click the browser
   * fires at the END of a completed hold so arming and disarming cannot
   * happen in the same gesture. */
  const compHeld = useRef(false);
  const compHoldStart = () => {
    if (compTimer.current) clearTimeout(compTimer.current);
    compTimer.current = setTimeout(() => {
      compTimer.current = null;
      compHeld.current = true;
      pickMethod("comp");
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
    /* A bare tap never ARMS comp; it only disarms an armed one. */
    if (method === "comp") pickMethod("comp");
  };

  const keypadTap = (key: string) => {
    setTendered((cur) => {
      if (key === "back") return cur.slice(0, -1);
      if (key === "clear") return "";
      const next = (cur + key).replace(/^0+(?=\d)/, "");
      return next.length > 7 ? cur : next;
    });
  };

  const openCashModal = () => {
    setCashOpen(true);
    onModalChange(true);
  };
  /** Cancelling clears the tender too: with none recorded, the Charge
   *  button reopens this modal rather than charging directly. */
  const closeCashModal = useCallback(() => {
    setCashOpen(false);
    setTendered("");
    onModalChange(false);
  }, [onModalChange]);
  /** The confirm: close the modal and fire the ONE charge path. The
   *  tendered amount stays as entered (it rides the request for the
   *  server-side short-tender refusal); the outcome renders where every
   *  charge outcome renders, under the receipt. */
  const confirmCash = () => {
    setCashOpen(false);
    onModalChange(false);
    void doCharge();
  };

  /* Escape closes the cash modal (never mid-charge). SaleScreen skips
   * its own overlay-close for the same press via onModalChange. */
  useEffect(() => {
    if (!cashOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !charging) closeCashModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cashOpen, charging, closeCashModal]);

  /* The shared quiet line under the method row (the per-card subtitle is
   * gone with the compact buttons): the selected method's detail, else
   * the first unavailable method's reason. The full reason also sits on
   * each button's title attr. */
  const methodNote = splitOn
    ? splitCardUnderMin
      ? `The card leg is under the $${CARD_MINIMUM_USD} card minimum`
      : splitCreditShort
        ? `Only ${balance !== null ? money(balance) : "$0.00"} on account for the credit leg`
        : splitA.trim() !== "" && total !== null && !splitAInRange
          ? "The first amount must be more than $0.00 and less than the total"
          : splitAMethod === null || splitBMethod === null
            ? "Two parts, two methods. Pick one for each."
            : ""
    : method === "storedcard"
      ? (cardDetail ?? "")
      : method === "credit"
        ? creditLabel
        : method === "cash"
          ? tenderedUsd !== null
            ? `Tendered ${money(tenderedUsd)}`
            : ""
          : method === "comp"
            ? ""
            : cardReasonFinal !== null
              ? `Stored card: ${cardReasonFinal}`
              : creditReason !== null
                ? `Credit: ${creditReason}`
                : "";

  return (
    <div className="sale-left">
      {/* Who the sale is for lives in the screen header now (Pete, fourth
          live test: it is identity, not a payment control, and the column
          is the scarcer real estate). The method row it gates is first
          here. */}

      {/* The method row, compact and ABOVE the receipt (second live
          test): three 64px segmented buttons, icon + label, no subtitle
          line. Unavailable stays visible-but-greyed; the reason moves to
          the title attr and the shared quiet line below. */}
      <div>
        <div className="methods" aria-label="Payment methods">
          {!splitOn ? (
          <>
          <button
            className={method === "storedcard" ? "method on" : "method"}
            disabled={cardReasonFinal !== null || charging}
            onClick={() => pickMethod("storedcard")}
            aria-pressed={method === "storedcard"}
            title={cardReasonFinal ?? cardDetail ?? "Stored card"}
          >
            <span className="mi">
              <CardIcon />
            </span>
            Stored card
          </button>
          <button
            className={method === "credit" ? "method on" : "method"}
            disabled={creditReason !== null || charging}
            onClick={() => pickMethod("credit")}
            aria-pressed={method === "credit"}
            title={creditReason ?? creditLabel}
          >
            <span className="mi">
              <CreditIcon />
            </span>
            Credit
          </button>
          <button
            className={method === "cash" ? "method on" : "method"}
            disabled={charging}
            onClick={() => {
              const selecting = method !== "cash";
              pickMethod("cash");
              /* Selecting cash opens the tender modal; a deselecting tap
                 does not. */
              if (selecting) openCashModal();
            }}
            aria-pressed={method === "cash"}
            title="Cash"
          >
            <span className="mi">
              <CashIcon />
            </span>
            Cash
          </button>
          </>
          ) : null}
          {/* T28: the quiet Split toggle. In split mode it is the only
              thing left in this row; the two slots below replace the
              single-method buttons. */}
          <button
            className={splitOn ? "split-toggle on" : "split-toggle"}
            disabled={charging}
            onClick={toggleSplit}
            aria-pressed={splitOn}
            title={
              splitOn ? "Back to one payment method" : "Pay with two methods"
            }
          >
            Split
          </button>
        </div>

        {splitOn ? (
          <div className="split-slots" aria-label="Split payment">
            <div className="split-slot">
              <label className="split-amt-row">
                <span>First part</span>
                <input
                  className="split-amt"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={splitA}
                  disabled={charging}
                  aria-label="First part amount in dollars"
                  onChange={(e) => {
                    /* Dollars and cents only; anything else never lands
                       in the state. */
                    const v = e.target.value;
                    if (/^\d{0,5}(\.\d{0,2})?$/.test(v)) setSplitA(v);
                  }}
                />
              </label>
              <div
                className="split-methods"
                role="group"
                aria-label="First part method"
              >
                {renderSlotMethods("A")}
              </div>
            </div>
            <div className="split-slot">
              <div className="split-amt-row">
                <span>Remainder</span>
                {/* Computed, read-only: the server total minus part one,
                    so the legs can only ever sum to the rehearsed
                    total. */}
                <span className="split-rest-amt">
                  {splitBUsd !== null ? money(splitBUsd) : "--"}
                </span>
              </div>
              <div
                className="split-methods"
                role="group"
                aria-label="Remainder method"
              >
                {renderSlotMethods("B")}
              </div>
            </div>
          </div>
        ) : null}
        <p className="methods-note">{methodNote || " "}</p>
      </div>

      {/* The receipt ticket; it may scroll internally, so the charge
          button below stays on screen for a long cart. */}
      {receipt}

      <div className="pay-seam">
      {/* Comp: deliberately out of the method row and armed by holding,
          so nobody comps a sale by grazing a card. */}
      <button
        className={method === "comp" ? "comp-hold on" : "comp-hold"}
        /* Comp is a whole-sale gesture and is excluded from splits; while
           split mode is armed the hold is off rather than fighting it. */
        disabled={charging || splitOn}
        title={splitOn ? "Not available in a split" : undefined}
        onPointerDown={compHoldStart}
        onPointerUp={compHoldEnd}
        onPointerLeave={compHoldAbort}
        onPointerCancel={compHoldAbort}
        onClick={compClick}
        onContextMenu={(e) => e.preventDefault()}
        aria-pressed={method === "comp"}
      >
        {method === "comp"
          ? "Comp selected. Tap to unselect."
          : "Hold to comp this sale"}
      </button>

      <button
        className="charge-btn"
        disabled={!chargeable}
        onClick={() => {
          /* Cash armed with no tender recorded: the tap opens the tender
             modal (whose confirm fires this same path) instead of
             charging directly. Split mode never opens it: a split's cash
             leg needs no tender math, its amount IS what is collected
             (the label says "collect $X cash"). */
          if (!splitOn && method === "cash" && tenderedCents === null) {
            openCashModal();
            return;
          }
          void doCharge();
        }}
        aria-label={chargeLabel}
      >
        {charging ? (
          <>
            <span className="spinner" aria-label="working" /> Charging...
          </>
        ) : (
          chargeLabel
        )}
      </button>

      {/* Bug-1 branch (b): no client, no house client, so Mindbody could
          not price the cart and there is no total to charge. The local
          estimate on the ticket is never chargeable. */}
      {cart.length > 0 && !pricing && priced?.needsClient ? (
        <p className="muted-note">
          Attach a client (or set a house client) to charge.
        </p>
      ) : null}

      {result?.kind === "paid" ? (
        <div className="pay-done" role="status">
          <p className="pay-done-line">{result.summary}</p>
          {result.detail ? (
            <p className="pay-done-detail">{result.detail}</p>
          ) : null}
          <button className="class-change" onClick={() => setResult(null)}>
            Done
          </button>
        </div>
      ) : result?.kind === "suppressed" ? (
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
          The charge may or may not have gone through. Check the dev drawer
          or Mindbody before charging again.
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
      </div>

      {/* The cash-tender modal (second live test: the inline panel read
          as part of the form; a modal is the deliberate step it is).
          Keypad and chips are display-only change math; the confirm is
          the SAME charge path as the Charge button, single-flight and
          all, and the outcome renders under the receipt like every
          other charge outcome. The server still refuses a short tender. */}
      {cashOpen ? (
        <div
          className="modal-scrim"
          role="presentation"
          onClick={() => {
            if (!charging) closeCashModal();
          }}
        >
          <div
            className="modal modal-cash"
            role="dialog"
            aria-modal="true"
            aria-label="Record a cash payment"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="modal-title">Cash</p>
            <div className="cash-row">
              <span className="cash-label">Total</span>
              <span className="cash-amt">
                {total !== null ? money(total) : "--"}
              </span>
            </div>
            <div className="cash-row">
              <span className="cash-label">Tendered</span>
              <span className="cash-amt">
                {tenderedUsd !== null ? money(tenderedUsd) : "--"}
              </span>
            </div>
            <div className="cash-chips">
              <button
                className="cash-chip"
                disabled={total === null}
                onClick={() =>
                  total !== null &&
                  setTendered(String(Math.round(total * 100)))
                }
              >
                Exact
              </button>
              {[20, 50, 100].map((usd) => (
                <button
                  key={usd}
                  className="cash-chip"
                  onClick={() => setTendered(String(usd * 100))}
                >
                  ${usd}
                </button>
              ))}
            </div>
            <div className="cash-keys">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0"].map(
                (k) => (
                  <button
                    key={k}
                    className="cash-key"
                    onClick={() => keypadTap(k)}
                  >
                    {k}
                  </button>
                ),
              )}
              <button
                className="cash-key"
                aria-label="Delete last digit"
                onClick={() => keypadTap("back")}
              >
                &#9003;
              </button>
            </div>
            {total !== null && tenderedUsd !== null ? (
              cashShort ? (
                <p className="cash-change short">
                  Short {money(total - tenderedUsd)}
                </p>
              ) : (
                <p className="cash-change">
                  Change due {money(tenderedUsd - total)}
                </p>
              )
            ) : (
              <p className="cash-change muted-note">
                Tendered is for the change math only; it is not sent to
                Mindbody.
              </p>
            )}
            <div className="modal-actions">
              <button
                className="modal-cancel"
                disabled={charging}
                onClick={closeCashModal}
              >
                Cancel
              </button>
              <button
                className="modal-confirm go"
                disabled={total === null || cashShort || charging || !chargeable}
                onClick={confirmCash}
              >
                {total !== null ? `Record ${money(total)} cash` : "Record cash"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
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

  /** True while the payment panel's cash-tender modal is up: the Escape
   *  that closes it must not also close the overlay. */
  const [payModalOpen, setPayModalOpen] = useState(false);

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

  /** Fetch the shelf once per screen life; the route caches server-side
   *  for 10 minutes anyway. A failure renders with a retry button. */
  const loadCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    fetch("/api/catalog")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        setCatalog({
          categories: body?.categories ?? [],
          bundles: body?.bundles ?? [],
          products: body?.products ?? [],
          passes: body?.passes ?? [],
          packages: body?.packages ?? [],
          contracts: body?.contracts ?? [],
        });
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

  /** Escape closes the overlay like the X does -- unless a modal is
   *  stacked above (that layer takes the press), not mid-pricing (a
   *  total is on its way, and the screen waits to show it), and never
   *  mid-charge: money is moving and its outcome renders HERE. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !modalAbove &&
        !payModalOpen &&
        !cartPrompt &&
        !contractDialog &&
        !pricing &&
        !charging
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    open,
    modalAbove,
    payModalOpen,
    cartPrompt,
    contractDialog,
    pricing,
    charging,
    onClose,
  ]);

  const addItem = useCallback((item: ShelfItem) => {
    const key = `${item.type}-${item.id}`;
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
    setCart((lines) => lines.filter((l) => l.key !== key));
  }, []);

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
              <span className="sale-for-name">For: {client.name}</span>
              {attachedBalance !== null && attachedBalance !== 0 ? (
                <span
                  className={attachedBalance < 0 ? "bal-chip neg" : "bal-chip"}
                >
                  {money(attachedBalance)}
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
              <span>
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
            onClick={onClose}
            disabled={charging}
            aria-label="Back to the roster"
          >
            <span className="btn-ico">
              <CloseIcon />
            </span>
            Back
          </button>
        </div>

        <div className="sale-panes">
          {/* LEFT: the whole payment column (PaymentPanel since the
              second live test): the attach control, the compact method
              row, the receipt, the charge button and the outcomes. The
              ticket rides in as a prop; the cart and the pricing loop
              stay here in SaleScreen. */}
          <PaymentPanel
            cart={cart}
            priced={priced}
            pricing={pricing}
            client={client}
            cardLookup={cardLookup}
            onSold={() => setCart([])}
            onBusyChange={setCharging}
            onModalChange={setPayModalOpen}
            cartResetNonce={cartResetNonce}
            onClientDataStale={onClientDataStale}
            receipt={
              <div className="ticket">
            <h3>Sealevel Hot Yoga</h3>
            <p className="t-sub">Fremont</p>

            <hr className="t-rule" />

            {cart.length === 0 ? (
              <p className="t-empty">Nothing rung up yet.</p>
            ) : (
              <>
                {/* The lines scroll internally past a few items, so the
                    totals and the charge button below never leave an
                    iPad-landscape screen. */}
                <div className="t-lines">
                {cart.map((line) => (
                  <div className="t-item" key={line.key}>
                    <div className="t-line">
                      <span className="t-name">{line.item.name}</span>
                      <span className="amt">
                        {money(line.item.price * line.quantity)}
                      </span>
                    </div>
                    <div className="t-qty-row">
                      <button
                        className="qty-btn"
                        disabled={line.quantity <= 1}
                        aria-label={`One fewer ${line.item.name}`}
                        onClick={() => bumpQuantity(line.key, -1)}
                      >
                        <MinusIcon />
                      </button>
                      <span className="t-qty">
                        x{line.quantity}
                        {/* No "at $0.00" clause: a zero unit price cannot
                            reach the shelf any more (the catalog filters
                            it), but a line that somehow carries one reads
                            better bare than absurd. */}
                        {line.quantity > 1 && line.item.price > 0
                          ? ` at ${money(line.item.price)}`
                          : ""}
                      </span>
                      <button
                        className="qty-btn"
                        disabled={line.quantity >= MAX_LINE_QUANTITY}
                        aria-label={`One more ${line.item.name}`}
                        onClick={() => bumpQuantity(line.key, 1)}
                      >
                        <PlusIcon />
                      </button>
                      <button
                        className="qty-btn t-remove"
                        aria-label={`Remove ${line.item.name} from the sale`}
                        title="Remove"
                        onClick={() => removeLine(line.key)}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  </div>
                ))}
                </div>

                <hr className="t-rule" />

                {/* The totals area. The server's numbers or an honest
                    absence; local math never renders as a total. */}
                {showSpinner ? (
                  <p className="t-pricing">
                    <span className="spinner" aria-label="working" /> Pricing
                    with Mindbody...
                  </p>
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
                        <span>Tax</span>
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
              </>
            )}
              </div>
            }
          />

          {/* RIGHT: only the shelf since the second live test; the
              payment column moved left, above and below the receipt. */}
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
                <div className="sale-cats" role="tablist" aria-label="Categories">
                  {/* Favorites pinned first: the per-device stars plus the
                      hardcoded bundles, both pure reads over the loaded
                      catalog. */}
                  <button
                    key={FAVORITES_LABEL}
                    role="tab"
                    aria-selected={onFavorites}
                    className={onFavorites ? "cat-chip on" : "cat-chip"}
                    onClick={() => setActiveCat(FAVORITES_LABEL)}
                  >
                    {FAVORITES_LABEL}
                  </button>
                  {(() => {
                    /* T30: the Packages and Memberships chips slot in
                       right after Passes (the one category with no
                       category ids), each rendered ONLY when it has
                       something to sell; an empty extra chip would be a
                       button that can never show anything. */
                    const extras: string[] = [
                      ...(catalog.packages.length > 0
                        ? [PACKAGES_LABEL]
                        : []),
                      ...(catalog.contracts.length > 0
                        ? [MEMBERSHIPS_LABEL]
                        : []),
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
                    return labels.map((label) => (
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
                    ));
                  })()}
                </div>

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
                        <span className="shelf-name">{c.name}</span>
                        <span className="shelf-price">
                          {c.autopayEnabled &&
                          c.recurringPaymentTotal !== null &&
                          c.recurringPaymentTotal > 0
                            ? `${money(c.recurringPaymentTotal)} ${frequencyPhrase(c)}`
                            : c.firstPaymentTotal !== null
                              ? money(c.firstPaymentTotal)
                              : ""}
                          <span className="shelf-bundle-mark"> membership</span>
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
                            <span className="shelf-price">
                              {money(item.price)}
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
                            <span className="shelf-name">{bundle.name}</span>
                            <span className="shelf-price">
                              {money(bundle.total)}
                              <span className="shelf-bundle-mark"> bundle</span>
                            </span>
                          </button>
                        ))
                      : null}
                  </div>
                )}
              </>
            ) : null}
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
    </div>
  );
}
