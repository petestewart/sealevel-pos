"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * T274: the admin "Sales" sheet. Every money tap the counter made on one
 * studio day, from the sale_log table: when, who, for whom, what was
 * asked, what the counter was told, and what the read-back from Mindbody
 * found. READS ONLY, apart from "Check now", which asks the server to
 * read that day's unchecked sales back from Mindbody (reads again). Shown
 * to a teacher whose staff id is in POS_ADMIN_STAFF_IDS, from the account
 * modal; the server refuses everybody else.
 */

interface ReaderHoldRow {
  id: string;
  state: string;
  amountCents: number;
  clientId: string | null;
  cardBrand: string | null;
  lastFour: string | null;
  failure: string | null;
  createdAt: number;
}

interface Row {
  id: string;
  route: string;
  staffId: string | null;
  clientIds: string[];
  dryRun: string | null;
  writeGuard: boolean;
  request: any;
  outcome: string;
  httpStatus: number | null;
  message: string | null;
  saleIds: string[];
  total: number | null;
  startedAt: number;
  finishedAt: number | null;
  checkState: string | null;
  checkDetail: any;
}

const OUTCOME_WORDS: Record<string, string> = {
  started: "No answer recorded",
  stood: "Sold",
  suppressed: "Not sent (dry run or write guard)",
  refused: "Refused, nothing charged",
  held: "Refused: client held",
  ambiguous: "May have gone through",
  "sold-nothing": "Paid, nothing sold",
  partial: "Partly sold",
};

const CHECK_WORDS: Record<string, string> = {
  ok: "Matches Mindbody",
  differs: "Differs from Mindbody",
  missing: "Not found in Mindbody",
  unverified: "Could not be checked",
};

