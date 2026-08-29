"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  type: "Product" | "Service";
  categoryId: number | null;
}

interface ShelfCategory {
  label: string;
  categoryIds: number[];
}

interface CatalogState {
  categories: ShelfCategory[];
  products: ShelfItem[];
  passes: ShelfItem[];
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
  suppressed: boolean;
  subTotal: number | null;
  discountTotal: number | null;
  taxTotal: number | null;
  grandTotal: number | null;
  expectedTotal: number;
  disagrees: boolean;
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

/** Account-credit icon: a wallet-ish note. */
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
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M16 15h2" />
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

/** The attach-time card lookup's lifecycle, held by SaleScreen. */
interface CardLookup {
  loading: boolean;
  card: StoredCardInfo | null;
  error: string | null;
}

type PayMethod = "storedcard" | "credit" | "cash" | "comp";

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
 * THE T24 SEAM, now live. Everything below the receipt's totals -- the
 * method cards, the cash keypad, the charge button and the outcome
 * panel -- renders here, and ONLY here. The invariants inherited from
 * T23 are kept verbatim: never charge an empty, in-flight, suppressed,
 * or disagreeing cart; the button restates the server's number or none.
 * On top of them: nothing fires without an explicit tap, one charge can
 * be in flight at a time (ref-guarded, button disabled), and a failed or
 * ambiguous outcome renders with enough truth that re-tapping cannot
 * quietly double-charge.
 */
function PaymentPanel(props: {
  cart: readonly CartEntry[];
  priced: PricedResult | null;
  pricing: boolean;
  client: SaleClient | null;
  cardLookup: CardLookup | null;
  /** Clear the cart: the sale is recorded on Mindbody's side. */
  onSold: () => void;
  /** Mirrors the in-flight charge up to SaleScreen so ambient Escape
   *  cannot close the overlay while money is moving. */
  onBusyChange: (busy: boolean) => void;
}) {
  const { cart, priced, pricing, client, cardLookup, onSold, onBusyChange } =
    props;

  const [method, setMethod] = useState<PayMethod | null>(null);
  /** Tendered cash in CENTS, as a digit string (POS-style entry: typing
   *  2-0-0-0 reads $20.00). Display only; never sent to Mindbody. */
  const [tendered, setTendered] = useState("");
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
  const balance = freshBalance ?? client?.balance ?? null;
  /* The attach snapshot (or a split failure's fresher report) gates the
   * button; /api/checkout re-reads the balance server-side and never
   * trusts this number. */
  const balanceCoversTotal =
    balance !== null && total !== null && balance >= total;

  /* A detach invalidates the client-bound methods and the balance. */
  const clientId = client?.id ?? null;
  useEffect(() => {
    setFreshBalance(null);
    if (clientId === null) {
      setMethod((m) => (m === "storedcard" || m === "credit" ? null : m));
    }
  }, [clientId]);

  /* A cart EDIT retires a stale receipt; warnings stay until dismissed.
   * The empty cart is skipped deliberately: a successful charge clears the
   * cart in the same commit that sets the receipt, and this effect firing
   * on that clear would wipe the receipt before the teacher saw it. */
  useEffect(() => {
    if (cart.length === 0) return;
    setResult((r) => (r?.kind === "paid" ? null : r));
  }, [cart]);

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

  const chargeable =
    cart.length > 0 &&
    !pricing &&
    total !== null &&
    method !== null &&
    !charging &&
    !cashShort;

  const chargeLabel =
    total === null
      ? "Charge"
      : method === "cash"
        ? `Record ${money(total)} cash`
        : method === "comp"
          ? `Comp ${money(total)}`
          : `Charge ${money(total)}`;

  const doCharge = async () => {
    /* Single flight: the ref refuses a second tap even in the same
     * render tick, and the button is disabled for every later one. */
    if (inFlight.current || !chargeable || method === null) return;
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
          })),
          ...(clientId ? { clientId } : {}),
          method,
          ...(method === "cash" && tenderedUsd !== null
            ? { cashTendered: tenderedUsd }
            : {}),
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
      if (res.ok && body === null) {
        /* A 200 whose body could not be read: the charge may well have
         * completed, so this must NOT render as "not charged". */
        setResult({
          kind: "ambiguous",
          message: "The server answered but the outcome could not be read.",
        });
      } else if (res.ok && body?.ok === true) {
        const methodName =
          method === "storedcard"
            ? `stored card${card ? ` ...${card.lastFour}` : ""}`
            : method === "credit"
              ? "account credit"
              : method;
        onSold();
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

  return (
    <div className="pay-seam">
      <div className="methods" aria-label="Payment methods">
        <button
          className={method === "storedcard" ? "method on" : "method"}
          disabled={cardReasonFinal !== null || charging}
          onClick={() => pickMethod("storedcard")}
          aria-pressed={method === "storedcard"}
        >
          <span className="mi">
            <CardIcon />
          </span>
          Stored card
          <span className="method-why">
            {cardReasonFinal ?? cardDetail ?? ""}
          </span>
        </button>
        <button
          className={method === "credit" ? "method on" : "method"}
          disabled={creditReason !== null || charging}
          onClick={() => pickMethod("credit")}
          aria-pressed={method === "credit"}
        >
          <span className="mi">
            <CreditIcon />
          </span>
          {creditLabel}
          <span className="method-why">{creditReason ?? ""}</span>
        </button>
        <button
          className={method === "cash" ? "method on" : "method"}
          disabled={charging}
          onClick={() => pickMethod("cash")}
          aria-pressed={method === "cash"}
        >
          <span className="mi">
            <CashIcon />
          </span>
          Cash
          <span className="method-why"></span>
        </button>
      </div>

      {/* Comp: deliberately out of the method row and armed by holding,
          so nobody comps a sale by grazing a card. */}
      <button
        className={method === "comp" ? "comp-hold on" : "comp-hold"}
        disabled={charging}
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

      {method === "cash" ? (
        <div className="cash-pad" aria-label="Cash tendered">
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
        </div>
      ) : null}

      <button
        className="charge-btn"
        disabled={!chargeable}
        onClick={doCharge}
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
}) {
  const {
    open,
    onClose,
    config,
    client,
    onRequestAttach,
    onDetachClient,
    modalAbove,
  } = props;

  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  /** The active category chip, by label (labels are unique in the
   *  hardcoded list). Defaults to the first once the catalog lands. */
  const [activeCat, setActiveCat] = useState<string | null>(null);

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

  /** The attached client's card on file, fetched on attach via the
   *  guarded /api/stored-card route. Null when nobody is attached. */
  const [cardLookup, setCardLookup] = useState<CardLookup | null>(null);

  /** Fetch the shelf once per screen life; the route caches server-side
   *  for 10 minutes anyway. A failure renders with a retry button. */
  const loadCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    fetch("/api/catalog")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        const cats: ShelfCategory[] = body?.categories ?? [];
        setCatalog({
          categories: cats,
          products: body?.products ?? [],
          passes: body?.passes ?? [],
        });
        setActiveCat((cur) => cur ?? cats[0]?.label ?? null);
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

  /** Card-on-file lookup on attach. The result only gates which method
   *  cards light up; /api/checkout re-reads everything server-side. */
  useEffect(() => {
    if (clientId === null) {
      setCardLookup(null);
      return;
    }
    let alive = true;
    setCardLookup({ loading: true, card: null, error: null });
    fetch(`/api/stored-card?clientId=${encodeURIComponent(clientId)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        if (alive) {
          setCardLookup({
            loading: false,
            card: body?.card ?? null,
            error: null,
          });
        }
      })
      .catch((e) => {
        if (alive) {
          setCardLookup({
            loading: false,
            card: null,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [clientId]);

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
      if (e.key === "Escape" && !modalAbove && !pricing && !charging) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, modalAbove, pricing, charging, onClose]);

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

  const category =
    catalog?.categories.find((c) => c.label === activeCat) ?? null;
  const shelfItems: ShelfItem[] =
    catalog === null || category === null
      ? []
      : category.categoryIds.length === 0
        ? catalog.passes
        : catalog.products.filter(
            (p) =>
              p.categoryId !== null &&
              category.categoryIds.includes(p.categoryId),
          );

  /** What the totals area shows, in priority order: the amber suppression
   *  notice, the loud disagreement, a failed call, the spinner, or the
   *  server's numbers. Never a locally computed total dressed as one. */
  const totals = priced;
  const showSpinner = pricing;

  return (
    <div className="sale-overlay" role="dialog" aria-label="Sell">
      <div className="sale-shell">
        <ModeBanner config={config} />

        <div className="sale-top">
          <h2 className="sale-title">Sell</h2>
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
          {/* LEFT: the receipt ticket. */}
          <div className="ticket">
            <h3>Sealevel Hot Yoga</h3>
            <p className="t-sub">Fremont</p>

            {/* Who the sale is for. Anonymous is fine; attaching enables
                stored-card/credit in T24 and rides price-cart now. */}
            {client ? (
              <div className="sale-for attached">
                <span className="sale-for-name">For: {client.name}</span>
                {client.balance !== null && client.balance !== 0 ? (
                  <span
                    className={
                      client.balance < 0 ? "bal-chip neg" : "bal-chip"
                    }
                  >
                    {money(client.balance)}
                  </span>
                ) : null}
                <button
                  className="row-icon sale-for-clear"
                  aria-label={`Detach ${client.name} from this sale`}
                  title="Detach"
                  onClick={onDetachClient}
                >
                  <CloseIcon />
                </button>
              </div>
            ) : (
              <button className="sale-for" onClick={onRequestAttach}>
                For: nobody. Tap to attach a client.
              </button>
            )}

            <hr className="t-rule" />

            {cart.length === 0 ? (
              <p className="t-empty">Nothing rung up yet.</p>
            ) : (
              <>
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
                        {line.quantity > 1
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
                    {totals.usedPaymentStub ? (
                      <p className="t-stub">
                        Priced via the Comp payment stub (T24 cares).
                      </p>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>

          {/* RIGHT: the shelf, and below it the T24 payment seam. */}
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
                  {catalog.categories.map((c) => (
                    <button
                      key={c.label}
                      role="tab"
                      aria-selected={activeCat === c.label}
                      className={
                        activeCat === c.label ? "cat-chip on" : "cat-chip"
                      }
                      onClick={() => setActiveCat(c.label)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>

                {shelfItems.length === 0 ? (
                  <p className="muted">Nothing sellable in this category.</p>
                ) : (
                  <div className="shelf-grid">
                    {shelfItems.map((item) => (
                      <button
                        key={`${item.type}-${item.id}`}
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
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : null}

            <PaymentPanel
              cart={cart}
              priced={priced}
              pricing={pricing}
              client={client}
              cardLookup={cardLookup}
              onSold={() => setCart([])}
              onBusyChange={setCharging}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
