"use client";

import { useActionState, useState } from "react";
import {
  clearVendorLinkAction,
  setPayRateAction,
  setVendorLinkAction,
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

/**
 * Link a teacher to their QuickBooks vendor (SEA-119). Stores the QBO
 * Vendor Id, never a name: the push job pays the linked id, so the link
 * IS the payee decision. The vendor record itself is created by a human
 * in QuickBooks first; there is deliberately no create-vendor path here.
 */
export function VendorLinkForm({
  mbStaffId,
  currentVendorId,
  currentVendorName,
}: {
  mbStaffId: number;
  currentVendorId: string | null;
  currentVendorName: string | null;
}) {
  const [state, formAction, pending] = useActionState(setVendorLinkAction, IDLE);
  const [clearState, clearFormAction, clearPending] = useActionState(
    clearVendorLinkAction,
    IDLE,
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        {currentVendorId === null ? "Link QuickBooks vendor" : "Change vendor link"}
      </button>
    );
  }

  return (
    <form action={formAction} className="settings-form-row payrate-form">
      <input type="hidden" name="mb_staff_id" value={mbStaffId} />
      <label className="field-label" htmlFor={`vendor-id-${mbStaffId}`}>
        QuickBooks vendor id
      </label>
      <input
        id={`vendor-id-${mbStaffId}`}
        type="text"
        name="vendor_id"
        className="draft-subject-input"
        inputMode="numeric"
        placeholder="e.g. 58"
        defaultValue={currentVendorId ?? ""}
        required
      />
      <input
        type="text"
        name="vendor_name"
        className="draft-subject-input"
        placeholder="Vendor name in QuickBooks (label only)"
        defaultValue={currentVendorName ?? ""}
        maxLength={200}
      />
      <p className="settings-help">
        Open the vendor in QuickBooks and copy the number after nameId= in
        the address bar. Payroll pays this exact vendor record.
      </p>
      <button type="submit" className="btn btn--primary" disabled={pending}>
        {pending ? "Saving..." : "Save link"}
      </button>
      {currentVendorId !== null ? (
        <button
          type="submit"
          className="btn"
          formAction={clearFormAction}
          disabled={pending || clearPending}
        >
          {clearPending ? "Removing..." : "Remove link"}
        </button>
      ) : null}
      <button
        type="button"
        className="btn"
        onClick={() => setOpen(false)}
        disabled={pending || clearPending}
      >
        Cancel
      </button>
      {state.error ?? clearState.error ? (
        <p className="settings-error" role="alert">
          {state.error ?? clearState.error}
        </p>
      ) : null}
    </form>
  );
}