function money(n: number | null): string {
  return n === null ? "" : `$${n.toFixed(2)}`;
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shift(day: string, by: number): string {
  const t = Date.parse(`${day}T12:00:00Z`) + by * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function routeWord(route: string): string {
  if (route === "/api/purchase-contract") return "Membership";
  if (route === "/api/guest") return "Guest pass";
  return "Sale";
}

function lines(req: any): string {
  const parts: string[] = [];
  for (const l of Array.isArray(req?.items) ? req.items : []) {
    const name = l?.name ?? `${l?.type ?? "item"} ${l?.id ?? ""}`;
    parts.push(`${l?.quantity && l.quantity !== 1 ? `${l.quantity} x ` : ""}${name}`);
  }
  for (const g of Array.isArray(req?.giftCards) ? req.giftCards : []) {
    parts.push(`Gift card${g?.amount ? ` $${Number(g.amount).toFixed(2)}` : ""}`);
  }
  if (req?.accountCredit) {
    parts.push(
      `Account credit $${Number(req.accountCredit.amount ?? 0).toFixed(2)}` +
        (req.accountCredit.noCharge ? " (no charge)" : ""),
    );
  }
  if (req?.contractId) parts.push(`Contract ${req.contractId}`);
  if (req?.guestClientId) parts.push(`Guest ${req.guestClientId}`);
  return parts.join(", ");
}

function tender(req: any): string {
  if (Array.isArray(req?.split)) {
    return req.split
      .map((l: any) => `${l?.method ?? "?"} ${money(typeof l?.amount === "number" ? l.amount : null)}`)
      .join(" + ");
  }
  return typeof req?.method === "string" ? req.method : "";
}

export default function SalesSheet({
  open,
  onClose,
  today,
}: {
  open: boolean;
  onClose: () => void;
  /** The studio's date, YYYY-MM-DD, the sheet opens on. */
  today: string;
}) {
  const [day, setDay] = useState(today);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** T228: card reader holds that need a person. Empty when there are
   *  none or the reader is not in use (the route answers 403 off). */
  const [holds, setHolds] = useState<ReaderHoldRow[]>([]);
  const [holdNote, setHoldNote] = useState<string | null>(null);
  const [holdBusy, setHoldBusy] = useState<string | null>(null);

  const loadHolds = useCallback(async () => {
    try {
      const res = await fetch("/api/reader/attention");
      if (!res.ok) {
        setHolds([]);
        return;
      }
      const body = await res.json().catch(() => null);
      setHolds(Array.isArray(body?.rows) ? body.rows : []);
    } catch {
      setHolds([]);
    }
  }, []);

  const settle = async (id: string, decision: "charge" | "release") => {
    setHoldBusy(id);
    setHoldNote(null);
    try {
      const res = await fetch(`/api/reader/attempt/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = await res.json().catch(() => null);
      setHoldNote(
        res.ok
          ? decision === "charge"
            ? `Charged, against sale ${body?.saleId ?? "?"}.`
            : "Released. Nothing was charged."
          : String(body?.error ?? `HTTP ${res.status}`),
      );
      await loadHolds();
    } finally {
      setHoldBusy(null);
    }
  };

  const load = useCallback(async (d: string) => {
    setNote(null);
    try {
      const res = await fetch(`/api/sale-log?day=${d}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setRows([]);
        setNote(String(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      if (body?.available === false) {
        setNote(
          body?.configured === false
            ? "This counter has no database, so there is no sales log."
            : "The sales log did not answer. Try again in a minute.",
        );
      }
      setRows(Array.isArray(body?.rows) ? body.rows : []);
    } catch (err) {
      setRows([]);
      setNote(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setDay(today);
      void load(today);
      void loadHolds();
    }
  }, [open, today, load, loadHolds]);

  const check = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/sale-log/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ day }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setNote(String(body?.error ?? `HTTP ${res.status}`));
      } else {
        const parts = [`${body.checked} checked against Mindbody`];
        if (body.waiting > 0) parts.push(`${body.waiting} too recent, asked again later`);
        if (body.remaining > 0) parts.push(`${body.remaining} more: tap again`);
        setNote(`${parts.join(". ")}.`);
      }
      await load(day);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const problem = (r: Row) =>
    r.checkState === "differs" ||
    r.checkState === "missing" ||
    r.outcome === "ambiguous" ||
    r.outcome === "sold-nothing" ||
    r.outcome === "partial" ||
    r.outcome === "started";
  const shown = (rows ?? []).filter((r) => !onlyProblems || problem(r));
  const sold = (rows ?? []).filter((r) => r.outcome === "stood");
  const soldTotal = sold.reduce((a, r) => a + (r.total ?? 0), 0);

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal modal-sales" role="dialog" aria-label="Sales log">
        <div className="modal-head">
          <p className="modal-kicker">Sales log</p>
          <p className="modal-title">{dayLabel(day)}</p>
        </div>
        {holds.length > 0 ? (
          <div className="sales-holds">
            <p className="sales-holds-head">Card reader holds to settle</p>
            {holdNote ? <p className="reason-note">{holdNote}</p> : null}
            {holds.map((h) => (
              <div key={h.id} className="sales-hold">
                <p>
                  <strong>{money(h.amountCents / 100)}</strong>
                  {h.lastFour ? ` on ${h.cardBrand ?? "card"} ending ${h.lastFour}` : ""}
                  {h.clientId ? `, client ${h.clientId}` : ""}, {time(h.createdAt)}.
                </p>
                {h.failure ? <p className="sales-problem">{h.failure}</p> : null}
                {h.state === "unresolved" ? (
                  <div className="sales-nav">
                    <button
                      className="modal-cancel"
                      disabled={holdBusy !== null}
                      onClick={() => void settle(h.id, "charge")}
                    >
                      Sale is in Mindbody: charge the card
                    </button>
                    <button
                      className="modal-cancel"
                      disabled={holdBusy !== null}
                      onClick={() => void settle(h.id, "release")}
                    >
                      No sale: release the hold
                    </button>
                  </div>
                ) : (
                  <p className="reason-sub">
                    Sold in Mindbody, and the card was not charged. Charge it in Square, or void
                    the sale in Mindbody.
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : null}
        <div className="sales-nav">
          <button
            className="modal-cancel"
            onClick={() => {
              const d = shift(day, -1);
              setDay(d);
              setRows(null);
              void load(d);
            }}
          >
            Previous day
          </button>
          <button
            className="modal-cancel"
            disabled={day >= today}
            onClick={() => {
              const d = shift(day, 1);
              setDay(d);
              setRows(null);
              void load(d);
            }}
          >
            Next day
          </button>
          <button
            className={onlyProblems ? "modal-cancel sales-on" : "modal-cancel"}
            aria-pressed={onlyProblems}
            onClick={() => setOnlyProblems((v) => !v)}
          >
            Only problems
          </button>
        </div>
        <p className="reason-sub">
          {rows === null
            ? "Loading..."
            : `${rows.length} taps. ${sold.length} sold, ${money(soldTotal)}.`}
        </p>
        {note ? <p className="reason-note">{note}</p> : null}
        <ul className="sales-list">
          {shown.map((r) => {
            const open = expanded === r.id;
            const problems: string[] = Array.isArray(r.checkDetail?.problems)
              ? r.checkDetail.problems
              : [];
            return (
              <li key={r.id} className={problem(r) ? "sales-row bad" : "sales-row"}>
                <button
                  className="sales-row-head"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : r.id)}
                >
                  <span className="sales-time">{time(r.startedAt)}</span>
                  <span className="sales-what">
                    {routeWord(r.route)}: {lines(r.request) || "nothing listed"}
                  </span>
                  <span className="sales-total">{money(r.total)}</span>
                  <span className={`sales-outcome o-${r.outcome}`}>
                    {OUTCOME_WORDS[r.outcome] ?? r.outcome}
                  </span>
                  {r.checkState ? (
                    <span className={`sales-check c-${r.checkState}`}>
                      {CHECK_WORDS[r.checkState] ?? r.checkState}
                    </span>
                  ) : r.outcome === "stood" ? (
                    <span className="sales-check">Not checked yet</span>
                  ) : null}
                </button>
                {open ? (
                  <div className="sales-detail">
                    <p>
                      Client {r.clientIds.join(", ") || "walk-in"}
                      {r.request?.clientName ? ` (${r.request.clientName})` : ""}.
                      Teacher {r.request?.teacherName ?? r.staffId ?? "unknown"}. Paid by {tender(r.request) || "nothing"}.
                    </p>
                    {r.saleIds.length > 0 ? (
                      <p>Mindbody sale {r.saleIds.join(", ")}.</p>
                    ) : null}
                    {r.dryRun || r.writeGuard ? (
                      <p>
                        {r.dryRun ? `Dry run on (${r.dryRun}). ` : ""}
                        {r.writeGuard ? "Write guard narrowing writes." : ""}
                      </p>
                    ) : null}
                    {r.message ? <p>The counter was told: {r.message}</p> : null}
                    {problems.map((p, i) => (
                      <p key={i} className="sales-problem">
                        {p}
                      </p>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
          {rows !== null && shown.length === 0 ? (
            <li className="sales-empty">
              {onlyProblems ? "No problems on this day." : "No taps on this day."}
            </li>
          ) : null}
        </ul>
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>
            Close
          </button>
          <button className="modal-confirm go" disabled={busy} onClick={() => void check()}>
            {busy ? "Checking..." : "Check now"}
          </button>
        </div>
      </div>
    </div>
  );
}
