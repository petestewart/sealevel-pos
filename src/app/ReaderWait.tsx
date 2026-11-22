"use client";

import type { ReaderView } from "./useReaderPayment";

/**
 * T227: the panel while the Square Terminal waits for the student's card,
 * shared by the Cart screen and the roster's "Pay and check in" (T209's
 * rule: one piece, the same words on both). A modal over the charge
 * surface: the teacher's only control is Cancel, 64px, while the reader
 * can still be cancelled. Tokens only, no amount typed anywhere.
 */
export default function ReaderWait({
  view,
  onCancel,
}: {
  view: ReaderView | null;
  onCancel: () => void;
}) {
  if (view === null) return null;
  const amount =
    view.amountCents === null ? null : `$${(view.amountCents / 100).toFixed(2)}`;
  const card =
    view.lastFour !== null
      ? `${view.cardBrand ? `${view.cardBrand.charAt(0)}${view.cardBrand.slice(1).toLowerCase()} ` : "Card "}ending ${view.lastFour}`
      : null;
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal reader-wait" role="dialog" aria-label="Card reader">
        <div className="modal-head">
          <p className="modal-kicker">Card reader</p>
          <p className="modal-title">{amount ?? "Starting"}</p>
        </div>
        <p className="reader-words" role="status" aria-live="polite">
          {view.words}
        </p>
        {view.state === "collecting" ? (
          <p className="reason-sub">
            Ask them to tap, insert or use their phone on the reader.
          </p>
        ) : null}
        {card ? <p className="reason-sub">{card}</p> : null}
        <div className="modal-actions">
          <button
            className="modal-cancel"
            disabled={!view.cancellable}
            onClick={onCancel}
          >
            {view.cancellable ? "Cancel" : "Please wait"}
          </button>
        </div>
      </div>
    </div>
  );
}
