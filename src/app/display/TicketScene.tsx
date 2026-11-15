"use client";

import { useCallback, useEffect, useState } from "react";

import { plainText } from "@/lib/richtext";

import {
  choiceWord,
  tenderSentence,
  type TenderOffer,
  type TicketPayload,
} from "@/lib/displayticket";

import CardForm from "./CardForm";

/**
 * The ticket, as the student sees it (T201, Phase 2.5 item 2; design
 * "Scene 2").
 *
 * Three modes, one layout. `live` mirrors the cart the teacher is
 * building, line by line, and is replaced in place as it changes.
 * `summary` is the same ticket after the charge, plus how it was paid and
 * a thank you, for the few seconds the hub gives it before it sends the
 * screen back to idle by itself. `approve` (T203) is the same ticket with
 * Cancel and Approve on it, for the studio that has turned
 * `customer_confirms_sale` on. T206, Pete's first drive: the two
 * words and nothing above them. 'instead of "Does this look right?
 * Not yet | Approve" it should just be "Cancel | Approve"'.
 *
 * THIS COMPONENT CHARGES NOTHING and writes nothing. Approve stores an
 * answer on the request (`/api/display/complete`), Cancel refuses it
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
  /** T241 review: which version of the request this is. An approve
   *  ticket can be replaced in place after a pick, and the Approve names
   *  the version the student read, so a tap on the old one cannot
   *  complete the new. */
  version?: number;
  /** Told when the student has answered, so the screen can move on while
   *  the server catches up. */
  onAnswered?: (approved: boolean) => void;
  /** T241: told when the server has the student's pick, with the words
   *  of what they picked, so the screen can say "One moment" across the
   *  teacher's iPad asking again. */
  onPicked?: (words: string) => void;
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

  /* T240: how the student is paying, in the fixed words the payload
   * was checked against, on every mode once a tender is on the ticket.
   * Never a card's digits: the list cannot carry any. */
  const paying =
    t.tenders !== undefined && t.tenders.length > 0
      ? tenderSentence(t.tenders)
      : null;
  /* T240 review: a full comp reads "No charge" on its own, never
   * "Paying by No charge" or "Paid $0.00 by No charge". */
  const noCharge = paying === "No charge";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requestId, onAnswered, onPicked } = props;

  /**
   * T241 (Pete: "would be better to surface a choice to the customer for
   * the payment method if they want to switch it"): the Change control
   * and what it opens. The list is the TEACHER's offer, as the server
   * stored it; a pick sends one key from it and nothing else, and the
   * server refuses a key that is not on it. A pick charges nothing.
   */
  const choices: TenderOffer[] =
    !summary && t.choices !== undefined && requestId ? t.choices : [];
  const [view, setView] = useState<"ticket" | "change" | "card" | "sent">(
    "ticket",
  );
  const [sentWords, setSentWords] = useState<string | null>(null);
  /* A different request is a different ticket: back to it, whatever
   * was open. */
  useEffect(() => {
    setView("ticket");
    setSentWords(null);
  }, [requestId]);
  /* A new present of THIS request is the teacher's iPad answering the
   * pick (or the ticket moving): "sent" gives way to the ticket as it
   * now stands. A half-typed card is NOT wiped by it (T241 review: the
   * teacher's screen re-presents as a balance settles or a code is
   * applied); the form stays until the student sends it or backs out,
   * or the request ends. The list stays open while it still has
   * anything on it. */
  const payloadKey = JSON.stringify(t);
  useEffect(() => {
    setView((v) => (v === "sent" ? "ticket" : v));
  }, [payloadKey]);
  useEffect(() => {
    if (view === "change" && choices.length === 0) setView("ticket");
  }, [view, choices.length]);
  /* If the teacher's iPad never answers (it was charging, say, and
   * refused the pick with nothing changed), the ticket comes back. */
  useEffect(() => {
    if (view !== "sent") return;
    const timer = setTimeout(() => setView("ticket"), 8_000);
    return () => clearTimeout(timer);
  }, [view]);

  const pick = useCallback(
    async (offer: TenderOffer) => {
      if (busy || !requestId) return;
      if (offer.choice === "typedcard") {
        setError(null);
        setView("card");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/display/choose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, choice: offer.choice }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setView("ticket");
          setError(
            typeof body?.error === "string" && body.error
              ? body.error
              : "That did not go through. Please tell the front desk.",
          );
          return;
        }
        const words = choiceWord({ choice: offer.choice });
        setSentWords(words);
        setView("sent");
        onPicked?.(words);
      } catch {
        setView("ticket");
        setError("That did not go through. Please tell the front desk.");
      } finally {
        setBusy(false);
      }
    },
    [busy, requestId, onPicked],
  );

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
                ? {
                    requestId,
                    result: { approved: true },
                    ...(props.version !== undefined
                      ? { version: props.version }
                      : {}),
                  }
                : { requestId, reason: "Customer cancelled" },
            ),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(
            res.status === 409 && typeof body?.error === "string"
              ? body.error
              : "That did not go through. Please tell the front desk.",
          );
          return;
        }
        onAnswered?.(approved);
      } catch {
        setError("That did not go through. Please tell the front desk.");
      } finally {
        setBusy(false);
      }
    },
    [busy, requestId, onAnswered, props.version],
  );

  if (view === "card" && requestId) {
    const card = choices.find((c) => c.choice === "typedcard");
    return (
      <CardForm
        requestId={requestId}
        canKeep={card?.keep === true}
        onCancel={() => setView("change")}
        onSent={() => {
          setSentWords("Your card");
          setView("sent");
          onPicked?.("your card");
        }}
      />
    );
  }

  if (view === "sent") {
    return (
      <section className="dticket" aria-label="Your ticket">
        <h1 className="dticket-heading">Thank you</h1>
        <p className="dticket-tender">
          {sentWords === "Your card"
            ? "Your card is with the front desk. One moment."
            : `The front desk will switch to ${sentWords ?? "that"}. One moment.`}
        </p>
      </section>
    );
  }

  if (view === "change") {
    return (
      <section className="dticket" aria-label="How would you like to pay?">
        <h1 className="dticket-heading">How would you like to pay?</h1>
        {t.total !== null ? (
          <p className="dticket-tender">Total {money(t.total)}</p>
        ) : null}
        <div className="dchoice-list">
          {choices.map((offer) => (
            <button
              key={offer.choice}
              type="button"
              className="dscene-btn dchoice"
              disabled={busy}
              onClick={() => void pick(offer)}
            >
              {choiceWord(offer)}
            </button>
          ))}
        </div>
        <div className="dticket-approve-buttons">
          <button
            type="button"
            className="dscene-btn"
            disabled={busy}
            onClick={() => setView("ticket")}
          >
            Back
          </button>
        </div>
      </section>
    );
  }

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

      {!summary && paying !== null ? (
        <div className="dticket-tender-row">
          <p className="dticket-tender">
            {noCharge ? "No charge" : `Paying by ${paying}`}
          </p>
          {/* T241: a single-method tender may be changed by the student,
              to a way the teacher's iPad offered for this ticket. */}
          {choices.length > 0 ? (
            <button
              type="button"
              className="dscene-btn dticket-change"
              disabled={busy}
              onClick={() => {
                setError(null);
                setView("change");
              }}
            >
              Change
            </button>
          ) : null}
        </div>
      ) : null}
      {/* T241 review: no tender yet, and ways to pay on offer (a card
          that was let go of, a gift card entry cancelled): the student
          may choose rather than wait. */}
      {!summary && paying === null && choices.length > 0 ? (
        <div className="dticket-tender-row">
          <p className="dticket-tender">How would you like to pay?</p>
          <button
            type="button"
            className="dscene-btn dticket-change"
            disabled={busy}
            onClick={() => {
              setError(null);
              setView("change");
            }}
          >
            Choose
          </button>
        </div>
      ) : null}
      {!approve && error !== null ? <p className="dticket-error">{error}</p> : null}

      {approve ? (
        <div className="dticket-approve">
          {error !== null ? <p className="dticket-error">{error}</p> : null}
          <div className="dticket-approve-buttons">
            <button
              type="button"
              className="dscene-btn"
              disabled={busy}
              onClick={() => void answer(false)}
            >
              Cancel
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
          {noCharge ? (
            <p className="dticket-charged">No charge</p>
          ) : t.charged !== undefined ? (
            <p className="dticket-charged">
              Paid {money(t.charged)}
              {paying !== null ? ` by ${paying}` : ""}
            </p>
          ) : paying !== null ? (
            <p className="dticket-charged">Paid by {paying}</p>
          ) : null}
          {t.emailedReceipt === true ? (
            <p className="dticket-receipt">A receipt is on its way by email.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
