"use client";

import { plainText } from "@/lib/richtext";

import type { TicketPayload } from "@/lib/displayticket";

/**
 * The ticket, as the student sees it (T114, Phase 2.5 item 2; design
 * "Scene 2").
 *
 * Two modes, one layout. `live` mirrors the cart the teacher is building,
 * line by line, and is replaced in place as it changes. `summary` is the
 * same ticket after the charge, plus how it was paid and a thank you, for
 * the few seconds the hub gives it before it sends the screen back to
 * idle by itself.
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

export default function TicketScene(props: { payload: TicketPayload }) {
  const t = props.payload;
  const summary = t.mode === "summary";
  const name = plainText(t.clientFirstName ?? "");
  const heading = summary
    ? name.length > 0
      ? `Thank you, ${name}`
      : "Thank you"
    : name.length > 0
      ? `Hello, ${name}`
      : "Your ticket";

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
