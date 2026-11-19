"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ClientPurchases, PurchaseSale } from "@/lib/clientpurchases";
import { wallDateTime } from "./ClientProfileCard";

/**
 * T257: "Recent purchases" in the client profile modal (Pete, 2026-11-18:
 * see a student's recent sales, with a way to void one). It reads
 * `/api/client-purchases` when the profile opens, and again when the
 * teacher comes back from Mindbody after tapping a void link, so a sale
 * voided there drops off the list. The API cannot void (T256), so the
 * control opens Mindbody's own void page for that sale, in a new tab:
 * Safari, from the Home Screen web app, where the teacher signs in to
 * Mindbody themselves.
 *
 * A link rather than a script: an `<a target="_blank" rel="noopener
 * noreferrer">` is what iOS hands to Safari from a standalone web app
 * (an out-of-scope URL never opens inside the app), it is not a popup a
 * blocker can eat, and its href is the thing to check. The URL is built
 * on the server from digits only and checked again here.
 *
 * Mounted keyed by the client (page.tsx), so a different student is a
 * fresh list and never shows the last one's.
 */

const VOID_URL =
  /^https:\/\/clients\.mindbodyonline\.com\/app\/clients\/\d{1,12}\/account-details\/void-edit\?saleno=\d{1,12}$/;

function money(n: number | null): string {
  if (n === null) return "";
  const s = Math.abs(n).toFixed(2);
  return n < 0 ? `-$${s}` : `$${s}`;
}

function paidBy(sale: PurchaseSale): string {
  if (sale.payments.length === 0) return "No payment recorded";
  return sale.payments
    .map((p) => (p.amount === null ? p.type : `${p.type} ${money(p.amount)}`))
    .join(", ");
}

export function RecentPurchases({
  clientId,
  uniqueId,
}: {
  clientId: string;
  uniqueId: number | null;
}) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ClientPurchases | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  /** Set when a void link was tapped: the next return to the app reads
   *  the list again. */
  const awayToVoid = useRef(false);

  const load = useCallback(() => {
    const g = ++gen.current;
    setLoading(true);
    const qs =
      `clientId=${encodeURIComponent(clientId)}` +
      (uniqueId !== null ? `&uniqueId=${uniqueId}` : "") +
      `&days=${days}`;
    fetch(`/api/client-purchases?${qs}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || body.error) {
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        return body as ClientPurchases;
      })
      .then((body) => {
        if (gen.current !== g) return;
        setData(body);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (gen.current !== g) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [clientId, uniqueId, days]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== "visible" || !awayToVoid.current) return;
      awayToVoid.current = false;
      load();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    window.addEventListener("pageshow", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
      window.removeEventListener("pageshow", back);
    };
  }, [load]);

  /* Invalidate an answer still in flight when the section goes. */
  useEffect(() => () => void ++gen.current, []);

  const sales = data?.sales ?? [];
  const anyVoid = sales.some((s) => s.voidUrl && VOID_URL.test(s.voidUrl));

  return (
    <section className="purchases" aria-label="Recent purchases" aria-busy={loading}>
      <p className="profile-label profile-section purchases-head">
        Recent purchases
        {loading ? (
          <span className="spinner purchases-spin" aria-label="reading" />
        ) : null}
      </p>
      {error ? (
        <p className="purchases-error" role="status">
          Could not read recent purchases: {error}
        </p>
      ) : null}
      {data?.linkWarning ? (
        <p className="optins-msg warn-text">{data.linkWarning}</p>
      ) : null}
      {data && !error && sales.length === 0 ? (
        <p className="profile-missing">
          No purchases in the last {data.days} days.
        </p>
      ) : null}
      {anyVoid ? (
        <p className="optins-msg purchases-help">
          Void opens Mindbody. Sign in there if asked; the void happens in Mindbody.
        </p>
      ) : null}
      {sales.length > 0 ? (
        <ul className="purchase-list">
          {sales.map((s) => {
            const url = s.voidUrl && VOID_URL.test(s.voidUrl) ? s.voidUrl : null;
            return (
              <li key={s.saleId} className="purchase" data-sale={s.saleId}>
                <div className="purchase-top">
                  <span className="purchase-when">
                    {wallDateTime(s.at) ?? "Date unknown"}
                  </span>
                  <span className="purchase-total">{money(s.totalPaid)}</span>
                </div>
                <ul className="purchase-lines">
                  {s.lines.map((l, i) => (
                    <li key={i} className="purchase-line">
                      <span className="purchase-desc">
                        {l.quantity !== null && l.quantity !== 1
                          ? `${l.quantity} x `
                          : ""}
                        {l.description}
                        {/* Per line only when not every line was: a
                            whole returned sale says it once, below. */}
                        {l.returned && !s.returned ? (
                          <span className="purchase-returned">Returned</span>
                        ) : null}
                      </span>
                      <span className="purchase-amt">{money(l.amountPaid)}</span>
                    </li>
                  ))}
                </ul>
                <div className="purchase-foot">
                <p className="purchase-meta">
                  Paid by {paidBy(s)}
                  <span className="purchase-no"> · sale {s.saleId}</span>
                  {s.returned ? (
                    <span className="purchase-returned">Returned</span>
                  ) : s.partlyReturned ? (
                    <span className="purchase-returned">Partly returned</span>
                  ) : null}
                </p>
                {url ? (
                  <span className="purchase-actions">
                    <a
                      className="purchase-void"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => {
                        awayToVoid.current = true;
                      }}
                    >
                      Void
                    </a>
                  </span>
                ) : null}
                </div>
                {!url && s.noVoidWhy && !data?.linkWarning ? (
                  <p className="optins-msg">{s.noVoidWhy}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {data && data.truncated ? (
        <p className="optins-msg">
          Only the newest {sales.length} sales are shown. Mindbody has more.
        </p>
      ) : null}
      {data && days < 90 && !loading ? (
        <button className="purchases-more" onClick={() => setDays(90)}>
          Show the last 90 days
        </button>
      ) : null}
    </section>
  );
}
