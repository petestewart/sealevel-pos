"use client";

import { useCallback, useState } from "react";

import { plainText } from "@/lib/richtext";

import type { TicketPayload } from "@/lib/displayticket";

/**
 * The ticket, as the student sees it (T201, Phase 2.5 item 2; design
 * "Scene 2").
 *
 * Three modes, one layout. `live` mirrors the cart the teacher is
 * building, line by line, and is replaced in place as it changes.
 * `summary` is the same ticket after the charge, plus how it was paid and
 * a thank you, for the few seconds the hub gives it before it sends the
 * screen back to idle by itself. `approve` (T203) is the same ticket with
 * Approve and Not yet on it, for the studio that has turned
 * `customer_confirms_sale` on.
 *
 * THIS COMPONENT CHARGES NOTHING and writes nothing. Approve stores an
 * answer on the request (`/api/display/complete`), Not yet refuses it
 * (`/api/display/refuse`), and /api/checkout treats that stored answer as
 * a PRECONDITION it checks before it charges. A tap here never moves
 * money; the teacher's own Charge does.
 *
 * THIS COMPONENT DOES NO ARITHMETIC. Every figure on it was priced by
 * Mindbody and arrived on the payload; a subtotal, a tax line or a total
 * the payload did not carry is simply not drawn, because a number this
 * screen invented is a number the studio cannot stand behind. Every name
 * came from Mindbody's catalog and goes through plainText, never
 * dangerouslySetInnerHTML: this iPad is in a student's hands.
 */

function money(n: number): string {
  return n.toLocaleString([], { style: "currency", currency: "USD" });
}

export default function TicketScene(props: {
  payload: TicketPayload;
  /** T203: the request this ticket is, for the approve mode's two taps.
   *  Absent for a live mirror and a summary, which nobody answers. */
  requestId?: string;
  /** Told when the student has answered, so the screen can move on while
   *  the server catches up. */
  onAnswered?: (approved: boolean) => void;
}) {
  const t = props.payload;
  const summary = t.mode === "summary";
  const approve = t.mode === "approve";
  const name = plainText(t.clientFirstName ?? "");
  const heading = summary
    ? name.length > 0
      ? `Thank you, ${name}`
      : "Thank you"
    : name.length > 0
      ? `Hello, ${name}`
      : "Your ticket";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requestId, onAnswered } = props;

  const answer = useCallback(
    async (approved: boolean) => {
      if (busy || !requestId) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          approved ? "/api/display/complete" : "/api/display/refuse",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              approved
                ? { requestId, result: { approved: true } }
                : { requestId, reason: "Customer did not approve" },
            ),
          },
        );
        if (!res.ok) {
          setError("That did not go through. Please tell the front desk.");
          return;
        }
        onAnswered?.(approved);
      } catch {
        setError("That did not go through. Please tell the front desk.");
      } finally {
        setBusy(false);
      }
    },
    [busy, requestId, onAnswered],
  );

  return (
    <section className="dticket" aria-label="Your ticket">
      <h1 className="dticket-heading">{heading}</h1>

      <ul className="dticket-lines">
        {t.lines.map((line, i) => (
          <li className="dticket-line" key={`${i}-${line.name}`}>
            <span className="dticket-line-name">{plainText(line.name)}</span>
            <span className="dticket-line-qty">
              {line.quantity > 1
                ? `${line.quantity} x ${money(line.unitPrice)}`
                : money(line.unitPrice)}
            </span>
            <span className="dticket-line-price">{money(line.linePrice)}</span>
            {line.discount !== undefined ? (
              <span className="dticket-line-discount">
                Discount {money(-Math.abs(line.discount))}
              </span>
            ) : null}
          </li>
        ))}
        {t.lines.length === 0 ? (
          <li className="dticket-line dticket-line-empty">Nothing on the ticket yet</li>
        ) : null}
      </ul>

      <dl className="dticket-totals">
        {t.subtotal !== null ? (
          <div className="dticket-total-row">
            <dt>Subtotal</dt>
            <dd>{money(t.subtotal)}</dd>
          </div>
        ) : null}
        {t.discountTotal !== undefined ? (
          <div className="dticket-total-row">
            <dt>Discount</dt>
            <dd>{money(-Math.abs(t.discountTotal))}</dd>
          </div>
        ) : null}
        {t.tax !== null ? (
          <div className="dticket-total-row">
            <dt>Tax</dt>
            <dd>{money(t.tax)}</dd>
          </div>
        ) : null}
        {t.total !== null ? (
          <div className="dticket-total-row dticket-grand">
            <dt>Total</dt>
            <dd>{money(t.total)}</dd>
          </div>
        ) : (
          /* The cart is being priced, or Mindbody has not answered for it
           * yet. The lines stand; the figure waits. */
          <div className="dticket-total-row dticket-pending">
            <dt>Total</dt>
            <dd>Pricing</dd>
          </div>
        )}
      </dl>

      {approve ? (
        <div className="dticket-approve">
          <p className="dticket-ask">Does this look right?</p>
          {error !== null ? <p className="dticket-error">{error}</p> : null}
          <div className="dticket-approve-buttons">
            <button
              type="button"
              className="dscene-btn"
              disabled={busy}
              onClick={() => void answer(false)}
            >
              Not yet
            </button>
            <button
              type="button"
              className="dscene-btn dscene-go"
              disabled={busy}
              onClick={() => void answer(true)}
            >
              {busy ? "One moment" : "Approve"}
            </button>
          </div>
        </div>
      ) : null}

      {summary ? (
        <div className="dticket-paid">
          {t.charged !== undefined ? (
            <p className="dticket-charged">
              Paid {money(t.charged)}
              {t.tender ? ` by ${plainText(t.tender)}` : ""}
            </p>
          ) : t.tender ? (
            <p className="dticket-charged">Paid by {plainText(t.tender)}</p>
          ) : null}
          {t.emailedReceipt === true ? (
            <p className="dticket-receipt">A receipt is on its way by email.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
