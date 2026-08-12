"use client";

import { useActionState, useState } from "react";
import {
  setPayRateAction,
  type PayRateActionState,
} from "../app/settings/pay-rates/actions";

/**
 * Client form for setting or changing one teacher's pay rate (SEA-106).
 * Presentation only: the server action re-checks settings:manage and core
 * changePayRate enforces the policy rules (next-period effective dates,
 * no back-dating, zero rates need a note) regardless of what this
 * renders.
 */

const IDLE: PayRateActionState = { error: null };

export function SetRateForm({
  mbStaffId,
  displayName,
  currentRateCents,
  defaultEffectiveFrom,
  minEffectiveFrom,
}: {
  mbStaffId: number;
  displayName: string;
  currentRateCents: number | null;
  /** First rates default to the open period start (so the blocked period
   * is covered on re-run); changes default to the next period start. */
  defaultEffectiveFrom: string;
  /** Omitted for a first rate: it may back-date to cover a blocked
   * (possibly already-closed) period, per policy 11's new-teacher flow. */
  minEffectiveFrom?: string;
}) {
  const [state, formAction, pending] = useActionState(setPayRateAction, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="btn"
        onClick={() => setOpen(true)}
      >
        {currentRateCents === null ? "Set rate" : "Change rate"}
      </button>
    );
  }

  return (
    <form action={formAction} className="settings-form-row payrate-form">
      <input type="hidden" name="mb_staff_id" value={mbStaffId} />
      <input type="hidden" name="display_name" value={displayName} />
      <label className="field-label" htmlFor={`rate-amount-${mbStaffId}`}>
        Per class ($)
      </label>
      <input
        id={`rate-amount-${mbStaffId}`}
        type="number"
        name="amount"
        className="draft-subject-input"
        min="0"
        step="0.01"
        defaultValue={
          currentRateCents === null
            ? ""
            : (currentRateCents / 100).toFixed(2)
        }
        required
      />
      <label className="field-label" htmlFor={`rate-from-${mbStaffId}`}>
        Effective from
      </label>
      <input
        id={`rate-from-${mbStaffId}`}
        type="date"
        name="effective_from"
        className="draft-subject-input"
        defaultValue={defaultEffectiveFrom}
        min={minEffectiveFrom}
        // For a CHANGE, min is the next period start and step walks in
        // 14-day hops from it, so the picker only offers period starts
        // (the server enforces alignment regardless). First rates are
        // unconstrained; they may back-date to cover a blocked period.
        step={minEffectiveFrom ? 14 : undefined}
        required
      />
      <input
        type="text"
        name="notes"
        className="draft-subject-input"
        placeholder="Notes (required for a $0 rate)"
        maxLength={200}
      />
      <button type="submit" className="btn btn--primary" disabled={pending}>
        {pending ? "Saving..." : "Save rate"}
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen(false)}
        disabled={pending}
      >
        Cancel
      </button>
      {state.error ? (
        <p className="settings-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
