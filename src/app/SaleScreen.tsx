"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The sale screen (T23, PLAN 2.1 UI). A full-screen overlay over the
 * roster: receipt-style cart on the left, category chips and the item
 * shelf on the right, per the approved mockup (counter-refresh panel 5).
 *
 * UI and wiring only. The one network write-shaped call it makes is
 * POST /api/price-cart, which is Test: true pricing and moves no money by
 * construction; the Charge button is a DISABLED placeholder for T24, and
 * the whole payment area lives behind the <PaymentPanel> boundary so T24
 * can replace the stub without touching the cart.
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

/**
 * THE T24 SEAM. Everything below the receipt's totals -- the method cards
 * and the charge button -- renders here, and ONLY here. T23 ships it as
 * static disabled placeholders; T24 replaces this component's internals
 * (real method availability from balances and stored cards, the $10-
 * minimum routing per PLAN 2.3, a live onCharge) without touching the
 * cart, the shelf, or the pricing loop. The props are the whole contract:
 * the cart lines, the server-priced totals, the attached client, and the
 * charge callback (a no-op stub until T24).
 */
function PaymentPanel(props: {
  cart: readonly CartEntry[];
  priced: PricedResult | null;
  pricing: boolean;
  client: SaleClient | null;
  onCharge: () => void;
}) {
  const { cart, priced, pricing, client, onCharge } = props;
  const total =
    priced && !priced.suppressed && !priced.disagrees ? priced.grandTotal : null;
  /* Disabled outright until T24; the stricter conditions below are what
   * T24 inherits: no empty cart, no in-flight pricing, no suppressed or
   * disagreeing total may ever be charged. */
  const chargeable = false;
  return (
    <div className="pay-seam">
      <div className="methods" aria-label="Payment methods (not available yet)">
        <button className="method" disabled>
          <span className="mi">
            <CardIcon />
          </span>
          Stored card
        </button>
        <button className="method" disabled>
          <span className="mi">
            <CreditIcon />
          </span>
          Account credit
        </button>
        <button className="method" disabled>
          <span className="mi">
            <CashIcon />
          </span>
          Cash
        </button>
      </div>
      <p className="method-hint">
        {client
          ? "Payment arrives with T24. Nothing can be charged yet."
          : "Payment arrives with T24. Stored card and credit will need a client attached."}
      </p>
      <button
        className="charge-btn"
        disabled={
          !chargeable || cart.length === 0 || pricing || total === null
        }
        onClick={onCharge}
        aria-label="Charge (not available yet)"
      >
        {total !== null ? `Charge ${money(total)}` : "Charge"}
      </button>
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
   *  stacked above (that layer takes the press), and not mid-pricing:
   *  a total is on its way, and the screen waits to show it. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modalAbove && !pricing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, modalAbove, pricing, onClose]);

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
          {/* The deliberate Back always works, mid-pricing included (the
              cart and its in-flight answer survive: the component stays
              mounted). Only the ambient Escape waits for a total. */}
          <button
            className="class-change sale-back"
            onClick={onClose}
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
                    Dry run: Mindbody did not price this cart, so there is no
                    total to show. Nothing was written.
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
              onCharge={() => {
                /* T24 replaces this stub with real payment execution.
                 * Until then the button above it is disabled outright. */
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
