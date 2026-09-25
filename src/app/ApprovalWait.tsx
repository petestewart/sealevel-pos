"use client";

import type { ApprovalState } from "./useSaleApproval";

/**
 * T203's "Waiting for the customer to approve", in ONE place (T209).
 *
 * It stands where a teacher is already looking, says what is being
 * waited for, and carries the ways out: Cancel (the ticket stays exactly
 * as built), and the D1 PIN override. A busy screen adds the design's
 * Wait and Take over. Nothing here charges: the charge follows the
 * customer's own tap, or the PIN.
 *
 * The panel is the SAME on every charge path, which is the whole point
 * of lifting it out of SaleScreen (T209, Pete's third drive): the Cart
 * screen's Charge and the roster's "Pay and check in" ask the same
 * question in the same words, so a teacher who has read it once has read
 * it everywhere. A screen that is not connected does not skip the panel
 * and jump to a PIN pad: it shows the same panel with the line that says
 * why, and Approve sale is still the teacher's own deliberate tap.
 *
 * With nothing outstanding it draws the quiet sentence a finished
 * approval left behind ("Customer cancelled"), and with neither, nothing.
 */
export default function ApprovalWait(props: {
  approval: ApprovalState | null;
  note: string | null;
  waitingForScreen: boolean;
  onCancel: () => void;
  onWait: () => void;
  onTakeOver: () => void;
  onPin: () => void;
}) {
  const { approval, note, waitingForScreen } = props;
  if (approval === null) {
    return note !== null ? <p className="approve-wait-sub">{note}</p> : null;
  }
  return (
    <div className="approve-wait" role="status">
      <p className="approve-wait-title">
        {approval.stage === "waiting"
          ? "Waiting for the customer to approve"
          : approval.stage === "busy"
            ? approval.signup === true
              ? "Someone is signing up on the customer screen."
              : "The customer screen is busy."
            : approval.stage === "offline"
              ? "The customer screen is not connected."
              : approval.stage === "refused"
                ? "The customer could not be asked."
                : "Approving with your PIN"}
      </p>
      <p className="approve-wait-sub">
        {approval.stage === "waiting"
          ? "The ticket is on their screen. The sale goes through the moment they tap Approve."
          : approval.stage === "busy"
            ? waitingForScreen
              ? "Waiting for it to come free. The ticket goes up by itself."
              : approval.signup === true
                ? "Wait for them to finish, take the screen over, or approve the sale with your PIN."
                : "Wait for it, take it over, or approve the sale with your PIN."
            : approval.stage === "offline"
              ? "This sale needs your PIN, or a screen to ask on."
              : approval.stage === "refused"
                ? /* T209 review: the SERVER's own sentence. A refusal a
                     teacher cannot read is a refusal they cannot act
                     on, and "not connected" over a connected screen
                     sends them to the wrong iPad. */
                  `${approval.error} Charge again to try, or approve the sale with your PIN.`
                : "Enter your PIN in the box."}
      </p>
      {approval.stage !== "pin" ? (
        <div className="approve-wait-buttons">
          <button
            type="button"
            className="approve-wait-btn"
            onClick={() => props.onCancel()}
          >
            Cancel
          </button>
          {approval.stage === "busy" && !waitingForScreen ? (
            <button
              type="button"
              className="approve-wait-btn"
              onClick={props.onWait}
            >
              Wait
            </button>
          ) : null}
          {approval.stage === "busy" ? (
            <button
              type="button"
              className="approve-wait-btn"
              onClick={props.onTakeOver}
            >
              Take over
            </button>
          ) : null}
          <button
            type="button"
            className="approve-wait-btn go"
            onClick={props.onPin}
          >
            Approve sale
          </button>
        </div>
      ) : null}
    </div>
  );
}
